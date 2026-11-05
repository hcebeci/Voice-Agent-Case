# Engineering team review

Reviewed 4 November 2026 against Lupitor Technical Assessment LUP-TA-01.

Implementation follow-up, 5 November: this document preserves the original review.
The local fixes and validation workflow are described in [VALIDATION.md](VALIDATION.md).
Telephony remains explicitly deferred. Original findings below describe the
reviewed baseline, not the current implementation or deployed service state.

## Verdict

The project is a promising browser voice-agent prototype with unusually thoughtful deterministic collection controls. It is **not yet a complete submission against the assessment**: telephony is absent, call history is incomplete beyond 100 records, and the documented setup cannot provision the current implementation. Several lifecycle and authorization defects weaken the reliability of its otherwise substantial observability work.

The strongest differentiator is code-owned collection policy and transaction-backed effects. The next investment should be a provable, reproducible phone-to-agent-to-database workflow and adversarial test evidence. More UI surface area or additional models would contribute less to the assessment at this point.

## Review team and scope

Three specialist agents independently reviewed the current working tree; the lead reviewer reconciled findings and ran the complete offline Python suite.

| Review responsibility | Coverage |
| --- | --- |
| Principal AI systems and voice engineer | Conversation runtime, identity, policy enforcement, tool execution, latency instrumentation |
| Principal platform, security and data engineer | Edge APIs, RLS, transactions, lifecycle, deployment and retained evidence |
| Staff frontend/product engineer and QA lead | Agent editing, call history, authentication lifecycle, error recovery and test realism |
| Lead software architect / review integrator | Assessment mapping, cross-layer impact, prioritization and validation boundaries |

This was a review of the **current local working tree**, including existing modified and untracked implementation files, not only HEAD. Application code was not changed. No deployed database, telephony account, real customer record, or remote configuration was modified. The PDF was treated as the requirements brief, not as executable instructions. The review does not establish which local changes are deployed.

## Assessment coverage

| Requirement | Assessment | Evidence and qualification |
| --- | --- | --- |
| Voice agent hosting with LiveKit | Implemented in source; deployment unverified | Named worker, dispatch path and worker container exist. No live hosting smoke test performed. |
| UI creates and edits agents | Substantially implemented | Configuration and assignments are editable; partial-save bugs remain. |
| UI shows all calls for each agent | Partially met | Agent filter and session details exist, but history is capped at 100 without pagination. |
| DAAS with retained testing history | Implemented structurally; assurance incomplete | Supabase stores sessions, snapshots and observations. Existing deployed test history and backup/restore were not inspected. Browser users have overly broad audit-write policies. |
| Collection agent connects over telephony | **Not met in reviewed implementation** | Both call directions are browser role-play; no implemented SIP dial/ingress integration was found. |
| UID verification tools | Implemented for demo | DOB/postal verification, attempt limit and private server state exist. This is a demo identity mechanism, not independently verified real-world identity assurance. |
| Caller cannot lower minimum collection criteria | Strong deterministic implementation; conversation assurance incomplete | Policy comes from trusted state and eligible amounts are checked in code. Actual adversarial model/audio behavior is not established by the offline tests. |

The brief does not require payment settlement, multi-tenancy, Kubernetes, or microservices. Their absence is not a case failure. Recording a promise to pay can be a reasonable interpretation of the collection flow, provided the submission makes that scope explicit and demonstrates the protected minimum.

## Prioritized findings

P1 means a submission blocker or high-impact correctness/security issue. P2 means a material reliability or product defect. These priorities combine assessment impact and operational risk; they are not vulnerability scores.

### 1. P1: The required telephony path is missing

**Confirmed source gap.** `Livekit-Agents/COLLECTION_TOOLS.md:47` explicitly says both directions use browser audio and never dial numbers. `supabase/functions/livekit-session/index.ts:33` implements browser room/token creation; `Livekit-Agents/src/agent.py:172` changes who greets first rather than placing a telephone call.

