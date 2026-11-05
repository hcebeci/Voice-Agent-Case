const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function latencyHarness(sourcePath = path.join(__dirname, '../app.js')) {
  const nodes = new Map();
  let formatterConstructions = 0;
  const instrumentedIntl = Object.create(Intl);
  instrumentedIntl.DateTimeFormat = function (...args) {
    formatterConstructions++;
    return new Intl.DateTimeFormat(...args);
  };
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: '', hidden: true, disabled: false, textContent: '', innerHTML: '', dataset: {},
      focus() {}, reset() {}, classList: { toggle() {} }, addEventListener() {},
      setAttribute() {}, removeAttribute() {}, querySelectorAll() { return []; },
      querySelector() { return null; }, replaceChildren() {}, appendChild() {},
    });
    return nodes.get(id);
  }
  const room = {
    on() {}, registerTextStreamHandler() {}, async connect() {}, async startAudio() {}, async disconnect() {},
    localParticipant: { identity: 'tester', async setMicrophoneEnabled() {} },
  };
  const context = vm.createContext({
    console, Intl: instrumentedIntl, Date, URL, URLSearchParams, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    document: { querySelector: element, querySelectorAll() { return []; }, addEventListener() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    window: { location: { protocol: 'http:', hash: '' }, history: { replaceState() {} }, setInterval() {},
      LivekitClient: { Room: function () { return room; }, RoomEvent: {}, Track: { Kind: { Audio: 'audio' } } } },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8') + '\nglobalThis.api = {pageState, elements, renderCallTranscript, receiveCallText, startBrowserSession, finishBrowserSession, loadDashboard};', context);
  vm.runInContext('callWorkspaceApi = async () => ({session_id:"test", server_url:"wss://test", participant_token:"test"}); loadDashboard = async () => {}; loadAgents = async () => {};', context);
  context.api.pageState.agents = [{ id: 'agent', name: 'Test agent', runtime_status: 'sleeping' }];
  return { context, api: context.api, room, formatterConstructions: () => formatterConstructions };
}

function transcriptFixture(harness, count = 120) {
  const capture = { room: harness.room, messages: new Map(), streamSequence: 0, ended: false };
  for (let index = 0; index < count; index++) {
    capture.messages.set(String(index), {
      text: `Sentence ${index}: I can make the payment tomorrow.`,
      speaker: index % 2 ? 'agent' : 'user', final: true,
      receivedAt: new Date(1700000000000 + index * 1000),
    });
  }
  harness.api.pageState.callTranscript = capture;
  return capture;
}

module.exports = { latencyHarness, transcriptFixture };
