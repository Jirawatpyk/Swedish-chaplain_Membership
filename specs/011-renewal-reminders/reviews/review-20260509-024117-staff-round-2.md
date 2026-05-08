# Staff Review Report — F8 Phase 5 (Round 2 — K26 Closure Verification)

**Reviewer**: Claude Code (Opus 4.7) — `/speckit.staff-review.run` orchestrating 4 specialised agents
**Sub-agents engaged**: chamber-os-architect · enterprise-ux-designer · reliability-guardian · senior-tester
**Date**: 2026-05-09
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [tasks.md](../tasks.md)
**Branch**: `011-renewal-reminders` · HEAD: `42d23cfb` (Wave K26 — Round 1 closure commit)
**Round 1 reference**: `review-20260509-015035-staff-full-scope.md` (5 BLK + 13 WRN + 11 SUG flagged; all closed in K26)
**Verdict**: ⚠️ **APPROVED WITH CONDITIONS**

---

## Executive Summary

Round 2 verifies that K26 (commit `42d23cfb`) correctly closed every Round-1 finding without introducing regressions. **All 5 Blockers (BLK-1 through BLK-5) and all 13 Warnings (WRN-1 through WRN-13) and all 11 Suggestions verified as closed.** The K26 fixes hold up under cross-validation: WRN-1 advisory lock pattern matches `lapseCyclesOnGraceExpiry` + `reconcilePendingReactivations` precedents; WRN-12 `closedAt` injected `now` is consistent with `cutoffMs` and integration-test compatible; BLK-4 section landmark + spacing fix passes WCAG 1.3.1; BLK-5 + WRN-5 focus rings present at all 5 sites.

**4 NEW Warnings + 10 Suggestions** surfaced from cross-validation of K26 + the user/linter additions (`AutoFocusH1`, `_lib/resolve-plan-name.ts`, skeleton structure). None are Constitution-blocking; all are non-blocking polish or test-quality improvements. The `paymentsTable` SUG-3 barrel re-export pattern is consistent with established F4/F5/F7 conventions (verified). Tailwind `ring-3` concern raised by UX agent is a false positive (used throughout shadcn/ui Button primitive — valid v4 numeric shorthand).

Constitution v1.4.0 NON-NEGOTIABLE Principles I/II/III all hold; Principle IV remains n/a; Principle V (i18n) at 2048 keys × 3 locales OK; Principle VI (UX) cleared via K26 a11y fixes; Principle VIII (state↔audit atomicity) PASS via WRN-1 advisory-lock re-acquire.

---

## K26 Closure Verification (per Round-1 finding)

