# Independent database validation

Audit-only, 4 November 2026. All mutations used UUID fixtures in the database team's disposable Unix-socket PostgreSQL cluster. No product changes or production access.

## Independent evidence

Command: `Livekit-Agents/.venv/bin/python -m pytest audits/idempotency/database/validation/test_independent_database.py -q` (sandbox escalation required for the local socket).

Three independently authored tests passed in 0.46 seconds:

1. Run the SQL effect inside an explicit open transaction, wait until the function completes and the connection enters `pg_sleep`, then terminate that connection before COMMIT. Callback, receipt, audit and version update all disappear. Retrying the same request key succeeds exactly once. This tests connection loss before commit; the lead separately tests lost acknowledgment after commit.
2. Modify the bound customer's balance after taking a snapshot. The stale attempt returns conflict with no effect/receipt/audit. Refresh and retry the same key succeeds.
3. Inspect the local service-role fixture and function metadata: role lacks BYPASSRLS, function uses SECURITY INVOKER, execute grant exists. Therefore superuser-driven transaction tests are not a positive test of the real Supabase worker role or gateway. This is an explicit coverage limitation, not a deployed failure claim.

Independent rerun of the lead's current suite: `Livekit-Agents/.venv/bin/python -m pytest audits/idempotency/database/test_database_idempotency.py -q`: 18 passed, 2 strict xfailed in 4.54 seconds. The xfails reproduce a new-ID callback retry identity gap and the partial-index webhook conflict-target gap. They are not satisfied safety requirements.

## Challenge and feedback

Challenged two assumptions: fixture service-role execution is not equivalent to Supabase worker permissions, and insertion faults alone omit a state-UPDATE fault boundary. Lead accepted the permission limitation and added `test_atomic_rollback_when_state_update_fails_after_callback_insert`, reporting a full-suite retest of 19 passed and 2 strict xfailed in 5.05 seconds. Independently reran that new test: 1 passed in 0.31 seconds. Confirmed it injects an UPDATE exception after callback insertion, verifies no effect/receipt/audit/version change, removes the fault, and retries the original key successfully. This closes both challenges for the bounded local-schema audit. The targeted rerun is a repeat of the lead's new case, not another unique test.

## Cross-team adjudication

Read security lead and independent security validator reports. Their same-key/different-tool and payload observations agree with actual database first-writer-wins behavior: one effect, but no mismatch rejection. It is an intent-integrity risk rather than demonstrated duplicate effect. New IDs with equal callback arguments cannot alone establish equal intent. Anonymous/authenticated grant denials do not imply production tenant-isolation coverage. Historical success replay after session closure correctly reports a prior operation without permitting another effect.

The root's session-handler replay test is separate boundary evidence with mocked dispatch; it is not part of this validator's SQL test count. No global duplicate-free claim is supported. External consumers, deployed indexes/grants, real PostgREST gateway behavior and regenerated user-intent identity remain outside this test cluster.
