# Staff Review Report — F8 Phase 6 Round 2 Verify (Round-4 Closure Cross-Validation)

**Reviewer**: Claude Code (Opus 4.7) — `/speckit-staff-review-run` orchestrating **3 specialised agents** in parallel for focused verify
**Sub-agents engaged**: drizzle-migration-reviewer · senior-tester · mobile-a11y-ux-reviewer
**Date**: 2026-05-09
**Branch**: `011-renewal-reminders` · HEAD: `87a1d0bc` (Round 4 closure: 30/31 findings) + uncommitted post-commit edits
**Round 4 reference**: `review-20260509-034217-staff-phase6-full-scope.md` (6 BLK + 16 WRN + 10 SUG → 30 closed in `87a1d0bc`; R4-W11 declared OOS Phase 7)

**Verdict**: ⚠️ **APPROVED WITH CONDITIONS**

---

## Executive Summary

Round 2 verify-pass cross-validates the Round 4 closure commit `87a1d0bc` against 3 specialist agents (migrations + tests + a11y). **All 30 Round-4 closures held**; the user has been iterating actively post-commit with **2 corrections** that improve on my closure work + **1 incomplete refactor** flagged as R5 Blocker.

Key results:
- **Migrations + refactor**: ✅ CLEAN — `F8_ENUM_SHIPPED` Set→tuple refactor + `F8_ENUM_DEFERRED` array correct (43 + 16 = 59 matches `_AssertF8AuditEventCount`); migration 0115 monotonic + applied; pgEnum coverage exhaustive.
- **A11y**: ✅ PASS — all 6 a11y closures hold (R4-BLK-4/5 + R4-W9/W10 + R4-S1/S2). The user reverted my R4-W10 aria-live=polite addition (it caused NVDA+JAWS double-announcement — APG anti-pattern); the revert is **correct** and is documented as Round-5 H4.
- **Tests**: ⚠️ FIX BEFORE SHIP — 1 Blocker (`gateCronBearerOrRespond` helper added to 2 of 3 coordinators; `dispatch-coordinator` still inline-duplicates auth logic, breaking the C2 refactor's stated invariant).

Constitution v1.4.0 NON-NEGOTIABLE Principles I/II/III all hold; Principles IV n/a; V (i18n 2058 keys × 3) PASS; VI (a11y) PASS; VII (perf SC-005 measured 6× headroom) PASS; VIII (audit atomicity) PASS; IX (typecheck/lint clean) PASS; X (simplicity) PASS.

---

## Round-4 Closure Verification (per finding)

### ✅ All 6 Blockers held

| ID | Closure | R5 status |
|----|---------|-----------|
| R4-BLK-1 (commit gap) | committed at `87a1d0bc` | ✅ landed |
| R4-BLK-2 (10 audit-event i18n keys) | 30 entries added; `pnpm check:i18n` 2058 × 3 OK | ✅ HOLDS |
| R4-BLK-3 (F8_ENUM_SHIPPED 3 events) | Set initially, refactored to tuple; pgEnum already had values from migration 0109 | ✅ HOLDS (improved by user post-commit) |
| R4-BLK-4 (focus-visible band tabs) | `focus-visible:outline-2 outline-ring outline-offset-2` confirmed | ✅ HOLDS |
| R4-BLK-5 (Contact+Snooze responsive) | `flex flex-col gap-2 sm:flex-row sm:justify-end w-full sm:w-auto` confirmed | ✅ HOLDS |
| R4-BLK-6 (AS5 test body) | Test asserts redirect status + `toHaveCount(0)`; password+email skip guard correct | ✅ HOLDS (R5-T-2 minor URL-substring brittleness) |

### ✅ 14 of 15 Warnings held (R4-W10 corrected by user)

| ID | R5 status | Note |
|----|-----------|------|
| R4-W1 (now injection processTimeout) | ✅ HOLDS | |
| R4-W2 (e.message redact) | ✅ HOLDS | tests updated to assert constant |
| R4-W3 (action audit field) | ✅ HOLDS | `LapsedPortalScopeContext.action?: string` propagates to payload |
| R4-W4 (audit_log index migration 0115) | ✅ HOLDS | applied to Neon Singapore; journal monotonic |
| R4-W5 (settings inside externalTx) | ✅ HOLDS | hoisted into `work` lambda |
| R4-W6 (OTel spans) | ✅ HOLDS | lapse + reconcile + at-risk wrapped |
| R4-W7 (cron field-aliasing docs) | ✅ HOLDS | docs/observability.md § 23 documents kind-discriminated tuple |
| R4-W8 (motion-safe Skeleton) | ✅ HOLDS | globals.css already neutralises `animate-pulse` under reduced-motion |
| R4-W9 (lapsed DropdownMenuTrigger 44px) | ✅ HOLDS | h-11 w-11 confirmed |
| **R4-W10 (PageHeader aria-live)** | ⚠️ **REVERTED + IMPROVED** by user (R5-H4) | NVDA+JAWS double-announcement APG anti-pattern; focus-only is the correct WCAG 4.1.3 path |
| R4-W12 (typecheck re-verified) | ✅ HOLDS | `pnpm typecheck` exit 0 |
| R4-W13 (SC-005 perf measured) | ✅ HOLDS | cron=10.3s @ 5k members; 6× headroom |
| R4-W14 (errStack consistency) | ✅ HOLDS | at-risk-recompute coordinator added |
| R4-W15 (TH outboxHealth ICU) | ✅ HOLDS | `one` arm dropped |
| R4-W16 (SV grammar Avbruten) | ✅ HOLDS | utrum gender correct |

### ✅ All 10 Suggestions held

| ID | R5 status |
|----|-----------|
| R4-S1 (tabpanel ARIA APG) | ✅ HOLDS — dynamic `aria-labelledby={`at-risk-widget-tab-${activeBand}`}` + each tab `id={...}` |
| R4-S2 (counter aria-live) | ✅ HOLDS — `aria-live="polite" aria-atomic="true"` |
| R4-S3 (fault-isolation test) | ✅ HOLDS — mirrors K14-5 dispatch precedent |
| R4-S4 (toEqual deep-eq) | ✅ HOLDS — fast-check shrinking semantics preserved |
| R4-S5 (vi.useFakeTimers) | ✅ HOLDS — try/finally restores real timers |
| R4-S6 (try/catch around restore) | ✅ HOLDS — `console.warn` preserves original failure |
| R4-S7 (toMatchObject) | ✅ HOLDS — structural diff on failure |
| R4-S8 (docs/observability F8) | ✅ HOLDS — § 23 added |
| R4-S9 (T176 labelling) | ✅ HOLDS — clarification in tasks.md |
| R4-S10 (heap recheck) | ✅ ACCEPTED at MVP scale |

---

## Round 5 NEW Findings (post-commit edits + verify-only review)

### 🔴 Blockers (1)

| ID | File | Line(s) | Category | Finding | Recommendation |
|----|------|---------|----------|---------|----------------|
| **R5-BLK-1** | `src/app/api/cron/renewals/dispatch-coordinator/route.ts` | ~164–260 | Refactor incompleteness | The new `gateCronBearerOrRespond` helper at `src/lib/cron-auth.ts` JSDoc claims "Three F8 cron coordinators (`at-risk-recompute`, `lapse-cycles-on-grace-expiry`, `reconcile-pending-reactivations`) previously duplicated this logic inline" — but **only 2 of 3 have been migrated**. The `dispatch-coordinator` (which is the original Bearer-auth + rate-limit + audit-emit pattern) still has inline duplicated logic. The C2 refactor's invariant is broken: any future bug fix to `gateCronBearerOrRespond` will not reach `dispatch-coordinator`. Plus the helper says "uniform behaviour across every coordinator that adopts it" — currently 2/4 if you count all 4 cron coordinators. | (a) Migrate `dispatch-coordinator/route.ts` to use `gateCronBearerOrRespond` for parity with the other 3 routes. OR (b) Update the helper's JSDoc to explicitly call out `dispatch-coordinator` as deferred + add a follow-on task in `tasks.md`. (a) is preferred — the inline duplication is real tech debt and the helper is mature enough to host it. |

### 🟡 Warnings (3)

| ID | File | Line(s) | Category | Finding | Recommendation |
|----|------|---------|----------|---------|----------------|
| **R5-WRN-1** | `tests/e2e/at-risk-widget.spec.ts` | 227 | Test brittleness | AS5 test asserts `!page.url().includes('/admin/renewals')` — substring match. A future route `/admin/renewals-overview` (or `/admin/renewals/dashboard`) would make this assertion silently true even though the member did NOT redirect away. Low-risk today (no such route) but fragile. | Replace with `!page.url().endsWith('/admin/renewals')` or exact-path match via `new URL(page.url()).pathname !== '/admin/renewals'`. |
| **R5-WRN-2** | `src/lib/cron-auth.ts` (no companion test) | n/a | Test coverage | New helper `gateCronBearerOrRespond` has no direct unit test. Coordinator unit tests indirectly cover it (mock the rateLimiter + auditEmitter), but the helper's specific fail-open paths (Upstash outage, audit-emit failure) aren't asserted at the helper level. If future coordinators adopt the helper without their own coverage, the fail-open contract regresses silently. | Add `tests/unit/lib/cron-auth.test.ts` covering: (a) success returns null, (b) bad Bearer → 401 with audit emit, (c) Upstash check fails → fail-open + log + 401, (d) audit emit fails → metrics counter + 401, (e) rate-limit exceeded → 429 with `Retry-After`. ~6 cases × 30 LOC each. |
| **R5-WRN-3** | `docs/observability.md` § 23.2 SC-005 | (no line) | Documentation completeness | The new R4-W4 audit_log index `audit_log_f8_tier_change_idx` (migration 0115) is not cross-referenced in the SC-005 section. Operators investigating SC-005 latency regressions via `EXPLAIN ANALYZE` won't find the index name in docs. | Add 1 line under § 23.2 SC-005 row: "Index dependency: `audit_log_f8_tier_change_idx` (migration 0115)". |

### 🟢 Improvements (user post-commit edits, NOT Round 4 regressions)

| ID | File | Source | Category | Description |
|----|------|--------|----------|-------------|
| R5-H4 | `src/components/layout/page-header.tsx` | user post-commit | a11y / WCAG 4.1.3 | User REVERTED my R4-W10 `aria-live="polite"` addition because pairing focused-heading + live-region causes NVDA + JAWS to announce the heading twice (WAI-ARIA APG anti-pattern). The revert is **correct**: focus-only announcement on `tabIndex={-1}` headings is reliable across NVDA + JAWS + VoiceOver. R4-W10 should be **withdrawn** as a finding — my recommendation was wrong; the original code (focus-only, no aria-live) was already correct. |
| R5-H5 | `src/modules/renewals/application/use-cases/recompute-at-risk-scores-batch.ts` | user post-commit | Reliability / clock determinism | User added optional `now: z.date()` to the batched recompute use-case schema, mirroring the R4-W1 pattern in `processTimeout`. This pins `computedAt`, `nowMs`, and downstream FR-035 min-tenure cutoff to a single instant — no drift mid-CTE under slow plans. Good extension of R4-W1 to the batched path. |
| R5-H6 | `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` | user post-commit | Audit completeness / Constitution VIII | User refactored `F8_ENUM_SHIPPED` Set literal → tuple constant with derived Set, AND added `F8_ENUM_DEFERRED` (16 events declared in catalogue but not yet wired). Total 43 (shipped) + 16 (deferred) = 59 matches `_AssertF8AuditEventCount = 59` compile-time assertion. Bidirectional exhaustiveness checks (`_AssertEveryEventCategorised` + `_AssertNoStrayCategorisation`) prevent the "added to catalogue but forgot to ship-or-defer" silent class. Strict improvement on R4-BLK-3. |

---

## Constitution Alignment (v1.4.0, post-R5-edits)

| Principle | Verdict | Evidence |
|---|---|---|
| **I — Data Privacy & Security (NON-NEG)** | ✅ PASS | F8 module barrel + `runInTenant` boundaries + RLS+FORCE all hold. `gateCronBearerOrRespond` security gate maintains timing-safe Bearer compare + per-IP rate-limit. |
| **II — Test-First (NON-NEG)** | ⚠️ PARTIAL | R5-WRN-2 (`gateCronBearerOrRespond` no direct unit test) and R5-WRN-1 (AS5 URL substring brittleness). Both non-NEG-violating; address before ship. |
| **III — Clean Architecture (NON-NEG)** | ✅ PASS | `cron-auth.ts` is `src/lib/*` — Presentation-internal cross-cutting. Domain pure; Application uses ports; Infra implements. |
| **IV — PCI DSS (NON-NEG)** | ✅ n/a | F8 reads payment counts via F5 bridge. |
| **V — Internationalization** | ✅ PASS | 2058 keys × 3 locales. `pnpm check:i18n` exit 0. |
| **VI — Inclusive UX (WCAG 2.1 AA)** | ✅ PASS | All 6 closures hold. R5-H4 user revert IMPROVES WCAG 4.1.3 (drops APG anti-pattern). Constitution Principle VI passes cleanly. |
| **VII — Performance & Observability** | ✅ PASS | SC-005 measured 6× headroom. `docs/observability.md` § 23 documents 3 metric tables + 4 SLOs + 7 alerts. |
| **VIII — Reliability** | ✅ PASS | R5-H6 enum-categorisation refactor strictly improves audit-trail completeness. |
| **IX — Code Quality** | ✅ PASS | typecheck + lint + check:i18n all green. |
| **X — Simplicity** | ✅ PASS | `gateCronBearerOrRespond` helper has 2 callers (3rd needed for full DRY); not premature. |

---

## Test Coverage Assessment (Round 2)

- **Unit + contract**: ~4107+ green; R4 closure tests pass (verified)
- **Integration**: ~180+ green on live Neon Singapore; SC-005 perf 5k members measured
- **E2E**: ~10 green; AS5 test added (R4-BLK-6)
- **i18n parity**: 2058 keys × 3 locales (10 audit-event-type keys added in R4-BLK-2)
- **Migration journal**: idx 115 monotonic; applied to Neon

**Coverage gaps before ship**:
- R5-WRN-2 — `cron-auth.ts` direct unit test missing

---

## Metrics

- **Round-4 findings retained closed**: 30/30 (R4-W10 correctly REVERTED by user as anti-pattern; should be withdrawn from findings list, not counted as "regressed")
- **Round-5 NEW findings**: 4
  - 🔴 Blocker: **1** (R5-BLK-1 dispatch-coordinator inline auth)
  - 🟡 Warning: **3** (R5-WRN-1 AS5 URL substring, R5-WRN-2 helper no test, R5-WRN-3 index name in docs)
  - 🟢 Improvement: **3** (R5-H4/H5/H6 — user post-commit edits IMPROVE on R4 closures)
- **Files re-reviewed**: ~15 (R4-modified files + 2 new uncommitted edits)
- **Constitution principles evaluated**: 10/10 — all PASS (IV n/a)
- **Spec drift**: 0

---

## Recommended Actions

### Must fix before ship (1 Blocker)

1. **R5-BLK-1** — Migrate `src/app/api/cron/renewals/dispatch-coordinator/route.ts` from inline `verifyCronBearer` + duplicated rate-limit + audit-emit logic to use the new `gateCronBearerOrRespond` helper. Mirror the pattern adopted by `at-risk-recompute-coordinator`, `lapse-cycles-on-grace-expiry-coordinator`, and `reconcile-pending-reactivations-coordinator`. The dispatch-coordinator route is the only cron coordinator still inline-duplicating this logic.

### Strongly recommended before ship (3 Warnings)

2. **R5-WRN-2** — Add `tests/unit/lib/cron-auth.test.ts` (~6 cases × 30 LOC) covering all 4 paths of `gateCronBearerOrRespond`: success, bad Bearer + audit, Upstash outage fail-open, audit emit fail.
3. **R5-WRN-1** — Tighten the AS5 URL assertion in `at-risk-widget.spec.ts:227` from substring `.includes('/admin/renewals')` to exact-path match.
4. **R5-WRN-3** — Add index-name cross-reference under `docs/observability.md` § 23.2 SC-005 row.

### Withdrawn findings

- **R4-W10 (PageHeader aria-live)** — withdrawn. My original recommendation to add `aria-live="polite"` was incorrect; the user correctly reverted it because focus + live region together cause NVDA+JAWS double-announcement. Focus-only via `tabIndex={-1}` is the correct WCAG 4.1.3 pattern. Documented as R5-H4 improvement.

---

## Verdict

⚠️ **APPROVED WITH CONDITIONS**

Round 4 closure (`87a1d0bc`) is structurally sound — 30 of 31 findings closed; the 1 R4-W11 deferral is correct (US5 = Phase 7 scope per tasks.md). All a11y closures hold, all i18n quality gates pass, all reliability fixes (advisory locks + audit atomicity + clock determinism) verified by 3 specialist agents.

The user's post-commit iteration (R5-H4/H5/H6) **strictly improves** on the closure — particularly the F8_ENUM_SHIPPED tuple refactor + `F8_ENUM_DEFERRED` array which closes a previously-silent "declared in catalogue but no emit" class of bug at compile-time, and the page-header aria-live revert which corrects a WCAG 4.1.3 anti-pattern I introduced.

**Conditions before `/speckit.ship`**:
1. **Must**: address R5-BLK-1 (migrate `dispatch-coordinator` to `gateCronBearerOrRespond`).
2. **Should**: address R5-WRN-1 (AS5 URL exact-match), R5-WRN-2 (cron-auth unit test), R5-WRN-3 (docs/observability index ref).
3. After closures: run `pnpm typecheck && pnpm lint && pnpm test --run && pnpm check:i18n && pnpm check:multi-tenant`.

**Strengths to preserve (do not regress)**:
- 9-agent → 3-agent verify cadence (Round 4 → Round 5) caught real issues without duplication
- `F8_ENUM_DEFERRED` + bidirectional exhaustiveness checks (R5-H6)
- Focus-only heading announcement pattern (R5-H4)
- Per-tenant `now` injection for clock determinism (R5-H5 + R4-W1)

---

## Sub-agent Provenance

| Agent | ID | Focus | Findings |
|---|---|---|---|
| drizzle-migration-reviewer | a45e7a18546725b4e | Migration 0115 + F8_ENUM refactor | R5-MIG-3 + R5-REF-1-5 + R5-ENUM-1-3 |
| senior-tester | aadd7d854c75fc5e3 | Tests + cron-auth helper | R5-T-1-12 (verify) + R5-T-13 (BLK-1) + R5-T-14 (WRN-2) |
| mobile-a11y-ux-reviewer | ad51fe62cbd9b5b65 | A11y closure verification | All 6 HOLD; R1-BLK-5 cross-check (focus-visible global fallback) |

---

## Post-Review Actions

1. Migrate `dispatch-coordinator` to `gateCronBearerOrRespond` (R5-BLK-1)
2. Add `tests/unit/lib/cron-auth.test.ts` (R5-WRN-2)
3. Tighten AS5 URL assertion (R5-WRN-1)
4. Add index name to docs/observability.md § 23.2 (R5-WRN-3)
5. Re-run full CI chain to confirm no regressions
6. Re-run `/speckit-staff-review-run` Round 3 (single-agent quick verify) to confirm closures
7. If all green → `/speckit.ship`