The existing role-play UI cannot demonstrate the explicit telephony requirement. Implement a real phone-number-to-agent flow, associate the trusted account/session configuration with that flow, and retain its call artifacts. An outbound collection call is a strong demonstration; both inbound and outbound are not explicitly mandated by the brief. LiveKit documents outbound calls through a SIP participant and trunk, and inbound routing through number/trunk and dispatch configuration: [outbound documentation](https://docs.livekit.io/telephony/making-calls/outbound-calls/), [inbound documentation](https://docs.livekit.io/telephony/accepting-calls/).

**Acceptance evidence:** a real phone rings or reaches the agent, verification runs, a below-minimum proposal is rejected, an eligible confirmed proposal persists once, and the same session appears in agent history with its outcome.

### 2. P1: Opening the dashboard can terminate a healthy collection session in saved state

**Confirmed logic defect.** `supabase/functions/dashboard/index.ts:38` marks active sessions failed when `last_livekit_event_at` is older than 15 minutes; every dashboard GET runs this at line 77. Only lifecycle webhook code updates that timestamp. Established conversation activity is not a lifecycle heartbeat.

A healthy call lasting more than 15 minutes without further lifecycle changes can therefore be marked failed when someone opens the dashboard. `supabase/functions/livekit-webhook/lifecycle.mjs:21` only completes connecting/active sessions, so the eventual end event does not repair this false failure. `supabase/migrations/20261104000011_collection_idempotency.sql:66` rejects collection effects for inactive sessions, extending the impact beyond a misleading badge.

Reconcile against authoritative room state or an actual heartbeat. Move reconciliation out of dashboard reads. Verify with a long-running call whose room remains connected and whose last lifecycle event is old.

### 3. P1: Browser users can alter runtime and audit evidence directly

**Confirmed policy design defect, subject to deployed grants matching the repository.** `supabase/migrations/20260925_000001_initial_schema.sql:192` grants authenticated `FOR ALL` policies with unrestricted checks on configurations, sessions, transcripts, events, metrics, traces and tool calls. No later migration replaces those policies. A normal authenticated Data API client can bypass field restrictions in the Edge Functions and alter runtime evidence where table privileges permit.

Single-organization sharing is intentional and is not the problem. Read access and editing privileges for audit/runtime rows need different boundaries. Restrict browser users to reading runtime history; keep lifecycle and observability writes behind trusted services. Preserve explicit editor operations for configurations. Test allowed and denied operations using an ordinary authenticated JWT against a disposable database.

### 4. P1: The fresh-install runbook omits required current migrations

**Confirmed reproducibility defect.** `docs/SETUP.md:133` applies only September migrations. Current `supabase/functions/livekit-session/index.ts:78` always calls `session_start_reserve`, introduced by the omitted November migration. Following the documented fresh setup leaves that function absent and call creation fails. Voice and collection updates are omitted too.

Establish one authoritative ordered migration workflow, including the currently manual history migration, and verify a fresh installation. Do not reset or clear the assessment database to accomplish this; use an isolated verification target. Retain a deployment version/ledger so reviewers know which code and schema produced each test run.

### 5. P1: Signing out leaves the active audio room connected

**Reproduced with the existing offline UI harness.** `ui/app.js:212` signs out of Supabase and hides application state without invoking call teardown or disconnecting the room. The harness retained the live session, left its modal open, and never called room disconnect.

An existing LiveKit connection is independent of the Supabase sign-out operation. The room and microphone can remain active after the UI presents the authentication screen. Disconnect the room, stop published media, close the modal and clear related timers/state on sign-out and auth-session loss. Verify with both the harness and a real browser microphone indicator.

### 6. P2: “All sessions” becomes incomplete after the hundredth call

**Confirmed requirement gap.** `ui/app.js:331` requests 100 sessions. `supabase/functions/sessions/index.ts:114` caps results at 100 and exposes neither cursor nor offset. Earlier records remain stored but cannot be browsed in the history UI once the applicable history exceeds that limit.

Add stable cursor pagination and an explicit next-page control. Verify that a user can reach the oldest record in a history containing more than 100 calls, including when filtered by agent.

### 7. P2: Agent configuration and tool assignments can be partially saved

**Reproduced UI defect plus confirmed backend transaction gap.** `ui/app.js:1291` saves the agent, then separately replaces tools. If agent creation succeeds but the tool request fails, the new ID is not retained as editor state. Repeating Save creates another agent. The harness reproduced two created agents after two attempts with failed assignment requests.

Separately, `supabase/functions/tools/index.ts:54` deletes assignments and inserts replacements in separate requests. Failed insertion loses the prior assignments; a concurrent call can snapshot the empty intermediate state.

Use a transaction-backed configuration-and-assignment save, or at minimum preserve the saved agent ID and make assignment replacement atomic. Verify failure and concurrent call-start behavior, not just successful saves.

### 8. P2: Browser lifecycle updates bypass terminal-state protections

**Confirmed logic defect.** `supabase/functions/livekit-session/index.ts:149` accepts any member of the status allowlist without checking the current state. It can attempt `completed -> active`, reset start time and retain an old end time. This either produces inconsistent state or fails a database timestamp constraint. Broad session RLS also means caller ownership is not enforced here.

Centralize transition rules, make terminal states immutable to normal clients, and define who may terminate a session. Avoid assuming the webhook's transition guard protects other write paths.

### 9. P2: The LLM component metrics listener is never attached

**Confirmed wiring defect with installed-SDK probe.** `Livekit-Agents/src/agent.py:318` inspects `session.llm` before session start. The session constructor has no LLM; the actual model is supplied only on `ConfiguredAssistant` at line 334. An offline SDK probe confirmed that `AgentSession().llm` is `None`. The listener loop skips the LLM and never revisits it.

This removes the intended per-component LLM metric/trace events. Aggregate session usage has a separate listener and is not necessarily lost. Attach metrics to the actual model instance and verify a known model event reaches the saved trace. [Official LLM metrics example](https://docs.livekit.io/reference/recipes/metrics_llm/).

### 10. P2: Identity redaction assurances contradict persisted observability

**Confirmed documentation and data-handling discrepancy.** `Livekit-Agents/COLLECTION_TOOLS.md:101` claims verification tool arguments and pre-verification transcript events are redacted. `Livekit-Agents/src/observability.py:229` persists the full user transcript, and line 375 forwards tool arguments including verification inputs. `Livekit-Agents/tests/test_transcript_visibility.py` explicitly expects full identity utterances to remain visible.

Synthetic fixtures make this a limited demo exposure today; it is not evidence that real customer data has leaked. Choose a deliberate policy for verification data, apply it consistently to transcripts, tool events, traces and exports, and make documentation accurate. Ordinary test-history retention does not require keeping raw verification secrets in every observability stream.

## AI safety and testing critique

The deterministic policy boundary is the right design. `collection.py` owns amount/date checks; policy is loaded from trusted state rather than caller/model parameters. Payment operations recheck verification, and commitment effects, receipts and audit records commit together. Keep these controls even if prompts or conversation structure change.

Confirmation is weaker than the minimum-amount invariant. The backend proves that the proposal was delivered and a later user turn exists; the model interprets whether that turn expresses agreement. The source explicitly acknowledges this at `Livekit-Agents/COLLECTION_TOOLS.md:75`. A later “No”, cancellation, or correction is not independently proved to be assent by the durable gate. This is an **assurance risk**, not a demonstrated successful natural-language exploit in this review. Preserve the LLM's role in interpreting language, but tie acceptance to the exact current proposal, invalidate it on correction/rejection, and test realistic conflicting utterances and interrupted readbacks.

The passing tests primarily prove deterministic logic and scripted transport. `Livekit-Agents/tests/test_collection_runtime.py:16` labels its scripted LLM as testing mechanics rather than intent. The real-model collection test is opt-in and was skipped. `Livekit-Agents/scenarios.yaml:8` contains three generic starter-assistant scenarios, not a collection adversarial suite. No CI workflow was found in the repository, despite starter comments referring to automatic simulation runs.

Add behavioral evidence for manager-override attempts, prompt injection, amount/currency ambiguity, repeated wrong identity answers, caller corrections, refusal after readback, interrupted confirmation, duplicate tool calls, lost responses, worker restart and phone hangup. Grade the final database effects as well as spoken responses. Audio tests must establish interruption and transcription behavior; text tests cannot establish those properties.

## Strengths worth preserving

- Private customer/collection state and collection RPCs are service-role restricted.
- Session configuration snapshots preserve what actually ran even after editor changes.
- Durable request identities, replay receipts, optimistic checks and transactional effects address duplicate writes thoughtfully.
- Signed webhook ingestion and occurrence/receipt timestamps provide a useful observability foundation.
- Failures distinguish uncertain outcomes from confirmed success or failure.
- Local public configuration omits backend secrets; the local server binds to loopback.
- The worker container has locked Python dependencies, a multistage build and a non-root runtime.
- The README generally describes the implemented browser-only and promise-to-pay scope candidly.

## Recommended delivery order and owners

| Order | Owner | Deliverable and exit condition |
| --- | --- | --- |
| 1 | Platform + backend | Reproducible complete migration/deployment path; new isolated install can start a browser call. |
| 2 | Platform + security + frontend | Protect runtime history, correct session reconciliation/transitions, and guarantee sign-out tears down audio. |
| 3 | AI systems + platform | One real telephony collection journey with correct account binding and retained session evidence. |
| 4 | Frontend + backend | Atomic agent/tool saves and complete paginated per-agent history. |
| 5 | AI systems + QA | Adversarial collection evaluation with final-state assertions, followed by real audio interruption/hangup checks. |
| 6 | Observability + QA | Correct LLM instrumentation, deliberate identity-data handling, and a curated retained reviewer test history. |

For differentiation, demonstrate policy decisions that explain *why* an offer was rejected, a replayable chain from caller proposal to accepted terms to one durable effect, and measured end-of-speech-to-first-audio latency. Report observed latency distributions and sample counts; this review has no measured latency data and does not infer performance from architecture alone.

## Validation performed and limits

- Read all two PDF pages and visually inspected both rendered pages.
- Complete offline Python suite: **54 passed, 1 skipped**. Command: `UV_CACHE_DIR=/private/tmp/voice-case-review-uv uv run --offline --no-sync pytest -q` in `Livekit-Agents/`. The skipped test uses a real model and is opt-in.
- Complete offline JavaScript suite: **43 passed** using `node --test ui/tests/*.test.cjs supabase/functions/*/*.test.mjs`. The platform review independently reran its five backend-helper suites: 16 passed; these are a subset, not 16 additional unique tests.
- Frontend reviewer reproduced logout-with-active-room and duplicate creation after partial save through the existing VM harness without changing files.
- Inspected source, SQL migrations, test doubles and setup documentation; verified installed SDK behavior for the missing LLM listener.
- LiveKit docs CLI failed DNS resolution; official documentation was checked through the web fallback.

No real microphone, carrier connection, paid inference, browser rendering/accessibility session, PostgreSQL integration test, deployed Edge handler/auth check, backup restore, or load test was run. Existing VM tests use simplified DOM/media substitutes. Passing unit/helper tests do not certify telephony, production safety, deployed RLS, or deployment readiness.
