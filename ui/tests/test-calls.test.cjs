const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness({ microphoneFails = false, textStreams = true, createResponses = [], storage = new Map() } = {}) {
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', hidden: true, disabled: false, textContent: '', innerHTML: '', dataset: {},
      focus() {}, reset() {}, classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
      querySelectorAll() { return []; }, querySelector() { return null; }, replaceChildren() {}, appendChild() {} });
    return nodes.get(id);
  }
  let disconnected = false;
  const handlers = new Map();
  let streamHandler;
  const room = {
    on(name, callback) { handlers.set(name, callback); },
    registerTextStreamHandler(topic, callback) { assert.equal(topic,'lk.transcription'); streamHandler=callback; },
    async connect() { if (textStreams) assert.ok(streamHandler, 'transcription must be registered before connection'); }, async startAudio() {},
    async disconnect() { disconnected = true; },
    localParticipant: { identity:'tester', async setMicrophoneEnabled() { if (microphoneFails) throw Error('Microphone denied'); } },
  };
  if (!textStreams) delete room.registerTextStreamHandler;
  const context = vm.createContext({ console, Intl, Date, JSON, URL, URLSearchParams, setTimeout, clearTimeout, crypto: require("node:crypto").webcrypto, crypto: require("node:crypto").webcrypto,
    document: { querySelector: element, querySelectorAll() { return []; }, addEventListener() {} },
    sessionStorage: { setItem(key,value) {storage.set(key,value);}, getItem(key) { return storage.get(key) ?? null; }, removeItem(key) {storage.delete(key);} },
    window: { location: { protocol: 'http:', hash: '' }, history: { replaceState() {} }, setInterval() {},
      LivekitClient: { Room: function () { return room; }, RoomEvent: {TrackSubscribed:'track',TrackUnsubscribed:'untrack',Disconnected:'disconnected',TranscriptionReceived:'transcription'}, Track:{Kind:{Audio:'audio'}} } },
  });
  vm.runInContext(fs.readFileSync('ui/app.js','utf8') + '\nglobalThis.api={pageState,elements,startBrowserSession,finishBrowserSession,receiveCallText,renderTestCustomer,renderTestAgent,signOut,showAuthentication,saveAgent,loadAllSessions,loadSessionDetails,loadValidationHistory,loadValidationDetail,recordAudioValidation,openEditModal};', context);
  const requests = [];
  context.record = (name, path, options) => {
    requests.push({name,path,options});
    if (options?.method === 'POST' && createResponses.length) {
      const response = createResponses.shift();
      if (response instanceof Error) throw response;
      return response;
    }
    return { session_id:'session-1',server_url:'wss://test',participant_token:'test-token' };
  };
  vm.runInContext('callWorkspaceApi=async (...args)=>record(...args);loadDashboard=async()=>{};loadAgents=async()=>{};',context);
  context.api.pageState.agents = [{id:'agent-1',name:'UI Agent',runtime_status:'sleeping'}];
  return {context,api:context.api,requests,handlers,room,stream:()=>streamHandler,disconnected:()=>disconnected};
}

function reader(id, chunks, { final = false, fails = false, finalOnClose = false } = {}) {
  return {
    info: {id,attributes:{'lk.segment_id':id,'lk.transcription_final':String(final)}},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      if (fails) throw Error('stream disconnected');
      if (finalOnClose) this.info.attributes['lk.transcription_final']='true';
    },
  };
}

async function text(api, id, chunks, options = {}, identity = 'tester') {
  await api.receiveCallText(api.pageState.callTranscript,reader(id,chunks,options),{identity});
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

test('stream registration receives the greeting before database transcript reads', async () => {
  const {api,stream,requests}=harness();
  await api.startBrowserSession('agent-1');
  assert.equal(typeof stream(),'function');
  await text(api,'greeting',['Hello ','there.'],{finalOnClose:true},'agent');
  assert.match(api.elements.callTranscript.innerHTML,/Turn 1 · Agent/);
  assert.match(api.elements.callTranscript.innerHTML,/Hello there\./);
  assert.equal(requests.filter(r=>r.name==='sessions').length,0);
});

test('interim recognition revisions replace words instead of duplicating turns', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  await text(api,'U1',['I can pay fifteen']);
  assert.match(api.elements.callTranscript.innerHTML,/Recognizing/);
  await text(api,'U1',['I can pay fifty']);
  await text(api,'U1',['I can pay fifty dollars.'],{final:true});
  assert.equal(api.pageState.callTranscript.messages.size,1);
  assert.doesNotMatch(api.elements.callTranscript.innerHTML,/fifteen|Recognizing/);
  assert.match(api.elements.callTranscript.innerHTML,/fifty dollars/);
});

