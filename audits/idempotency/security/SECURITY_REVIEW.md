# Security team idempotency review

Audit-only. No product source, production schema or production records changed. All SQL writes used generated fixture sessions in a socket-only disposable PostgreSQL cluster initialized with the repository migrations. HTTP was MockTransport; actual collection transitions and SQL RPCs executed locally. User-authorized testing does not certify deployed schema or external services.

## Loop and internal validation

1. Hypotheses: durable receipt prevents repeated same-ID effects; receipt collisions may ignore tool/payload; session scope isolates receipts; untrusted roles cannot invoke collection RPCs; inactive session stops fresh effects.
2. Lead adversarial tests: `test_security_contract.py` initially 13 passing.
3. Independent validator: `validation/test_independent_replay.py` 5 backend tests and `validation/test_sql_replay_validation.py` 3 actual-SQL tests; independently falsified stronger payload binding claims and narrowed trust boundary.
4. Challenge: SET ROLE permission errors alone could be schema-USAGE denial. Added explicit `has_function_privilege`/`has_table_privilege` checks for both roles.
5. Retest: lead 15 passed. Independent validator reviewed additions. Root challenge accepted: new request IDs with same payload do not establish duplicate intent, mismatched replay is not duplicate effect, privileged probes are not browser exploits.
6. Database-team crosscheck: 12 simultaneous mismatched payload calls yielded one winning receipt/effect and no mismatch error. This corroborates the security observation using an independent concurrency test. Database team also independently confirmed transactional rollback under injected faults.

## Coverage ledger

| Claim | Lead tests | Result | Confidence/boundary |
|---|---:|---|---|
| Same key/different payload returns original receipt without second effect | 1 | Confirmed | High, actual SQL through backend |
| Same key/different tool returns original tool result | 1 | Confirmed | High; incorrect result semantics, not a duplicated write |
| Same key across different sessions is isolated | 1 | Confirmed | High for collection receipt key |
| anon/authenticated denied snapshot, commit, receipt read and effect insert | 8 | Confirmed | High for repository grants and local roles |
| Catalog grants actually deny relevant function/table privileges | 2 | Confirmed | High; removes schema-denial ambiguity |
| Closed session blocks fresh callback effect | 1 | Confirmed | High |
| Original successful receipt replays after session closure without another effect | 1 | Confirmed | High; historical result is expected replay behavior |
| Total lead tests | 15 | Passed | Independent tests counted separately |

## Findings

**P2: Receipt identity is not bound to request semantics.** `CollectionBackend.execute` returns the stored result before comparing the supplied tool or arguments. `collection_commit` similarly returns the old receipt by `(session_id, request_id)`. Reusing a key accidentally across tools can return a `verify_identity` result to a callback invocation, while applying no callback effect. Payload mismatch should be rejected under a defined operation contract if later fixed. This audit applied no fix.

**Operation identity boundary:** `CollectionTools.invoke` forwards `context.function_call.call_id`. That is provider/SDK function-call metadata, not a model tool-argument field and not an application-minted durable business-action identity. Transport retries preserve it, but a regenerated tool call can get another ID. Identical new-ID callbacks can be intentional; the code cannot determine retry vs new intent from payload equality alone.

**Protected boundary:** collection RPCs and tables revoke anonymous/authenticated access; the database binds effects to `cs.customer_id`, not an arbitrary effect customer ID. No unprivileged cross-session receipt leak or duplicate-write exploit was demonstrated.

**Historical replay:** returning a preexisting success after session closure is correct for recovery of an uncertain operation. It does not imply a new operation is allowed after closure.

## Reproduction

Start a disposable database using the database-team preparation helper. Then, from repository root:

```sh
UV_CACHE_DIR=/tmp/security-uv-cache IDEMPOTENCY_TEST_DB_CONFIG=/tmp/database-team-cluster.json uv run --project Livekit-Agents pytest audits/idempotency/security/test_security_contract.py -v
```

The explicit configuration is required; tests have no production default. Local socket access can need sandbox escalation. Review the configuration before running.

## Not certified

External callback execution and real payment side effects were not tested; the tested effects are callback request records and payment promises, not actual calls or funds transfers. Replayed receipts do not alone prove a downstream consumer will avoid repeating its effects. Live PostgREST auth behavior, deployed grants/indexes, JWT tenancy, actual LiveKit delivery, restart-generated IDs and production response loss were not tested. Single-organization authenticated access is a documented MVP policy rather than tenant-isolation proof. No security claim is made against a stolen service-role key. Root/database team cover session creation, webhooks, telemetry concurrency and broader atomicity separately.

## Final cross-team challenge: session handler

Independently reviewed and reran `audits/idempotency/test_session_handler_replay.py`: **1 passed**. It extracts the current `createBrowserSession` body and executes two identical requests with the same `Idempotency-Key`; observed **two different session IDs, two session insertion attempts and two SDK dispatch invocations**. The handler reads no idempotency header and performs no receipt reservation. This substantiates a handler-level missing retry identity mechanism, not actual duplicate production sessions. Database and SDK are mocked and the `withSupabase` authentication wrapper is not executed. Failures, real database constraints and remote dispatch behavior are not covered. A passing reproduction test asserts the existing defect, not that the handler is safe.

Database-validator qualification: the disposable fixture creates a plain `service_role` without Supabase's BYPASSRLS behavior. SQL effect tests execute as the cluster owner and therefore prove transaction/constraint behavior, not successful positive worker-role RLS execution. Explicit anonymous/authenticated privilege denials remain valid negative checks. No positive deployed service-role claim is made.
