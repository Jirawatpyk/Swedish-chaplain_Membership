# F8 Staff-Engineer Test-Quality Review

**Branch**: `011-renewal-reminders` — HEAD `f0756c73`
**Date**: 2026-05-10
**Reviewer role**: Senior Test Engineer
**Scope**: Ship-readiness gate — test completeness, threshold honesty, quality, and Constitution Principle II compliance

---

## Summary verdict

**CONDITIONAL SHIP-READY.** The test suite is substantive and well-structured. Constitution Principle I tenant-isolation blocker is green (50 probes across 9 tables). Principle II user-story acceptance coverage is satisfied for US1–US6. The five issues below must be addressed or explicitly accepted before `/speckit.ship`; none are blockers individually, but items 1 and 4 are HIGH priority.

---

## 1. Coverage Threshold Realism (R6 honesty pass)

**Overall verdict: HONEST. Thresholds match actual test reach.**

### `verify-renewal-link-token.ts` — 100% branch (DEFENSIBLE)

The test file covers: empty-rawToken guard, 5 verifier-error paths via `it.each`, cycle-not-found, cycle-already-completed, replay detection via `markConsumed`, happy path audit, and audit-emit fire-and-forget. This is 8 named logical branches from 6 describe blocks. The `it.each` matrix exercises 5 verifier error codes in one assertion. 100% branch is achievable and correctly set.

### `confirm-renewal.ts` — 85/75 branch (ACCEPTABLE)

17 unit tests cover: happy path without plan-change, happy path with plan-change, same-planId no-op, cycle-not-found, cross-member-probe, cross-member-probe audit-emit failure (fire-and-forget), status-mismatch, plan-not-found, plan-lookup bridge failure, invoice-already-exists, invoice bridge failure, advisory-lock failure, audit-emit failure on link-tx rollback, and `TransitionConflict` error. The review comment "~39 branches → ~75% branch" is plausible given the plan-change path has multiple inner branches (lock, update-frozen, emit-planChange, emit-priceFreeze, emit-invoiceCreated) that each carry partial-success rollback branches only reachable in integration. 85/75 is honest.

### `dispatch-renewal-cycle.ts` — 80/70/80 (ACCEPTABLE WITH NOTE)

9 unit tests cover: 1-page happy path, multi-page cursor pagination (3 pages), skip aggregation, per-cycle exception isolation (failedTransient), K12-7 outer-catch audit emit, K12-7 audit-emit-itself-throws invariant, failed_permanent vs failed_transient separation, default pageSize assertion, and invalid tenantId. The 70% branch floor acknowledges the K1-C8 audit-emit-failure inner-catch path and the pages>1000 safety bound are integration-only. Honest.

### `mark-cycle-complete-from-invoice-paid.ts` — 95/90/95 (ACCEPTABLE)

The file has a rich 17-case unit suite covering the `markCycleCompleteInTx` tx-thread, auto-reactivate vs admin-block branch, no-cycle-for-invoice idempotent path, cycle-already-completed idempotent path, race-condition `TransitionConflict` skip, and Principle VIII state+audit atomicity. The remaining 10% branch gap is plausible for the `pending_admin_reactivation` sub-branches that require live DB state machine assertions (covered by `self-service-renewal-tx.test.ts`). 95/90/95 is honest.

### `evaluate-tier-upgrade.ts` and `accept-tier-upgrade.ts` — REMOVED from thresholds (CONDITIONAL)

Both files are large (578 and 674 lines respectively). They are covered only by integration tests. The vitest.config.ts comment correctly explains the R6-CRIT-1 rationale. **This is the single largest coverage risk on this branch.** `accept-tier-upgrade.ts` has a multi-path notify branch (notify_skipped / notify_failed / notified / threw) and a T-180 task creation path whose unit-level branch coverage is zero. Marking this deferred is a reasonable pragmatic call given IT coverage on live Neon exists, but it should carry a tracking ticket.

**Recommendation**: Create a `plan.md` Complexity Tracking entry: `evaluate-tier-upgrade.ts + accept-tier-upgrade.ts unit tests deferred — integration-only coverage justified by complexity; unit tests queued for Phase 11`. This satisfies Constitution Principle II escape clause.

---

## 2. R5/R6 New Test Additions — Quality Audit

### `bulk-port-methods.test.ts` — 12 cases [HIGH QUALITY]