test('live chunks appear before stream completion and final trailer is honored', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  const input=reader('A1',[],{finalOnClose:true});
  input[Symbol.asyncIterator]=async function* () {
    yield 'First words';
    assert.match(api.elements.callTranscript.innerHTML,/First words/);
    yield ' still speaking';
    this.info.attributes['lk.transcription_final']='true';
  };
  await api.receiveCallText(api.pageState.callTranscript,input,{identity:'agent'});
  assert.match(api.elements.callTranscript.innerHTML,/First words still speaking/);
  assert.doesNotMatch(api.elements.callTranscript.innerHTML,/Speaking…/);
});

test('late interim stream cannot overwrite a final correction', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  const input=reader('U1',[]);
  input[Symbol.asyncIterator]=async function* () {
    yield 'fifteen';
    await text(api,'U1',['fifty'],{final:true});
    yield ' wrong late words';
  };
  await api.receiveCallText(api.pageState.callTranscript,input,{identity:'tester'});
  await text(api,'U1',['older hypothesis']);
  assert.match(api.elements.callTranscript.innerHTML,/fifty/);
  assert.doesNotMatch(api.elements.callTranscript.innerHTML,/fifteen|older hypothesis|wrong late words/);
});

test('partial final stream supersedes older interim streams before it closes', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  const input=reader('U1',[],{final:true});
  input[Symbol.asyncIterator]=async function* () {
    yield 'correct';
    await text(api,'U1',['stale interim']);
    yield ' final';
  };
  await api.receiveCallText(api.pageState.callTranscript,input,{identity:'tester'});
  assert.match(api.elements.callTranscript.innerHTML,/correct final/);
  assert.doesNotMatch(api.elements.callTranscript.innerHTML,/stale interim/);
});

test('speaker changes create turns and delayed text stays in its original position', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  await text(api,'U1',['first user words']);
  await text(api,'U2',['more user words'],{final:true});
  await text(api,'A1',['agent response'],{final:true},'agent');
  await text(api,'U3',['interruption'],{final:true});
  await text(api,'U1',['corrected first words'],{final:true});
  const html=api.elements.callTranscript.innerHTML;
  assert.equal((html.match(/class="call-turn/g)||[]).length,3);
  assert.ok(html.indexOf('corrected first words')<html.indexOf('agent response'));
  assert.match(html,/more user words/);
  assert.match(html,/Turn 3 · You/);
});

test('legacy captions work when text streams are unavailable', async () => {
  const {api,handlers}=harness({textStreams:false});
  await api.startBrowserSession('agent-1');
  handlers.get('transcription')([{id:'U1',text:'legacy',final:false}],{identity:'tester'});
  handlers.get('transcription')([{id:'U1',text:'final legacy',final:true}],{identity:'tester'});
  assert.equal(api.pageState.callTranscript.messages.size,1);
  assert.match(api.elements.callTranscript.innerHTML,/final legacy/);
});

test('dual-published captions with different legacy and stream IDs render once', async () => {
  const {api,handlers}=harness();
  await api.startBrowserSession('agent-1');
  for (const identity of ['tester','agent']) {
    const legacy=handlers.get('transcription');
    legacy?.([{id:`legacy-${identity}`,text:'Gün ve ay.',final:false}],{identity});
    await text(api,`stream-${identity}`,['Gün ve ay.'],{final:true},identity);
    legacy?.([{id:`legacy-${identity}`,text:'Gün ve ay.',final:true}],{identity});
  }
  assert.equal(api.pageState.callTranscript.messages.size,2,'one message per speaker, not one per transport');
  assert.equal((api.elements.callTranscript.innerHTML.match(/Gün ve ay\./g)||[]).length,2);
});

test('genuinely repeated utterances with distinct stream IDs are retained', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  await text(api,'U1',['Gün ve ay.'],{final:true});
  await text(api,'U2',['Gün ve ay.'],{final:true});
  assert.equal(api.pageState.callTranscript.messages.size,2);
  assert.equal((api.elements.callTranscript.innerHTML.match(/Gün ve ay\./g)||[]).length,2);
});

test('stream error preserves received words and marks transcript partial', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  await text(api,'U1',['<script>partial words</script>'],{fails:true});
  assert.match(api.elements.callTranscript.innerHTML,/Partial transcript/);
  assert.match(api.elements.callTranscript.innerHTML,/&lt;script&gt;/);
  assert.doesNotMatch(api.elements.callTranscript.innerHTML,/<script>/);
  assert.match(api.elements.callError.textContent,/some words may be missing/);
});

