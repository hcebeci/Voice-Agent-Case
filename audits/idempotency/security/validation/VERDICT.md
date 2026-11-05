# Independent security validation

Audit only. No product changes or production writes. Tests run 4 November 2026.

## Evidence

- `test_independent_replay.py`: 5 passed; independent application-wrapper and backend probes with an in-memory RPC boundary. Command from `Livekit-Agents`: `UV_CACHE_DIR=/tmp/security-validator-uv-cache uv run --no-sync pytest ../audits/idempotency/security/validation/test_independent_replay.py -q`.
- `test_sql_replay_validation.py`: 3 passed; real PostgreSQL built from repository migrations by database team. Writes restricted to synthetic fixtures in `/tmp/database-team-cluster.json`. Same command with the SQL test filename; local socket requires sandbox escalation.
- SQL test shares the database team's fixture adapter, but assertions are independent. It does not independently provision PostgreSQL, so provisioning integrity remains a shared dependency.

## Claim verdicts

| Claim | Verdict | Evidence / limit |
|---|---|---|
| Same session/request ID prevents repeat effects | Confirmed within tested path | Real SQL collision probe leaves one callback, one receipt. Concurrency coverage belongs to database team's tests. |
| Request IDs are bound to tool and payload | Rejected | Real SQL and backend probes return original callback result to a later `verify_identity` call with the same key. No tool/payload fingerprint rejection. This is a semantic collision, not a second write. |
| Identical request keys cross session boundaries | Rejected | Distinct sessions with the same key create independent callbacks and never retrieve the other session's receipt. |
| Request identity is app-controlled | Narrowed | Not a model tool argument; `CollectionTools.invoke` forwards `context.function_call.call_id` unchanged. The installed inference transport builds that from provider tool-call metadata. It is not a durable app-minted user-intent ID. No evidence that an ordinary caller can directly control this value. |
| Session closure blocks fresh effects | Confirmed | Actual SQL: fresh callback gets SESSION_NOT_ACTIVE and no second callback. A prior key still returns historical success, correctly without a new effect. |
| New key with matching arguments is automatically the same intent | Rejected | Cannot infer intent from arguments alone. Database team reproduced two callbacks under new IDs; describe as unprotected retry boundary, not every pair of matching requests being a bug. |
| Session handler enforces Idempotency-Key | Rejected by source review | Handler does not consume header and creates fresh UUID. Executable handler replay belongs to team lead/root evidence. |
| Wrong-tool replay is an unprivileged security exploit | Unverified / unsupported | Tests use trusted worker or privileged DB path. No cross-user exploit demonstrated. |
| Anonymous/authenticated roles lack RPC execute privilege | Confirmed in migrated local schema | Lead added direct function/table privilege catalog checks after challenge; independent rerun of revised suite: 15 passed. No claim about deployed schema. |
| Whole system is duplicate-free | Rejected | New operation identity and session creation remain uncovered; cannot extrapolate scoped receipt protection to all business actions. |

## Feedback loop

Sent lead initial independent results and required narrowing of request-ID trust claim. Independently inspected its 13 passing DB tests and challenged role-denial specificity: requested direct function-privilege checks because a generic permission error alone does not isolate the cause. Requested retest, not a product fix. Lead also received actual-SQL collision, cross-session, and closed-session results.

Lead responded with two catalog-privilege cases covering anon/authenticated and reran its suite (15 passed). Independent validator reran the revised 15-case suite successfully. This closes the specific permission-evidence challenge for the local migrated schema.

## Outstanding

No production schema/permission verification, HTTP gateway auth validation, provider adversarial ID manipulation, or crash-during-remote-dispatch recovery test in this bounded round. SQL constraints and service-role trust boundaries must not be described as global guarantees.
