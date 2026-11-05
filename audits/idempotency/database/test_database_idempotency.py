import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
import json
from pathlib import Path
import subprocess
import sys
from uuid import uuid4
import httpx
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'Livekit-Agents/src'))
from collection_backend import CollectionBackend
from observability import ObservabilityClient,Observation

CFG=json.loads(Path('/tmp/database-team-cluster.json').read_text())
PSQL=CFG['psql']
def sql(s):
 r=subprocess.run(PSQL+['-A','-t','-c',s],capture_output=True,text=True)
 if r.returncode:raise RuntimeError(r.stderr.strip())
 return r.stdout.strip()
def quoted(v):return "'"+str(v).replace("'","''")+"'"
def jsonsql(v):return quoted(json.dumps(v))+'::jsonb'
def scalar(s):return json.loads(sql(s))
def count(table,sid):return int(sql(f'SELECT count(*) FROM public.{table} WHERE session_id={quoted(sid)}'))
def seed():
 aid,cid,sid=[str(uuid4()) for _ in range(3)]
 sql(f"INSERT INTO agents(id,name,model) VALUES({quoted(aid)},'audit fixture','test');")
 sql(f"INSERT INTO customers(id,full_name,phone_e164,date_of_birth,postal_code,account_reference,balance_cents,payment_due_date,is_test_record) VALUES({quoted(cid)},'Audit Fixture','+905550000000','1988-04-12','34000',{quoted(cid)},200000,'2026-10-01',true);")
 sql(f"INSERT INTO sessions(id,agent_id,room_name,source,status) VALUES({quoted(sid)},{quoted(aid)},{quoted('audit-'+sid)},'user_started','active'); INSERT INTO collection_sessions(session_id,customer_id) VALUES({quoted(sid)},{quoted(cid)});")
 return sid
class AuditBackend(CollectionBackend):
 async def execute(self,tool,arguments,request_id,**evidence):
  evidence.setdefault('user_turn_id','audit-user-message')
  return await super().execute(tool,arguments,request_id,**evidence)

class ActualDatabase:
 def __init__(self,sid,lose_response=False):self.sid=sid;self.lose_response=lose_response;self.commits=0;self.payloads=[]
 def handle(self,request):
  body=json.loads(request.content)
  name=request.url.path.rsplit('/',1)[-1]
  def literal(value):
   if value is None:return 'NULL'
   if isinstance(value,(dict,list)):return jsonsql(value)
   if isinstance(value,(int,float)):return str(value)
   return quoted(value)
  args=','.join(key+' => '+literal(value) for key,value in body.items())
  result=scalar(f'SELECT public.{name}({args})::text')
  if name=='collection_commit':
   self.commits+=1;self.payloads.append(body)
   if self.lose_response:self.lose_response=False;raise httpx.ReadTimeout('response lost AFTER real database commit')
  return httpx.Response(200,json=result)
 def backend(self):
  return AuditBackend(self.sid,'http://isolated','fixture',client=httpx.AsyncClient(base_url='http://isolated/',transport=httpx.MockTransport(self.handle)))