| ID | Round-1 Severity | K26 Closure Status | Evidence |
|----|-----------------|-------------------|----------|
| BLK-1 | 🔴 | VERIFIED | `_journal.json` entries 110-113 monotonic at 1792224000001-004 (committed earlier) |
| BLK-2 | 🔴 | VERIFIED | TH `srResultCount` ICU-wrapped at `th.json:1655` |
| BLK-3 | 🔴 | VERIFIED | SV `administratörsgranskning` at `sv.json:1939` |
| BLK-4 | 🔴 | VERIFIED + spacing follow-up | Member+Plan + Period cards `<section>` wraps content; `space-y-4` lifted to wrapping section (closes user's "Show technical IDs ติดด้านบน" complaint) |
| BLK-5 | 🔴 | VERIFIED | `focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2` at 3 inline Link sites + 2 `<summary>` sites |
| WRN-1 | 🟡 | ATOMIC | `acquireCycleLockInTx` at `admin-reject-reactivation.ts:236` before `transitionStatus`; same `renewals:{tenant}:{cycle}` namespace as tx1 |
| WRN-2 | 🟡 | SOLID | Hard `expect(200)` + `.first()` to dodge strict-mode 2-element match (h1 + p) — 4/4 e2e green |
| WRN-3 | 🟡 | SOLID | FK delete order renewal_cycles → contacts → members → auditLog → tenant.cleanup() |
| WRN-4 | 🟡 | SOLID | beforeAll merged; throw on null seed produces clear error |
| WRN-5 | 🟡 | VERIFIED | Both `<summary>` elements have focus-visible classes |
| WRN-6 | 🟡 | VERIFIED with caveat | 4-block skeleton matches real page; OnboardingBanner slot still missing (NEW R2-W1) |
| WRN-7 | 🟡 | VERIFIED | `<PageHeader>` at portal/renewal/page.tsx:151 + success/page.tsx:74 |
| WRN-8/10/11 | 🟡 | VERIFIED | EN+TH+SV pending_admin_reactivation + tier-tabs aligned |
| WRN-9 | 🟡 | VERIFIED | SV `f6Inactive` jargon removed |
| WRN-12 | 🟡 | ATOMIC | `closedAt = input.now.toISOString()` + signature update consistent across caller |
| WRN-13 | 🟡 | ATOMIC | Orphan-count subquery drops `deleted_at IS NULL`; repair UPDATE keeps it |
| SUG-1 | 🟢 | SOLID | Positive class regex `(bg-|border-|text-)` |
| SUG-2 | 🟢 | SOLID | `queryChunks` instead of full JSON.stringify |
| SUG-3 | 🟢 | VERIFIED | `paymentsTable` re-export consistent with F4/F5/F7 precedents (`membershipPlans`, `f3DrizzleMemberRepo`) |
| SUG-4 | 🟢 | VERIFIED | `docs/runbooks/tenant-onboarding.md` shipped with per-tenant repair recipe |
| SUG-5 | 🟢 | VERIFIED | cycle-detail `<Alert>` for Promise.allSettled rejections + 4 i18n keys × 3 locales |
| SUG-6 | 🟢 | VERIFIED | 0114 `DO $$ BEGIN IF EXISTS … END IF` guard with RAISE NOTICE |
| SUG-7 | 🟢 | VERIFIED | `-- grants unchanged` comment in 0113 |
| SUG-8 | 🟢 | VERIFIED | spec.md US3 AS-Note (1) for isFirstTimeRenewer=false rationale |
| SUG-9 | 🟢 | VERIFIED | randomUUID legacy-pattern comment in lapse-cycles integration test |
| SUG-10/11 | 🟢 | CLOSED via T277e/f | manager-role test + lapse-cron E2E shipped |

**Summary**: 5 BLK + 13 WRN + 11 SUG = **29 of 29 Round-1 findings verified closed.**

---

## Round 2 NEW Findings

### 🟡 Warnings (4)

| ID | File | Line(s) | Category | Finding | Recommendation |
|----|------|---------|----------|---------|----------------|
| **R2-W1** | `src/app/(member)/portal/renewal/[memberId]/loading.tsx` | 77-122 | UX / CLS | Skeleton has 4 blocks (PageHeader + plan-summary + benefit-summary + RenewalConfirmFlow) but the real `page.tsx:153` conditionally renders `<OnboardingBanner>` for first-time renewers. First-renewer path → ~50px CLS at hydration. WRN-6 fix is mostly complete but missed this branch. | Add `<Skeleton className="h-12 w-full rounded-lg" />` between PageHeader skeleton and plan-summary card, conditionally — but since loading.tsx can't read `summary.isFirstTimeRenewer` (use-case hasn't loaded yet), unconditionally reserve the slot. Trade-off: ~50px wasted vertical for non-first-renewers vs. ~50px CLS for first-renewers. Reserve unconditional. |
| **R2-W2** | `src/components/a11y/auto-focus-h1.tsx` (NEW) + `success/page.tsx:75` | 28 | UX / a11y / fragility | `AutoFocusH1` mutates `tabIndex` directly on a React-owned DOM node found via `document.querySelector('main h1, h1')`. PageHeader owns the `<h1>` — if PageHeader ever re-renders client-side, React reconciler may reset the `tabIndex`. Currently safe because both portal/renewal pages are Server Components without client-side re-render, but the pattern is fragile. WCAG 2.4.3 (Focus Order) intent is correct. | Refactor to pass `autoFocus` prop down to `<PageHeader>` and have PageHeader render `<h1 tabIndex={-1} ref={focusRef}>` — proper React-owned focus management via ref. Defer to a polish wave; not ship-blocking. |
| **R2-W3** | `src/modules/renewals/application/use-cases/admin-reject-reactivation.ts` | 221 | Reliability / Determinism | `closedAt = new Date().toISOString()` still uses wall-clock. WRN-12 fix to `lapseCyclesOnGraceExpiry` introduced injected `now` for cron determinism; admin-reject is interactive (not cron) so less critical, but inconsistent with the same-class fix in the sibling use-case. Not unit-testable without `vi.setSystemTime`. | Add `now?: Date` to `AdminRejectReactivationInput` schema with `= new Date()` default (backward-compatible); thread to `closedAt` + `dueAt` (line 335). Defer to a polish wave; current state IS safe — Stripe call latency drift is bounded by the 30s admin click → tx2 commit window. |
| **R2-W4** | `tests/e2e/lapse-cycles-cron.spec.ts` | 71-105 | Test Quality | `200 + canonical shape` test inlines both feature-flag-disabled and feature-flag-enabled branches via early `return`. In CI where `FEATURE_F8_RENEWALS=false`, the shape assertions silently no-op — a test marked green that didn't actually verify what its name implies. | Split into 2 `it()` blocks: `it('returns 200 + skipped when feature flag disabled')` + `it('returns 200 + canonical per-tenant shape when feature flag enabled')`. The second one uses `test.skip(!F8_RENEWALS_ENABLED, ...)` for clean skip semantics. |