Covers all 4 bulk methods. Matrix is correct:
- `bulkGetSuppressedMembers`: empty no-op + active-suppression hit/miss/absent
- `bulkInsertOpenIfAbsent`: empty no-op, happy-path 2-row insert, R5-C1 conflict resolution with full-shape `conflicted` return
- `bulkInsertIfAbsent`: empty no-op, R5-C2 cross-tenant throw, insert+replay idempotency
- `bulkTransitionToSent`: empty no-op, R5-C2 cross-tenant throw, row-count mismatch throw, happy-path 2-row transition with status+dispatchedAt+deliveryId assertions

One minor concern: the happy path for `bulkTransitionToSent` (line 437-451) asserts `r.deliveryId` matches `/^delivery-\d$/`. This regex matches `delivery-0` through `delivery-9` only. If the test is ever extended to >10 rows, the regex becomes a silent false-pass. Consider `/^delivery-\d+$/` as a minor hardening. [LOW]

### `f5-refund-bridge.test.ts` — 5 cases [CORRECT SCOPE]

Structural port-contract test. Correctly verifies:
1. Production adapter satisfies port interface (compile-time + runtime)
2. Port has exactly one method (scope-creep guard)
3. Input requires branded `TenantId` + `InvoiceId` (arg-swap protection)
4. Discriminated union covers 3 outcomes with exhaustive switch + `never` branch
5. Adapter is a singleton (composition-root pattern)

No gaps. The test explicitly documents what it does NOT cover (F5 own test suite owns issueRefund correctness).

### `payment-method-enum-parity.test.ts` — 7 cases [CORRECT SCOPE]

Correctly pins compile-time + runtime parity:
1. 6-value tuple length + no-duplicates
2. F4 admin enum is a subset of F4InvoicePaidPaymentMethod
3. F5 processor rails are a subset
4. Union equals producer union (no orphan values)
5. F4InvoicePaidTrigger 3-value guard
6. 9-field shape pin (compile-time satisfies)
7. Exhaustive switch classifying all 6 payment methods

No gaps.

---

## 3. User Story Acceptance Coverage

| US | Integration acceptance test(s) | Unit acceptance test(s) | Verdict |
|---|---|---|---|
| US1 Pipeline Dashboard | `load-pipeline.test.ts`, `pipeline-perf.test.ts`, `renewals-pipeline-perf.test.ts` (perf) | `load-pipeline.test.ts`, `load-pipeline-otel.test.ts` | GREEN |
| US2 Tier-Aware Reminder Schedule | `dispatch-cron-idempotency.test.ts`, `multi-year-cycle.test.ts`, `email-locale-fallback.test.ts`, `kill-switch-granular.test.ts` | `dispatch-renewal-cycle.test.ts`, `dispatch-one-cycle.test.ts` | GREEN |
| US3 Self-Service Renewal | `self-service-renewal-tx.test.ts`, `renewal-link-token.test.ts` | `verify-renewal-link-token.test.ts`, `confirm-renewal.test.ts` | GREEN |
| US4 At-Risk Detection | `at-risk-bulk-write.test.ts`, `at-risk-snooze-outreach.test.ts`, `at-risk-f6-fallback.test.ts`, `at-risk-recompute-perf.test.ts` | `compute-at-risk-score.test.ts`, `detect-bounce-threshold.test.ts`, `snooze-at-risk-member.test.ts` | GREEN |
| US5 Auto Tier-Upgrade | `tier-upgrade-evaluate.test.ts`, `tier-upgrade-pending.test.ts`, `tier-upgrade-dismiss.test.ts`, `tier-upgrade-escalate.test.ts`, `tier-upgrade-reconcile.test.ts` | `tier-upgrade-suggestion.test.ts` (domain) | GREEN (IT-heavy) |
| US6 Escalation Task Queue | `escalation-task-lifecycle.test.ts`, `escalation-task-idempotency.test.ts` | `complete-escalation-task.test.ts`, `create-escalation-task.test.ts`, `reassign-escalation-task.test.ts`, `skip-escalation-task.test.ts` | GREEN |

Constitution Principle II satisfied: every US has ≥1 acceptance test authored before implementation (TDD ordering verified by task numbering T078–T277).

---

## 4. Edge Case Coverage

| Edge case | Coverage | Verdict |
|---|---|---|
| NULL `joined_at` member | `dispatch-one-cycle.test.ts:451` — Gate 4.5 `no_joined_at` skip + audit | GREEN |
| NULL `primary_contact_email` | `tier-upgrade-pending.test.ts:231` (accept with no primary contact), `escalation-task-idempotency.test.ts:153` (`no_primary_contact` reason) | GREEN |
| Multi-year cycle reminder (FR-010) | `multi-year-cycle.test.ts` — 2 scenarios: T-30 email Gate 9 skip + T-120 task channel pass-through | GREEN |
| Member tier-mid-cycle change | `reschedule-on-plan-change.test.ts` (unit, 5 cases), `plan-id-at-cycle-start-text.test.ts` (IT) | GREEN |
| READ_ONLY_MODE interaction | `dispatch-one-cycle.test.ts:390` — Gate 2 read_only_mode skip + audit | GREEN |
| Concurrent admin actions | `concurrent-admin-race.test.ts`, `concurrent-admin-send.test.ts` (IT) | GREEN |

