from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import subprocess
import tempfile
from uuid import uuid4

import pytest
from test_database_fix_validation import sql, q, js

ROOT = Path(__file__).resolve().parents[3]

@pytest.mark.parametrize('scenario', ['replay','concurrent','mismatch','dispatch-lost-ack','dispatch-unknown','ready-lost-ack','room-lost-ack','closed','missing-key'])
def test_current_session_handler_real_receipt_mock_remote_sdk(scenario):
    source=(ROOT/'supabase/functions/livekit-session/index.ts').read_text()
    body=source[source.index('type SessionRequest'):source.index('async function updateBrowserSession')]
    fixture=(Path(__file__).with_name('session_handler_harness.mts')).read_text()
    imports=f"import {{ assignedExecutionKeys, callDirection }} from '{(ROOT/'supabase/functions/livekit-session/configuration.mjs').as_uri()}';\n"
    with tempfile.TemporaryDirectory(prefix='session-fixed-') as directory:
        probe=Path(directory)/'test.mts'
        probe.write_text(imports+fixture.replace('// HANDLER',body))
        result=subprocess.run(['node','--experimental-strip-types',str(probe),scenario],capture_output=True,text=True)
        assert result.returncode==0,result.stdout+result.stderr


def reserve_fixture():
    aid,uid=[str(uuid4()) for _ in range(2)]
    sql(f"INSERT INTO auth.users(id) VALUES({q(uid)}); INSERT INTO agents(id,name,model) VALUES({q(aid)},'Session SQL fixture','test');")
    payload={'agent_id':aid,'source':'user_started','customer_id':None,'call_direction':'agent_calls_user'}
    def reserve(user=uid,key='fixture-key',data=payload):
        return f'SELECT session_start_reserve({q(user)},{q(key)},{js(data)},{js(dict(id=aid,name="fixture"))})::text'
    return aid,uid,payload,reserve


def test_twelve_connections_reserve_one_session_and_only_one_dispatch_owner():
    aid,uid,_,reserve=reserve_fixture()
    with ThreadPoolExecutor(max_workers=12) as pool:
        records=list(pool.map(lambda _:json.loads(sql(reserve())),range(12)))
    assert len({r['session_id'] for r in records})==1
    with ThreadPoolExecutor(max_workers=12) as pool:
        ownership=list(pool.map(lambda _:sql(f"SELECT session_start_dispatch({q(uid)},'fixture-key',false)"),range(12)))
    assert ownership.count('t')==1
    assert sql(f'SELECT count(*) FROM sessions WHERE agent_id={q(aid)}')=='1'


def test_session_receipt_user_scope_and_payload_binding():
    aid,uid,payload,reserve=reserve_fixture()
    first=json.loads(sql(reserve()))
    changed=dict(payload,call_direction='user_calls_agent')
    assert json.loads(sql(reserve(data=changed)))=={'code':'IDEMPOTENCY_KEY_REUSED'}
    uid2=str(uuid4());sql(f'INSERT INTO auth.users(id) VALUES({q(uid2)})')
    other=json.loads(sql(reserve(user=uid2)))
    assert first['session_id']!=other['session_id']
    assert sql(f'SELECT count(*) FROM sessions WHERE agent_id={q(aid)}')=='2'


def test_browser_roles_cannot_reserve_or_claim_dispatch():
    for role in ['anon','authenticated']:
        for signature in ['session_start_reserve(uuid,text,jsonb,jsonb)','session_start_dispatch(uuid,text,boolean)']:
            assert sql(f'SELECT has_function_privilege({q(role)},{q(signature)},\'EXECUTE\')')=='f'
        assert sql(f"SELECT has_table_privilege({q(role)},'session_start_requests','SELECT')")=='f'