test('failed final stream with no chunks preserves the preceding interim words', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  await text(api,'U1',['words already received']);
  await text(api,'U1',[],{final:true,fails:true});
  assert.match(api.elements.callTranscript.innerHTML,/words already received/);
  assert.match(api.elements.callTranscript.innerHTML,/Partial transcript/);
});

test('ending a call preserves transcript and allows closing it afterward', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  await text(api,'U1',['words to retain']);
  await api.finishBrowserSession();
  assert.equal(api.elements.callModal.hidden,false);
  assert.equal(api.elements.endCallButton.textContent,'Close');
  assert.match(api.elements.callTranscript.innerHTML,/words to retain/);
  assert.match(api.elements.callTranscript.innerHTML,/Partial transcript/);
  assert.equal(api.elements.callSessionLink.hidden,false);
  await api.finishBrowserSession();
  assert.equal(api.elements.callModal.hidden,true);
});

test('new calls clear old transcript and ignore old in-flight streams', async () => {
  const {api}=harness();
  await api.startBrowserSession('agent-1');
  const oldCapture=api.pageState.callTranscript;
  await api.finishBrowserSession();
  await api.startBrowserSession('agent-1');
  await api.receiveCallText(oldCapture,reader('old',['old call text'],{final:true}),{identity:'tester'});
  assert.doesNotMatch(api.elements.callTranscript.innerHTML,/old call text/);
  assert.equal(api.pageState.callTranscript.messages.size,0);
});

test('customer facts are shown inside the call with escaped verification values', async () => {
  const {api}=harness();
  api.pageState.testCustomers=[{id:'C1',full_name:'Demo <Customer>',date_of_birth:'1990-06-18',postal_code:'35000',currency:'USD',balance_cents:150000}];
  await api.startBrowserSession('agent-1',{customer_id:'C1'});
  assert.equal(api.elements.callCustomerDetails.hidden,false);
  assert.match(api.elements.callCustomerDetails.innerHTML,/Demo &lt;Customer&gt;/);
  assert.match(api.elements.callCustomerDetails.innerHTML,/1990-06-18/);
  assert.match(api.elements.callCustomerDetails.innerHTML,/35000/);
  assert.match(api.elements.callCustomerDetails.innerHTML,/\$1,500.00/);
});


test('uncertain session creation retries with the same key', async () => {
  const {api,requests} = harness({createResponses:[new Error('response lost')]});
  await api.startBrowserSession('agent-1');
  assert.equal(api.pageState.liveSession,null);
  assert.equal(api.elements.callStatus.textContent,'Start unconfirmed');
  await api.startBrowserSession('agent-1');
  const starts=requests.filter(r=>r.options?.method==='POST');
  assert.equal(starts.length,2);
  assert.equal(starts[0].options.headers['Idempotency-Key'],starts[1].options.headers['Idempotency-Key']);
  assert.match(starts[0].options.headers['Idempotency-Key'],/^[0-9a-f-]{36}$/);
  assert.equal(api.pageState.liveSession.sessionId,'session-1');
});

test('pending dispatch response retains identity without opening a room', async () => {
  const {api,requests} = harness({createResponses:[{code:'SESSION_START_PENDING',session_id:'session-1',error:'Awaiting confirmation'}]});
  await api.startBrowserSession('agent-1');
  assert.equal(api.pageState.liveSession,null);
  assert.equal(api.elements.callStatus.textContent,'Start unconfirmed');
  await api.startBrowserSession('agent-1');
  const starts=requests.filter(r=>r.options?.method==='POST');
  assert.equal(starts[0].options.headers['Idempotency-Key'],starts[1].options.headers['Idempotency-Key']);
});

