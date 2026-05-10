# F8 Test Coverage Review — Phase 10 REVIEW-READY

**Branch**: `011-renewal-reminders` (118 changed files, +109k LOC vs `main`)
**Date**: 2026-05-10
**Reviewer scope**: test-engineering only — TDD discipline, behavioural coverage, regression-catch potential.

---

## 1. Summary

F8 test coverage is **broad and disciplined** — the 41 application use-cases have ~32 dedicated unit-test files plus 46 integration files hitting live Neon Singapore plus 9 F8-specific E2E specs. The Spec Kit gates have produced strong gate-by-gate coverage on the dispatch decision tree (28 tests across 12 gates) and security-critical paths like `verify-renewal-link-token` (10 tests covering all 5 verifier-error branches + race window + replay) and `confirm-renewal` (17 tests including Principle VIII rollback variants).

The most significant concerns are **(a) absence of vitest threshold gates** for F8 security-critical files (silent regression risk), **(b) two newly-added bulk repo methods that are not yet wired into any test**, and **(c) cross-module integration thinness** in two places (audit-emit-rollback has only 1 test on the dispatch side; `rescheduleOnPlanChange` cascade has no integration coverage at all).

---

## 2. Critical Gaps (rating 8-10)

### G1. Missing vitest coverage thresholds for F8 security-critical files — BLOCKER (rating 9)

**File**: `vitest.config.ts:51-227`

`vitest.config.ts` enumerates 100% branch thresholds for **F1 auth** (5 files), **F2 plans** (4 files), **F3 members** (5 files), and **F5 payments** (3 files), but contains **zero F8 entries**. Constitution Principle II requires 100% branches on security-critical use cases — F8's analogues are unprotected:

- `src/modules/renewals/application/use-cases/verify-renewal-link-token.ts` (token verifier — equivalent to sign-in)
- `src/modules/renewals/application/use-cases/confirm-renewal.ts` (state-mutating with Principle VIII rollback)
- `src/modules/renewals/application/use-cases/dispatch-renewal-cycle.ts` (cron entry — affects all members)
- `src/modules/renewals/application/use-cases/_lib/dispatch-one-cycle.ts` (12-gate decision tree)
- `src/modules/renewals/application/use-cases/accept-tier-upgrade.ts` + `apply-pending-tier-upgrade.ts` (state + plan mutation)
- `src/modules/renewals/application/use-cases/compute-at-risk-score.ts` (scoring + Principle VIII)
- `src/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid.ts` (F4 bridge)
- `src/modules/renewals/domain/**/*.ts` (currently no `100% lines/branches` block — F1/F2/F3/F5 all have one)

**Failure this catches**: Any future commit silently dropping a security-critical branch (e.g. removing the cross_member_probe audit emit in `confirm-renewal.ts:88-110`) passes the test suite without surfacing a coverage drop.

**Fix**: add `'src/modules/renewals/domain/**/*.ts': { lines: 100, branches: 100, functions: 100, statements: 100 }` plus per-file 100% branch entries for the 8 use-cases listed above, mirroring the F5 pattern at `vitest.config.ts:184-198`.

### G2. T262 bulk methods on RenewalReminderEventRepo are untested — BLOCKER (rating 8)

**Files**: `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:330-425`, `src/modules/renewals/application/ports/renewal-reminder-event-repo.ts`

Commit `2caa8d74` ("T262 batched-write infrastructure") added two new public port methods + Drizzle adapters with **risky SQL**:

- `bulkInsertIfAbsent`: multi-row `INSERT ... ON CONFLICT DO NOTHING` against `renewal_reminder_events_idem_idx` plus a `Set`-based filter to derive `conflicted` from inserted rows by reconstructing natural-key strings (line 369-379).
- `bulkTransitionToSent`: multi-row `UPDATE … SET dispatchedAt = CASE WHEN id=… THEN …::timestamptz` with hand-written SQL `CASE` expressions (line 396-409).

Grep across `tests/` for these symbol names: **0 matches**. The commit message admits the wiring into `dispatchRenewalCycle` was deferred to follow-up work — these methods are dead weight until wired, but the **SQL adapter is shipping**. A Drizzle version bump or a column rename will silently break the multi-row INSERT or the `CASE` shape and there is no test to catch it.

