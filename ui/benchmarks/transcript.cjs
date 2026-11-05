// Usage: node ui/benchmarks/transcript.cjs [path/to/baseline/app.js]
// Measures real renderer JS with DOM stubs; excludes browser layout and audio.
const { performance } = require('node:perf_hooks');
const { latencyHarness, transcriptFixture } = require('../tests/latency-harness.cjs');
const harness = latencyHarness(process.argv[2]);
const capture = transcriptFixture(harness, 120);
const current = capture.messages.get('119');
harness.api.renderCallTranscript(capture);
const beforeCount = harness.formatterConstructions();
const samples = [];
for (let run = 0; run < 5; run++) {
  const started = performance.now();
  for (let chunk = 0; chunk < 100; chunk++) {
    current.text = `Response chunk ${run * 100 + chunk}`;
    current.final = false;
    harness.api.renderCallTranscript(capture);
  }
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({
  turns: capture.messages.size, updatesPerSample: 100, samples: samples.length,
  medianMilliseconds: Number(samples[2].toFixed(2)),
  formatterConstructions: harness.formatterConstructions() - beforeCount,
  includesBrowserLayout: false,
}, null, 2));