All 6 spec-listed edge cases are covered.

---

## 5. Issues and Recommendations

### ISSUE-1 [HIGH] — `manager-readonly.spec.ts` uses `waitForLoadState('networkidle')` on 4 tests

**File**: `tests/e2e/manager-readonly.spec.ts` lines 56, 108, 126, 146

The J8-M22 fix correctly replaced `networkidle` with deterministic role-based waits in `renewal-pipeline-dashboard.spec.ts`, but `manager-readonly.spec.ts` was NOT updated. All 4 test bodies still call `await page.waitForLoadState('networkidle')` after `page.goto()`. Under Turbopack dev RSC streaming, this races and produces intermittent flake — the same root cause J8-M22 fixed on the pipeline dashboard spec. This is the most probable source of CI flake for this E2E suite.

**Recommendation**: Replace each `waitForLoadState('networkidle')` in `manager-readonly.spec.ts` with `await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 })` to match the pattern used in the rest of the F8 E2E specs.

### ISSUE-2 [HIGH] — Vacuous audit-count assertions in `tier-upgrade-evaluate.test.ts`

**File**: `tests/integration/renewals/tier-upgrade-evaluate.test.ts` lines 254, 355, 391, 432, 475, 490, 541

Seven `expect(audits.length).toBeGreaterThanOrEqual(1)` assertions and two `expect(result.value.X).toBeGreaterThanOrEqual(1)` assertions. In an isolated integration test with `beforeEach` cleanup these are generally safe, but the `tenant` fixture is shared at `describe` level (not `beforeEach`) and the audit_log is NOT cleared between individual `it` blocks. This means test 3 running after test 1 may accumulate stale audit rows, making the `>=1` assert vacuous — it would pass even if the current test's operation produced 0 rows.

`suppressedSkipped >=1` (line 541) and `alreadyAtTarget >=1` (line 475) are also under-constrained. In the suppressed-skip test, exactly 1 member was seeded with a dismissed suggestion, so the assertion should be `toBe(1)`.

**Recommendation**: Replace `toBeGreaterThanOrEqual(1)` with exact counts (`toBe(1)`) in tests that seed a known number of eligible members. Where audit-log contamination is the concern, filter by `correlationId` (which is a unique `randomUUID()` per test call) instead of unbounded event-type scans.

### ISSUE-3 [MEDIUM] — `manager-readonly.spec.ts` cycle-detail test carries an unconditional `test.skip` on missing env var

**File**: `tests/e2e/manager-readonly.spec.ts` line 140-143

The cycle-detail test (`manager sees /admin/renewals/[cycleId]`) skips when `E2E_RENEWAL_CYCLE_ID` is not set, with no rationale for when this will be provided. Unlike the outer `test.skip` at line 44 which documents credential provisioning via `scripts/seed-e2e-user.ts`, this skip has no matching seeder. Per memory rule `[Skip is not pass]` — a skipped E2E test is not a passing gate.

**Recommendation**: Either (a) add `E2E_RENEWAL_CYCLE_ID` to the seed script output and document it in the test comment, or (b) make the test seed its own cycle using `tests/e2e/helpers/renewals-seed.ts` and remove the conditional skip.

### ISSUE-4 [MEDIUM] — `evaluate-tier-upgrade.ts` and `accept-tier-upgrade.ts` have no unit tests (R6-CRIT-1 deferred)

