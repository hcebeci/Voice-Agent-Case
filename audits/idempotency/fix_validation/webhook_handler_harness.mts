import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(process.env.IDEMPOTENCY_TEST_DB_CONFIG!, 'utf8'));
const sql=(s:string)=>execFileSync(config.psql[0],[...config.psql.slice(1),'-A','-t','-c',s],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const q=(v:any)=>"'"+String(v).replaceAll("'","''")+"'";
const lit=(v:any)=>v===null?'NULL':typeof v==='object'?q(JSON.stringify(v))+'::jsonb':q(v);
const aid=crypto.randomUUID(),sid=crypto.randomUUID(),room='webhook-'+sid;
sql(`INSERT INTO agents(id,name,model) VALUES('${aid}','Webhook fixture','test'); INSERT INTO sessions(id,agent_id,room_name,source,status) VALUES('${sid}','${aid}','${room}','user_started','connecting');`);
const Deno={env:{get(){return 'fixture';}}};
class WebhookReceiver{constructor(..._args:any[]){} async receive(body:string){return JSON.parse(body);}}
let fault=process.argv[2];
class Query {
 table:string;op='select';data:any;filters:string[]=[];conflict=false;
 constructor(table:string){this.table=table;}
 select(..._args:any[]){return this;}
 insert(data:any){this.op='insert';this.data=data;return this;}
 upsert(data:any,_opts:any){this.op='insert';this.data=data;this.conflict=true;return this;}
 update(data:any){this.op='update';this.data=data;return this;}
 eq(k:string,v:any){this.filters.push(k+'='+lit(v));return this;}
 in(k:string,values:any[]){this.filters.push(k+' IN ('+values.map(lit).join(',')+')');return this;}
 async maybeSingle(){const r=this.execute();return {...r,data:r.data?.[0]??null};}
 then(resolve:any,reject:any){return Promise.resolve(this.execute()).then(resolve,reject);}
 execute(){
  const at=this.table==='session_events'&&this.op==='insert'?'append':this.table==='sessions'&&this.op==='update'?'lifecycle':this.table==='session_events'&&this.op==='update'?'materialized':this.table==='livekit_webhook_events'&&this.op==='update'&&this.data.processed_at?'processed':null;
  if(fault===at){fault='';return {data:null,error:{code:'fixture',message:'injected '+at}};}
  try{
   const where=this.filters.length?' WHERE '+this.filters.join(' AND '):'';
   let statement;
   if(this.op==='select')statement='SELECT * FROM '+this.table+where;
   else if(this.op==='insert')statement='INSERT INTO '+this.table+'('+Object.keys(this.data).join(',')+') VALUES('+Object.values(this.data).map(lit).join(',')+')'+(this.conflict?' ON CONFLICT(source,source_event_id) DO NOTHING':'')+' RETURNING *';
   else statement='UPDATE '+this.table+' SET '+Object.entries(this.data).map(([k,v])=>k+'='+lit(v)).join(',')+where+' RETURNING *';
   const wrapped=this.op==='select'?`SELECT coalesce(json_agg(t),'[]'::json) FROM (${statement}) t`:`WITH t AS (${statement}) SELECT coalesce(json_agg(t),'[]'::json) FROM t`;
   return {data:JSON.parse(sql(wrapped)),error:null};
  }catch(error:any){return {data:null,error:{code:String(error.stderr).includes('duplicate key')?'23505':'fixture',message:String(error.stderr)}};}
 }
}
const context={supabaseAdmin:{from:(table:string)=>new Query(table)}};
// HANDLER
const event={id:crypto.randomUUID(),event:'room_started',createdAt:Math.floor(Date.now()/1000),room:{name:room}};
const request=()=>new Request('https://fixture/functions/v1/livekit-webhook',{method:'POST',body:JSON.stringify(event)});
const mode=process.argv[2];
if(mode==='normal'){
 assert.equal((await processWebhook(request(),context)).status,200);
 const duplicate=await processWebhook(request(),context);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);
}else if(mode==='concurrent'){
 const results=await Promise.all(Array.from({length:8},()=>processWebhook(request(),context)));assert.ok(results.every(r=>r.status===200));
}else{
 assert.equal((await processWebhook(request(),context)).status,500);
 assert.equal(sql(`SELECT processed_at IS NULL FROM livekit_webhook_events WHERE event_id='${event.id}'`),'t');
 assert.equal((await processWebhook(request(),context)).status,200);
}
assert.equal(sql(`SELECT count(*) FROM livekit_webhook_events WHERE event_id='${event.id}'`),'1');
assert.equal(sql(`SELECT count(*) FROM session_events WHERE session_id='${sid}'`),'1');
assert.equal(sql(`SELECT status FROM sessions WHERE id='${sid}'`),'active');
assert.equal(sql(`SELECT processed_at IS NOT NULL AND processing_error IS NULL FROM livekit_webhook_events WHERE event_id='${event.id}'`),'t');
console.log('PASS '+mode);
