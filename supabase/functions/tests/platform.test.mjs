import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Execute actual handler code with injected SDK boundary, not copied business logic.
// Credential verification and Postgres privileges are separate integration checks.
async function loadHandler(name, context) {
  let source = await readFile(new URL(`../${name}/index.ts`, import.meta.url), 'utf8');
  source = source.replace(/import \{ withSupabase \} from "npm:@supabase\/server"/, 'const withSupabase = (_options, handler) => request => handler(request, globalThis.__platformTestContext)');
  source = source.replace(/import \{ AccessToken, AgentDispatchClient, RoomServiceClient \} from "npm:livekit-server-sdk"/, 'const AccessToken = class {}; const AgentDispatchClient = class {}; const RoomServiceClient = class {}');
  source = source.replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) => `from "${new URL(`../${name}/${path}`, import.meta.url).href}"`);
  globalThis.__platformTestContext = context;
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  return (await import(`data:text/javascript;base64,${Buffer.from(stripped).toString('base64')}#${name}-${Math.random()}`)).default.fetch;
}

function readOnlyClient() {
  return { from() { return {
    select() { return this; }, in() { return this; }, gte() { return this; }, lt() { return this; },
    order() { return this; }, limit() { return this; },
    then(resolve) { return Promise.resolve({data: [], error: null}).then(resolve); },
    update() { throw new Error('Dashboard attempted mutation'); },
  }; } };
}

test('dashboard GET reads data without mutating a long-running call', async () => {
  const fetch = await loadHandler('dashboard', {supabase: readOnlyClient()});
  const response = await fetch(new Request('http://local/dashboard'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).metrics.active_session_count, 0);
});

test('browser rejects active/connecting and delegates close with verified owner', async () => {
  const calls = [];
  const fetch = await loadHandler('livekit-session', {
    userClaims: {id: 'verified-user'},
    supabase: {from() {throw new Error('Unrestricted browser database write');}},
    supabaseAdmin: {async rpc(name, parameters) {
      calls.push({name, parameters});
      return {data: {session: {id: 'session', status: parameters.p_status}}, error: null};
    }},
  });
  const request = status => new Request('http://local/livekit-session?id=session', {method: 'PATCH', body: JSON.stringify({status, user_id: 'forged-user'})});
  assert.equal((await fetch(request('active'))).status, 400);
  assert.equal((await fetch(request('connecting'))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(request('completed'))).status, 200);
  assert.deepEqual(calls, [{name: 'close_browser_session', parameters: {p_user_id: 'verified-user', p_session_id: 'session', p_status: 'completed'}}]);
});

test('agent editor sends configuration and assignments in one RPC', async () => {
  const calls = [];
  const fetch = await loadHandler('agents', {
    supabase: { async rpc(name, parameters) {calls.push({name, parameters});return {data: {id: 'saved'}, error: null};},
      from() {throw new Error('Split configuration save attempted');}},
  });
  const response = await fetch(new Request('http://local/agents?id=agent', {
    method: 'PATCH', body: JSON.stringify({name: 'saved', assignments: [], created_by: 'forged'}),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{name: 'save_agent', parameters: {p_agent_id: 'agent', p_fields: {name: 'saved'}, p_assignments: []}}]);
});

test('session start delegates coherent snapshot to reservation without Edge prefetch', async () => {
  const calls=[];
  const previousDeno=globalThis.Deno;
  globalThis.Deno={env:{get:()=> 'configured-test-value'}};
  try {
    const fetch=await loadHandler('livekit-session', {
      userClaims:{id:'verified-user'},
      supabase:{from(){throw new Error('Non-atomic Edge configuration prefetch');}},
      supabaseAdmin:{async rpc(name,parameters){calls.push({name,parameters});return {data:{code:'AGENT_OFFLINE'},error:null};}},
    });
    const response=await fetch(new Request('http://local/livekit-session',{
      method:'POST',headers:{'Idempotency-Key':'consistent-snapshot'},
      body:JSON.stringify({agent_id:'70000000-0000-0000-0000-000000000002',call_direction:'user_calls_agent'}),
    }));
    assert.equal(response.status,409);
    assert.equal(calls[0].name,'session_start_reserve');
    assert.deepEqual(calls[0].parameters.p_snapshot,{});
    assert.equal(calls[0].parameters.p_payload.agent_id,'70000000-0000-0000-0000-000000000002');
  } finally {globalThis.Deno=previousDeno;}
});
