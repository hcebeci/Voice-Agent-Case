import os
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
sys.path.insert(0,str(Path(__file__).resolve().parents[3]/'Livekit-Agents'/'src'))
from collection_backend import CollectionBackend
from observability import ObservabilityClient,Observation

CFG=json.loads(Path(os.environ['IDEMPOTENCY_TEST_DB_CONFIG']).read_text())
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
