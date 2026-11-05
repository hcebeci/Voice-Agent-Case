"""Independent real-Postgres regression assertions; no production access.

Requires IDEMPOTENCY_TEST_DB_CONFIG pointing at root's disposable fixture.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'Livekit-Agents/src'))
from collection_backend import CollectionBackend


def sql(statement):
    config = json.loads(Path(os.environ['IDEMPOTENCY_TEST_DB_CONFIG']).read_text())
    result = subprocess.run(config['psql'] + ['-A', '-t', '-c', statement], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


def js(value):
    return q(json.dumps(value)) + '::jsonb'


def seed():
    aid, cid, sid = [str(uuid4()) for _ in range(3)]
    sql(f"INSERT INTO agents(id,name,model) VALUES({q(aid)},'independent fixture','test'); INSERT INTO customers(id,full_name,phone_e164,date_of_birth,postal_code,account_reference,balance_cents,payment_due_date,is_test_record) VALUES({q(cid)},'Independent Fixture','+905550001111','1988-04-12','34000',{q(cid)},200000,'2026-10-01',true); INSERT INTO sessions(id,agent_id,room_name,source,status) VALUES({q(sid)},{q(aid)},{q('independent-'+sid)},'user_started','active'); INSERT INTO collection_sessions(session_id,customer_id) VALUES({q(sid)},{q(cid)});")
    return sid


def count(table, sid):
    return int(sql(f'SELECT count(*) FROM {table} WHERE session_id={q(sid)}'))


class DatabaseBoundary:
    """Only HTTP mocked: execute actual current RPC signatures in separate psql connections."""
    def __init__(self, sid):
        self.sid = sid
        self.commits = []
        self.lose_ack = False

    def handle(self, request):
        body = json.loads(request.content)
        name = request.url.path.rsplit('/', 1)[-1]
        values = []
        for key, value in body.items():
            if isinstance(value, (dict, list)):
                literal = js(value)
            elif value is None:
                literal = 'NULL'
            elif isinstance(value, (int, float)):
                literal = str(value)
            else:
                literal = q(value)
            values.append(f'{key} => {literal}')
        result = json.loads(sql(f"SELECT public.{name}({','.join(values)})::text"))
        if name == 'collection_commit':
            self.commits.append(body)
            if self.lose_ack:
                self.lose_ack = False
                raise httpx.ReadTimeout('lost ACK after actual durable COMMIT')
        return httpx.Response(200, json=result)

    def backend(self):
        return CollectionBackend(self.sid, 'http://fixture', 'fixture', client=httpx.AsyncClient(base_url='http://fixture/', transport=httpx.MockTransport(self.handle)))


def callback():
    return {'callback_at': (datetime.now(timezone.utc) + timedelta(days=2)).replace(microsecond=0).isoformat()}


@pytest.mark.asyncio
async def test_same_key_argument_and_tool_mismatch_rejected_without_mutation():
    sid = seed(); db = DatabaseBoundary(sid); backend = db.backend()
    try:
        arguments = callback()
        one = await backend.execute('request_callback', arguments, 'collision', user_turn_id='intent-A')
        assert one['code'] == 'CALLBACK_REQUESTED'
        changed = dict(arguments, callback_at=(datetime.now(timezone.utc)+timedelta(days=3)).isoformat())
        for tool, args in [('request_callback', changed), ('verify_identity', {'date_of_birth':'1988-04-12','postal_code':'34000'})]:
            rejected = await backend.execute(tool, args, 'collision')
            assert rejected['code'] == 'IDEMPOTENCY_KEY_REUSED', rejected
        assert count('follow_up_requests', sid) == count('collection_operations', sid) == 1
        assert int(sql(f'SELECT version FROM collection_sessions WHERE session_id={q(sid)}')) == 1
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_lost_ack_recovers_one_effect_and_receipt_across_backend_restart():
    sid = seed(); db = DatabaseBoundary(sid); backend = db.backend(); args = callback()
    try:
        db.lose_ack = True
        first = await backend.execute('request_callback', args, 'restart-recovery', user_turn_id='intent-A')
        assert first['code'] == 'CALLBACK_REQUESTED'
    finally:
        await backend.close()
    backend = db.backend()
    try:
        second = await backend.execute('request_callback', args, 'restart-recovery', user_turn_id='intent-A')
        assert second == first
        assert len(db.commits) == 1
        assert count('follow_up_requests', sid) == count('collection_operations', sid) == 1
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_equal_key_in_two_sessions_never_shares_receipts():
    sid1, sid2 = seed(), seed(); args = callback()
    for sid in (sid1, sid2):
        backend = DatabaseBoundary(sid).backend()
        try:
            result = await backend.execute('request_callback', args, 'same-external-key', user_turn_id='intent-A')
            assert result['code'] == 'CALLBACK_REQUESTED'
        finally:
            await backend.close()
        assert count('follow_up_requests', sid) == count('collection_operations', sid) == 1
    assert sql(f'SELECT id FROM follow_up_requests WHERE session_id={q(sid1)}') != sql(f'SELECT id FROM follow_up_requests WHERE session_id={q(sid2)}')


def test_event_upsert_retry_is_supported_and_preserves_null_event_semantics():
    sid = seed(); event = str(uuid4())
    insert = f"INSERT INTO session_events(session_id,event_type,source,source_event_id) VALUES({q(sid)},'livekit.room_started','livekit_webhook',{q(event)}) ON CONFLICT(source,source_event_id) DO NOTHING"
    with ThreadPoolExecutor(max_workers=10) as pool:
        list(pool.map(sql, [insert]*10))
    assert count('session_events', sid) == 1
    for _ in range(2):
        sql(f"INSERT INTO session_events(session_id,event_type,source) VALUES({q(sid)},'collection.tool_result','platform')")
    assert count('session_events', sid) == 3


@pytest.mark.asyncio
async def test_callback_identity_survives_new_tool_id_but_distinct_intent_is_allowed():
    sid = seed(); db = DatabaseBoundary(sid); backend = db.backend(); args = callback()
    try:
        first = await backend.execute('request_callback', args, 'tool-1', user_turn_id='intent-A')
        replay = await backend.execute('request_callback', args, 'tool-2', user_turn_id='intent-A')
        assert first['code'] == replay['code'] == 'CALLBACK_REQUESTED'
        assert first['data'] == replay['data']
        assert count('follow_up_requests', sid) == 1
        distinct = await backend.execute('request_callback', args, 'tool-3', user_turn_id='intent-B')
        assert distinct['code'] == 'CALLBACK_REQUESTED'
        assert count('follow_up_requests', sid) == 2
        assert count('collection_operations', sid) == 3
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_same_operation_offset_equivalent_timestamp_returns_original_record():
    sid = seed(); db = DatabaseBoundary(sid); backend = db.backend(); args = callback()
    offset = datetime.fromisoformat(args['callback_at']).astimezone(timezone(timedelta(hours=3))).isoformat()
    try:
        first = await backend.execute('request_callback', args, 'offset-1', user_turn_id='intent-A')
        replay = await backend.execute('request_callback', {'callback_at':offset}, 'offset-2', user_turn_id='intent-A')
        assert first['data'] == replay['data']
        assert count('follow_up_requests', sid) == 1
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_raw_commit_same_key_different_args_has_one_winner_and_rejects_all_collisions():
    sid = seed(); db = DatabaseBoundary(sid); backend = db.backend(); args = callback()
    try:
        await backend.execute('request_callback', args, 'race', user_turn_id='intent-A')
        payload = db.commits[0]
        sql(f"DELETE FROM session_events WHERE session_id={q(sid)}; DELETE FROM follow_up_requests WHERE session_id={q(sid)}; DELETE FROM collection_operations WHERE session_id={q(sid)}; UPDATE collection_sessions SET version=0 WHERE session_id={q(sid)}")
        variants = []
        for i in range(12):
            p = json.loads(json.dumps(payload))
            p['p_arguments'] = dict(args, unique_marker=i)
            values = [f"{key} => {js(value) if isinstance(value, (dict,list)) else ('NULL' if value is None else str(value) if isinstance(value,(int,float)) else q(value))}" for key,value in p.items()]
            variants.append(f"SELECT collection_commit({','.join(values)})::text")
        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda stmt:json.loads(sql(stmt)), variants))
        codes = [result['result']['code'] for result in results]
        assert codes.count('CALLBACK_REQUESTED') == 1, codes
        assert codes.count('IDEMPOTENCY_KEY_REUSED') == 11, codes
        assert count('follow_up_requests', sid) == count('collection_operations', sid) == 1
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_verify_identity_receipt_hashes_arguments_and_redacts_audit():
    sid=seed(); backend=DatabaseBoundary(sid).backend()
    try:
        args={'date_of_birth':'1988-04-12','postal_code':'34000'}
        one=await backend.execute('verify_identity',args,'identity')
        assert one['code']=='IDENTITY_VERIFIED'
        # Reordered JSON keys retain identity, changed answers do not.
        replay=await backend.execute('verify_identity',dict(reversed(list(args.items()))),'identity')
        assert replay==one
        changed=await backend.execute('verify_identity',dict(args,postal_code='99999'),'identity')
        assert changed['code']=='IDEMPOTENCY_KEY_REUSED'
        audit=json.loads(sql(f'SELECT payload::text FROM session_events WHERE session_id={q(sid)}'))
        assert audit['arguments']=={'redacted':True}
        hashed=sql(f'SELECT arguments_hash FROM collection_operations WHERE session_id={q(sid)}')
        assert len(hashed)==64 and '34000' not in hashed
        assert count('collection_operations',sid)==1
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_legacy_receipt_fails_closed_without_exposing_old_result():
    sid=seed(); backend=DatabaseBoundary(sid).backend()
    secret={'tool_name':'verify_identity','code':'IDENTITY_VERIFIED','verified_user':True,'data':{'account':'private'}}
    sql(f"INSERT INTO collection_operations(session_id,request_id,tool_name,result) VALUES({q(sid)},'legacy','verify_identity',{js(secret)})")
    try:
        result=await backend.execute('request_callback',callback(),'legacy',user_turn_id='intent-A')
        assert result['code']=='IDEMPOTENCY_LEGACY_RECEIPT'
        assert result['data']=={}
        assert count('follow_up_requests',sid)==0
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_database_rejects_missing_or_mismatched_callback_operation_evidence():
    sid=seed(); boundary=DatabaseBoundary(sid); backend=boundary.backend()
    try:
        await backend.execute('request_callback',callback(),'valid',user_turn_id='intent-A')
        payload=boundary.commits[0]
        sql(f"DELETE FROM session_events WHERE session_id={q(sid)}; DELETE FROM follow_up_requests WHERE session_id={q(sid)}; DELETE FROM collection_operations WHERE session_id={q(sid)}; UPDATE collection_sessions SET version=0 WHERE session_id={q(sid)}")
        for turn,operation,error in [(None,payload['p_effect']['operation_id'],'USER_MESSAGE_REQUIRED'),('intent-B',payload['p_effect']['operation_id'],'CALLBACK_IDENTITY_MISMATCH')]:
            p=json.loads(json.dumps(payload));p['p_user_turn_id']=turn;p['p_effect']['operation_id']=operation
            values=[f"{key} => {js(value) if isinstance(value,(dict,list)) else 'NULL' if value is None else str(value) if isinstance(value,(int,float)) else q(value)}" for key,value in p.items()]
            with pytest.raises(AssertionError,match=error):
                sql(f"SELECT collection_commit({','.join(values)})::text")
            assert count('follow_up_requests',sid)==count('collection_operations',sid)==0
    finally:
        await backend.close()


@pytest.mark.asyncio
async def test_database_unique_operation_replays_original_uuid_after_state_map_loss():
    sid=seed(); boundary=DatabaseBoundary(sid); backend=boundary.backend()
    try:
        first=await backend.execute('request_callback',callback(),'first',user_turn_id='intent-A')
        payload=boundary.commits[0]
        # Force a valid newer snapshot whose callback map is absent. Durable effect
        # uniqueness must protect even if transition-level memoization is lost.
        state=json.loads(sql(f'SELECT state::text FROM collection_sessions WHERE session_id={q(sid)}'))
        state.pop('callbacks',None)
        sql(f'UPDATE collection_sessions SET state={js(state)} WHERE session_id={q(sid)}')
        p=json.loads(json.dumps(payload));p['p_version']=1;p['p_request_id']='second';p['p_state']=state
        p['p_effect']['request_id']=str(uuid4())
        p['p_result']['data']['request_id']=p['p_effect']['request_id']
        values=[f"{key} => {js(value) if isinstance(value,(dict,list)) else 'NULL' if value is None else str(value) if isinstance(value,(int,float)) else q(value)}" for key,value in p.items()]
        replay=json.loads(sql(f"SELECT collection_commit({','.join(values)})::text"))
        assert replay['result']['data']['request_id']==first['data']['request_id']
        assert count('follow_up_requests',sid)==1
        assert count('collection_operations',sid)==2
    finally:
        await backend.close()