test('a completed call followed by a new call uses a fresh operation key', async () => {
  const {api,requests}=harness();
  await api.startBrowserSession('agent-1');
  await api.finishBrowserSession();
  await api.startBrowserSession('agent-1');
  const starts=requests.filter(r=>r.options?.method==='POST');
  assert.notEqual(starts[0].options.headers['Idempotency-Key'],starts[1].options.headers['Idempotency-Key']);
});


test('pending call identity survives a browser reload', async () => {
  const storage=new Map();
  const first=harness({storage,createResponses:[new Error('response lost')]});
  await first.api.startBrowserSession('agent-1',{customer_id:'customer-1',call_direction:'agent_calls_user'});
  const second=harness({storage});
  // Object property order changes, but the normalized request is identical.
  await second.api.startBrowserSession('agent-1',{call_direction:'agent_calls_user',customer_id:'customer-1'});
  assert.equal(first.requests[0].options.headers['Idempotency-Key'],second.requests[0].options.headers['Idempotency-Key']);
});


test('logout disconnects the room and hides retained call details', async () => {
  const {api,disconnected}=harness();
  await api.startBrowserSession('agent-1');
  await api.signOut();
  assert.equal(disconnected(),true);
  assert.equal(api.pageState.liveSession,null);
  assert.equal(api.elements.callModal.hidden,true);
});

test('auth loss disconnects a room even without explicit logout', async () => {
  const {api,disconnected}=harness();
  await api.startBrowserSession('agent-1');
  api.showAuthentication();
  await Promise.resolve();
  assert.equal(disconnected(),true);
  assert.equal(api.pageState.liveSession,null);
});

test('agent save submits configuration and assignments together and prevents double submit', async () => {
  const {api,context}=harness();
  for (const [key,value] of Object.entries({name:'Collector',instructions:'Verify first',voice:'voice',description:'',model:'model',language:'en',ttsModel:'tts'})) api.elements[key].value=value;
  api.elements.voice.disabled=false;
  api.pageState.agentEditorReady=true;
  context.saves=[];
  vm.runInContext('callAgentsApi=async(path,options)=>{saves.push(JSON.parse(options.body));return {agent:{id:"new-agent"}}};loadTools=async()=>{};',context);
  const event={preventDefault(){}};
  await Promise.all([api.saveAgent(event),api.saveAgent(event)]);
  assert.equal(context.saves.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.saves[0].assignments)),[]);
});

test('agent save is blocked until assignment loading finishes', async () => {
  const {api,context}=harness();context.saves=0;
  vm.runInContext('callAgentsApi=async()=>{saves++;return {agent:{id:"new-agent"}}}',context);
  api.pageState.agentEditorReady=false;
  await api.saveAgent({preventDefault(){}});
  assert.equal(context.saves,0);
});

test('history load more keeps the agent filter and appends older sessions', async () => {
  const {api,context}=harness();context.paths=[];
  vm.runInContext('callWorkspaceApi=async(name,path)=>{paths.push(path);return paths.length===1?{sessions:[{id:"new"}],next_cursor:"older"}:{sessions:[{id:"old"}],next_cursor:null}};renderSessionList=()=>{};',context);
  await api.loadAllSessions('agent-1');
  await api.loadAllSessions('agent-1',{append:true});
  assert.match(context.paths[1],/agent_id=agent-1/);
  assert.match(context.paths[1],/cursor=older/);
  assert.deepEqual(Array.from(api.pageState.sessionHistory,s=>s.id),['new','old']);
});

test('stale session details cannot overwrite a newer selection', async () => {
  const {api,context}=harness();context.pending={};context.rendered=[];
  vm.runInContext('callWorkspaceApi=async(name,path)=>new Promise(resolve=>{pending[path]=resolve});renderSessionDetails=data=>rendered.push(data.session.id);',context);
  const first=api.loadSessionDetails('first',{background:true});
  const second=api.loadSessionDetails('second',{background:true});
  context.pending['?id=second']({session:{id:'second',status:'completed'}});await second;
  context.pending['?id=first']({session:{id:'first',status:'completed'}});await first;
  assert.deepEqual(Array.from(context.rendered),['second']);
});


