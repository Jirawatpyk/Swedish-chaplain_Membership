COUNTS: {"candidates": 20, "confirmed": 11, "plausible": 5, "refuted": 4, "sweepNew": 3}
======================================================================
CONFIRMED:
[HIGH] importer scripts/import-members/validate.ts:115
  parseTurnover accepts any finite number (including non-integers) with no integer guard; a fractional turnover cell flows unvalidated into the bigint turnover_thb column and crashes the whole --commit transaction.
[MEDIUM] w0-02-lock src/modules/members/application/use-cases/change-plan.ts:242
  Asymmetric TOCTOU fix: changePlan resolves `newPlan` (line 174, via getPlan→findOne) BEFORE entering runInTenant/acquiring the lock, and never re-validates the new plan's deleted_at INSIDE the lock. The advisory lock only closes t
[MEDIUM] w0-09-metrics src/modules/renewals/application/use-cases/load-pipeline.ts:122
  pipelineRowCount() re-introduces the exact per-tenant membership-scale leak that the span code 10 lines above (renewals.total_in_window_bucket, lines 108-115) was deliberately added to PREVENT. The span path buckets r.summary.tota
[MEDIUM] w0-09-metrics src/modules/renewals/application/use-cases/load-pipeline.ts:125
  Wrong value: the metric is named `renewals.pipeline.row_count` and documented in metrics.ts as 'the number of rows returned for the current page' / 'pipeline page row count per load', but the call passes r.summary.totalInWindow (t
[MEDIUM] w0-09-metrics src/modules/renewals/application/use-cases/snooze-at-risk-member.ts:113
  atRiskSnooze() success counter is emitted INSIDE the runInTenant(tx) callback (before `return ok(...)` on line 114), not after commit. The comment explicitly and falsely claims 'emitted AFTER tx commit ... Emitted outside the tx b
[MEDIUM] journey-perf scripts/run-perf-tests.ts:6
  Docstring elevates this script to "the go/no-go perf gate ... a missed SLO budget here fails the pipeline," but 5 of the 18 registered renewals suites gate their numeric p95 assertion behind a SECOND env var (PERF_SLO_STRICT=1) th
[LOW] importer scripts/import-members/columns.ts:95
  splitFullName maps a single-token 'Full Name' to lastName='' which validate.ts then rejects as contactLastName 'required', dropping the whole member when its only/primary contact has a mononym.
[LOW] w0-02-lock src/modules/members/infrastructure/adapters/plan-lookup-adapter.ts:38
  plansBarrelAdapter.getPlan calls planRepo.findOne, which has NO `deleted_at IS NULL` filter (plan-repo.ts:166-181). changePlan therefore accepts a soft-deleted plan as the 'new plan' even with no race at all, and there is no delet
[LOW] w0-09-metrics src/lib/cron-auth.ts:113
  cronBearerAuthRejected() (line 160) is skipped on the 429 rate-limited rejection branch (early return at lines 113-121), even though those are also Bearer-auth rejections. The F8-A3 counter docstring/comment claims it fires on the
[LOW] journey-perf tests/e2e/member-journey.spec.ts:67
  The gated step name `'F5 pay-now affordance'` is recorded as a skip both when the F5 flag is off AND when only the ISSUED_INVOICE_ID fixture is missing (`F5 && Boolean(ISSUED_INVOICE_ID)`), conflating two distinct causes in the go
[LOW] angle-crossfile src/modules/renewals/application/use-cases/load-pipeline.ts:124
  pipelineRowCount gauge is fed r.summary.totalInWindow (total matching the window/filter) but the metric is named/documented as `pipeline.row_count` = 'number of rows returned for the current page' (the span attribute one line abov
----------------------------------------------------------------------
PLAUSIBLE:
[LOW] importer scripts/import-members/validate.ts:149
  Members are grouped solely by normalized company name (normCompanyKey: trim+lowercase+collapse whitespace), so two genuinely DISTINCT companies that share a display name are silently merged into one m
[LOW] w0-02-lock src/modules/plans/application/soft-delete-plan.ts:124
  Audit (`plan_soft_deleted`) is recorded in a SEPARATE transaction AFTER softDeleteGuarded's tx has already committed (and released the advisory lock). State and audit are not atomic — Principle VIII. 
[LOW] w0-09-metrics src/app/api/cron/renewals/at-risk-recompute/[tenantId]/route.ts:261
  atRiskRecomputeMembersSucceeded() is called with band='batch', a sentinel string that contradicts the instrument's own documented contract in metrics.ts (band 'is the NEW risk band ... bounded 4-value
[LOW] hydration-ui src/components/ui/dialog.tsx:38
  Inline comment justifying why the built-in DialogClose 'X' keeps data-slot="dialog-close" is factually wrong about the rendering: it claims the X 'renders its own icon, not a Button'. The built-in clo
[LOW] journey-perf tests/e2e/manager-journey.spec.ts:91
  The defining read-only RBAC negative — `getByRole('button', { name: /^(done|skip|reassign)$/i }).toHaveCount(0)` — passes vacuously whenever the escalation queue is empty, because in escalation-task-q
----------------------------------------------------------------------
SWEEP-NEW:
[HIGH] tests/unit/members/application/m1-in-tx-not-found.test.ts:124
  W0-02 broke this changePlan unit test: the test hand-builds `ChangePlanDeps` (lines 101-115) WITHOUT the now-required `planAdvisoryLock` dep, but change-plan.ts:242 calls `await deps.planAdvisoryLock. -> The 'M1 — changePlan surfaces not_found when the in-tx locked read misses' test now fails: the advisory-lock acquire throws on the undefined
[LOW] tests/e2e/manager-journey.spec.ts:63
  The manager read-only RBAC negatives `getByTestId('record-payment-trigger'|'void-invoice-trigger'|'refund-dialog-trigger').toHaveCount(0)` pass vacuously for many seeded invoice states. In invoices/[i -> An RBAC regression that grants a read-only manager a write affordance goes undetected because the assertion only proves 'this trigger is abs
[LOW] src/lib/metrics.ts:2819
  atRiskRecomputeMembersSucceeded docstring (lines 2806-2818) hard-states `band` is the 'bounded 4-value RiskBand enum: healthy/warning/at-risk/critical. Cardinality: 4 bands × tenant count', but the ON -> An SRE building the band-distribution panel from the documented 4-value enum sees an undocumented 5th label ('batch') carrying ALL the cron-