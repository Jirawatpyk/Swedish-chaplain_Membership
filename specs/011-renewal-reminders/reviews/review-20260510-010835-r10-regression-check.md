# Round 10 Regression Check Review — F8 Phase 8

**Reviewer**: Claude Opus 4.7 (1M context) — staff-engineer-level regression scan
**Trigger**: `/speckit-staff-review-run เช็ค regression`
**Subject**: commit `1e8febdb` ("[Spec Kit] fix(F8): Phase 8 Round 10 staff-review fix close — 22/27 findings (2 CRIT + 12 IMP + 8 SUG)")
**Scope**: regression risk introduced by Round 10 changes — does my close break anything that was working before?
**Date**: 2026-05-10 01:08
**Branch**: `011-renewal-reminders` @ HEAD `1e8febdb`
**Diff scale**: 35 files, +1,897 / −214

---

## Executive Summary

✅ **APPROVED — no regressions found.**

Round 10 closes 22 of 27 staff-review findings without introducing breakage to existing code paths. The 5 forward-deferred items remain documented at `plan.md` Complexity Tracking #8. Verification stack:

- `pnpm typecheck` ✅ green
- `pnpm lint` ✅ 0 errors (1 cosmetic lint warning — see W-2 below)
- `pnpm check:i18n` ✅ green (2,242 keys × EN+TH+SV)
- 51 F8 unit test files (560 tests) ✅ all green
- 35 new contract tests (W2 + W3) ✅ green
- 20 new unit tests (S10 + S11) ✅ green
- 4 cross-module risk vectors all verified safe (see § 2 below)

**Verdict**: safe to ship. Two cosmetic warnings (W-1 type-cast hides missing field in test fixture, W-2 stray lint-disable directive) are non-blocking but should land in the next polish wave.

---

## 1. Findings Table

| ID | Severity | File | Line(s) | Description | Recommendation |
|----|----------|------|---------|-------------|----------------|
| **W-1** | 🟡 Warning | `tests/unit/renewals/domain/renewal-escalation-task.test.ts` | 17-38 | The `buildTask()` factory builds a `RenewalEscalationTask` without `yearInCycle` but uses `as RenewalEscalationTask` cast (line 37) to suppress the type error introduced by S5's promotion of `yearInCycle` from port-only to domain-required. The 18 tests in this file pass at runtime because none of them read `task.yearInCycle`. **Risk surface**: a future test addition that reads `task.yearInCycle` will get `undefined` (not `number`), which can mask a real bug. | Add `yearInCycle: 1,` to the factory defaults so the cast becomes unnecessary; drop the cast. ~2 LOC. |
| **W-2** | 🟡 Warning | `tests/unit/renewals/application/use-cases/complete-escalation-task.test.ts` | 189 | `// eslint-disable-next-line @typescript-eslint/only-throw-error` directive is unused for this file (the rule is not active in the test ESLint config). Lint reports "Unused eslint-disable directive" warning — non-blocking but shipped through to CI. | Drop the directive. ~1 LOC. |
| **S-1** | 🟢 Suggestion | `src/app/(staff)/admin/renewals/tasks/_components/_describe-error.ts` | filename | The new helper file uses an underscore prefix (private-folder convention), but `escalation-task-queue.tsx` imports it as a sibling. R10 S12 already established the precedent that files used as cross-module imports drop the underscore. Consider renaming `_describe-error.ts` → `describe-error.ts` in a follow-up to match the S12 precedent, since the helper is now imported by both the component and the unit test. | Rename in the next polish wave. ~2 file edits. |
| **S-2** | 🟢 Suggestion | `docs/observability.md` | § 23 (Phase 8 metrics block) | The 4 forward metrics (`renewals.escalation_task.queue_load_duration_ms`, `…action_total`, `…overdue_count`, `…audit_emit_failed_total`) are documented as "R10 forward — not yet wired" but no follow-up task ID is assigned. Phase 9 cross-cutting may forget to wire them if there's no explicit T-task. | Add a Phase 9 task `T245 — wire 4 F8 escalation-task OTel metrics per docs/observability.md § 23 R10 W9 close`. |

