"""Real PostgreSQL contracts; explicitly requires disposable config, no production default."""
import importlib.util
import json
import os
from pathlib import Path
import pytest

config = os.environ.get('IDEMPOTENCY_TEST_DB_CONFIG')
if not config:
    pytest.skip('Explicit disposable DB config required', allow_module_level=True)
spec = importlib.util.spec_from_file_location('audit_helper', Path(__file__).with_name('_database_helper.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
h.PSQL = json.loads(Path(config).read_text())['psql']

@pytest.mark.asyncio
async def test_changed_payload_same_key_rejected_without_second_effect():
    sid=h.seed(); db=h.ActualDatabase(sid); b=db.backend()
    one=await b.execute('request_callback',h.CALLBACK,'collision')
    changed={'callback_at':(h.datetime.now(h.timezone.utc)+h.timedelta(days=2)).isoformat()}
    two=await b.execute('request_callback',changed,'collision')
    assert one['code']=='CALLBACK_REQUESTED' and two['code']=='IDEMPOTENCY_KEY_REUSED'
    assert h.count('follow_up_requests',sid)==1 and db.commits==1
    await b.close()

@pytest.mark.asyncio
async def test_changed_tool_same_key_rejected():
    sid=h.seed(); b=h.ActualDatabase(sid).backend()
    one=await b.execute('verify_identity',{'date_of_birth':'1988-04-12','postal_code':'34000'},'collision')
    two=await b.execute('request_callback',h.CALLBACK,'collision')
    assert one['tool_name']=='verify_identity' and two['code']=='IDEMPOTENCY_KEY_REUSED'
    assert h.count('follow_up_requests',sid)==0
    await b.close()

@pytest.mark.asyncio
async def test_identical_request_key_isolated_between_sessions():
    s1,s2=h.seed(),h.seed(); b1,b2=h.ActualDatabase(s1).backend(),h.ActualDatabase(s2).backend()
    one=await b1.execute('request_callback',h.CALLBACK,'same-key')
    two=await b2.execute('request_callback',h.CALLBACK,'same-key')
    assert one['data']['request_id']!=two['data']['request_id']
    assert h.count('follow_up_requests',s1)==h.count('follow_up_requests',s2)==1
    await b1.close(); await b2.close()

@pytest.mark.parametrize('role',['anon','authenticated'])
@pytest.mark.parametrize('operation',['snapshot','commit','receipts','effects'])
def test_untrusted_roles_denied(role,operation):
    sid=h.seed(); q=h.quoted
    statements={
      'snapshot':f"SELECT collection_snapshot({q(sid)}::uuid,'x')",
      'commit':f"SELECT collection_commit({q(sid)}::uuid,'x',0,'{{}}','{{}}',null,'{{}}')",
      'receipts':'SELECT * FROM collection_operations',
      'effects':f"INSERT INTO follow_up_requests(id,session_id,customer_id,kind,callback_at) VALUES(gen_random_uuid(),{q(sid)},gen_random_uuid(),'callback',now())"
    }
    with pytest.raises(RuntimeError,match='permission denied'):
        h.sql(f'SET ROLE {role}; '+statements[operation])

@pytest.mark.asyncio
async def test_closed_session_blocks_fresh_effect():
    sid=h.seed(); b=h.ActualDatabase(sid).backend()
    h.sql(f"UPDATE sessions SET status='completed' WHERE id={h.quoted(sid)}")
    result=await b.execute('request_callback',h.CALLBACK,'closed')
    assert result['code']=='SESSION_NOT_ACTIVE' and h.count('follow_up_requests',sid)==0
    await b.close()

@pytest.mark.asyncio
async def test_closed_session_replay_returns_historical_success_only():
    sid=h.seed(); b=h.ActualDatabase(sid).backend()
    original=await b.execute('request_callback',h.CALLBACK,'before-close')
    h.sql(f"UPDATE sessions SET status='completed' WHERE id={h.quoted(sid)}")
    replay=await b.execute('request_callback',h.CALLBACK,'before-close')
    assert replay==original and h.count('follow_up_requests',sid)==1
    await b.close()

@pytest.mark.parametrize('role',['anon','authenticated'])
def test_role_privilege_catalog_denies_collection_api_and_tables(role):
    privileges=h.scalar(f"""SELECT json_build_object(
      'snapshot',has_function_privilege('{role}','public.collection_snapshot(uuid,text,text,jsonb)','EXECUTE'),
      'commit',has_function_privilege('{role}','public.collection_commit(uuid,text,bigint,jsonb,jsonb,jsonb,jsonb,text)','EXECUTE'),
      'receipt_read',has_table_privilege('{role}','public.collection_operations','SELECT'),
      'effect_insert',has_table_privilege('{role}','public.follow_up_requests','INSERT'))::text""")
    assert privileges == {'snapshot':False,'commit':False,'receipt_read':False,'effect_insert':False}