### 🟢 Suggestions (10)

| ID | File | Line(s) | Category | Finding |
|----|------|---------|----------|---------|
| R2-S1 | `src/app/(staff)/admin/renewals/[cycleId]/page.tsx` | 411-496 + 571-622 | Code Quality | BLK-4 fix wrapped content in outer `<section>` but didn't re-indent inner content under the new nesting level. HTML correct (parsed by tag closure not whitespace), but readability suffers — a future reviewer may misread the nesting. |
| R2-S2 | `src/components/a11y/auto-focus-h1.tsx` | 28 | Robustness | Selector `'main h1, h1'` falls back to ANY `<h1>` if no `<main>` — could focus a heading in `<nav>` or `<header>`. Not a current bug (F8 portal pages all have `<main>`), but fragile. Use `'[data-main-content] h1, main h1'` or accept a ref. |
| R2-S3 | `tests/e2e/admin-cycle-detail.spec.ts` | 136 | Test Quality | `test.skip(!MANAGER_EMAIL)` does not guard against `E2E_MANAGER_PASSWORD` missing; if only the password is absent, `signInAsManager` throws. Add `|| !process.env.E2E_MANAGER_PASSWORD` to the skip condition. |
| R2-S4 | `tests/unit/api/cron/renewals/at-risk-per-tenant.test.ts` | 170-173 | Test Quality | `queryChunks` assertion checks lock-namespace + advisory-lock function but NOT the `tenantSlug` substring — a future refactor that drops tenant scope from the lock key would silently pass. Add `expect(chunksText).toContain(tenantSlug)`. |
| R2-S5 | `tests/e2e/admin-cycle-detail.spec.ts` | 80 | Test Robustness | `response?.status()` evaluates to `undefined` if `response` is null — `.toBe(200)` fails by `undefined !== 200`. Use non-null assertion `response!.status()` or explicit null check before assertion. |
| R2-S6 | `tests/unit/components/renewals/cycle-status-badge.test.tsx` | 37 | Test Convention | `getByText(...).toBeTruthy()` passes for any DOM node reference even hidden; convention is `.toBeInTheDocument()` from `@testing-library/jest-dom`. Minor. |
| R2-S7 | `src/app/(member)/portal/renewal/[memberId]/_components/benefit-summary.tsx` | 53 | a11y | Both `<section>` and inner `<ul>` carry `aria-labelledby="benefits-heading"` — duplicated reference can produce SR redundancy ("Membership benefits, Membership benefits list"). Comment explains why; consider `aria-label={t('heading')}` on `<ul>` to avoid id-reuse. |
| R2-S8 | `src/app/(member)/portal/renewal/[memberId]/_lib/resolve-plan-name.ts` | 29 | Test Coverage | `localeText.en \|\| fallback` short-circuits on empty `en` string — that branch is untested in the 11-case suite. Low risk (F2 plan names always non-empty `en`) but a coverage gap. |
| R2-S9 | `tests/integration/renewals/lapse-cycles-on-grace-expiry.test.ts` | 161 | Test Documentation | Seed uses `planIdAtCycleStart: randomUUID()` (legacy pre-0113 pattern); SUG-9 added a comment but the canonical post-0113 pattern uses plan slug. Update to slug for consistency with `tests/e2e/helpers/renewals-seed.ts`. |
| R2-S10 | `tests/integration/renewals/tier-bucket-repair-mapping.test.ts` | 70 | Test Documentation | `db.insert(membershipPlans)` runs OUTSIDE `runInTenant` (no RLS context) — works in integration test via service role but should have a comment so future devs don't copy the pattern into production code. |