**Total: 0 🔴 + 2 🟡 + 2 🟢 = 4 findings**

---

## 2. Regression Risk Vectors — verification details

### 2.1 Domain field promotion (S5) — `yearInCycle: number` on `RenewalEscalationTaskBase`

**Risk**: every consumer of `RenewalEscalationTask` (the domain entity) must now provide `yearInCycle`. Type-system enforcement is strict, but `as RenewalEscalationTask` casts in test fixtures can hide missing fields.

**Verification**:
- `grep -rln ": RenewalEscalationTask\b"` found **6 sites** (4 source + 2 tests):
  - `src/modules/renewals/application/ports/renewal-escalation-task-repo.ts` ✅ (port type only)
  - `src/modules/renewals/application/use-cases/create-escalation-task.ts` ✅ (use-case I/O)
  - `src/modules/renewals/domain/renewal-escalation-task.ts` ✅ (definition site)
  - `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-escalation-task-repo.ts` ✅ (rowToDomain reads `row.yearInCycle ?? 1`)
  - `tests/unit/renewals/application/use-cases/reset-email-unverified.test.ts` ✅ (R10 fixed — sets `yearInCycle: 1`)
  - `tests/unit/renewals/domain/renewal-escalation-task.test.ts` ⚠️ **W-1** (cast suppresses missing field)
- All 18 tests in the affected file pass at runtime → no functional regression.
- The cast is the only path through which a consumer could read `undefined` from `task.yearInCycle`. Documented as W-1.

**Verdict**: ✅ no functional regression; W-1 cosmetic.

### 2.2 Zod enum narrowing (S9) — `triggerReason` closed enum

**Risk**: 5 inline producers emit `escalation_task_created` audit events with `trigger_reason` strings; if any of them passes a value outside the new closed enum, the use-case's zod gate would reject. **However**: the inline producers do NOT call `createEscalationTask` — they emit the audit DIRECTLY via `auditEmitter.emitInTx({ type: 'escalation_task_created', payload: { trigger_reason: '...' }, ... })`. The audit-emitter's payload type at `renewal-audit-emitter.ts:653` declares `trigger_reason?: string` (open string). So the enum narrowing only affects the new use-case path; inline producers are untouched.

**Verification**:
- `dispatch-one-cycle.ts:504` → `trigger_reason: 'no_primary_contact'` ✅ (canonical)
- `admin-reject-reactivation.ts:376` → `trigger_reason: 'admin_reject_with_refund'` ✅ (canonical)
- `detect-bounce-threshold.ts:291` → `trigger_reason: 'bounce_threshold_crossed'` ✅ (canonical)
- `retry-failed-reminders.ts:463` → `trigger_reason: 'retry_budget_exhausted'` ✅ (canonical)
- `accept-tier-upgrade.ts` — emits `tier_upgrade_*` audit events (no `escalation_task_created`); not affected.

All 4 inline values match the new enum literals. The use-case zod schema's enum is the authoritative type-level constraint; runtime audit emit is unchanged.

**Verdict**: ✅ no regression on inline producers.

### 2.3 Port type extension (W4) — `countMatching opts` Pick<…> + `overdueThresholdDays`

**Risk**: extending `Pick<ListEscalationTasksOpts, …>` could break callers that pass an exhaustive object. **However**: TypeScript's `Pick<>` is open to extra fields only when explicitly added; existing callers (`page.tsx`) pass `{ statusFilter: ['open'], overdueOnly: true }` — these field names remain valid.

**Verification**:
- `grep -n "countMatching\b" src/` — single call site at `tasks/page.tsx:155` after R10 W4 fix; threads `overdueThresholdDays: 3` through.
- Drizzle adapter `buildListWhereExpr` handles the new field with conditional SQL emission (default behaviour unchanged when threshold is undefined).

**Verdict**: ✅ no regression on existing callers.

### 2.4 REDACT_PATHS additions (W5)

**Risk**: pino's redaction reads each path through every log record. If a non-task log record happens to have a top-level `outcomeNote` or `skippedReason` field that the system relies on visible, the redaction would silently strip it.

