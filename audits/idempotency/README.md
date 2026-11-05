# Layered idempotency cross-check

Scope: audit and tests only. No production writes, live calls, deployed changes, or application fixes. Test-generated business records belong to disposable local databases.

## Team structure

- Security team lead: threat hypotheses, adversarial reproductions, and first assessment.
- Security team validator: independent falsification, positive controls, and revised verdict.
- Database team lead: real PostgreSQL migrations, transaction/concurrency/fault tests, and first assessment.
- Database team validator: independently rerun and challenge database assumptions and evidence.
- Root coordinator: cross-team challenges, test reconciliation, scope verification, and final adjudication.

The four-agent concurrency limit means the two internal validators run in successive waves while both leads remain available. They are distinct agents, not two roles played by a single reviewer.

## Required feedback loop

1. Lead records a falsifiable claim and an executable test.
2. Internal validator independently reruns or constructs a counterexample.
3. Lead accepts, rejects with evidence, or narrows the claim; reruns affected tests.
4. The other team challenges assumptions about scope, identity, privilege, and persistence.
5. Root reconciles counts and disputes, preserving unverified boundaries.

Passing a test that reproduces unsafe behavior is not equivalent to passing the desired safety requirement. Reports must distinguish validated protections, reproduced gaps, and conditional/unverified claims.

Existing uncommitted work is preserved. A root-owned checksum baseline of tracked files is held outside the repository for an end-of-audit application-scope check.
