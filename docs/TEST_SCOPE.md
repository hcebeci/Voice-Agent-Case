# Test scope and evidence

Use this guide to understand what a check establishes before interpreting its
result. The [README](../README.md#test-scope) summarizes scope; the
[validation guide](VALIDATION.md) provides commands and prerequisites.

## Revision and result boundaries

This inventory describes the current local checkout. Several suites, runners,
and collection simulation fixtures are modified or untracked and are not in
published commit `b6e9c92`. Publish the associated implementations, migrations,
and tests together before describing them as available from a fresh clone.
The published commit's simulation file contains starter-assistant scenarios;
the local replacement contains collection scenarios.

Keep three statements separate:

- **Included:** a test or scenario exists in the selected revision.
- **Executed:** a particular command ran against that revision and environment.
- **Passed:** its assertions succeeded in that execution; record failures and
  skips alongside passes.

This documentation update does not execute tests. It reports no new pass counts
and no measured line or branch coverage. When recording a run, include the commit
and any local changes, command, date, environment, result, skips, and evidence
location. Retain unsuccessful and inconclusive runs too.

## Validation layers

| Layer | What it establishes | Boundary |
| --- | --- | --- |
| Policy and helper tests | Specific inputs produce the asserted state transitions, validations, or calculated values. | Do not exercise a complete service or call. |
| Scripted SDK and browser-logic tests | SDK/tool mechanics and UI logic behave as asserted when supplied known model outputs or simulated events. | Model output, browser objects, and service transports may be replaced. They do not establish spoken behavior or natural-language interpretation. |
| Local database/handler integration | Selected migrations, permissions, transactions, projections, and handler interactions work against disposable PostgreSQL. | Local additions. Supabase roles/identity are modeled and external adapters are injected; hosted JWT verification, gateway behavior, and network delivery are not established. |
| Real-model text evaluation | Checks a selected model's actual responses and tool choices against the case's assertions. | Opt-in inference. The collection evaluation uses synthetic state and replaced remote database transport; it does not verify hosted persistence or audio. |
| Hosted text/audio simulation | Selected simulated conversations exercise model behavior or the speech pipeline and are graded for expected outcomes. | Opt-in, may incur charges. Authored fixtures are not completed runs; audio simulation is not a real microphone, deployed dashboard, or telephone test. |
| Manual deployment acceptance | A person checks the actual deployed sign-in, browser audio, session delivery, and visible results. | A separate recorded execution, not an automatic consequence of passing unit or integration tests. |

The newer database runners and collection evaluation/simulation files are local
additions. Available layers differ between the published commit and this checkout.
Scripted tests are most repeatable; real-model and audio results can vary. A
single passing model conversation does not establish general conversational reliability.

## Specific scenario examples

Write each scenario as **given a known setup → perform an action → assert an
observable outcome**. Link it to the test that makes that assertion and state
which dependencies are simulated. These examples describe existing checks;
they are not statements that the checks passed in this review.

| Scenario and expected assertion | Existing test | Test method / boundary |
| --- | --- | --- |
| Given an unverified customer, submit a payment offer → receive `IDENTITY_VERIFICATION_REQUIRED`. Given a verified eligible proposal without review evidence, request a commitment → receive `CONFIRMATION_REQUIRED` and no effect. | [`test_guard_and_missing_confirmation`](../Livekit-Agents/tests/test_collection.py) | Direct policy calls with synthetic state. Payment guards do not imply that callback requests require verification. |
| Given a reviewed proposal, evaluate the same terms → retain the review. Change the date → clear the review; attempting the old proposal returns `CONFIRMATION_REQUIRED`. | [`test_changed_terms_invalidate_review_and_same_terms_preserve_it`](../Livekit-Agents/tests/test_collection.py) | Asserts proposal-state invalidation; it does not test a model interpreting a spoken correction. |
| Given three well-formed but wrong identity attempts, submit the correct answers → verification remains locked. Malformed input does not consume an attempt. | [`test_three_failed_attempts_lock_and_invalid_input_does_not_count`](../Livekit-Agents/tests/test_collection.py) | Fixed synthetic customer and clock; not speech-recognition accuracy. |
| Given a verification write whose response is lost, retry through the backend → the failed identity attempt is counted once. | [`test_lost_write_response_recovers_without_counting_verification_twice`](../Livekit-Agents/tests/test_collection_runtime.py) | Mock HTTP transport and in-memory state. Does not establish every retry, database concurrency, or semantic duplicate-intent case. |
| Given a call whose microphone operation rejects, start it → clear the active call, disconnect the room, show failure, and request failed session status. | [`microphone failure marks session failed and disconnects room`](../ui/tests/test-calls.test.cjs) | Simulated DOM, microphone, room, and API. Does not actually deny browser permission or prove the server saved the update. |
| Given an active session and `room_finished`, calculate a lifecycle update → produce completed status and the supplied end timestamp. | [`room finish completes an active session`](../supabase/functions/livekit-webhook/lifecycle.test.mjs) | Pure helper assertion. Does not send a signed webhook, authenticate it, or persist the result. |

For new examples, avoid universal phrases such as “all retries are safe” or
“the agent understands confirmation.” Describe the particular input, assertion,
and execution layer instead. If an example has no implemented assertion, label
it **planned** or **manual**, rather than adding it to automated scope.

## Manual acceptance checklist

Use this checklist when verifying the deployed application. Every item begins
**not run**; mark passed, failed, or inconclusive only after recording the
execution and evidence. These items are separate from automated test results.

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