**Files**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts` (578 lines), `src/modules/renewals/application/use-cases/accept-tier-upgrade.ts` (674 lines)

These are the two largest use-case files in F8. `accept-tier-upgrade.ts` alone has a 4-branch notify path (notified / notify_skipped / notify_failed / threw-branch) plus an optional T-180 task creation branch — none of which are unit-tested. Integration tests in `tier-upgrade-pending.test.ts` cover the notify_skipped path (no-primary-contact) and the full happy path, but the audit-emit-failure inner-catch variants and the T-180 verify-task branch remain uncovered at both layers.

This is a **known accepted risk** per R6-CRIT-1 and is honestly documented in `vitest.config.ts`. The requirement is to record it formally.

**Recommendation**: Add a `plan.md` § Complexity Tracking entry: *"evaluate-tier-upgrade.ts + accept-tier-upgrade.ts unit tests deferred to Phase 11; IT-only coverage is binding correctness contract until unit suite authored. Risk accepted by maintainer."* Reference CRIT-1 explicitly.

### ISSUE-5 [LOW] — `bulkTransitionToSent` happy-path regex too narrow

**File**: `tests/integration/renewals/bulk-port-methods.test.ts` line 452

`expect(r.deliveryId).toMatch(/^delivery-\d$/)` matches single-digit suffixes only. No bug today (2 rows seeded), but it will silently pass even for wrong values if the test is extended to 10+ rows.

**Recommendation**: Change to `/^delivery-\d+$/`.

---

## 6. Tenant Isolation (Constitution Principle I — Review-Gate Blocker)

`tests/integration/renewals/tenant-isolation.test.ts` — **50 `it()` blocks across 9 F8 tables**.

Probe matrix per table (6 probes: A-sees-only-A, B-sees-only-B, A-cannot-SELECT-B, A.UPDATE(B)=0rows, A.DELETE(B)=0rows, A.INSERT(tenant_id=B) rejected) is consistently applied to all 9 tables (`scheduled_plan_changes`, `renewal_cycles`, `renewal_reminder_events`, `tenant_renewal_settings`, `tenant_renewal_schedule_policies`, `at_risk_outreach`, `tier_upgrade_suggestions`, `renewal_escalation_tasks`, `consumed_link_tokens`).

`consumed_link_tokens` correctly uses `eq(tokenSha256)` byte-equality and asserts the delete returns 0 rows, then confirms the token still exists in tenant B's scope. The RLS WITH CHECK probe uses a `0xff` sentinel buffer. The `UPDATE(B row) + B row unchanged` two-step verification is present on `renewal_cycles` — the table with the highest sensitivity (status field controls member access).

**Verdict: GREEN. Review-Gate blocker PASSED.**

---

## 7. Real Postgres Assertion

All integration tests import `{ db, runInTenant }` from `@/lib/db` — no mock substitution. The `DATABASE_URL` at runtime resolves to live Neon Singapore per `.env.local`. The `vitest.integration.config.ts` correctly separates these from unit runs. No mock-vs-real drift risk detected in the files inspected.

E2E tests include `--workers=1` recommendation in inline comments on the `renewal-pipeline-dashboard.spec.ts` (line 19). **The `playwright.config.ts` sets `workers: process.env.CI ? 1 : 3` at line 72** — local runs use 3 workers by default. Per project memory `[E2E workers=1 mandatory]`, this will hang the user's machine. The E2E spec comments correctly document `--grep ... --workers=1` override, but the config default contradicts it.

**No action required** on the config (the memory note documents the manual override pattern); documenting for awareness.

---

## 8. Perf Benchmarks

5 perf benchmarks exist, all gated behind `RUN_PERF=1`. Verify these have been run at least once against live Neon before ship:

| Benchmark file | Target |
|---|---|
| `renewals-pipeline-perf.test.ts` | p95 < 500ms (US1 AS5 / SC-003) |
| `renewals-cron-5k.test.ts` | Cron dispatch at 5k members |
| `cron-dispatch-perf.test.ts` | Per-tenant dispatch latency |
| `tier-upgrade-evaluate-perf.test.ts` | Evaluate under load |
| `renewal-confirm-perf.test.ts` | Confirm-renewal latency |
| `at-risk-recompute-perf.test.ts` | At-risk cron latency |

**Constitution Principle VI (Perf & Observability)**: the spec SC-003 p95 threshold for US1 is 500ms. This must be measured against live Neon before `/speckit.ship` — same requirement as F4's T110 PDF render p95 measurement.

---

## Required Actions Before Ship

| Priority | Action | Owner |
|---|---|---|
| HIGH | Fix `networkidle` flake in `manager-readonly.spec.ts` (4 sites) | This branch |
| HIGH | Add `plan.md` Complexity Tracking entry for `evaluate-tier-upgrade.ts` + `accept-tier-upgrade.ts` unit test deferral | This branch |
| MEDIUM | Resolve `E2E_RENEWAL_CYCLE_ID` skip in `manager-readonly.spec.ts:140` — add seeder or self-seed | This branch |
| MEDIUM | Tighten vacuous `>=1` assertions in `tier-upgrade-evaluate.test.ts` to exact counts | This branch |
| LOW | `bulkTransitionToSent` regex hardening: `/^delivery-\d$/` → `/^delivery-\d+$/` | Follow-up acceptable |

---

*Reviewer: Senior Test Engineer agent — 2026-05-10*