**Verification**: 8 new paths added (4 camelCase + 4 snake_case, with both top-level and `*.` wildcard variants):
- `outcomeNote`, `*.outcomeNote`, `outcome_note`, `*.outcome_note`
- `skippedReason`, `*.skippedReason`, `skipped_reason`, `*.skipped_reason`

These field names are F8-escalation-task-specific (the textareas in the Done/Skip dialogs) and are not used elsewhere in the codebase. `grep -rn "outcomeNote\|skippedReason"` confirms only F8 escalation-task module references them. **No collision risk** with other modules' log shapes.

**Verdict**: ✅ no regression; defence-in-depth for PII as designed.

### 2.5 File rename (S12) — `_task-action-dialog.tsx` → `task-action-dialog.tsx`

**Risk**: stale imports referencing the old underscored path would break the build.

**Verification**: `grep -rn "_task-action-dialog\|task-action-dialog" src/ tests/` returns 4 imports — all 4 point to the new path:
- `done-task-dialog.tsx:19` ✅
- `reassign-task-dropdown.tsx:35` ✅
- `skip-task-dialog.tsx:22` ✅
- `tests/unit/renewals/components/task-action-dialog.test.tsx:21` ✅

**Verdict**: ✅ no regression; rename is complete + consistent.

---

## 3. Spec Coverage Matrix

| Requirement | R10 close action | Verification path |
|---|---|---|
| FR-044 (admin reassign action) | W2 reassign route contract test | `tests/contract/renewals/admin-tasks-reassign-route.test.ts` (10 tests) |
| FR-045 (overdue >3 days highlight) | W4 banner threshold alignment | `pages.tsx` + adapter SQL update |
| FR-052a (manager read-only / FR-046a empty state copy) | W7 + S3 (manager E2E + role="note") | `tests/e2e/escalation-task-queue.spec.ts` W7 test |
| FR-046 (queue with member name + tier) | W8 member-detail link assertion | E2E test added |
| AS3 (URL-as-state assignment filter) | (covered in Round 5 C-6) | unchanged in R10 |
| AS4 (overdue banner click → filter) | (covered in Round 5 C-6) | unchanged in R10 |
| Constitution Principle II (TDD ≥1 acceptance test per user story) | 35 contract + 20 unit + 7 E2E tests added in R10 | All green |
| Constitution Principle V (i18n EN+TH+SV at release) | S1 table_caption added in 3 locales | `pnpm check:i18n` green |
| Constitution Principle VI (WCAG 2.1 AA) | W11 ring contrast bump (SC 1.4.11) + S2 autoFocus + S3 role="note" | E2E axe-core scan unchanged |

**Coverage**: all R10 findings traceable to a spec line + verification path. ✅

---

## 4. Test Coverage Assessment

**New tests added in R10**:

| Test file | Count | Type | Status |
|---|---|---|---|
| `tests/contract/renewals/admin-tasks-done-route.test.ts` | 9 | contract | ✅ green |
| `tests/contract/renewals/admin-tasks-skip-route.test.ts` | 10 | contract | ✅ green |
| `tests/contract/renewals/admin-tasks-reassign-route.test.ts` | 10 | contract | ✅ green |
| `tests/contract/admin/users-staff-active-route.test.ts` | 6 | contract | ✅ green |
| `tests/unit/renewals/components/describe-error.test.ts` | 14 | unit | ✅ green |
| `tests/unit/renewals/components/task-action-dialog.test.tsx` | 6 | unit | ✅ green |
| **Total** | **55** | | **all green** |

**Existing tests amended**:

