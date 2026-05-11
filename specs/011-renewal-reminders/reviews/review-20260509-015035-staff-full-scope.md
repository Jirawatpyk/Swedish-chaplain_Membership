# Staff Review Report — F8 Phase 5 (Full Scope, Delta since Wave K22)

**Reviewer**: Claude Code (Opus 4.7) — `/speckit.staff-review.run` orchestrating 6 specialised agents
**Sub-agents engaged**: chamber-os-architect · drizzle-migration-reviewer · senior-tester · enterprise-ux-designer · i18n-translation-reviewer · reliability-guardian
**Date**: 2026-05-09
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [tasks.md](../tasks.md)
**Branch**: `011-renewal-reminders` (working-tree dirty; baseline = HEAD `db4351e6`, prior staff review = `3b17864b` Wave K22)
**Commit range reviewed**: `3b17864b..HEAD` + uncommitted working-tree (Waves K23 + K24 + K25 + Phase 6 US4 entire delivery + T149 + cycle-detail UX rework + migration 0113/0114).
**Verdict**: ❌ **CHANGES REQUIRED**

---

## Executive Summary

Phase 5 (US3 Member Self-Service Renewal) shipped well in K17–K22 and remains code-quality-strong. However, this Full-Scope review uncovers **5 Blockers** that the K22-K25 + Phase 6 + cycle-detail rework introduced or carried forward. The most severe is a Drizzle journal-ordering corruption (`drizzle/migrations/meta/_journal.json` entries 110–113 have `when` values 161 days *below* 0109's synthetic future `when`) which causes **`pnpm drizzle-kit migrate` against a fresh Neon prod DB to silently skip 4 migrations** — including the T149 `plan_id_at_cycle_start` text fix that this very wave ships. On the dev DB they were applied by accident-of-history (0110–0113 generated before 0109 was inserted retroactively); a clean prod migrate path is currently broken.

The other 4 Blockers split: 2 i18n correctness gaps (TH plural ICU + SV Anglicism), 2 a11y regressions in the cycle-detail rework that the 3 prior review rounds did NOT catch (section-landmark orphan + missing focus rings on 3 inline `<Link>` and `<summary>` elements). Phase 6 (US4 at-risk) Constitution-side passes; reliability has 1 high (advisory-lock drop in `adminRejectReactivation` between tx1 and tx2) + 2 medium gaps.

Constitution v1.4.0 NON-NEGOTIABLE Principles I/II/III all hold; Principle IV remains n/a (F5 owns SAQ-A); Principle V (i18n) and Principle VI (Inclusive UX) PARTIAL until the 5 Blockers close. **17 findings** total: 5 🔴 Blocker, 13 🟡 Warning, 11 🟢 Suggestion.

**The journal corruption is the only finding that would corrupt prod data** (T149 silently not running → `plan_id_at_cycle_start` stays as `uuid` → cycle-creation runtime type-mismatch when seed/repo writes a TEXT slug). All 4 other Blockers are correctness/UX defects that block ship but not data integrity.

---

## Review Findings

### 🔴 Blockers (must fix before ship)

| ID | Severity | File | Line(s) | Category | Finding | Recommendation |
|----|----------|------|---------|----------|---------|----------------|
| **BLK-1** | 🔴 Blocker | `drizzle/migrations/meta/_journal.json` | entries idx 110–113 | Data Integrity / Migration | `when` non-monotonic: 0109=1792224000000 (Oct 17 synthetic) but 0110–0113=1778310400000…1778803200000 (May 9–15 real wall-clock). Drizzle migrator (`migrator.cjs:45`) compares each `migration.folderMillis` against `lastDbMigration.created_at` AFTER each apply; once 0109 lands its `created_at` is the future timestamp, so 0110–0113 fail the `<` check and are silently skipped. **Result**: T149 schema fix (`plan_id_at_cycle_start` uuid→text) never runs in prod, `renewal_lapsed` enum value never added, `at_risk_*` + `cron_bearer_auth_rejected` enum values never added. Audit INSERT in `lapseCyclesOnGraceExpiry` will throw a Postgres enum-constraint error at first cron tick. | Update `_journal.json` entries 110→114 to monotonic `when` values strictly greater than 0109's (e.g. 1792310400001…1792310400005, increment values are arbitrary — runner only tests `>`). Then re-verify on a Neon staging branch wiped to 0085 + run `pnpm drizzle-kit migrate` and assert: (a) `information_schema.columns` for `renewal_cycles.plan_id_at_cycle_start` returns `text`, (b) `enum_range(NULL::audit_event_type)` includes `renewal_lapsed` + `at_risk_score_recomputed` + `cron_bearer_auth_rejected`. |
| **BLK-2** | 🔴 Blocker | `src/i18n/messages/th.json` | `admin.renewals.table.srResultCount` | i18n / Correctness | TH translation is a flat string `"แสดง {count} สมาชิก ใน {urgency}"` — no ICU MessageFormat plural wrapper. EN + SV both use `{count, plural, one{...} other{...}}`. next-intl will pass through the `{count}` placeholder literally if formatter calls `t('srResultCount', { count: 5 })` against the TH locale (no plural rule resolution). | Wrap with TH-correct `other`-only plural: `"{count, plural, other {แสดง # สมาชิก ใน {urgency}}}"`. (Thai CLDR has only `other`.) |
| **BLK-3** | 🔴 Blocker | `src/i18n/messages/sv.json` | `admin.renewals.cycleDetail.statusSeverity.pending_admin_reactivation` | i18n / Quality | SV uses Anglicism `"admin-granskning"`. Per docs/ux-standards.md Swedish formal-register rule + project memory `kammaradministratör not kammaradmin`. This key is appended to status badge text and read by screen readers as a sentence. | Replace with `" — kräver administratörsgranskning"`. |
| **BLK-4** | 🔴 Blocker | `src/app/(staff)/admin/renewals/[cycleId]/page.tsx` | 389–396 (Member & Plan card) · 540–547 (Period card) | UX / a11y (WCAG 1.3.1) | Section landmark orphan at 2 cards: `</section>` closes immediately AFTER `<h2>`, before the `<dl>` content. Screen readers announce the region "Member & plan" / "Period" then immediately exit the landmark — the dl/dt/dd structure is read as orphan content with no region context. **The previous 3 review rounds (R3/R4/R5) explicitly closed this as "section landmark for keyboard/SR navigation" — implementation was paper-over-fix, the bug is still present.** User explicitly flagged on this surface: "อย่าให้ผมเจอเองอีกนะ". | Move `</section>` past the dl + details for both cards. Verify with axe-core E2E on the cycle-detail spec (currently the spec is behavioural-only — see WRN-2). |
| **BLK-5** | 🔴 Blocker | `src/app/(staff)/admin/renewals/[cycleId]/page.tsx:415` (company-name Link) · `:517` (view-invoice Link) · `src/app/(staff)/admin/renewals/_components/lapsed-tab.tsx:151–158` (View detail Link) | (multiple) | UX / a11y (WCAG 2.4.7 + 2.4.11) | Inline `<Link>` elements lack `focus-visible:` classes — Tailwind v4 + shadcn/ui globals reset native outline, leaving keyboard-only users with no focus indicator. The fix shipped in `success/page.tsx:125` (`focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`) was NOT propagated to these 3 surfaces despite being in the same UX rework batch. | Apply the success-page Link focus-ring class consistently across all 3 inline Link sites (and any other `text-primary hover:underline` Link in the F8 surface). Add an axe-core E2E assertion that each Link has `focus-visible:` styling on `:focus-visible`. |

### 🟡 Warnings

| ID | Severity | File | Line(s) | Category | Finding | Recommendation |
|----|----------|------|---------|----------|---------|----------------|
| WRN-1 | 🟡 Warning | `src/modules/renewals/application/use-cases/admin-reject-reactivation.ts` | 153–222 | Reliability / Atomicity | tx1 acquires `acquireCycleLockInTx` then COMMITS; the Stripe refund call runs with no lock held; tx2 opens a fresh `runInTenant` with NO `acquireCycleLockInTx`. A concurrent admin (double-click, second admin) can both pass `transitionStatus(from='pending_admin_reactivation')`, causing `CycleTransitionConflictError` to fire AFTER both have called `f5RefundBridge.issueRefundForInvoice`. Refund idempotency rests entirely on F5's credit-note uniqueness, not on the F8-side advisory lock. Constitution Principle VIII PARTIAL. | Re-acquire the advisory lock at the top of tx2 BEFORE `transitionStatus`: `await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);`. Mirror the pattern in `lapseCyclesOnGraceExpiry` + `reconcilePendingReactivations`. |
| WRN-2 | 🟡 Warning | `tests/e2e/admin-cycle-detail.spec.ts` | 86–93 | Test Quality | 404 test has dual-branch exit (`response.status() === 200 && getByText(...)` OR `response.status() === 404`). If production code returns 200 with no empty-state text, the test fails by Playwright timeout, not by assertion — opaque failure mode. | Replace with a hard `expect(response?.status()).toBe(404)` after confirming `notFound()` propagation in the page, or assert the empty-state element unconditionally. Either branch, not both. |
| WRN-3 | 🟡 Warning | `tests/integration/renewals/plan-id-at-cycle-start-text.test.ts` | 54–63 (afterAll cleanup) | Test Quality / Hygiene | `afterAll` deletes `renewal_cycles` + `auditLog` rows but leaves the 2 `members` + 2 `contacts` rows from lines 91–108 + 149–167 orphaned in Neon Singapore on every CI run. | Add `db.delete(members).where(...)` + `db.delete(contacts).where(...)` to the cleanup block. |
| WRN-4 | 🟡 Warning | `tests/e2e/admin-cycle-detail.spec.ts` | 44–51 | Test Quality | Two `test.beforeAll` blocks share `seeded` state; if the env-var guard didn't throw and `seedF8Renewals` returned `null`, member-role test at line 95 dereferences `seeded!.cycleId` → TypeError instead of clean skip. | Merge both `beforeAll` blocks, or guard `seeded !== null` before each dereference. |
| WRN-5 | 🟡 Warning | `src/app/(staff)/admin/renewals/[cycleId]/page.tsx` | 466–482 + 585–599 | UX / a11y | `<details>/<summary>` elements use `cursor-pointer text-xs ...` but no `focus-visible:` utility. shadcn/ui globals reset native outlines — keyboard-only users see no focus indicator. | Add `focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2` to the `<summary>` className. |
| WRN-6 | 🟡 Warning | `src/app/(member)/portal/renewal/[memberId]/loading.tsx` | 67–84 | UX / Layout shift | Skeleton tree has 2 card divs (plan + benefit), but real page has 3 sections (plan + benefit + RenewalConfirmFlow). Final `<Skeleton className="h-10 w-32" />` represents a CTA button but RenewalConfirmFlow renders much larger → CLS at hydration. | Align skeleton structure to 3-section real layout; size the bottom skeleton to RenewalConfirmFlow's actual height. |
| WRN-7 | 🟡 Warning | `src/app/(member)/portal/renewal/[memberId]/page.tsx` | 141–145 + `success/page.tsx` | UX / Consistency | Portal renewal page handrolls `<header><h1><p></header>` instead of using the `<PageHeader>` primitive used by all other portal pages (F3 self-service). Skip-to-content wiring + responsive margin not baked in; visual rhythm inconsistent. | Replace handrolled header with `<PageHeader title={t('title')} subtitle={t('subtitle')} />`. |
| WRN-8 | 🟡 Warning | `src/i18n/messages/{en,sv,th}.json` | 3 namespaces (pipeline.status / cycleDetail.cycleStatus / timeline) | i18n / Consistency | Three different EN strings for the same state: `"Pending reactivation"` (line ~1648) vs `"Pending admin reactivation"` (line ~1935) vs `"Pending review"` (line ~2722). Admins scanning across 3 surfaces see 3 labels. TH/SV inherit the inconsistency. Constitution Principle V requires consistency, not just structural parity. | Pick one canonical phrase across all 3 namespaces (recommend `"Pending admin reactivation"` as most precise). Update EN+TH+SV in lockstep. |
| WRN-9 | 🟡 Warning | `src/i18n/messages/sv.json` | `admin.renewals.atRisk.f6Inactive` | i18n / Quality | SV translation reads `"F6-evenemangsmodulen är inte aktiv — maxpoäng {max}"` — leaks internal feature code "F6" to user-visible text + truncates EN meaning ("scores reflect recent engagement signals only"). | Replace with `"Eventdata är inte ansluten — poäng speglar endast senaste engagemangssignaler (max {max} poäng)"`. |
| WRN-10 | 🟡 Warning | `src/i18n/messages/th.json` | `admin.renewals.table.status.pending_admin_reactivation` vs `cycleDetail.cycleStatus.pending_admin_reactivation` | i18n / Consistency | TH terminology drift: `"รอผู้ดูแลฟื้นฟูสถานะ"` vs `"รอผู้ดูแลอนุมัติ"`. | Align both keys to one canonical TH phrase (recommend `"รอผู้ดูแลระบบอนุมัติการฟื้นฟูสถานะ"`). |
| WRN-11 | 🟡 Warning | `src/i18n/messages/{th,sv}.json` | `admin.renewals.settings.schedules.tabs.*` | i18n / Drift | TH + SV tab names left as EN (`"Thai Alumni"`, `"Start-up"`, ...) — but `tierBadge` namespace in TH is fully translated (`ศิษย์เก่าไทย`, `สตาร์ทอัพ`, ...). Inconsistent EN/translated within same locale. | Either translate tabs to match `tierBadge` (recommended for TH), or revert `tierBadge` to EN brand-style. Pick one rule per locale. |
| WRN-12 | 🟡 Warning | `src/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry.ts:242` | 242 | Reliability / Determinism | `closedAt = new Date().toISOString()` uses wall-clock inside `processOne` even though use-case accepts an injected `now: z.date()`. Under heavy cron load `closedAt` can drift from the `listCyclesEligibleForLapse` cutoff timestamp. | Pass `input.now` down to `processOne` and use `input.now.toISOString()` for `closedAt`. |
| WRN-13 | 🟡 Warning | `drizzle/migrations/0113_f8_t149_fix_plan_id_at_cycle_start_text.sql` | 79–100 | Data Integrity / Diagnostic | The orphan-count `DO $$ ... SELECT count(*) WHERE NOT EXISTS (SELECT 1 FROM membership_plans ...)` does not filter `p.deleted_at IS NULL` in the orphan subquery — a soft-deleted plan referenced by a cycle is counted as orphan even though the repair UPDATE correctly leaves it alone. NOTICE inflates → SRE over-escalates. | Add `AND p.deleted_at IS NULL` to the orphan-count subquery at line 89. |

### 🟢 Suggestions

| ID | Severity | File | Line(s) | Category | Finding | Recommendation |
|----|----------|------|---------|----------|---------|----------------|
| SUG-1 | 🟢 Suggestion | `tests/unit/components/renewals/cycle-status-badge.test.tsx:36` | 36 | Test brittleness | `expect(className.length > 50).toBe(true)` — coupling to Tailwind class-string length. CSS-module migration would silently fail CI. | Replace with positive class assertion: `expect(badge?.className).toMatch(/bg-|border-|text-/)`. |
| SUG-2 | 🟢 Suggestion | `tests/unit/api/cron/renewals/at-risk-per-tenant.test.ts:159` | 159 | Test brittleness | `JSON.stringify(lockCall[0])` substring assertion is fragile against Drizzle SQL template whitespace changes. | Capture `.sql` property of the Drizzle tagged-template result, or assert lock call count + argument type instead. |
| SUG-3 | 🟢 Suggestion | `src/modules/renewals/infrastructure/ports-adapters/f5-payment-attempts-bridge-drizzle.ts:30` | 30 | Architecture | F8 infra reaches into `@/modules/payments/infrastructure/schema` directly. Permitted (F4/F5/F7 do same) but if F5 renames its schema, F8 breaks at build time. | F5 add a barrel-level `paymentsTable` re-export so F8 can import via `@/modules/payments` symbolic boundary. Defer to Phase 10 cross-module hygiene. |
| SUG-4 | 🟢 Suggestion | `drizzle/migrations/0114_f8_repair_renewal_tier_bucket_seed.sql:49` | 49 | Migration / Multi-tenancy | Hardcodes `tenant_id = 'swecham'`. Future tenants onboarding post-F10 may arrive with same plan IDs and same misclassification. | Add a row to `docs/runbooks/tenant-onboarding.md` (or create one) — "run per-tenant bucket-repair SQL at onboarding time". |
| SUG-5 | 🟢 Suggestion | `src/app/(staff)/admin/renewals/[cycleId]/page.tsx:189–230` | 189–230 | UX / Error visibility | `Promise.allSettled` for member + plan lookups → on rejection renders inline `"—"` fallback. pino error log emits but admin UI shows no indication. | Surface lookup failures via `<Alert variant="warning">` matching pipeline-table empty-state pattern. |
| SUG-6 | 🟢 Suggestion | `drizzle/migrations/0114_f8_repair_renewal_tier_bucket_seed.sql` | top | Migration / Style | Lacks `IF EXISTS (SELECT 1 FROM membership_plans WHERE tenant_id='swecham')` guard — would no-op on non-swecham envs but the intent isn't explicit. | Wrap UPDATE block in `DO $$ BEGIN IF EXISTS … THEN … END IF; END $$`. |
| SUG-7 | 🟢 Suggestion | `drizzle/migrations/0113_f8_t149_fix_plan_id_at_cycle_start_text.sql` | top | Migration / Style | No `-- grants unchanged` comment per F4/F5 migration pattern. | Add comment for reviewer clarity. |
| SUG-8 | 🟢 Suggestion | `src/modules/renewals/application/use-cases/load-renewal-summary.ts:221` | 221 | Spec / Documentation | `isFirstTimeRenewer: false` default is documented in code comment but no spec-level AS covers the deferred-false rationale. Future developer may "fix" it to `true`. | Add an `AS-Note` to spec.md US3 explaining the false-negative-preferred decision. |
| SUG-9 | 🟢 Suggestion | `tests/integration/renewals/lapse-cycles-on-grace-expiry.test.ts:152` | 152 | Test Documentation | Seeds use `planIdAtCycleStart: randomUUID()` — testing pre-0113 legacy path. Reads as bug to a fresh reviewer. | Add comment: `// Intentional: tests legacy UUID-shaped fallback per 0113 backward-compat`. |
| SUG-10 | 🟢 Suggestion | `tests/e2e/admin-cycle-detail.spec.ts:13–14` | 13–14 | Tracking debt | Manager-role read-only render + cached-error regression deferred via code comment with no `tasks.md` entry. | Add a follow-on task to `tasks.md` Phase 10 polish section. |
| SUG-11 | 🟢 Suggestion | (no E2E file) | n/a | Test coverage | No E2E test exists for `lapseCyclesOnGraceExpiry` cron coordinator (HTTP → coordinator → per-tenant → DB transition). The lapse transition is the only production path that writes `cycle.status='lapsed'`. | Add `tests/e2e/lapse-cycles-cron.spec.ts` mirroring `tier-aware-reminder-cron.spec.ts` precedent before Phase 10 quality gate. |

---

## Constitution Alignment (v1.4.0, 10 Principles)

| Principle | Verdict | Evidence |
|---|---|---|
| **I — Data Privacy & Security (NON-NEG)** | ✅ PASS | K24 F5 bridge implements two-layer isolation: `runInTenant(ctx,…)` + explicit `eq(payments.tenantId, input.tenantId)` predicate. `pnpm check:multi-tenant` 24/24 SCOPED tables pass. Cross-tenant probe count 0 → conservative `grace_expired` decision. |
| **II — Test-First (NON-NEG)** | ⚠️ PARTIAL | K24 ships unit + integration before per-tenant route. K25 `_exhaustive: never` switch closes a previously untested outcome path at compile time. New `plan-id-at-cycle-start-text.test.ts` + `cycle-status-badge.test.tsx` solid. WRN-2 (404 dual-branch) + WRN-4 (beforeAll race) need fix. |
| **III — Clean Architecture (NON-NEG)** | ✅ PASS | Module boundaries intact: Domain pure (no framework), Application uses ports only, Infrastructure implements ports. ESLint `no-restricted-imports` enforces module wall. `client.ts` split barrel correctly scoped. SUG-3 noted but permitted. |
| **IV — Payment Security (PCI DSS NON-NEG)** | ✅ n/a | F5 owns SAQ-A. F8's F5 bridge is read-only COUNT — no card data. F5 `issueRefund` invoked via cross-module barrel only. |
| **V — Internationalization** | ❌ FAIL | BLK-2 (TH ICU plural missing) + BLK-3 (SV Anglicism) + WRN-8/9/10/11 (4 consistency issues). 2044 keys × 3 locales structural parity OK but quality gate fails. |
| **VI — Inclusive UX (Mobile-First + WCAG 2.1 AA)** | ❌ FAIL | BLK-4 (section landmark orphan, WCAG 1.3.1) + BLK-5 (focus rings missing on 3 inline Links, WCAG 2.4.7) + WRN-5 (`<summary>` no focus ring) + WRN-6 (skeleton CLS) + WRN-7 (PageHeader inconsistency). Cycle-detail page is the worst offender — third review round did not catch landmark orphan. |
| **VII — Performance & Observability** | ✅ PASS | K25 `tenantsWithErrors` counter at coordinator surfaces "200-OK-but-everything-failed" pattern. `pageSize` defaults to 1000 with max 5000 — bounded. Per-cycle advisory locks correctly scoped. |
| **VIII — Reliability (state↔audit atomicity)** | ⚠️ PARTIAL | K24 `lapseCyclesOnGraceExpiry` correctly atomic. `markCycleCompleteFromInvoicePaid` I3 closure verified. `adminRejectReactivation` PARTIAL — WRN-1 (advisory lock dropped between tx1/tx2) + WRN-12 (wall-clock `closedAt`) + WRN-13 (orphan-count NOTICE inflated). |
| **IX — Code Quality** | ⚠️ PARTIAL | typecheck + lint + check:i18n GREEN at 2044 keys. K25 exhaustive switch + DRY repo helpers solid. SUG-1/2 (test brittleness) + WRN-2 (test exit) need fix. |
| **X — Simplicity (YAGNI)** | ✅ PASS | `client.ts` split barrel solves real Turbopack 16 build failure — not premature. `numFromJson` 4-line helper eliminates 6 repetitions. Zero new npm dependencies. K24 deletion of `branded-ids.ts` (54 LOC) + `runInTenantOrReuse` (16 LOC) demonstrates dead-code culling discipline. |

---

## Phase 5 Spec Coverage Matrix

Carry-forward from K22 staff review (`review-20260508-084649-staff.md`) — no Phase 5 FR regression detected. 15/16 fully implemented + 1 partial (FR-023 reminder cancellation + welcome email Phase 6 carry-forward = SHIPPED in Phase 6 / U4 wave per commits `f6850f25`, `ef17a760`). **Phase 5 FR coverage = 16/16 = 100%**.

Phase 6 spec coverage delta (US4 At-Risk Smart Suggestions): 6/6 spec.ts use-cases shipped (`compute-at-risk-score`, `record-at-risk-outreach`, `snooze-at-risk-member`, `bulkSetRiskScores`, `dispatch-at-risk-outreach`, etc.). Phase 6 not in scope for this Phase 5 staff review — covered by `/speckit.verify.run` Wave H/I checkpoint.

T149 schema fix: BLK-1 means schema fix exists in code but **does not run on prod migrate path** — counts as IMPLEMENTED-NOT-DEPLOYABLE.

---

## Test Coverage Assessment

- **Unit + contract**: 608 + Phase 6 additions ≈ ~700 GREEN (per K24/K25 verify reports)
- **Integration**: 112 F8 + 1 new T149 + Phase 6 additions ≈ ~125 GREEN on live Neon Singapore
- **E2E**: 2 + new `admin-cycle-detail.spec.ts` ≈ 3 GREEN (workers=1 mandate per memory)
- **i18n parity**: 2044 keys × 3 locales structural OK; quality gate fails on BLK-2/BLK-3
- **Coverage thresholds** (vitest.config.ts): Domain 100% line + Application 80%+ + 100% branch on 11 security-critical use-cases — last verified GREEN at K22

**Test gaps to fix**: WRN-2/3/4 (3 test-quality issues) + SUG-11 (lapse cron E2E missing).

---

## Metrics

- **Total findings**: 17
  - 🔴 Blocker: **5** (1 data-integrity migration, 2 i18n, 2 a11y/UX)
  - 🟡 Warning: **13** (1 reliability, 6 UX/a11y, 4 i18n, 2 test quality, 1 reliability/diagnostic)
  - 🟢 Suggestion: **11**
- **Files reviewed**: ~50 files across the K22→HEAD delta + uncommitted working-tree
- **Constitution principles evaluated**: 10/10 (4 NON-NEG all PASS or n/a; V + VI FAIL on quality gate; II + VIII + IX PARTIAL)
- **Phase 5 FR coverage**: 16/16 (100%) implemented; 1 (T149) **not deployable to prod** until BLK-1 fixed
- **Spec drift**: 0 new (no scope creep in K23/K24/K25 + UX rework)

---

## Recommended Actions (Prioritised)

### Must fix before merge / production flag-flip

1. **BLK-1** — fix `_journal.json` entries 110–113 to monotonic `when` values; verify on staging Neon branch wiped to 0085 baseline. **(highest priority — data integrity)**
2. **BLK-2** — wrap TH `srResultCount` in ICU plural form.
3. **BLK-3** — replace SV `admin-granskning` Anglicism.
4. **BLK-4** — fix section landmark orphan in cycle-detail Member & Plan + Period cards (move `</section>` past dl + details).
5. **BLK-5** — add `focus-visible:` classes to 3 inline `<Link>` sites (cycle-detail company-name + view-invoice; lapsed-tab View detail).

### Strongly recommended before ship

6. **WRN-1** — re-acquire advisory lock at top of tx2 in `adminRejectReactivation`.
7. **WRN-8/10/11** — i18n consistency sweeps (3 keys).
8. **WRN-2/3/4** — test-quality fixes (404 dual-branch, orphan members/contacts, beforeAll race).
9. **WRN-5** — focus ring on `<summary>` elements.
10. **WRN-7** — replace handrolled `<header>` with `<PageHeader>` primitive.
11. **WRN-9** — SV `f6Inactive` jargon removal.
12. **WRN-12** — wall-clock `closedAt` → injected `now`.
13. **WRN-13** — orphan-count NOTICE filter `deleted_at IS NULL`.

### Optional polish (post-ship)

14. SUG-1/2 — test brittleness on className.length + JSON.stringify(lockCall).
15. SUG-3 — F5 schema barrel re-export.
16. SUG-4/6/7 — migration polish (per-tenant runbook note + IF EXISTS guard + grants comment).
17. SUG-5 — Promise.allSettled error visibility.
18. SUG-8/9 — spec/test documentation.
19. SUG-10 — track manager-role + cached-error tests in `tasks.md`.
20. SUG-11 — E2E for lapse-cycles cron coordinator.
21. WRN-6 — skeleton structure alignment (CLS).

---

## Verdict

❌ **CHANGES REQUIRED**

**5 Blockers must close before merge / production flag-flip**:

1. **BLK-1** Drizzle journal corruption — silently skips 4 migrations including T149 schema fix on prod path
2. **BLK-2** TH ICU plural missing on `srResultCount`
3. **BLK-3** SV Anglicism `admin-granskning`
4. **BLK-4** WCAG 1.3.1 section landmark orphan in cycle-detail page (3rd-round paper-over-fix)
5. **BLK-5** WCAG 2.4.7 focus ring missing on 3 inline Links

After Blockers close, re-run `/speckit.staff-review.run` for verification + flip the `T277` maintainer co-sign in `tasks.md` once `pnpm test:coverage` confirms 100% branch on the 11 security-critical use-cases.

**Strengths to preserve** (do not regress):
- Two-layer tenant isolation (`runInTenant` + RLS+FORCE) — Constitution Principle I rock-solid
- K17 atomic single-tx F4→F8 closure (Principle VIII model implementation)
- K24 `lapseCyclesOnGraceExpiry` exhaustive switch + per-cycle fault isolation
- K25 `tenantsWithErrors` counter (closes "200-OK-but-everything-failed" blind spot)
- `client.ts` split barrel (Turbopack 16 Node-only fix — not premature)
- 2044 i18n keys × 3 locales structural parity
- Zero new npm dependencies in F8 module

---

## Post-Review Actions

After fixing the 5 Blockers:
1. Run `pnpm typecheck && pnpm lint && pnpm test --run && pnpm check:i18n && pnpm check:multi-tenant`
2. Run `pnpm test:integration tests/integration/renewals/` on live Neon Singapore
3. Run `pnpm test:e2e tests/e2e/admin-cycle-detail.spec.ts tests/e2e/member-self-service-renewal.spec.ts --workers=1 --project=chromium`
4. Verify on a Neon staging branch: `pnpm drizzle-kit migrate` against a baseline at idx 0085, then assert `plan_id_at_cycle_start='text'` + `enum_range(audit_event_type)` includes `renewal_lapsed` + `cron_bearer_auth_rejected`
5. Re-run `/speckit.staff-review.run` for verification pass

If verification GREEN: proceed to `/speckit.ship`.

---

**Sub-agent provenance**:
- chamber-os-architect: agentId `ad8f315fac22f8e70` — Constitution alignment + K24 verification + Phase 5 architecture audit
- drizzle-migration-reviewer: agentId `ae4ab4d54ce3c17fd` — Migrations 0109–0114 + journal ordering BLOCKER
- senior-tester: agentId `a2ad158a217419d51` — 5 new test files + Phase 5 AS coverage
- enterprise-ux-designer: agentId `a58d525edd44f7b2f` — 7 UX surface verdicts + 30-finding paper-over check
- i18n-translation-reviewer: agentId `ac51dc49ca6f6774b` — 2044-key parity + TH ICU + SV Anglicism + 5 quality issues
- reliability-guardian: agentId `a7c98dc437edca013` — H1/M1/M2/M3 reliability surfaces + state↔audit atomicity