**Failure this catches**:
- Drizzle 0.x → 0.y syntax change to `onConflictDoNothing({ target: [...] })` shape
- Schema rename of `dispatchedAt` / `deliveryId` columns (TS will catch shape but not the SQL `CASE` literal)
- Race condition where a row falls through `bulkTransitionToSent` because its `status='pending'` predicate fails (e.g. defensive cleanup raced)

**Fix**: minimum 3 integration tests in a new `tests/integration/renewals/bulk-reminder-event-repo.test.ts`:
1. happy `bulkInsertIfAbsent` with 5 inputs, 2 of which already conflict — assert `inserted.length === 3` AND `conflicted.length === 2` AND natural-key matching.
2. happy `bulkTransitionToSent` with 3 distinct `dispatchedAt` timestamps and 3 distinct `deliveryId` values — assert per-row CASE binding lands the right value on the right row.
3. `bulkTransitionToSent` with one row that has already transitioned (status='failed') — assert it is skipped (returned array length=2 not 3) without raising.

### G3. opt-in/opt-out renewal preferences has no integration test — HIGH (rating 8)

**Files**: `src/modules/renewals/application/use-cases/opt-in-renewal-reminders.ts`, `opt-out-renewal-reminders.ts`, `src/app/(member)/portal/preferences/renewals/page.tsx`

Both use-cases have unit tests (`tests/unit/renewals/application/use-cases/opt-in-renewal-reminders.test.ts`, etc.) but `tests/integration/renewals/` contains no `opt-*.test.ts` file. The portal preferences page exists but no E2E spec exercises the toggle (only the a11y + i18n smoke specs visit the URL — `tests/e2e/renewal-a11y.spec.ts:140`, `tests/e2e/renewal-i18n.spec.ts`).

This is the **only member-facing F8 mutating surface** (FR-027/FR-028 self-service opt-out) without integration or E2E behaviour coverage. Member portal cookie + RLS + `runInTenant` interactions for the member role specifically are not exercised on this surface.

**Failure this catches**: a future RLS policy change excluding members from updating their own `members.renewal_reminders_opted_out` flag would ship green.

**Fix**: add `tests/integration/renewals/opt-in-out-self-service.test.ts` with 4 cases (opt-out → flag flip + audit; opt-in → flag clear + audit; member-of-other-tenant attempt → cross_tenant_probe; idempotent re-opt-out → no double audit). Plus add a 1-test E2E spec exercising the toggle end-to-end with the existing `signInAsMember` helper.

---

## 3. Important Improvements (rating 5-7)

### G4. `audit-emit-rollback.test.ts` exercises only the dispatch side (rating 7)

**File**: `tests/integration/renewals/audit-emit-rollback.test.ts:1-300` — only 1 test (`emit failure inside success-path tx → rollback + defensive transition to failed`).

Principle VIII rollback is exercised at unit level for `confirm-renewal` (3 unit tests), `compute-at-risk-score` (1 unit test), `mark-cycle-complete-from-invoice-paid` (1 unit test), and `reschedule-on-plan-change` (2 unit tests). But `audit-emit-rollback.test.ts` integration exercises only `dispatchRenewalCycle`. The other Principle-VIII paths rely on `runInTenant` + the audit emitter behaving correctly at the **integration** level — unit tests mock `runInTenant` as a passthrough that doesn't actually rollback (per the test file docstring lines 7-12).

**Fix**: add 1 integration test per remaining Principle VIII surface — minimally `confirm-renewal` (since it mutates F4 via `linkInvoice`) and `mark-cycle-complete-from-invoice-paid` (F4 webhook entry). Each test pattern: spy `auditEmitter.emitInTx` to throw on the success-path event, assert the F4-side mutation rolled back via direct SQL.

### G5. `f4-callback-rollback.test.ts` is structural-only (rating 6)

**File**: `tests/integration/renewals/f4-callback-rollback.test.ts:1-250`

The 4 tests verify (a) callback array length=2, (b) function arity ≤2, (c) per-tenant factory distinctness, (d) ReadonlyArray. None verify the **actual** rollback semantics: that a thrown exception from `f8OnPaidCallbacks[0]` (cycle-completion) inside the F4 transaction rolls back the F4 invoice paid-state mutation. Unit-level coverage exists at `tests/unit/renewals/infrastructure/f8-on-paid-callbacks.test.ts` (8 tests) but uses mocked tx context.

**Fix**: 1 integration test that seeds an F4 invoice + F8 cycle, stubs `markCycleCompleteFromInvoicePaidInTx` to throw, calls `confirmInvoicePaid`, then asserts via direct SQL that the F4 `invoices.status` did NOT flip to `paid`. Without this, F4↔F8 atomicity could regress silently.