| Test file | R10 change | Risk |
|---|---|---|
| `tests/unit/renewals/application/use-cases/complete-escalation-task.test.ts` | + B-arch-1 non-Error throw | non-regressive (new test, original assertions unchanged); but lint warning W-2 |
| `tests/unit/renewals/application/use-cases/create-escalation-task.test.ts` | S9 enum cast for invalid_input test | non-regressive (test still exercises the rejection path with a non-canonical literal) |
| `tests/unit/renewals/application/use-cases/reset-email-unverified.test.ts` | + `yearInCycle: 1` in fixture | non-regressive (assertions unchanged) |
| `tests/integration/renewals/escalation-task-lifecycle.test.ts` | + W6 raw SQL retention check (3 sites) | non-regressive (additive assertion, no removal) |
| `tests/integration/renewals/escalation-task-idempotency.test.ts` | + S9 `as const` typing | non-regressive |
| `tests/e2e/escalation-task-queue.spec.ts` | + W7 + W8 tests | non-regressive (additive) |

**Untouched tests** (regression sanity): all 51 F8 unit-test files / 560 tests pass green. No prior assertion was weakened or skipped.

---

## 5. Cross-Tenant + Constitution Audit

| Principle | R10 impact | Status |
|---|---|---|
| **I — Tenant isolation (NON-NEG)** | No new RLS policies; unchanged. | ✅ |
| **II — TDD (NON-NEG)** | 55 new tests added, all wired into CI suites. | ✅ |
| **III — Clean Architecture (NON-NEG)** | S5 promotes `yearInCycle` from port to domain (correct direction). S11 extracts pure helper. | ✅ |
| **IV — PCI DSS (NON-NEG)** | n/a (no payment surface in F8 escalation queue). | ✅ |
| **V — i18n (CORE)** | EN+TH+SV parity preserved (table_caption added). | ✅ |
| **VI — Inclusive UX (CORE)** | W11 SC 1.4.11 contrast + S2 autoFocus + S3 role="note" all toward better a11y. | ✅ |
| **VII — Perf & Observability (CORE)** | W9 forward metrics documented. | ✅ |
| **VIII — Reliability (CORE)** | Audit emit semantics unchanged. The 5 inline producers retain their best-effort + log breadcrumb pattern (Complexity Tracking #8(b)). | ✅ |
| **IX — Code Quality (CORE)** | typecheck green; lint 0 errors. | ✅ |
| **X — Simplicity (CORE)** | S11 dispatcher extraction REDUCES escalation-task-queue.tsx LOC by ~15. S12 rename simplifies file naming. | ✅ |

**Verdict**: all 10 principles continue to pass.

---

## 6. Recommended Actions

### 🟡 Warnings — should land in next polish wave (non-blocking)

1. **W-1**: Add `yearInCycle: 1,` to the `buildTask()` factory in `tests/unit/renewals/domain/renewal-escalation-task.test.ts` line 20-37, then drop the `as RenewalEscalationTask` cast at line 37. ~3 LOC.
2. **W-2**: Drop the unused `// eslint-disable-next-line @typescript-eslint/only-throw-error` directive at `tests/unit/renewals/application/use-cases/complete-escalation-task.test.ts:189`. ~1 LOC.

### 🟢 Suggestions — defer to Phase 9 carry-forward

3. **S-1**: Rename `_describe-error.ts` → `describe-error.ts` to match the S12 precedent (drop underscore from cross-module-imported helpers).
4. **S-2**: Add Phase 9 task `T245` to wire the 4 F8 escalation-task OTel metrics from `docs/observability.md` § 23 (Phase 8 R10 W9 forward block).

---

## 7. Final Verdict

✅ **APPROVED** — no blockers, no regressions, 4 cosmetic findings documented.

**Why this is approved**:
- All 5 cross-module risk vectors verified safe (domain field, enum narrowing, port extension, REDACT_PATHS, file rename).
- 55 new tests added, all green; no prior tests weakened.
- typecheck + lint + i18n + 560 unit tests + 35 contract tests all green.
- The 5 forward-deferred items already documented in plan.md Complexity Tracking #8.

**Next step**: ship-dark behind `FEATURE_F8_RENEWALS=false` (already gated). Address W-1 + W-2 + S-1 + S-2 in the next polish wave or Phase 9 cross-cutting.

---

**Reviewed by**: Claude Opus 4.7 (1M context)
**Review type**: regression-focused staff-engineer-level scan
**Output**: read-only — no source files modified
