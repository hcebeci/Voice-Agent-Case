const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness({ microphoneFails = false } = {}) {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', hidden: true, disabled: false, textContent: '', innerHTML: '', dataset: {},
      classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
      querySelectorAll() { return []; }, replaceChildren() {}, appendChild() {} });
    return nodes.get(id);
  }
  let disconnected = false;
  const room = {
    on() {}, async connect() {}, async startAudio() {},
    async disconnect() { disconnected = true; },
    localParticipant: { async setMicrophoneEnabled() { if (microphoneFails) throw Error('Microphone denied'); } },
  };
  const context = vm.createContext({ console, Intl, Date, JSON, URL, setTimeout, clearTimeout,
    document: { querySelector: element, querySelectorAll() { return []; }, addEventListener() {} },
    sessionStorage: { setItem() {}, getItem() { return null; } },
    window: { location: { protocol: 'http:', hash: '' }, history: { replaceState() {} }, setInterval() {},
      LivekitClient: { Room: function () { return room; }, RoomEvent: {TrackSubscribed:'track',TrackUnsubscribed:'untrack',Disconnected:'disconnected'}, Track:{Kind:{Audio:'audio'}} } },
  });
  vm.runInContext(fs.readFileSync('ui/app.js','utf8') + '\nglobalThis.api={pageState,elements,startBrowserSession,renderTestCustomer,renderTestAgent};', context);
  const requests = [];
  context.record = (name, path, options) => {
    requests.push({name,path,options});
    return { session_id:'session-1',server_url:'wss://test',participant_token:'test-token' };
  };
  vm.runInContext('callWorkspaceApi=async (...args)=>record(...args);loadDashboard=async()=>{};',context);
  context.api.pageState.agents = [{id:'agent-1',name:'UI Agent',runtime_status:'sleeping'}];
  return {api:context.api,requests,disconnected:()=>disconnected};
}

test('test call sends selected agent, customer and direction', async () => {
  const { api, requests } = harness();
  await api.startBrowserSession('agent-1',{customer_id:'customer-1',call_direction:'agent_calls_user'});
  assert.deepEqual(JSON.parse(requests[0].options.body), {agent_id:'agent-1',source:'user_started',customer_id:'customer-1',call_direction:'agent_calls_user'});
  assert.match(api.elements.callAgentName.textContent,/agent will speak first/);
  assert.equal(api.pageState.liveSession.sessionId,'session-1');
});

test('user-initiated call prompts tester to speak first', async () => {
  const { api } = harness();
  await api.startBrowserSession('agent-1',{customer_id:'customer-1',call_direction:'user_calls_agent'});
  assert.match(api.elements.callAgentName.textContent,/You can speak first/);
});

test('microphone failure marks session failed and disconnects room', async () => {
  const { api, requests, disconnected } = harness({microphoneFails:true});
  await api.startBrowserSession('agent-1',{customer_id:'customer-1'});
  assert.equal(api.pageState.liveSession,null);
  assert.equal(api.pageState.callStarting,false);
  assert.equal(disconnected(),true);
  assert.ok(requests.some(r=>r.options?.body==='{"status":"failed"}'));
  assert.equal(api.elements.callStatus.textContent,'Failed');
});

test('customer fixture HTML is escaped', () => {
  const { api } = harness();
  api.pageState.testCustomers = [{id:'customer-1',full_name:'<img src=x onerror=alert(1)>',currency:'USD',balance_cents:200000,late_interest_cents:0}];
  api.elements.testCustomer.value='customer-1';
  api.renderTestCustomer();
  assert.ok(!api.elements.testCustomerDetails.innerHTML.includes('<img'));
  assert.match(api.elements.testCustomerDetails.innerHTML,/&lt;img/);
});

test('normal agent call works without a test customer', async () => {
  const { api, requests } = harness();
  await api.startBrowserSession('agent-1');
  assert.deepEqual(JSON.parse(requests[0].options.body), {agent_id:'agent-1',source:'user_started'});
  assert.equal(api.pageState.liveSession.sessionId,'session-1');
});