CALLBACK={'callback_at':(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()}

@pytest.mark.asyncio
async def test_callback_same_key_replays_one_real_database_write():
 sid=seed();db=ActualDatabase(sid);b=db.backend()
 one=await b.execute('request_callback',CALLBACK,'callback-1')
 two=await b.execute('request_callback',CALLBACK,'callback-1')
 assert one==two and one['code']=='CALLBACK_REQUESTED'
 assert count('follow_up_requests',sid)==count('collection_operations',sid)==1
 await b.close()

@pytest.mark.asyncio
async def test_lost_commit_response_recovers_receipt_without_second_callback():
 sid=seed();db=ActualDatabase(sid,lose_response=True);b=db.backend()
 result=await b.execute('request_callback',CALLBACK,'lost-response-1')
 assert result['code']=='CALLBACK_REQUESTED'
 assert db.commits==1
 assert count('follow_up_requests',sid)==count('collection_operations',sid)==1
 await b.close()

@pytest.mark.asyncio
async def test_twelve_concurrent_replays_at_database_commit_make_one_effect():
 sid=seed();db=ActualDatabase(sid);b=db.backend()
 await b.execute('request_callback',CALLBACK,'parallel-1')
 payload=db.payloads[0]
 # Roll back this fixture to its pre-request state before dispatching concurrent commits.
 sql(f"DELETE FROM session_events WHERE session_id={quoted(sid)}; DELETE FROM follow_up_requests WHERE session_id={quoted(sid)}; DELETE FROM collection_operations WHERE session_id={quoted(sid)}; UPDATE collection_sessions SET version=0 WHERE session_id={quoted(sid)};")
 statement=commit_sql(sid,'parallel-1',payload)
 with ThreadPoolExecutor(max_workers=12) as pool:results=list(pool.map(lambda _:scalar(statement),range(12)))
 assert all(r==results[0] for r in results)
 assert count('follow_up_requests',sid)==count('collection_operations',sid)==1
 await b.close()

@pytest.mark.asyncio
async def test_payment_same_proposal_under_new_tool_call_id_does_not_duplicate():
 sid=seed();db=ActualDatabase(sid);b=db.backend()
 verified=await b.execute('verify_identity',{'date_of_birth':'1988-04-12','postal_code':'34000'},'verify')
 assert verified['verified_user']
 paydate=(datetime.now(timezone.utc)+timedelta(days=7)).date().isoformat()
 offer=await b.execute('evaluate_offer',{'amount_cents':85000,'payment_date':paydate},'offer')
 pid=offer['data']['proposal_id'];now=datetime.now(timezone.utc).timestamp()
 await b.execute('_review_delivered',{'proposal_id':pid,'user_turn_id':'review-turn','delivered_at':now-1},'review')
 one=await b.execute('create_payment_commitment',{'proposal_id':pid},'commit-1',user_turn_id='confirmation',user_turn_at=now)
 two=await b.execute('create_payment_commitment',{'proposal_id':pid},'commit-2',user_turn_id='confirmation',user_turn_at=now)
 assert one['code']=='COMMITMENT_CREATED'
 assert two['code']=='COMMITMENT_ALREADY_EXISTS'
 assert one['data']==two['data']
 assert count('payment_commitments',sid)==1
 await b.close()

@pytest.mark.asyncio
async def test_same_callback_with_new_tool_call_id_should_not_duplicate():
 sid=seed();b=ActualDatabase(sid).backend()
 await b.execute('request_callback',CALLBACK,'call-id-1')
 await b.execute('request_callback',CALLBACK,'call-id-2')
 await b.close()
 actual=count('follow_up_requests',sid)
 print('GAP: repeated callback with new tool ID =>',actual,'rows')
 assert actual==1

@pytest.mark.asyncio
async def test_observability_http_retries_reuse_event_id():
 requests=[]
 async def handler(request):
  requests.append(json.loads(request.content))
  if len(requests)<3:raise httpx.ReadTimeout('ack lost')
  return httpx.Response(200,json={'received':True})
 client=object.__new__(ObservabilityClient)
 client.session_id='test';client.endpoint='http://fixture';client._secret_key='fixture'
 client._client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
 await client._send_with_retries(Observation('trace.tts','2026-11-04T00:00:00Z',1,1,{}))
 assert len(requests)==3
 assert len({r['event_id'] for r in requests})==1
 await client._client.aclose()


def test_duplicate_event_id_rejected_by_database():
 sid=seed(); eid=str(uuid4())
 query=f"INSERT INTO session_events(session_id,event_type,source,source_event_id) VALUES({quoted(sid)},'trace.tts','agent_worker',{quoted(eid)});"
 sql(query)
 with pytest.raises(RuntimeError,match='duplicate key'):sql(query)
 assert count('session_events',sid)==1

def test_webhook_on_conflict_target_supported_by_current_migrations():
 sid=seed();event=str(uuid4())
 sql(f"INSERT INTO session_events(session_id,event_type,source,source_event_id) VALUES({quoted(sid)},'livekit.room_started','livekit_webhook',{quoted(event)}) ON CONFLICT(source,source_event_id) DO NOTHING;")
 assert count('session_events',sid)==1


def raw_payload(sid, rid="fresh"):
    snap=scalar(f"SELECT collection_snapshot({quoted(sid)}::uuid,{quoted(rid)})::text")
    state=snap['state'];state['customer_updated_at']=snap['customer']['updated_at']
    turn='raw-user-'+uuid4().hex
    operation=turn+':'+datetime.fromisoformat(CALLBACK['callback_at']).astimezone(timezone.utc).isoformat(timespec='microseconds')
    return dict(p_user_turn_id=turn,p_version=snap['version'],p_state=state,
      p_result={'tool_name':'request_callback','code':'CALLBACK_REQUESTED','verified_user':False,'data':{}},
      p_effect={'kind':'callback','request_id':str(uuid4()),'callback_at':CALLBACK['callback_at'],'operation_id':operation},p_arguments=CALLBACK)

def commit_sql(sid,rid,p):
    return f"SELECT collection_commit({quoted(sid)}::uuid,{quoted(rid)},{p['p_version']},{jsonsql(p['p_state'])},{jsonsql(p['p_result'])},{jsonsql(p['p_effect'])},{jsonsql(p['p_arguments'])},{quoted(p['p_user_turn_id'])})::text"

@pytest.mark.parametrize('failure_table', ['follow_up_requests','collection_operations','session_events'])
def test_atomic_rollback_on_business_receipt_or_audit_failure(failure_table):
    sid=seed();p=raw_payload(sid)
    suffix=uuid4().hex
    fn='fault_'+suffix;trigger='fault_'+suffix
    sql(f"CREATE FUNCTION public.{fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id={quoted(sid)}::uuid THEN RAISE EXCEPTION 'INJECTED_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON public.{failure_table} FOR EACH ROW EXECUTE FUNCTION public.{fn}();")
    try:
        with pytest.raises(RuntimeError, match='INJECTED_FAILURE'):sql(commit_sql(sid,'fault-request',p))
        assert all(count(t,sid)==0 for t in ['follow_up_requests','collection_operations','session_events'])
        assert int(sql(f"SELECT version FROM collection_sessions WHERE session_id={quoted(sid)}"))==0
    finally:
        sql(f"DROP TRIGGER {trigger} ON public.{failure_table}; DROP FUNCTION public.{fn}();")
    result=scalar(commit_sql(sid,'fault-request',p))
    assert result['result']['code']=='CALLBACK_REQUESTED'
    assert all(count(t,sid)==1 for t in ['follow_up_requests','collection_operations','session_events'])


def test_parallel_distinct_request_keys_with_stale_versions_conflict_not_duplicate():
    sid=seed();payloads=[raw_payload(sid) for _ in range(16)]
    statements=[commit_sql(sid,'independent-'+str(i),p) for i,p in enumerate(payloads)]
    with ThreadPoolExecutor(max_workers=16) as pool:results=list(pool.map(scalar,statements))
    assert sum('result' in r for r in results)==1
    assert sum(r.get('conflict') is True for r in results)==15
    assert count('follow_up_requests',sid)==count('collection_operations',sid)==1


def test_stale_version_no_receipt_and_same_key_retry_after_refresh():
    sid=seed();one=raw_payload(sid);two=raw_payload(sid)
    scalar(commit_sql(sid,'first',one))
    assert scalar(commit_sql(sid,'second',two))=={'conflict':True}
    assert count('collection_operations',sid)==1
    fresh=raw_payload(sid)
    scalar(commit_sql(sid,'second',fresh))
    assert count('collection_operations',sid)==count('follow_up_requests',sid)==2


def test_same_callback_payload_different_keys_can_represent_distinct_intent():
    sid=seed()
    scalar(commit_sql(sid,'intent-one',raw_payload(sid)))
    scalar(commit_sql(sid,'intent-two',raw_payload(sid)))
    assert count('follow_up_requests',sid)==count('collection_operations',sid)==2


def test_duplicate_event_id_rejected_across_sessions_same_source():
    first,second=seed(),seed();eid=str(uuid4())
    sql(f"INSERT INTO session_events(session_id,event_type,source,source_event_id) VALUES({quoted(first)},'trace.tts','agent_worker',{quoted(eid)})")
    with pytest.raises(RuntimeError,match='duplicate key'):
        sql(f"INSERT INTO session_events(session_id,event_type,source,source_event_id) VALUES({quoted(second)},'trace.tts','agent_worker',{quoted(eid)})")
    sql(f"INSERT INTO session_events(session_id,event_type,source,source_event_id) VALUES({quoted(second)},'trace.tts','platform',{quoted(eid)})")
    assert count('session_events',first)==count('session_events',second)==1


def test_null_source_event_ids_do_not_deduplicate():
    sid=seed()
    for _ in range(2):sql(f"INSERT INTO session_events(session_id,event_type,source) VALUES({quoted(sid)},'trace.tts','agent_worker')")
    assert count('session_events',sid)==2


def test_parallel_new_request_ids_same_proposal_then_refreshed_retry_rolls_back():
    sid=seed();proposal=str(uuid4())
    payloads=[raw_payload(sid) for _ in range(12)]
    for p in payloads:
        p['p_result']['tool_name']='create_payment_commitment'
        p['p_result']['code']='COMMITMENT_CREATED'
        p['p_effect']={'kind':'commitment','commitment_id':str(uuid4()),'proposal_id':proposal,
          'amount_cents':85000,'currency':'USD','payment_date':'2026-11-10',
          'confirmation_turn_id':'fixture-confirm','policy_version':'collection-demo-v1'}
    with ThreadPoolExecutor(max_workers=12) as pool:
        results=list(pool.map(lambda item:scalar(commit_sql(sid,'proposal-race-'+str(item[0]),item[1])),enumerate(payloads)))
    assert sum('result' in r for r in results)==1
    assert sum(r.get('conflict') is True for r in results)==11
    assert count('payment_commitments',sid)==count('collection_operations',sid)==1
    refreshed=raw_payload(sid)
    refreshed['p_effect']=payloads[0]['p_effect']|{'commitment_id':str(uuid4())}
    refreshed['p_result']=payloads[0]['p_result']
    with pytest.raises(RuntimeError,match='duplicate key'):
        sql(commit_sql(sid,'proposal-race-refreshed',refreshed))
    assert count('payment_commitments',sid)==count('collection_operations',sid)==count('session_events',sid)==1
    assert int(sql(f"SELECT version FROM collection_sessions WHERE session_id={quoted(sid)}"))==1


def test_same_key_concurrent_mismatched_payload_rejects_collisions():
    sid=seed();payloads=[raw_payload(sid) for _ in range(12)]
    for i,p in enumerate(payloads):
        p['p_arguments']={'callback_at':(datetime.now(timezone.utc)+timedelta(days=i+1)).isoformat()}
        p['p_effect']['callback_at']=p['p_arguments']['callback_at']
        p['p_effect']['operation_id']=p['p_user_turn_id']+':'+datetime.fromisoformat(p['p_arguments']['callback_at']).astimezone(timezone.utc).isoformat(timespec='microseconds')
        p['p_result']['data']={'marker':i}
    with ThreadPoolExecutor(max_workers=12) as pool:
        results=list(pool.map(lambda p:scalar(commit_sql(sid,'same-key-different-data',p)),payloads))
    winners=[r for r in results if r['result']['code']=='CALLBACK_REQUESTED']
    assert len(winners)==1
    assert sum(r['result']['code']=='IDEMPOTENCY_KEY_REUSED' for r in results)==11
    assert count('follow_up_requests',sid)==count('collection_operations',sid)==1
    marker=winners[0]['result']['data']['marker']
    stored=sql(f"SELECT callback_at::text FROM follow_up_requests WHERE session_id={quoted(sid)}")
    expected=sql(f"SELECT ({quoted(payloads[marker]['p_arguments']['callback_at'])}::timestamptz)::text")
    assert stored==expected

@pytest.mark.asyncio
async def test_committed_effect_unreachable_receipt_returns_unknown_then_recovers_same_key():
    sid=seed();db=ActualDatabase(sid);committed=False
    def handler(request):
        nonlocal committed
        if committed:raise httpx.ReadTimeout('all acknowledgments lost after committed effect')
        result=db.handle(request)
        if request.url.path.endswith('collection_commit'):
            committed=True
            raise httpx.ReadTimeout('first commit acknowledgment lost')
        return result
    b=AuditBackend(sid,'http://isolated','fixture',client=httpx.AsyncClient(base_url='http://isolated/',transport=httpx.MockTransport(handler)))
    try:
        unknown=await b.execute('request_callback',CALLBACK,'unknown-recovery')
        assert unknown['code']=='OUTCOME_UNKNOWN'
        assert count('follow_up_requests',sid)==count('collection_operations',sid)==1
        await b.close()
        b=db.backend()
        recovered=await b.execute('request_callback',CALLBACK,'unknown-recovery')
        assert recovered['code']=='CALLBACK_REQUESTED'
        assert db.commits==1
        assert count('follow_up_requests',sid)==count('collection_operations',sid)==1
    finally:await b.close()

@pytest.mark.asyncio
async def test_unavailable_before_write_has_no_receipt_or_effect():
    sid=seed()
    def handler(request):raise httpx.ConnectError('synthetic unavailable before snapshot')
    b=AuditBackend(sid,'http://isolated','fixture',client=httpx.AsyncClient(base_url='http://isolated/',transport=httpx.MockTransport(handler)))
    try:
        result=await b.execute('request_callback',CALLBACK,'never-written')
        assert result['code']=='SERVICE_UNAVAILABLE'
        assert count('follow_up_requests',sid)==count('collection_operations',sid)==0
    finally:await b.close()


def test_atomic_rollback_when_state_update_fails_after_callback_insert():
    sid=seed();p=raw_payload(sid);suffix=uuid4().hex;fn='fault_'+suffix
    sql(f"CREATE FUNCTION public.{fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.session_id={quoted(sid)}::uuid THEN RAISE EXCEPTION 'INJECTED_STATE_UPDATE_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER {fn} BEFORE UPDATE ON public.collection_sessions FOR EACH ROW EXECUTE FUNCTION public.{fn}();")
    try:
        with pytest.raises(RuntimeError,match='INJECTED_STATE_UPDATE_FAILURE'):
            sql(commit_sql(sid,'state-update-fault',p))
        assert all(count(t,sid)==0 for t in ['follow_up_requests','collection_operations','session_events'])
        assert int(sql(f"SELECT version FROM collection_sessions WHERE session_id={quoted(sid)}"))==0
    finally:sql(f"DROP TRIGGER {fn} ON public.collection_sessions; DROP FUNCTION public.{fn}();")
    assert scalar(commit_sql(sid,'state-update-fault',p))['result']['code']=='CALLBACK_REQUESTED'
    assert all(count(t,sid)==1 for t in ['follow_up_requests','collection_operations','session_events'])
