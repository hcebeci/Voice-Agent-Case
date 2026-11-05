const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { latencyHarness, transcriptFixture } = require('./latency-harness.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function dashboardHarness() {
  const harness = latencyHarness();
  const pending = [];
  harness.context.request = (name) => {
    if (name !== 'dashboard') return Promise.resolve({ session_id: 'test', server_url: 'wss://test', participant_token: 'test' });
    const response = deferred();
    pending.push(response);
    return response.promise;
  };
  vm.runInContext('callWorkspaceApi = request; loadDashboard = api.loadDashboard;', harness.context);
  return { ...harness, pending };
}

const dashboard = (active) => ({ date: '2026-11-05', metrics: { active_session_count: active } });

test('streaming a long transcript reuses timestamp formatting infrastructure', async () => {
  const harness = latencyHarness();
  const { api } = harness;
  const capture = transcriptFixture(harness);
  api.renderCallTranscript(capture);
  const previousTurns = api.elements.callTranscript.innerHTML;
  const reader = {
    info: { id: 'latest', attributes: { 'lk.transcription_final': 'true' } },
    async *[Symbol.asyncIterator]() {
      for (const chunk of ['New ', '<answer>', ' arrives']) yield chunk;
    },
  };
  await api.receiveCallText(capture, reader, { identity: 'tester' });
  assert.ok(api.elements.callTranscript.innerHTML.startsWith(previousTurns));
  assert.match(api.elements.callTranscript.innerHTML, /New &lt;answer&gt; arrives/);
  assert.equal(api.elements.callTranscriptStatus.textContent, '121 turns · Live');
  assert.equal(harness.formatterConstructions(), 1, 'one formatter per app, not per historical turn and chunk');
});

test('connected call controls do not wait for a dashboard response', async () => {
  const { context, api } = latencyHarness();
  let release;
  context.dashboardPending = new Promise((resolve) => { release = resolve; });
  let dashboardStarted;
  const started = new Promise((resolve) => { dashboardStarted = resolve; });
  context.dashboardStarted = dashboardStarted;
  vm.runInContext('loadDashboard = async () => { dashboardStarted(); return dashboardPending; };', context);
  const start = api.startBrowserSession('agent');
  await started;
  // Drain the existing microtasks without allowing the dashboard to finish.
  await Promise.resolve();
  await Promise.resolve();
  try {
    assert.equal(api.elements.callStatus.textContent, 'Active');
    assert.equal(api.pageState.callStarting, false);
    assert.equal(api.elements.endCallButton.disabled, false);
  } finally {
    release();
    await start;
  }
});

test('ending a call keeps its dashboard when the detached start refresh arrives last', async () => {
  const { api, pending } = dashboardHarness();
  await api.startBrowserSession('agent');
  assert.equal(pending.length, 1);
  const ending = api.finishBrowserSession();
  await new Promise(setImmediate);
  assert.equal(pending.length, 2);
  pending[1].resolve(dashboard(0));
  await ending;
  pending[0].resolve(dashboard(1));
  await new Promise(setImmediate);
  assert.equal(api.pageState.dashboard.metrics.active_session_count, 0);
  assert.equal(api.elements.activeSessionsValue.textContent, 0);
});

test('a stale dashboard error cannot replace a newer successful refresh', async () => {
  const { api, pending } = dashboardHarness();
  const older = api.loadDashboard();
  const newer = api.loadDashboard();
  pending[1].resolve(dashboard(0));
  await newer;
  pending[0].reject(new Error('Old request failed'));
  await older;
  assert.equal(api.elements.pageError.textContent, '');
  assert.equal(api.elements.pageError.hidden, true);
  assert.equal(api.pageState.dashboard.metrics.active_session_count, 0);
});

for (const outcome of ['success', 'error']) {
  test(`a dashboard ${outcome} from a previous authenticated session is ignored`, async () => {
    const { api, pending } = dashboardHarness();
    const loading = api.loadDashboard();
    api.pageState.authGeneration = (api.pageState.authGeneration ?? 0) + 1;
    if (outcome === 'success') pending[0].resolve(dashboard(1));
    else pending[0].reject(new Error('Expired authentication'));
    await loading;
    assert.equal(api.pageState.dashboard, null);
    assert.equal(api.elements.activeSessionsValue.textContent, '');
    assert.equal(api.elements.pageError.textContent, '');
  });
}

test('the current dashboard request still displays its error', async () => {
  const { api, pending } = dashboardHarness();
  const loading = api.loadDashboard();
  pending[0].reject(new Error('Current request failed'));
  await loading;
  assert.equal(api.elements.pageError.textContent, 'Current request failed');
  assert.equal(api.elements.pageError.hidden, false);
});
