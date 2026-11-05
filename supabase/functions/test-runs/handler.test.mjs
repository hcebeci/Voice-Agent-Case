import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleTestRuns } from './handler.mjs'
import { encodeCursor, decodeCursor } from './validation.mjs'

const id = '60000000-0000-0000-0000-000000000001'
const sessionId = '60000000-0000-0000-0000-000000000002'
const agentId = '60000000-0000-0000-0000-000000000003'
const customerId = '60000000-0000-0000-0000-000000000004'
const owner = '60000000-0000-0000-0000-000000000005'
const manual = () => ({id,session_id:sessionId,execution_type:'manual_audio',scenario_id:'manual',scenario_name:'Manual audio',status:'passed',expected_outcome:{verified:true},notes:'reviewed'})
const automated = () => ({id,scenario_id:'automated',scenario_name:'Automated',execution_type:'automated_text',status:'passed',configuration_version:'v1',policy_version:'v1',configuration_snapshot:{},customer_snapshot:{is_test_record:true,date_of_birth:'1990-01-01',postal_code:'00000'},expected_outcome:{},actual_outcome:{},transcript:[]})
const post = body => new Request('http://local/test-runs',{method:'POST',body:JSON.stringify(body)})

function fixture({service=false, real=false}={}) {
  const rows = new Map(), calls=[]
  const savedSession = {id:sessionId,agent_id:agentId,status:'completed',started_at:'2026-11-05T00:00:00Z',ended_at:'2026-11-05T00:01:00Z',agent_configuration_snapshot:{model:'test'}}
  const tables = {
    sessions:[savedSession], collection_sessions:[{session_id:sessionId,customer_id:customerId}],
    customers:[{id:customerId,is_test_record:!real,date_of_birth:'1990-01-01',postal_code:'00000',policy_version:'v1'}],
    session_turns:[{session_id:sessionId,turn_number:1,user_transcript:'January first 1990, 00000',agent_transcript:'Verified.',total_latency_ms:100}],
    payment_commitments:[], follow_up_requests:[], collection_operations:[],
  }
  const client={from(table) {
    const query={filters:[], action:'select',values:null,
      select() {return this},eq(field,value) {this.filters.push([field,value]);return this},
      order(field,direction) {calls.push({table,order:field,direction});return this},
      limit(value) {this.maximum=value;calls.push({table,limit:value});return this},
      or(value) {calls.push({table,or:value});return this},
      insert(values) {this.action='insert';this.values=values;return this},
      single() {this.one=true;return this},maybeSingle() {this.one=true;return this},
      then(resolve,reject) {try {
        calls.push({table,action:this.action})
        if(this.action==='insert') {
          if(rows.has(this.values.id)) return Promise.resolve({error:{code:'23505'}}).then(resolve,reject)
          rows.set(this.values.id,{...structuredClone(this.values),created_at:'2026-11-05T01:00:00Z'})
          return Promise.resolve({error:null}).then(resolve,reject)
        }
        let data = table==='test_runs' ? [...rows.values()] : (tables[table]??[])
        data=data.filter(row=>this.filters.every(([field,value])=>row[field]===value))
        if(this.maximum) data=data.slice(0,this.maximum)
        return Promise.resolve({data:this.one?(data[0]??null):structuredClone(data),error:null}).then(resolve,reject)
      } catch(error) {return Promise.reject(error).then(resolve,reject)}},
    }
    return query
  }}
  return {rows,calls,tables,context:{authMode:service?'secret':'user',userClaims:{id:owner},supabase:client,supabaseAdmin:client}}
}

test('users cannot claim an automated execution type',async()=>{
  const f=fixture();const response=await handleTestRuns(post(automated()),f.context)
  assert.equal(response.status,403);assert.equal(f.rows.size,0);assert.equal(f.calls.length,0)
})

test('manual capture retains fictional identity data and replay returns immutable first capture',async()=>{
  const f=fixture();const body=manual()
  assert.equal((await handleTestRuns(post(body),f.context)).status,201)
  const saved=structuredClone(f.rows.get(id))
  assert.equal(saved.customer_snapshot.date_of_birth,'1990-01-01')
  assert.equal(saved.customer_snapshot.postal_code,'00000')
  assert.match(saved.transcript[0].content,/1990, 00000/)
  assert.equal(saved.provenance.verdict_source,'human')
  assert.equal(saved.created_by,owner)
  // Late telemetry must not create a conflict or replace retained evidence.
  f.tables.session_turns.push({session_id:sessionId,turn_number:2,agent_transcript:'Late transcript',total_latency_ms:900})
  f.tables.customers[0].postal_code='changed later'
  const before=f.calls.length
  const replay=await handleTestRuns(post(body),f.context)
  assert.equal(replay.status,200)
  const result=await replay.json()
  assert.equal(result.duplicate,true);assert.deepEqual(result.run,saved)
  assert.deepEqual(f.calls.slice(before).filter(call=>call.action).map(call=>call.table),['test_runs'])
  assert.deepEqual(f.rows.get(id),saved)
})

test('manual report ID rejects changed input or a different owner',async()=>{
  const f=fixture();const body=manual()
  await handleTestRuns(post(body),f.context)
  assert.equal((await handleTestRuns(post({...body,status:'failed'}),f.context)).status,409)
  const other={...f.context,userClaims:{id:customerId}}
  assert.equal((await handleTestRuns(post(body),other)).status,409)
  assert.equal(f.rows.get(id).status,'passed')
})

test('real customer manual captures are denied before retaining evidence',async()=>{
  const f=fixture({real:true});const response=await handleTestRuns(post(manual()),f.context)
  assert.equal(response.status,400);assert.match((await response.json()).error,/synthetic/)
  assert.equal(f.rows.size,0)
})

test('service exact duplicate succeeds; changed evidence with same ID conflicts',async()=>{
  const f=fixture({service:true}), body=automated()
  assert.equal((await handleTestRuns(post(body),f.context)).status,201)
  const duplicate=await handleTestRuns(post(body),f.context)
  assert.equal(duplicate.status,200)
  assert.deepEqual((await duplicate.json()).run,f.rows.get(id))
  assert.equal((await handleTestRuns(post({...body,status:'failed'}),f.context)).status,409)
  assert.equal(f.rows.get(id).status,'passed')
})

test('history uses bounded cursor paging and rejects malformed cursors',async()=>{
  const f=fixture()
  for(let i=1;i<=3;i++) f.rows.set(`row-${i}`,{id:`60000000-0000-0000-0000-00000000000${i}`,created_at:'2026-11-05T00:00:00Z'})
  const response=await handleTestRuns(new Request('http://local/test-runs?limit=2'),f.context)
  const page=await response.json()
  assert.equal(page.runs.length,2)
  assert.equal(decodeCursor(page.next_cursor).id,page.runs[1].id)
  assert.ok(f.calls.some(call=>call.limit===3))
  const cursor=encodeCursor(page.runs[1])
  assert.equal((await handleTestRuns(new Request(`http://local/test-runs?limit=2&cursor=${cursor}`),f.context)).status,200)
  assert.ok(f.calls.some(call=>call.or?.includes(`id.lt.${page.runs[1].id}`)))
  assert.equal((await handleTestRuns(new Request('http://local/test-runs?cursor=invalid'),f.context)).status,400)
})