### G6. `rescheduleOnPlanChange` cross-module cascade has no integration test (rating 6)

**File**: `src/modules/renewals/application/use-cases/reschedule-on-plan-change.ts` is exercised by 7 unit tests with mocked deps. The F2→F8 bridge wiring at `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts` is referenced from `src/modules/members/application/use-cases/change-plan.ts`. Integration test `tests/integration/members/change-plan-emits-both-audits.test.ts` covers the dual-audit invariant but does NOT assert that `renewal_reminder_events` rows get cancelled / regenerated for the new plan's tier-bucket schedule.

**Failure this catches**: a tier-bucket policy lookup misalignment between F2 plan-change events and F8 schedule cancellation could silently leave reminders firing on the OLD plan's schedule.

**Fix**: 1 integration test — seed member on Regular plan with reminder rows, call `changePlan` to upgrade to Premium, assert (a) `renewal_reminder_events.status='cancelled'` for old-plan rows scheduled in the future, (b) new rows match Premium tier bucket cadence.

### G7. Untested-at-unit-level use-cases rely on integration-only coverage (rating 5)

**Files**: 9 use-cases have NO `tests/unit/...test.ts` file:
- `accept-tier-upgrade.ts`, `apply-pending-tier-upgrade.ts`, `cancel-in-flight-cycles-for-member.ts`, `dismiss-tier-upgrade.ts`, `escalate-tier-upgrade.ts`, `evaluate-tier-upgrade.ts`, `recompute-at-risk-scores-batch.ts`, `reconcile-pending-applications.ts`, `supersede-pending-tier-upgrade.ts`

Most are covered by integration tests (e.g. `tier-upgrade-evaluate.test.ts`, `tier-upgrade-pending.test.ts`, `tier-upgrade-dismiss.test.ts`, `tier-upgrade-escalate.test.ts`, `at-risk-bulk-write.test.ts`, `at-risk-recompute-perf.test.ts`, `f3-archival-cascade.test.ts`). Acceptable per project convention (vitest.config.ts:88-93 documents this trade-off).

But `cancel-in-flight-cycles-for-member.ts` and `reconcile-pending-applications.ts` lack a dedicated integration test that exercises **branch-level** input validation (e.g. invalid tenant ID, non-UUID member ID). The `f3-archival-cascade.test.ts` and `tier-upgrade-reconcile.test.ts` only cover happy paths.

**Fix**: add 2-3 unit tests per use-case for input validation + RBAC denial branches. Targeted ~50 LOC each.

---

## 4. Test Quality Issues

### Q1. `tier-upgrade-evaluate-perf.test.ts` had a silent-success seed bug — already fixed but worth documenting

`tests/integration/renewals/tier-upgrade-evaluate-perf.test.ts:283-290` now pins `expect(out.suggestionsCreated).toBeGreaterThan(0)`. Pre-fix (commit `52637d75`) the bench was hiding the suggestion-create branch via a unit-mismatch (THB vs satang). **The mitigating assertion is exactly what blocks regression** — pattern to apply elsewhere: every perf bench should assert that the under-test code path **actually fired**, not just that the API returned `ok`.

Action: review `tests/integration/renewals/cron-dispatch-perf.test.ts:197` (which only asserts `candidatesProcessed > 0` — does not assert any reminders were actually `sent`); same risk pattern. Add `expect(result.value.summary.outcomes.sent).toBeGreaterThan(0)`.

### Q2. `f5-refund-bridge.test.ts` is structural — by design, but the "happy path" gap is real

The test docstring (`tests/integration/renewals/f5-refund-bridge.test.ts:25-29`) explicitly defers the end-to-end Stripe → F4 credit-note → F8 `linked_credit_note_id` wiring to "full F5+F4+F8 integration test infra". This is a known SUG-level gap, not a regression risk on F8 alone. Fine for ship; track as backlog.

### Q3. E2E manager-readonly relies on env var skips

`tests/e2e/admin-cycle-detail.spec.ts:144-147`, `tests/e2e/manager-readonly.spec.ts:121+` — `test.skip(!MANAGER_EMAIL || !MANAGER_PASSWORD, …)` is legitimate. Confirmed credentials are present in `.env.local` via `E2E_MANAGER_EMAIL` / `E2E_MANAGER_PASSWORD` per `MEMORY.md` "Skip is not pass" rule. CI gating: ensure these env vars are required in the CI step before promoting E2E.

