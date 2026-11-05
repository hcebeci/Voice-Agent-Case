/** Real handler -> real PostgreSQL -> real session serializer.
 * Supabase's SDK transport is replaced by SQL, not table/state mocks. Signature/JWT
 * verification and browser rendering are separate checks, not claimed here.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { usageTokenTotals } from "../../supabase/functions/session-observability/usage.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const psql: string[] = JSON.parse(process.env.VALIDATION_PSQL!);
const q = (value: any): string => value == null ? "null" : typeof value === "number" || typeof value === "boolean" ? String(value) : "'" + (typeof value === "object" ? JSON.stringify(value) : String(value)).replaceAll("'", "''") + "'";
const ident = (name: string) => { assert.match(name, /^[a-z_][a-z_0-9]*$/); return '"'+name+'"'; };
function sql(statement: string) {
  return execFileSync(psql[0], [...psql.slice(1), "--set", "VERBOSITY=verbose", "-A", "-t", "-c", statement], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
class Query {
  table: string; mode = "select"; values: any; filters: string[] = []; ordering: string[] = []; cap: number | null = null; one = false; conflict = "";
  constructor(table: string) { this.table = ident(table); }
  select(..._args: any[]) { return this; }
  eq(key: string, value: any) { this.filters.push(`${ident(key)}=${q(value)}`); return this; }
  neq(key: string, value: any) { this.filters.push(`${ident(key)}<>${q(value)}`); return this; }
  order(key: string, options: any = {}) { this.ordering.push(ident(key)+(options.ascending === false ? " desc" : " asc")); return this; }
  limit(n: number) { this.cap=n; return this; }
  maybeSingle() { this.one=true; return this; }
  single() { this.one=true; return this; }
  insert(values: any) { this.mode="insert"; this.values=values; return this; }
  upsert(values: any, options: any) { this.mode="upsert"; this.values=values; this.conflict=options.onConflict; return this; }
  update(values: any) { this.mode="update"; this.values=values; return this; }
  async then(resolvePromise: any, reject: any) {
    try {
      const where=this.filters.length ? " where "+this.filters.join(" and ") : "";
      let statement: string;
      if(this.mode === "select") {
        statement=`select * from ${this.table}${where}${this.ordering.length ? " order by "+this.ordering.join(",") : ""}${this.cap === null ? "" : " limit "+this.cap}`;
      } else if(this.mode === "update") {
        statement=`update ${this.table} set `+Object.entries(this.values).map(([key,v])=>ident(key)+"="+q(v)).join(",")+where+" returning *";
      } else {
        const entries=Object.entries(this.values).filter(([,v])=>v !== undefined);
        statement=`insert into ${this.table} (${entries.map(([key])=>ident(key)).join(",")}) values (${entries.map(([,v])=>q(v)).join(",")})`;
        if(this.mode === "upsert") statement+=" on conflict ("+this.conflict.split(",").map(ident).join(",")+") do update set "+entries.filter(([key])=>!this.conflict.split(",").includes(key)).map(([key])=>ident(key)+"=excluded."+ident(key)).join(",");
        statement+=" returning *";
      }
      const rows=JSON.parse(sql(`with data as (${statement}) select coalesce(json_agg(data),'[]'::json) from data`));
      return resolvePromise({data:this.one ? rows[0]??null : rows,error:null});
    } catch(error: any) { return resolvePromise({data:null,error:{message:error.stderr?.toString()??error.message,code:/23505/.test(error.stderr?.toString())?"23505":"TEST_SQL_ERROR"}}); }
  }
}
const db = {
  from(table: string) { return new Query(table); },
  async rpc(name: string, values: any) {
    try {
      const args=Object.entries(values).map(([key,value])=>ident(key)+" => "+q(value)).join(",");
      const result=sql(`select to_json(public.${ident(name)}(${args}))::text`);
      return {data:result ? JSON.parse(result) : null,error:null};
    } catch(error:any) { return {data:null,error:{message:error.stderr?.toString()??error.message}}; }
  },
};
const source=readFileSync(resolve(root,"supabase/functions/session-observability/index.ts"),"utf8");
const body=source.slice(source.indexOf("type ObservabilityEvent"),source.indexOf("export default"));
const {parseEvent, processEvent}=new Function("usageTokenTotals",stripTypeScriptTypes(body)+"\nreturn {parseEvent,processEvent}")(usageTokenTotals);
// Exercise the production Request/Response handler too. Only the external auth
// adapter is injected; JWT verification itself is deliberately not simulated.
const endpointBody=stripTypeScriptTypes(source.slice(source.indexOf("type ObservabilityEvent"))).replace("export default", "return");
const endpoint=new Function("withSupabase","usageTokenTotals",endpointBody)(
  (_options:any,handler:any)=>(request:Request)=>handler(request,{supabaseAdmin:db}),usageTokenTotals);
const sessionSource=readFileSync(resolve(root,"supabase/functions/sessions/index.ts"),"utf8");
const sessionBody=sessionSource.slice(sessionSource.indexOf("/** Calculate a percentile"),sessionSource.indexOf("/** Return the session history"));
const {loadSessionDetails}=new Function(stripTypeScriptTypes(sessionBody)+"\nreturn {loadSessionDetails}")();
const aid=crypto.randomUUID(), sid=crypto.randomUUID();
sql(`insert into agents(id,name,model) values(${q(aid)},'Observability integration','synthetic'); insert into sessions(id,agent_id,room_name,source,status) values(${q(sid)},${q(aid)},${q('integration-'+sid)},'user_started','completed')`);
let sequence=0;
const event=(type:string,at:string,payload:any={},turn=1)=>({event_id:crypto.randomUUID(),session_id:sid,event_type:type,occurred_at:at,turn_number:turn,sequence_number:++sequence,payload});
async function deliver(value:any) {
  const response=await endpoint.fetch(new Request("http://isolated.invalid/session-observability",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)}));
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  return result.duplicate;
}
assert.equal((await endpoint.fetch(new Request("http://isolated.invalid/session-observability"))).status,405);
assert.equal((await endpoint.fetch(new Request("http://isolated.invalid/session-observability",{method:"POST",body:"broken"}))).status,400);
const audio=event("turn.agent_audio_started","2026-11-05T10:00:01.200Z");
const stopped=event("turn.user_speech_stopped","2026-11-05T10:00:00.000Z");
await deliver(audio); await deliver(stopped);
let details=await (await loadSessionDetails(db,sid)).json();
assert.equal(details.turns[0].total_latency_ms,1200,"reverse arrival must yield complete latency");
await deliver(stopped); await deliver(audio);
assert.equal(Number(sql(`select count(*) from session_events where session_id=${q(sid)}`)),2,"duplicate delivery is one logical event");
const latest=event("turn.transcript_completed","2026-11-05T10:00:02Z",{transcript:"My birthday is April 12, 1988; postal code 34000."});
await deliver(latest);
await deliver(event("turn.transcript_completed","2026-11-05T10:00:00Z",{transcript:"stale transcript"}));
details=await (await loadSessionDetails(db,sid)).json();
assert.match(details.turns[0].user_transcript,/34000/);
assert.match(details.turns[0].user_transcript,/1988/);
const trace=event("trace.llm","2026-11-05T10:00:02Z",{started_at:"2026-11-05T10:00:02Z",ended_at:"2026-11-05T10:00:02.800Z",duration_ms:800,status:"completed"});
await deliver(trace); await deliver(trace);
details=await (await loadSessionDetails(db,sid)).json();
assert.equal(details.traces.length,1); assert.equal(details.traces[0].duration_ms,800);
const retry=event("turn.response_ready","2026-11-05T10:00:03Z",{transcript:"Please verify your identity."});
let fail=true;
const brokenDb={...db,async rpc(name:string,args:any) { if(fail){fail=false;return {data:null,error:{message:"injected temporary outage"}};} return db.rpc(name,args); }};
await assert.rejects(()=>processEvent(brokenDb,parseEvent(retry)),/injected temporary outage/);
assert.equal(sql(`select processed_at is null from session_events where source_event_id=${q(retry.event_id)}`),"t");
await deliver(retry);
assert.equal(sql(`select processed_at is not null from session_events where source_event_id=${q(retry.event_id)}`),"t");
details=await (await loadSessionDetails(db,sid)).json();
assert.equal(details.turns[0].agent_transcript,"Please verify your identity.");
await deliver(event("session.usage","2026-11-05T10:00:05Z",{usage:{model_usage:[{type:"llm_usage",input_tokens:100,output_tokens:50}]}}));
await deliver(event("session.usage","2026-11-05T10:00:04Z",{usage:{model_usage:[{type:"llm_usage",input_tokens:20,output_tokens:10}]}}));
details=await (await loadSessionDetails(db,sid)).json();
assert.equal(details.metrics.total_input_tokens,100,"older cumulative usage must not replace newer totals");
assert.equal(details.metrics.total_output_tokens,50);

const toolStart=event("tool.started","2026-11-05T10:00:06Z",{tool_call_id:"reversed-tool",tool_name:"evaluate_offer",arguments:{amount:25}});
const toolEnd=event("tool.succeeded","2026-11-05T10:00:07Z",{tool_call_id:"reversed-tool",tool_name:"evaluate_offer",result:{accepted:true},duration_ms:1000});
await deliver(toolEnd); await deliver(toolStart); await deliver(toolEnd);
let savedTool=JSON.parse(sql(`select row_to_json(t) from tool_calls t where source_event_id=${q(sid+":reversed-tool")}`));
assert.equal(savedTool.status,"succeeded");
assert.deepEqual(savedTool.arguments,{amount:25});
assert.equal(sql(`select status from session_traces where id=${q(savedTool.trace_id)}`),"completed");

// Two real PostgreSQL connections: hold the terminal projection uncommitted,
// prove the late start waits on its lock, then release it and inspect both rows.
const concurrentStart=event("tool.started","2026-11-05T10:00:08Z",{tool_call_id:"concurrent-tool",tool_name:"evaluate_offer",arguments:{amount:40}});
const concurrentEnd=event("tool.succeeded","2026-11-05T10:00:09Z",{tool_call_id:"concurrent-tool",tool_name:"evaluate_offer",result:{accepted:true},duration_ms:1000});
const holder=spawn(psql[0],[...psql.slice(1),"-q","-A","-t"],{stdio:["pipe","pipe","pipe"]});
let heldOutput="", heldError="";
holder.stderr.on("data",chunk=>{heldError+=chunk;});
const held=new Promise<void>((resolveHeld,rejectHeld)=>{
  holder.stdout.on("data",chunk=>{heldOutput+=chunk;if(heldOutput.includes("TOOL_LOCK_HELD"))resolveHeld();});
  holder.on("error",rejectHeld);
  holder.on("exit",code=>{if(!heldOutput.includes("TOOL_LOCK_HELD"))rejectHeld(new Error(heldError||`Lock holder exited ${code}`));});
});
const exited=new Promise<void>((resolveExit,rejectExit)=>holder.on("exit",code=>code===0?resolveExit():rejectExit(new Error(heldError))));
holder.stdin.write(`begin; select public.observe_tool_event(${q(concurrentEnd)}::jsonb);\n\\echo TOOL_LOCK_HELD\n`);
try {
  await held;
  const applicationName="tool-race-"+crypto.randomUUID();
  const waiting=new Promise<void>((resolveWait,rejectWait)=>{
    execFile(psql[0],[...psql.slice(1),"-A","-t","-c",`select public.observe_tool_event(${q(concurrentStart)}::jsonb)`],
      {env:{...process.env,PGAPPNAME:applicationName}},(error)=>error?rejectWait(error):resolveWait());
  });
  let blocked=false;
  for(let attempt=0;attempt<100;attempt++) {
    blocked=sql(`select exists(select 1 from pg_stat_activity where application_name=${q(applicationName)} and wait_event_type='Lock')`)==="t";
    if(blocked)break;
    await new Promise(resolveWait=>setTimeout(resolveWait,10));
  }
  assert.equal(blocked,true,"Concurrent start must wait for the terminal transaction");
  holder.stdin.end("commit;\n");
  await Promise.all([exited,waiting]);
} finally {
  if(!holder.stdin.writableEnded)holder.stdin.end("rollback;\n");
}
savedTool=JSON.parse(sql(`select row_to_json(t) from tool_calls t where source_event_id=${q(sid+":concurrent-tool")}`));
assert.equal(savedTool.status,"succeeded");
assert.deepEqual(savedTool.arguments,{amount:40});
const savedSpan=JSON.parse(sql(`select row_to_json(t) from session_traces t where id=${q(savedTool.trace_id)}`));
assert.equal(savedSpan.status,"completed");
assert.ok(savedSpan.ended_at);
assert.equal(savedSpan.sequence_number,savedTool.sequence_number);
console.log("PASS real tool projection: terminal-before-start, retry, concurrent connections serialize both tool and trace");
console.log("PASS real observability handler -> PostgreSQL -> session serializer: reverse arrival, stale revisions, duplicate events/traces, recoverable outage, uncensored synthetic transcript");
