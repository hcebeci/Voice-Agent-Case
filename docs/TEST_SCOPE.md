# Test scope and evidence

Use this guide to understand what a check establishes before interpreting its
result. The [README](../README.md#test-scope) summarizes scope; the
[validation guide](VALIDATION.md) provides commands and prerequisites.

## Revision and result boundaries

The [README matrix](../README.md#test-scope) uses seven columns: **Area**,
**Test type**, **How it works**, **Functional checks**, **Failure / edge checks**,
**Latest result**, and **Boundary**. Manual tests branch under the same areas as
automated tests, so a simulated result is never substituted for a real interaction.

The inventory and [latest offline results](test-results/2026-11-06-offline.md)
refer to source revision `85f3e7a`, checked on 6 November 2026. Automated evidence
is linked separately from user-reported manual audio checks. The current source
includes voice, database/handler, evaluation, audio-scenario, and CI suites.
`scenarios.yaml` contains collection scenarios, `scenarios.audio.yaml` contains
an interruption scenario, and `scenarios.starter.yaml` retains starter cases.
Included fixtures alone are not completed runs.

Keep three statements separate:

- **Included:** a test or scenario exists in the selected revision.
- **Executed:** a particular command ran against that revision and environment.
- **Passed:** its assertions succeeded in that execution; record failures and
  skips alongside passes.

The latest offline run recorded **108 Python passes and 1 skipped real-model
test, 78 JavaScript passes, 5 answer-speed report passes, 7 scripted scenario
passes, and passing database/handler integration across 19 migrations**. See
[the execution report](test-results/2026-11-06-offline.md) for commands, retained
outputs, scenario assertions, environment, and unexecuted checks. Counts are not
line/branch coverage measurements or per-area totals.

When recording a new run, include the commit and any local changes, command,
date, environment, result, skips, and evidence location. Retain unsuccessful and
inconclusive runs. Do not silently carry these results forward to changed code.

### Reading the latest-result checklists

- **✓ Demonstrated:** an assertion succeeded in the linked automated run, within
  the row's boundary. It does not guarantee every related input or environment.
- **□ Evidence needed:** an individual manual or opt-in item was not established
  by the reviewed evidence. It is not a failed assertion or an automated pass.
- **User-reported:** earlier manual interaction was reported without independently
  reviewing per-session evidence in this run. Preserve that provenance.
- **Skipped / not run:** distinguish an explicit runner skip from an evaluation
  that was never executed.

Record manual evidence as **Observed** for what a reviewer saw/heard and
**Verified in records** for the exact transcript, tool result, or persisted effect
reviewed. Include configuration, browser/device, date, reviewer, session/report
ID, expected outcome and actual outcome. The application's **Record audio
validation** feature supports this; its human verdict is not an automated grade.

## Validation layers

| Layer | What it establishes | Boundary |
| --- | --- | --- |
| Policy and helper tests | Specific inputs produce the asserted state transitions, validations, or calculated values. | Do not exercise a complete service or call. |
| Scripted SDK and browser-logic tests | SDK/tool mechanics and UI logic behave as asserted when supplied known model outputs or simulated events. | Model output, browser objects, and service transports may be replaced. They do not establish spoken behavior or natural-language interpretation. |
| Local database/handler integration | Selected migrations, permissions, transactions, projections, and handler interactions work against disposable PostgreSQL. | Supabase roles/identity are modeled and external adapters are injected; hosted JWT verification, gateway behavior, and network delivery are not established. |
| Real-model text evaluation | Checks a selected model's actual responses and tool choices against the case's assertions. | Opt-in inference. The collection evaluation uses synthetic state and replaced remote database transport; it does not verify hosted persistence or audio. |
| Hosted text/audio simulation | Selected simulated conversations exercise model behavior or the speech pipeline and are graded for expected outcomes. | Opt-in, may incur charges. Authored fixtures are not completed runs; audio simulation is not a real microphone, deployed dashboard, or telephone test. |
| Manual deployment acceptance | A person checks the actual deployed sign-in, browser audio, session delivery, and visible results. | A separate recorded execution, not an automatic consequence of passing unit or integration tests. |

Scripted tests are most repeatable; real-model and audio results can vary. A
single passing model conversation does not establish general conversational reliability.

## Specific scenario examples

Write each scenario as **given a known setup → perform an action → assert an
observable outcome**. Link it to the test that makes that assertion and state
which dependencies are simulated. These examples describe existing checks;
the linked execution report establishes whether their supporting suites passed.

| Scenario and expected assertion | Existing test | Test method / boundary |
| --- | --- | --- |
| Given an unverified customer, submit a payment offer → receive `IDENTITY_VERIFICATION_REQUIRED`. Given a verified eligible proposal without review evidence, request a commitment → receive `CONFIRMATION_REQUIRED` and no effect. | [`test_guard_and_missing_confirmation`](../Livekit-Agents/tests/test_collection.py) | Direct policy calls with synthetic state. Payment guards do not imply that callback requests require verification. |
| Given a reviewed proposal, evaluate the same terms → retain the review. Change the date → clear the review; attempting the old proposal returns `CONFIRMATION_REQUIRED`. | [`test_changed_terms_invalidate_review_and_same_terms_preserve_it`](../Livekit-Agents/tests/test_collection.py) | Asserts proposal-state invalidation; it does not test a model interpreting a spoken correction. |
| Given three well-formed but wrong identity attempts, submit the correct answers → verification remains locked. Malformed input does not consume an attempt. | [`test_three_failed_attempts_lock_and_invalid_input_does_not_count`](../Livekit-Agents/tests/test_collection.py) | Fixed synthetic customer and clock; not speech-recognition accuracy. |
| Given a verification write whose response is lost, retry through the backend → the failed identity attempt is counted once. | [`test_lost_write_response_recovers_without_counting_verification_twice`](../Livekit-Agents/tests/test_collection_runtime.py) | Mock HTTP transport and in-memory state. Does not establish every retry, database concurrency, or semantic duplicate-intent case. |
| Given a call whose microphone operation rejects, start it → clear the active call, disconnect the room, show failure, and request failed session status. | [`microphone failure marks session failed and disconnects room`](../ui/tests/test-calls.test.cjs) | Simulated DOM, microphone, room, and API. Does not actually deny browser permission or prove the server saved the update. |
| Given an active session and `room_finished`, calculate a lifecycle update → produce completed status and the supplied end timestamp. | [`room finish completes an active session`](../supabase/functions/livekit-webhook/lifecycle.test.mjs) | Pure helper assertion. Does not send a signed webhook, authenticate it, or persist the result. |
| Given a tool result before its start event, then replay or concurrently deliver the start → retain the terminal tool/trace status and fill the original arguments without duplicating the records. | [Ordered-tool SQL assertions](../supabase/tests/ordered-tool-observability.sql) and [concurrent handler integration](../tests/integration/observability.mts) | Real disposable PostgreSQL, including separate concurrent connections; injected external auth/SDK adapter. Does not verify deployed network ordering or throughput. |
| Given an existing manual report, replay its original capture after late telemetry → return the unchanged first snapshot, without rereading and replacing the evidence. | [Retained-report handler tests](../supabase/functions/test-runs/handler.test.mjs) | Handler fixtures with simulated database tables; not a hosted API request or proof the human verdict is correct. |
| Given a pending dashboard refresh after call connection → show active call controls without waiting for that refresh. | [Connected-call controls test](../ui/tests/latency.test.cjs) | Simulated browser and unresolved promise; verifies dependency ordering, not microphone latency or a millisecond response target. |

For new examples, avoid universal phrases such as “all retries are safe” or
“the agent understands confirmation.” Describe the particular input, assertion,
and execution layer instead. If an example has no implemented assertion, label
it **planned** or **manual**, rather than adding it to automated scope.

## CI and execution evidence

The [offline validation workflow](../.github/workflows/validation.yml) runs
JavaScript regressions, answer-speed report tests, worker pytest with the
real-model case disabled, scripted collection scenarios, and the disposable
PostgreSQL/handler integration runner. Artifacts are retained for 30 days,
including available failure evidence. Individual later steps can be skipped
when an earlier step fails; inspect the job log and artifacts to establish what ran.

The workflow does not run paid inference/audio simulations, publish reports to
production, or validate a hosted deployment. Workflow configuration is evidence
that checks are scheduled, not that a particular revision passed them.

## Manual acceptance checklist

Use this checklist when verifying the deployed application. The detailed items
below remain **not independently verified** in the latest run. Earlier manual
audio checks in both directions are [user-reported](IMPLEMENTATION_STATUS.md),
without per-scenario evidence reviewed here. Mark an item passed, failed, or
inconclusive only after recording its execution and evidence; automated suite
results do not complete this checklist.

- [ ] Sign in as an ordinary user and load the dashboard APIs. Separately call
  the protected `agents` endpoint without a user session; expect rejection.
- [ ] Start a browser call in each direction. For **Agent calls user**, expect
  the agent to greet first; for **User calls agent**, speak first and expect an
  audible reply.
- [ ] Separately deny microphone permission when starting a call; expect a
  visible failure and no connected room left behind.
- [ ] Complete a fictional-customer payment conversation; verify the exact
  saved amount/date and unchanged account balance; the result should be a
  recorded promise to pay, not a processed payment.
- [ ] Interrupt the terms readback before completion and request immediate
  saving; expect no commitment before a completed review and later agreement.
- [ ] Change the proposed date, wait for review of the revised terms, then agree;
  expect one commitment for the revised date and none for the original date.
- [ ] End a successful call containing a known tool action. Verify successful
  signed webhook delivery, `completed` session status, the expected tool event,
  and the transcript and usage records expected for the selected configuration.
  Mark missing or delayed required evidence inconclusive until resolved.

For each item, capture the selected configuration/customer, steps and expected
outcome, actual outcome, session or report ID, and reviewer. Record any partial
or missing evidence. Passing one browser call does not validate every model,
voice, network condition, or conversation.