---

## 5. Positive Observations

- **`dispatch-one-cycle.test.ts:250-810`** — 28 tests covering every one of the 12 gates × happy/skip/failure outcomes. Reference-grade gate coverage.
- **`confirm-renewal.test.ts`** (17 tests) — Principle VIII rollback variants explicitly named (e.g. `Principle VIII — audit emit failure throws to roll back linkInvoice`, `C4 review-fix: Principle VIII — plan-change emit failure rolls back updateFrozenPlan`). Will catch real regressions.
- **`compute-at-risk-score.test.ts`** (10 tests) — covers F6-active vs F6-inactive bands, threshold-up vs threshold-down asymmetry (FR-031), Principle VIII state↔audit atomicity, RLS-hidden member, scorer throw.
- **`detect-bounce-threshold.test.ts`** (20 tests) — threshold ordering invariants (hard before soft-streak, soft-streak before soft-rolling), task-create idempotency, all 3 trigger classes, member-RLS-hidden vs already-unverified distinction.
- **Perf bench gating** — all 5 perf benches use `describe.skipIf(!RUN_PERF)` consistently, and all gate strict SLO assertions on `PERF_SLO_STRICT=1` (so local dev runs don't false-fail on geo-latency). See `tier-upgrade-evaluate-perf.test.ts:311-316`, `at-risk-recompute-perf.test.ts:319+`.
- **Property-based testing** — `tests/unit/renewals/domain/at-risk-score.test.ts:539-557` uses `fast-check` for invariant testing of the band/skip output. Good signal-to-noise for the scoring policy.
- **Cross-tenant isolation** — `tests/integration/renewals/cross-tenant-isolation.test.ts` has 16 tests, satisfying Constitution Principle I Review-Gate blocker. Plus `rbac-defence-in-depth.test.ts` (6 tests) and `lapsed-portal-scope.test.ts` (5 tests).
- **F4 callback unit tests** at `tests/unit/renewals/infrastructure/f8-on-paid-callbacks.test.ts` (8 tests) cover deploy-skew defence (`onPaidUnknownOutcomeKind`), audit-emit-fail with stable `errorId`, and webhook replay (`W-012 F4 webhook replay`).

---

## 6. Recommended Action Order

1. **G1 (BLOCKER)** — add F8 vitest threshold entries before ship. ~30 LOC `vitest.config.ts` edit. Then run `pnpm test:coverage` and close any actual gaps surfaced.
2. **G2 (BLOCKER)** — wire 3 integration tests for `bulkInsertIfAbsent` + `bulkTransitionToSent` before T262 follow-up commit lands.
3. **G3 (HIGH)** — opt-in/opt-out integration + 1 E2E test.
4. **G4-G6 (IMP)** — 4 cross-module integration tests (Principle VIII rollback × 2, F4 callback rollback × 1, F2 plan-change cascade × 1).
5. **Q1** — add `outcomes.sent > 0` assertion to `cron-dispatch-perf.test.ts`. ~3 LOC.
6. **G7 (SUG)** — input-validation + RBAC unit tests for `cancel-in-flight-cycles-for-member`, `reconcile-pending-applications`. Optional, can ship without.

---

## File References

- `vitest.config.ts:51-227` — coverage threshold config (G1)
- `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-reminder-event-repo.ts:330-425` — untested bulk methods (G2)
- `src/modules/renewals/application/ports/renewal-reminder-event-repo.ts` — port surface for G2
- `src/modules/renewals/application/use-cases/opt-in-renewal-reminders.ts` + `opt-out-renewal-reminders.ts` — G3
- `src/app/(member)/portal/preferences/renewals/page.tsx` — G3 surface
- `tests/integration/renewals/audit-emit-rollback.test.ts:1-300` — G4 (only 1 test)
- `tests/integration/renewals/f4-callback-rollback.test.ts:1-250` — G5 (structural only)
- `src/modules/renewals/application/use-cases/reschedule-on-plan-change.ts` — G6
- `tests/integration/members/change-plan-emits-both-audits.test.ts` — closest existing G6 coverage
- `tests/integration/renewals/cron-dispatch-perf.test.ts:197` — Q1
- `tests/integration/renewals/tier-upgrade-evaluate-perf.test.ts:283-290` — Q1 reference pattern
