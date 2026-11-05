import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(process.env.IDEMPOTENCY_TEST_DB_CONFIG!, 'utf8'));
const sql=(statement:string)=>execFileSync(config.psql[0],[...config.psql.slice(1),'-A','-t','-c',statement],{encoding:'utf8'}).trim();
const quote=(v:any)=>"'"+String(v).replaceAll("'","''")+"'";
const literal=(v:any)=>v===null?'NULL':typeof v==='boolean'?String(v):typeof v==='object'?quote(JSON.stringify(v))+'::jsonb':quote(v);
const aid=crypto.randomUUID(),uid=crypto.randomUUID(),cid=crypto.randomUUID();
sql(`INSERT INTO auth.users(id) VALUES('${uid}'); INSERT INTO agents(id,name,model) VALUES('${aid}','Handler fixture','test'); INSERT INTO customers(id,full_name,date_of_birth,postal_code,account_reference,balance_cents,payment_due_date,is_test_record) VALUES('${cid}','Handler fixture','1988-04-12','34000','${cid}',200000,'2026-10-01',true);`);
const agent={id:aid,name:'Handler fixture',instructions:'Hello.',model:'test',language:'tr'};
const Deno={env:{get(name:string){return name==='LIVEKIT_URL'?'wss://fixture':'fixture';}}};
let attempts=0,rooms=0,loseDispatchAck=false,dropDispatch=false,loseReadyAck=false,failRoom=false;
const dispatched=new Map<string,any[]>();
class AccessToken {constructor(..._args:any[]){} addGrant(..._args:any[]){} async toJwt(){return 'fixture-token';}}
class RoomServiceClient {constructor(..._args:any[]){} async createRoom(){rooms++;if(failRoom){failRoom=false;throw Error('room ACK lost');}}}
class AgentDispatchClient {
 constructor(..._args:any[]){}
 async createDispatch(room:string,name:string,options:any){
  attempts++;
  if(!dropDispatch) dispatched.set(room,[{agentName:name,metadata:options.metadata}]);
  if(loseDispatchAck||dropDispatch)throw Error('dispatch ACK lost');
 }
 async listDispatch(room:string){return dispatched.get(room)??[];}
}
const context={
 userClaims:{id:uid},
 supabase:{from(table:string){
  if(table==='agents')return {select:()=>({eq:()=>({single:async()=>({data:agent,error:null})})})};
  if(table==='agent_tools')return {select:()=>({eq:async()=>({data:[],error:null})})};
  throw Error('Unexpected user table '+table);
 }},
 supabaseAdmin:{
  from(table:string){
   if(table==='customers')return {select:()=>({eq:()=>({maybeSingle:async()=>({data:{id:cid},error:null})})})};
   throw Error('Unexpected admin table '+table);
  },
  async rpc(name:string,body:any){
   const args=Object.entries(body).map(([key,value])=>key+' => '+literal(value)).join(',');
   const data=JSON.parse(sql(`SELECT public.${name}(${args})::text`));
   if(name==='session_start_dispatch'&&body.p_ready&&loseReadyAck){loseReadyAck=false;return {data:null,error:{message:'lost ready ACK'}};}
   return {data,error:null};
  }
 }
};
// HANDLER
const request=(key='fixture-attempt',direction='agent_calls_user')=>new Request('https://fixture/functions/v1/livekit-session',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({agent_id:aid,customer_id:cid,call_direction:direction})});
const count=(table:string)=>Number(sql(`SELECT count(*) FROM ${table} WHERE ${table==='sessions'?'agent_id':'session_id'} ${table==='sessions'?`='${aid}'`:`IN (SELECT id FROM sessions WHERE agent_id='${aid}')`}`));
const scenario=process.argv[2];
if(scenario==='replay'){
 const one=await createBrowserSession(request(),context),two=await createBrowserSession(request(),context);
 assert.equal(one.status,200);assert.equal(two.status,200);
 assert.equal((await one.json()).session_id,(await two.json()).session_id);
 assert.equal(attempts,1);assert.equal(count('sessions'),1);assert.equal(count('collection_sessions'),1);
}else if(scenario==='concurrent'){
 const responses=await Promise.all(Array.from({length:12},()=>createBrowserSession(request(),context)));
 assert.ok(responses.every(r=>[200,202].includes(r.status)));
 const ids=await Promise.all(responses.map(async r=>(await r.json()).session_id));assert.equal(new Set(ids).size,1);
 assert.equal(attempts,1);assert.equal(count('sessions'),1);
}else if(scenario==='mismatch'){
 assert.equal((await createBrowserSession(request(),context)).status,200);
 const changed=await createBrowserSession(request('fixture-attempt','user_calls_agent'),context);
 assert.equal(changed.status,409);assert.equal((await changed.json()).code,'IDEMPOTENCY_KEY_REUSED');assert.equal(attempts,1);
}else if(scenario==='dispatch-lost-ack'){
 loseDispatchAck=true;
 assert.equal((await createBrowserSession(request(),context)).status,200);
 assert.equal((await createBrowserSession(request(),context)).status,200);assert.equal(attempts,1);
}else if(scenario==='dispatch-unknown'){
 dropDispatch=true;
 for(let i=0;i<3;i++){const r=await createBrowserSession(request(),context);assert.equal(r.status,202);assert.equal((await r.json()).code,'SESSION_START_PENDING');}
 assert.equal(attempts,1);assert.equal(count('sessions'),1);
}else if(scenario==='ready-lost-ack'){
 loseReadyAck=true;
 assert.equal((await createBrowserSession(request(),context)).status,200);
 assert.equal((await createBrowserSession(request(),context)).status,200);assert.equal(attempts,1);
}else if(scenario==='room-lost-ack'){
 failRoom=true;
 assert.equal((await createBrowserSession(request(),context)).status,202);
 assert.equal((await createBrowserSession(request(),context)).status,200);assert.equal(attempts,1);assert.equal(count('sessions'),1);
}else if(scenario==='closed'){
 const first=await createBrowserSession(request(),context);const id=(await first.json()).session_id;
 sql(`UPDATE sessions SET status='completed' WHERE id='${id}'`);
 const retry=await createBrowserSession(request(),context);assert.equal(retry.status,409);assert.equal((await retry.json()).code,'SESSION_CLOSED');assert.equal(attempts,1);
}else if(scenario==='missing-key'){
 assert.equal((await createBrowserSession(request(''),context)).status,400);assert.equal(count('sessions'),0);assert.equal(attempts,0);
}else throw Error('Unknown scenario');
console.log('PASS '+scenario);