---

## Constitution Alignment (Round 2)

| Principle | Verdict | Evidence |
|---|---|---|
| **I — Data Privacy & Security (NON-NEG)** | ✅ PASS | `f5-payment-attempts-bridge-drizzle.ts` retains explicit `eq(payments.tenantId, …)` defence-in-depth + RLS+FORCE; migrations 0113/0114 tenant-scoped WHERE clauses; `acquireCycleLockInTx` uses `renewals:{tenantId}:{cycleId}` namespace |
| **II — Test-First (NON-NEG)** | ✅ PASS | All K26 closures have corresponding test coverage. New `_lib/resolve-plan-name.ts` ships with 11 unit tests in `tests/unit/app/portal/renewal/`. T277e + T277f added 4 + 3 e2e tests respectively. |
| **III — Clean Architecture (NON-NEG)** | ✅ PASS | SUG-3 `paymentsTable` re-export consistent with established `membershipPlans` (F2) + `f3DrizzleMemberRepo` (F3) precedents. F8 infra imports via barrel only. New `_lib/` co-location pattern is Presentation-internal helper (no Domain/Infra leak). |
| **IV — Payment Security (PCI DSS NON-NEG)** | ✅ n/a | F5 owns SAQ-A. F8 only reads payment counts via the bridge port. |
| **V — Internationalization** | ✅ PASS | 2048 keys × EN+TH+SV parity verified. K26 added 4 lookupFailed* keys × 3 locales. |
| **VI — Inclusive UX (Mobile-First + WCAG 2.1 AA)** | ✅ PASS | BLK-4 + BLK-5 + WRN-5/6/7 closed. R2-W1 (skeleton OnboardingBanner) + R2-W2 (AutoFocusH1 fragility) are polish — not Constitution gates. WCAG 1.3.1 + 2.4.3 + 2.4.7 + 2.5.8 met at all reviewed surfaces. |
| **VII — Performance & Observability** | ✅ PASS | T277f cron E2E covers SLO observability fields. No perf regressions in K26. |
| **VIII — Reliability (state↔audit atomicity)** | ✅ PASS | WRN-1 advisory lock re-acquire correct; transition + audit emit + escalation task all in tx2. R2-W3 (admin-reject `closedAt` wall-clock) is consistency-with-WRN-12 polish, not atomicity violation. |
| **IX — Code Quality** | ✅ PASS | typecheck + lint + check:i18n GREEN. K26 dead-code culling continues (`branded-ids.ts` deletion in earlier waves). |
| **X — Simplicity (YAGNI)** | ✅ PASS | T277d implemented as minimum-viable (DropdownMenu + reuse OutreachDialog), not over-engineered with Reactivate/Reject (correctly defer those — would be broken affordances on lapsed-status rows). |

---

## Test Coverage Assessment (Round 2)

| Surface | Round-1 → Round-2 |
|---|---|
| Unit + contract | ~700 → 733 GREEN (+33 from K26 additions including 11 resolve-plan-name) |
| Integration | 112 + 1 T149 + 1 tier-bucket-repair = 114 GREEN on live Neon Singapore |
| E2E | 2 + admin-cycle-detail (4) + lapse-cycles-cron (3) = 9 GREEN |
| i18n parity | 1915 → 2048 keys × 3 locales |
| Cross-tenant | 24/24 SCOPED tables `pnpm check:multi-tenant` GREEN |

**E2E results post-K26**:
- `admin-cycle-detail.spec.ts` — 4/4 ✓ (43s)
- `lapse-cycles-cron.spec.ts` — 3/3 ✓ (7.7s)

**Test-quality findings (R2-S3/4/5/6)** — minor polish, no failure-by-timeout vulnerabilities.

---

## Metrics

- **Round-1 findings closed**: 29/29 (100%)
- **NEW Round-2 findings**: 14 (4 Warnings + 10 Suggestions)
  - 🔴 Blocker: **0**
  - 🟡 Warning: **4** (1 UX/CLS, 1 a11y/fragility, 1 reliability/consistency, 1 test-quality)
  - 🟢 Suggestion: **10**
