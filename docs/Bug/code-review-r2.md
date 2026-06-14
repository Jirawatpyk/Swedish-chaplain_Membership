COUNTS {"candidates": 14, "confirmed": 2, "plausible": 2, "refuted": 10, "sweepNew": 3}
--- KEPT ---
[CONFIRMED/medium] dialog-pipeline scripts/import-members/validate.ts:120
  S: parseTurnover's new `Number.isInteger(n)` guard fixes fractional inputs but NOT magnitude overflow. A turnover cell larger than Postgres bigint max (9223372036854775807 ≈ 9.2e18), e.g. '99999999999999999999', parses to the integer-valued double 1e20 — `Number.isInteger(1e20)` is `true`, so it passes through to the bigint `turnover_thb` INSERT.
  V: CONFIRMED — the remediation closes the fractional-turnover hole but leaves an equivalent magnitude-overflow hole that re-exposes the exact "opaque DB abort + whole-import rollback" the fix's own comment claims to prevent.

Chain verified against source:

1. scripts/import-members/validate.ts:114 — `
[CONFIRMED/low] parseturnover-cron scripts/import-members/validate.ts:120
  S: parseTurnover now uses Number.isInteger but still admits NEGATIVE integers; a turnover cell like "-5000000" passes validation and is inserted into the turnover_thb bigint as a nonsensical negative value with no warning.
  V: CONFIRMED as a live defect — the candidate's premise (parseTurnover admits negative integers with NO warning) is exactly right; only its predicted downstream symptom ("silently persists garbage") is wrong, and the real symptom is worse.

INPUT → WRONG OUTPUT chain (all quoted):
1. scripts/import-mem
[PLAUSIBLE/low] m1-test-crossfile scripts/import-members/validate.ts:120
  S: parseTurnover now uses Number.isInteger but still silently truncates integers above Number.MAX_SAFE_INTEGER (turnover_thb is a bigint column).
  V: The numeric mechanism is real and I verified it directly. In scripts/import-members/validate.ts:

- Line 114: `const n = Number(t);` — for `t = "9007199254740993"` (2^53 + 1) this yields `9007199254740992` (precision loss; Node confirmed `String(n) !== t`).
- Line 120: `return Number.isInteger(n) ? 
[PLAUSIBLE/low] m1-test-crossfile src/modules/renewals/application/use-cases/load-pipeline.ts:124
  S: pipeline.row_count gauge value changed from totalInWindow to r.rows.length; docs/observability.md still labels it 'per-load summary'.
  V: Candidate is a doc-clarity nit, not a runtime defect. Facts verified:

1. Code change is correct and intentional. `src/modules/renewals/application/use-cases/load-pipeline.ts:124-127` now emits `r.rows.length` (page rows, bounded <=50) instead of `r.summary.totalInWindow`:
   `renewalsMetrics.pipeli
--- SWEEP-NEW ---
[low] src/lib/cron-auth.ts:118
  S: The remediation added renewalsMetrics.cronBearerAuthRejected() in the 429 (rate-limited) branch so the F8-A3 OTel counter keeps incrementing under a sustained probe, but the 429 branch returns at line 119 BEFORE the audit-emit block (lines 137-158). Result: rate-limited rejections now increment cron_bearer_auth_rejected_total WITHOUT writing a matching cron_bearer_auth_rejected audit_log row.
  -> An attacker sends 100 unauthenticated cron requests/min from one IP. Requests 1-60 take the success-of-ratelimit path → counter +1 AND audit row each. Requests 61-100 hit the 429 branch → counter +1 e
[low] src/modules/renewals/application/use-cases/snooze-at-risk-member.ts:77
  S: The member_not_found branch returns err(...) from inside the runInTenant callback (normal return, not throw), so the REAL runInTenant COMMITS the transaction. The new metric guard `if (txResult.ok)` correctly skips the counter, but the committed empty tx is relied upon being harmless. setRiskSnoozedUntil returned affectedRows=0 so no rows changed — currently benign, but if a future edit adds any pre-check write before the affectedRows===0 return, it would be committed on the not_found path rather than rolled back.
  -> Today the only statement before the early err return is setRiskSnoozedUntil (affectedRows=0 → no-op), so the commit is harmless. The latent hazard: the not_found path uses `return err(...)` (commit) r
[low] tests/unit/members/application/m1-in-tx-not-found.test.ts:116
  S: The added planAdvisoryLock mock is necessary (without it changePlan would TypeError on deps.planAdvisoryLock.acquire and the catch at change-plan.ts:387 would map to server_error, masking the not_found assertion), but the test asserts only the final not_found result — it does NOT assert acquire() was called or called BEFORE findByIdInTx. The lock-ordering invariant (lock acquired as the FIRST tx statement to serialise with softDeleteGuarded, change-plan.ts:242) is therefore unguarded by this regression test.
  -> A future refactor that moves deps.planAdvisoryLock.acquire(tx, lockKey) to AFTER findByIdInTx/updateFieldsInTx — or drops it entirely on the not_found short-circuit — would still pass this test (it re