test('validation history paginates real endpoint and keeps verdicts distinct', async () => {
  const {api,context}=harness();context.paths=[];
  vm.runInContext('callWorkspaceApi=async(name,path)=>{paths.push({name,path});return paths.length===1?{runs:[{id:"one",scenario_name:"<img src=x>",status:"not_run"}],next_cursor:"next"}:{runs:[{id:"two",status:"inconclusive"}],next_cursor:null}};',context);
  await api.loadValidationHistory();await api.loadValidationHistory({append:true});
  assert.equal(context.paths[0].name,'test-runs');
  assert.match(context.paths[1].path,/cursor=next/);
  assert.match(api.elements.validationHistory.innerHTML,/Not run/);
  assert.match(api.elements.validationHistory.innerHTML,/Inconclusive/);
  assert.match(api.elements.validationHistory.innerHTML,/&lt;img/);
  assert.doesNotMatch(api.elements.validationHistory.innerHTML,/<img/);
});

test('saved validation detail retains complete synthetic facts and escapes transcript HTML', async () => {
  const {api,context}=harness();
  vm.runInContext('callWorkspaceApi=async()=>({run:{id:"one",status:"failed",customer_snapshot:{postal_code:"35000",date_of_birth:"1990-06-18"},transcript:[{text:"<script>bad</script>"}],expected_outcome:{description:"Verify first"}}});',context);
  await api.loadValidationDetail('one');
  const html=api.elements.validationDetail.innerHTML;
  assert.match(html,/35000/);assert.match(html,/1990-06-18/);assert.match(html,/Verify first/);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});

test('manual audio review has stable retry identity and sends a structured expectation', async () => {
  const {api,context}=harness();
  api.pageState.lastTestSessionId='session-1';
  vm.runInContext('document.querySelector("#validation-scenario").value="Minimum offer";document.querySelector("#validation-expected").value="Reject under minimum";document.querySelector("#validation-verdict").value="inconclusive";document.querySelector("#validation-notes").value="Needs review";',context);
  context.posts=[];
  vm.runInContext('callWorkspaceApi=async(name,path,options)=>{if(options?.method==="POST"){posts.push(JSON.parse(options.body));if(posts.length===1)throw Error("response lost");return {run:{}}}return {runs:[]}};',context);
  await api.recordAudioValidation({preventDefault(){}});
  await api.recordAudioValidation({preventDefault(){}});
  assert.equal(context.posts.length,2);
  assert.equal(context.posts[0].id,context.posts[1].id);
  assert.equal(context.posts[0].expected_outcome.description,'Reject under minimum');
  assert.equal(context.posts[0].status,'inconclusive');
  assert.equal(context.posts[0].session_id,'session-1');
  assert.equal(context.posts[0].execution_type,'manual_audio');
  assert.ok(context.posts[0].scenario_id);
});


test('a delayed editor assignment response cannot replace the newly selected agent tools', async () => {
  const {api,context}=harness();
  api.pageState.agents=[{id:'first',name:'First',instructions:'First'},{id:'second',name:'Second',instructions:'Second'}];
  context.pending={};
  vm.runInContext('window.HostedVoicePicker=function(){return {load:async()=>{},stop(){}}};callWorkspaceApi=async(name,path)=>new Promise(resolve=>{pending[path]=resolve});',context);
  const first=api.openEditModal('first');await Promise.resolve();await Promise.resolve();
  const second=api.openEditModal('second');await Promise.resolve();await Promise.resolve();
  assert.equal(api.elements.agentSaveButton.disabled,true);
  context.pending['?agent_id=second']({tools:[{id:'second-tool',name:'Second tool',is_enabled:true,assigned:true}]});await second;
  context.pending['?agent_id=first']({tools:[{id:'first-tool',name:'First tool',is_enabled:true,assigned:true}]});await first;
  assert.match(api.elements.agentToolSelection.innerHTML,/Second tool/);
  assert.doesNotMatch(api.elements.agentToolSelection.innerHTML,/First tool/);
  assert.equal(api.elements.agentSaveButton.disabled,false);
});

test('changing active session replaces its polling timer', async () => {
  const {api,context}=harness();context.timerId=0;context.cleared=[];
  vm.runInContext('window.setInterval=()=>++timerId;window.clearInterval=id=>cleared.push(id);callWorkspaceApi=async(name,path)=>({session:{id:path,status:"active"}});renderSessionDetails=()=>{};',context);
  await api.loadSessionDetails('first');
  await api.loadSessionDetails('second');
  assert.deepEqual(Array.from(context.cleared),[1]);
  assert.equal(api.pageState.sessionDetailsPollTimer,2);
});