- **Files reviewed**: ~30 (K26 commit + uncommitted user/linter additions)
- **Constitution principles evaluated**: 10/10 — all PASS or n/a
- **Spec drift**: 0 (no scope creep in K26)

---

## Recommended Actions

### Should fix before ship (4 Warnings)

1. **R2-W1** — reserve unconditional skeleton slot for OnboardingBanner in `loading.tsx` (~5 LOC change)
2. **R2-W4** — split `lapse-cycles-cron.spec.ts` shape test into 2 `it()` blocks (~10 LOC change)
3. **R2-W2** — refactor `AutoFocusH1` to use ref via PageHeader prop (or defer with explicit follow-up task)
4. **R2-W3** — inject `now?` into `adminRejectReactivation` for clock determinism (or defer)

### Optional polish (10 Suggestions)

5. R2-S1 — re-indent BLK-4 inner content under outer section (cosmetic)
6. R2-S2 — `auto-focus-h1.tsx` selector hardening
7. R2-S3 — admin-cycle-detail.spec.ts add password env-var to skip guard
8. R2-S4 — at-risk-per-tenant test add tenantSlug substring assertion
9. R2-S5 — admin-cycle-detail.spec.ts use non-null assertion on `response`
10. R2-S6 — cycle-status-badge.test.tsx use `.toBeInTheDocument()`
11. R2-S7 — benefit-summary aria-labelledby duplication
12. R2-S8 — resolve-plan-name empty-string EN fallback test case
13. R2-S9 — lapse-cycles integration test seed pattern alignment
14. R2-S10 — tier-bucket-repair test runInTenant scope comment

---

## Verdict

⚠️ **APPROVED WITH CONDITIONS**

K26 successfully closed all 29 Round-1 findings. Round-2 cross-validation surfaced 0 new Blockers + 4 Warnings + 10 Suggestions — all non-Constitution-blocking polish items. The K26 closures are textbook-correct in pattern (advisory lock re-acquire mirrors sibling use-cases; section landmark + spacing fix passes WCAG 1.3.1; focus-visible classes consistent across 5 sites; injected `now` propagates through `processOne`).

**Conditions before `/speckit.ship`**:
1. Address R2-W1 (OnboardingBanner skeleton slot) and R2-W4 (lapse-cron test split) — both are ~5–10 LOC fixes.
2. Either address R2-W2 (AutoFocusH1 ref refactor) and R2-W3 (admin-reject `now` injection), OR open follow-up tasks T277g/h tracking them as polish-wave debt with explicit rationale (current state IS safe).
3. Run `/speckit.staff-review.run` Round 3 after closure to verify the 4 Warnings are resolved.

The remaining T277/T277b/T277c (Maintainer GPG sign + cron-job.org config + Phase 10 checklist sweep) all require human/operator action — those gates remain open for the maintainer post-Round 3.

**Strengths to preserve (do not regress)**:
- WRN-1 two-tx advisory lock pattern (textbook Principle VIII)
- WRN-13 orphan-count + repair UPDATE differentiated `deleted_at IS NULL` filtering
- T277d minimum-viable LapsedTab DropdownMenu (correctly skipped Reactivate/Reject as broken affordances)
- T277f cron coordinator HTTP route E2E (covers auth + observability shape)
- F2/F3 lookup failure surfaced via `<Alert>` not silent `"—"` (SUG-5)
- Per-tenant tier-bucket repair runbook (`docs/runbooks/tenant-onboarding.md`)

---

## Post-Review Actions

After fixing the 4 Warnings:
1. Re-run `pnpm typecheck && pnpm lint && pnpm test --run && pnpm check:i18n && pnpm check:multi-tenant`
2. Re-run `pnpm test:e2e tests/e2e/admin-cycle-detail.spec.ts tests/e2e/lapse-cycles-cron.spec.ts --workers=1`
3. Re-run `/speckit.staff-review.run` Round 3 for verification
4. If green: proceed to `/speckit.ship` (gated on T277/T277b human action)

---

**Sub-agent provenance**:
- chamber-os-architect: agentId `a2d9457278bb084d3` — K26 closure verification + Constitution alignment
- enterprise-ux-designer: agentId `a77d6e9842844dad6` — UX a11y closure verification + new findings
- reliability-guardian: agentId `a5642cddb3e9be892` — WRN-1/12/13 closure atomicity verification
- senior-tester: agentId `a5d98c2f731754156` — WRN-2/3/4 + T277e/f test quality verification
