const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const catalog = JSON.parse(fs.readFileSync('ui/voice-catalog.json'));

function harness({ fails = false } = {}) {
  const window = {};
  const context = vm.createContext({ window, Option: function(text, value) { Object.assign(this, {text, value}); },
    fetch: async () => ({ ok: !fails, json: async () => catalog }),
  });
  vm.runInContext(fs.readFileSync('ui/voices.js', 'utf8'), context);
  const element = () => ({ value: '', options: [], textContent: '', disabled: false, hidden: true, src: '', handlers: {},
    addEventListener(name, callback) { this.handlers[name] = callback; },
    replaceChildren() { this.options = []; }, add(option) { this.options.push(option); this.value ||= option.value; },
    pause() { this.paused = true; }, load() {}, removeAttribute(name) { delete this[name]; },
  });
  const elements = Object.fromEntries(['model','voice','audio','details','status'].map(name => [name, element()]));
  return { ...elements, picker: new window.HostedVoicePicker(elements) };
}

test('catalog contains only the requested multilingual Google and xAI voices', () => {
  assert.equal(catalog.models.reduce((count, m) => count + m.voices.length, 0), 56);
  assert.deepEqual(catalog.models.map(m => m.provider).sort(), ['Google', 'xAI']);
  for (const m of catalog.models) assert.ok(m.languages.includes('tr') && m.languages.includes('en'));
});
test('selection restores, provider switch resets, hosted playback stops on change', async () => {
  const { picker, model, voice, audio } = harness();
  await picker.load('xai/tts-1', 'eve');
  assert.equal(voice.value, 'eve');
  assert.match(audio.src, /^https:\/\/static.livekit.io\//);
  model.value = 'google/gemini-3.8-flash-tts'; model.handlers.change();
  assert.equal(voice.value, 'Kore');
  assert.equal(audio.hidden, false);
  assert.match(audio.src, /^https:\/\/docs.cloud.google.com\//);
  picker.stop();
  assert.equal(audio.src, undefined);
  assert.equal(audio.paused, true);
});
test('legacy saved voices remain selectable without exposing new legacy choices', async () => {
  const { picker, voice, model } = harness();
  await picker.load('inworld/inworld-tts-2', 'Ashley');
  assert.equal(voice.value, 'Ashley');
  assert.equal(model.options.length, 3);
  assert.ok(!model.options.some(m => m.value === 'cartesia/sonic-3'));
});
test('failed catalog loading blocks saving an unloaded selection', async () => {
  const { picker, voice, status } = harness({ fails: true });
  await assert.rejects(picker.load(), /Could not load voices/);
  assert.equal(voice.disabled, true);
  assert.match(status.textContent, /retry/);
});
