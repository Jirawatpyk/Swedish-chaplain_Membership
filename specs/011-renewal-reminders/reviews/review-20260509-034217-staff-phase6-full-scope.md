# Staff Review Report — F8 Phase 6 Full Scope (Round 4)

**Reviewer**: Claude Code (Opus 4.7) — `/speckit-staff-review-run` orchestrating **9 specialised agents** in parallel
**Sub-agents engaged**: chamber-os-architect · security-threat-modeler · reliability-guardian · drizzle-migration-reviewer · senior-tester · performance-slo-guardian · i18n-translation-reviewer · mobile-a11y-ux-reviewer · observability-instrumentor
**Date**: 2026-05-09
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [tasks.md](../tasks.md)
**Branch**: `011-renewal-reminders` · HEAD: `fb883d81` (Phase 6 review-round 3 close — 25/25 findings) + 13-file working-tree (uncommitted F1 `tenantId` propagation)
**Round-1 reference**: `review-20260509-015035-staff-full-scope.md` (5 BLK + 13 WRN + 11 SUG → 100% closed via K26)
**Round-2 reference**: `review-20260509-024117-staff-round-2.md` (0 BLK + 4 WRN + 10 SUG → 100% closed via K27 + Round-3 commit)
**Round-3 closure commit**: `fb883d81` (3 Critical + 10 Important + 12 Suggestions → 100% closed)

**Verdict**: ❌ **CHANGES REQUIRED**

---

## Executive Summary

Round-4 cross-validation by 9 specialist agents confirms **all 68 prior-round findings stayed closed** (BLK-1 journal monotonic, BLK-4 section landmark, BLK-5 + WRN-5 focus-visible on Links + `<summary>`, WRN-1 advisory lock re-acquire in `adminRejectReactivation` tx2, WRN-6 skeleton CLS, WRN-7 PageHeader primitive, R2-W2 → Round-3 C3 `autoFocusTitle` ref-based focus, BLK-2/3 i18n closures all hold).

However, the parallel re-scan surfaces **6 new Blockers** the prior 3 rounds missed, primarily in Phase 6 surfaces shipped after Wave G + UI surfaces from Wave E + closure work in Round 3. Three categories:

1. **Working-tree commit gap** — 13 files (`create-user.ts` + 6 source + 6 test) modified to thread `tenantId` through `CreateUserInput` and fix the F1 invitation flow against migration 0098's `notifications_outbox.tenant_id NOT NULL + FORCE RLS`. **All 13 files are uncommitted.** The architecture is correct; the fix exists; it just needs a commit.

2. **Phase 6 audit-event-type i18n + whitelist gaps** — 10 audit event types (`tier_upgrade_*` × 7 + `at_risk_compute_partial_failure` + `cron_bearer_auth_rejected` + `lapsed_member_action_blocked` + `renewal_kill_switch_blocked`) lack EN/TH/SV translations under `audit.eventType.*`; release-branch CI blocks on `pnpm check:i18n`. Separately, 3 of those events (`renewal_kill_switch_blocked` + `lapsed_member_action_blocked` + `renewal_cross_member_probe`) have live emit sites but are absent from `F8_ENUM_SHIPPED` whitelist — production-mode `pinoFallback` throws on emit, swallowed by surrounding try/catch, but the audit row is silently lost (Constitution Principle VIII partial).

3. **At-risk-widget UI a11y + missing test** — band-tab buttons lack `focus-visible` ring (WCAG 2.4.7 fail), Contact + Snooze action pair fails 44px touch target on narrow viewport (WCAG 2.5.5 fail), and AS5 / FR-034 ("member role MUST NOT see at-risk widget") has a docstring entry but **no test body** in `tests/e2e/at-risk-widget.spec.ts`.

Constitution v1.4.0 NON-NEGOTIABLE Principles I/II/III all hold; Principle IV remains n/a; Principle V (i18n) and Principle VI (Inclusive UX) and Principle VIII (Reliability) are PARTIAL until the 6 Blockers close.

---

## Round-1+2+3 Regression Spot-check (PASS)

| Item | Source round | Status at HEAD `fb883d81` |
|---|---|---|
| `_journal.json` entries 110–113 monotonic | R1-BLK-1 | ✅ confirmed `109:1792224000000 / 110:001 / 111:002 / 112:003 / 113:004 / 114:1792310400000` |
| TH `srResultCount` ICU `{count, plural, other {…}}` | R1-BLK-2 | ✅ confirmed |
| SV `administratörsgranskning` (Anglicism removed) | R1-BLK-3 | ✅ confirmed |
| Section landmark wraps full card content (Member+Plan / Period) | R1-BLK-4 | ✅ confirmed `<section aria-labelledby>` wraps `<h2> + <dl> + <details>` |
| `focus-visible:outline-2 outline-ring outline-offset-2` on Links + `<summary>` | R1-BLK-5 + R1-WRN-5 | ✅ confirmed at 5 sites |
| `adminRejectReactivation` re-acquires advisory lock at top of tx2 | R1-WRN-1 | ✅ confirmed at line 245 |
| Skeleton tree mirrors real page (PageHeader + OnboardingBanner reserved + plan + benefit + RenewalConfirmFlow) | R1-WRN-6 + R2-W1 | ✅ confirmed; `role="status" aria-live="polite"` wrapper added |
| Portal renewal + success use `<PageHeader>` primitive | R1-WRN-7 | ✅ confirmed at portal/renewal:151 + success:79 |
| `autoFocusTitle` ref-based focus management | R2-W2 + R3-C3 | ✅ confirmed in `page-header.tsx`; `success/page.tsx:83` consumes it |
| `cron_bearer_auth_rejected` pgEnum value (migration 0112) | R3-C2 | ✅ confirmed in `F8_ENUM_SHIPPED:151` and tests pin discriminator |
| `cycle_not_found` vs `unexpected` distinguished in `fetchMemberDisplay` | R3-C1 | ✅ confirmed; `Promise.allSettled` rejected branch fires + warn-log |
| Lapse-cron E2E split into 2 `it()` blocks | R2-W4 | ✅ confirmed; `--workers=1` mandate honoured |

**No regressions**. The architecture is sound; the fixes hold.

---

## Round-4 New Findings

### 🔴 Blockers (must fix before ship)

| ID | File | Line(s) | Category | Finding | Recommendation |
|----|------|---------|----------|---------|----------------|
| **R4-BLK-1** | `src/app/api/auth/invite/route.ts`, `src/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route.ts`, `src/lib/auth-deps.ts`, `src/modules/auth/application/create-user.ts`, `src/modules/members/application/use-cases/{invite-colleague,invite-portal,invite-user-for-member}.ts`, plus 6 test files | working-tree (13 files) | Working-tree commit gap | All 13 files modified to thread `tenantId` through `CreateUserInput` (closing the F1 invitation flow ↔ migration 0098 `notifications_outbox.tenant_id NOT NULL + FORCE RLS` mismatch surfaced in the Round-3 commit message). Working tree is correct; HEAD `fb883d81` is unshippable because committed source omits `tenantId` on 7 production routes — every staff/manager invitation would return 500 in production. `pnpm typecheck` against the working-tree state IS clean (R4-BLK-2 below in chamber-os-architect's report was a worktree-isolation false positive). | Single `[Spec Kit] fix(F8): Phase 6 review-round 4 — F1 tenantId propagation` commit covering all 13 files. Confirm `pnpm typecheck && pnpm test:integration tests/integration/auth tests/integration/members --workers=1` GREEN post-commit. |
| **R4-BLK-2** | `src/i18n/messages/{en,th,sv}.json` `audit.eventType.*` namespace | 10 missing keys × 3 locales | i18n / Constitution V | 10 Phase 6 audit event types declared in `F8_AUDIT_EVENT_TYPES` lack EN/TH/SV translations: `tier_upgrade_suggested`, `tier_upgrade_accepted`, `tier_upgrade_dismissed`, `tier_upgrade_already_at_target`, `tier_upgrade_skipped_no_thresholds_configured`, `tier_upgrade_tenant_disabled`, `at_risk_compute_partial_failure`, `cron_bearer_auth_rejected`, `lapsed_member_action_blocked`, `renewal_kill_switch_blocked`. Audit viewer falls back to EN with dev warning; release branch CI fails on `pnpm check:i18n`. | Add the 10 keys to all 3 locale files using the proposed translations from i18n agent's R4-BLK-1 report (canonical EN labels + TH formal-register translations + SV proper compounds). Run `pnpm check:i18n` to confirm 2058 keys × 3 locales (or matching post-add count). |
| **R4-BLK-3** | `src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts` | `F8_ENUM_SHIPPED` Set @67 | Audit / Constitution VIII | Three event types have live production emit sites but are absent from `F8_ENUM_SHIPPED`: `renewal_kill_switch_blocked` (`src/app/api/admin/renewals/route.ts:66`), `lapsed_member_action_blocked` (`src/lib/lapsed-portal-scope.ts:149`), `renewal_cross_member_probe` (`confirm-renewal.ts:153` + `load-renewal-summary.ts:169`). The DB pgEnum values exist (migration 0109). Each emit site has `try/catch` that swallows the production-mode `pinoFallback` throw, so requests don't crash — but **audit rows are silently dropped** when `FEATURE_F8_RENEWALS=true` flips. Constitution Principle VIII (state↔audit atomicity) requires every defensive-audit branch (cross-tenant probe, kill-switch deny, lapsed scope deny) to actually persist. Severity is Blocker because flag-flip = silent forensic-loss for security-relevant deny paths. | Add the 3 event types to `F8_ENUM_SHIPPED` Set in `drizzle-renewal-audit-emitter.ts:67`. No new migration needed (pgEnum values already exist). Add unit test `tests/unit/modules/renewals/drizzle-renewal-audit-emitter.whitelist.test.ts` parameterized over the 5 REQUIRED_EVENTS (the 3 above + `cron_bearer_auth_rejected` + `cron_dispatch_orchestrated`) asserting `F8_ENUM_SHIPPED.has(event)` to prevent regression. |
| **R4-BLK-4** | `src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx` | 197–243 | a11y / WCAG 2.4.7 | Band tab buttons (`Warning` / `At-Risk` / `Critical` filter pills) have plain Tailwind classes (`inline-flex ... rounded-t-md px-3 py-1.5 text-sm`) with **no `focus-visible:outline*` ring**. Tailwind v4 + shadcn/ui globals reset native outlines — keyboard-only users see no focus indicator on the tablist. WCAG 2.4.7 Focus Visible (Level AA) fails. Constitution Principle VI partial. | Add `focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2` (or the `ring-3` shorthand consistent with `success/page.tsx:125` Link-focus pattern) to the band tab button className. Add an axe-core E2E assertion in `tests/e2e/at-risk-widget.spec.ts` checking each band tab has visible focus on `:focus-visible`. |
| **R4-BLK-5** | `src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx` | 325–355 | a11y / Mobile-touch (WCAG 2.5.5) | Contact + Snooze action buttons in the at-risk widget table use mismatched sizes (one default 36px, one `size="sm"` 32px) and are placed `flex justify-end gap-2` without responsive breakpoints. At 320–375 px viewport they crowd or overlap; they fall below the 44 × 44 px best-practice and the 8 px gap. WCAG 2.5.5 Target Size (Level AAA, but project elects best-practice in `docs/ux-standards.md`) fails. Constitution Principle VI partial. | (1) Match both buttons to `size="default"` (h-9 = 36 px). (2) Wrap the action pair in `flex flex-col gap-2 sm:flex-row sm:justify-end w-full sm:w-auto` so each button is full-width on narrow viewports. (3) Add Playwright assertion at viewport 375 px confirming buttons do not overlap. |
| **R4-BLK-6** | `tests/e2e/at-risk-widget.spec.ts` | docstring @8 (test body missing) | Test gap / FR-034 | Spec Acceptance Scenario US4-AS5 ("Given the at-risk widget is shown to a `member` role user (the at-risk member themselves), When the page loads, Then the widget is NOT rendered — admin-only by design") and FR-034 are listed in the docstring as covered, but **no `test('AS5: …')` block exists**. This is a security invariant test gap — without it, a regression that exposes risk scores to members would not be caught at the E2E layer. | Add `test('AS5: member role cannot access at-risk widget — redirected to /portal', …)` mirroring the manager-role pattern in `admin-cycle-detail.spec.ts:122-130`: sign in as member, `page.goto('/admin/renewals')`, assert redirect to `/portal` (or 403 page) and absence of `[data-testid="at-risk-widget"]`. |

### 🟡 Warnings

| ID | File | Line(s) | Category | Finding | Recommendation |
|----|------|---------|----------|---------|----------------|
| **R4-W1** | `src/modules/renewals/application/use-cases/reconcile-pending-reactivations.ts` | 398 (`processTimeout`) | Reliability / clock determinism | `closedAt = new Date().toISOString()` uses wall-clock instead of injected `now`. Use-case schema accepts `now: z.date()` for deterministic testing (per Round-1 WRN-12 fix to `lapseCyclesOnGraceExpiry`), but `processTimeout` opens a fresh `new Date()` — `closedAt` drifts from cutoff timestamp under heavy cron load and breaks log↔audit correlation. | Pass `input.now` to `processTimeout(deps, cycle, correlationId, now)` and use `now.toISOString()` for `closedAt`. Mirror `lapseCyclesOnGraceExpiry` precedent. |
| **R4-W2** | `src/modules/renewals/application/use-cases/cancel-cycle.ts` + `mark-paid-offline.ts` | 233 + 343 | Error / forbidden-field leakage | `Result<T, { kind: 'server_error'; message: string }>` returns `e.message` raw. Route-handler may surface this in toast/HTTP body — leaks internal DB exception details (connection-timeout, constraint name, query fragment). Same class as a previously-closed Round-1 finding; recurred. | Replace with `message: 'internal error — see server logs'`; keep full stack in `logger.error` only. |
| **R4-W3** | `src/lib/lapsed-portal-scope.ts` | 148–155 (`emitBlockedAudit` payload) | Audit completeness | `lapsed_member_action_blocked` payload carries `cycle_id`, `member_id`, `blocked_route` — but **no `action` field** (HTTP method or logical operation). Spec edge-case "Lapsed-portal blocked-action scope (round 2)" requires `route + action`; without method, forensic triage cannot distinguish blocked GET from blocked POST. | Add `action?: string` to `LapsedPortalScopeContext`, propagate from each call site (`request.method`), and assert in the integration test that `payload.action` is set on mutation-path probes. |
| **R4-W4** | `drizzle/migrations/` (no migration) | new index needed | Performance / index | `gatherAtRiskFactorsForTenant` CTE in `drizzle-member-renewal-flags-repo.ts:417–501` runs `EXISTS (SELECT 1 FROM audit_log WHERE event_type='member_plan_changed' AND payload->>'member_id' = m.member_id::text AND timestamp > NOW() - INTERVAL '12 months')`. No index on `audit_log (tenant_id, event_type, timestamp)` for F8 events; at 5 k members + growing audit log, the correlated EXISTS may sequential-scan. SC-005 confidence drops below MEDIUM. | Run `EXPLAIN (ANALYZE, BUFFERS)` on Neon Singapore with realistic audit_log volume. If seq-scan: add migration `0115_audit_log_member_plan_changed_idx.sql` creating `CREATE INDEX CONCURRENTLY audit_log_f8_tier_change_idx ON audit_log (tenant_id, timestamp) WHERE event_type='member_plan_changed'`. |
| **R4-W5** | `src/modules/renewals/application/use-cases/recompute-at-risk-scores-batch.ts` | 116–118 | Reliability / tx scope | `tenantRenewalSettingsRepo.findByTenant(tenantId)` is called BEFORE the `runInTenant(externalTx, ...)` block — the settings read is NOT covered by the per-tenant advisory lock. Single-tenant MVP is safe; once admin can mutate `minTenureDaysForAtRisk` mid-cron in multi-tenant prod, settings drift between read-time and CTE-compute-time is possible. | Move `findByTenant` inside the `work(tx)` lambda. Settings is single-row read; no latency impact. |
| **R4-W6** | `src/app/api/cron/renewals/at-risk-recompute/[tenantId]/route.ts` (per-tenant) + `lapse-cycles-coordinator/route.ts` + `reconcile-pending-reactivations-coordinator/route.ts` | (no span) | Observability | Per-tenant at-risk route emits `duration_ms` in JSON body but has **no OTel span** — Vercel Observability cannot surface at-risk-recompute p95 separately from dispatch p95. Lapse + reconcile coordinator routes also lack OTel spans. SC-005 (at-risk p95 < 60 s @ 5 k) and lapse SLO have no emittable signal. | Wrap each handler call in `withActiveSpan(renewalsTracer(), 'at_risk_recompute_per_tenant', { 'tenant.id': tenantId, 'cron.kind': 'at_risk_recompute' })`. Mirror `admin_pipeline_load` span precedent. |
| **R4-W7** | `src/app/api/cron/renewals/{lapse-cycles,reconcile-pending-reactivations}-coordinator/route.ts` | `cron_dispatch_orchestrated` payload | Observability / semantic | At-risk + lapse + reconcile coordinators reuse `reminders_dispatched` field name to mean "members recomputed" / "cycles processed" / "timeouts resolved" and `tasks_created` to mean "errors". Alerts/dashboards keyed on `reminders_dispatched` will conflate counts when crons run in the same window. Round-3 I4 added `cron_kind` discriminator — verify all alert queries filter on it. | Either (a) extend the typed shape with discriminated `payload` per `cron_kind` (preferred long-term), or (b) document the field-aliasing in `docs/observability.md` § F8 + audit existing alert queries for `cron_kind` filter presence. Track as spec amendment to FR-XXX (cron observability). |
| **R4-W8** | `src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx` (`WidgetSkeleton`) | 402–415 | a11y / motion | Skeleton uses default `animate-pulse` without `motion-safe:` gate. Project pattern wraps shimmer in `motion-safe:animate-pulse` for `prefers-reduced-motion: reduce` users. Verify `globals.css` has the global `@media (prefers-reduced-motion: reduce)` override on `Skeleton`; if not, add the gate at usage. | Confirm global override; otherwise replace with `motion-safe:animate-pulse`. |
| **R4-W9** | `src/app/(staff)/admin/renewals/_components/lapsed-tab.tsx` | 204–213 (DropdownMenuTrigger) | Mobile-touch consistency | DropdownMenuTrigger uses `h-8 w-8` (32 px), inconsistent with `pipeline-table.tsx:346` which uses `h-11 w-11` (44 px). Above WCAG 2.5.8 minimum (24 px) but inconsistent within the same screen. | Change to `h-11 w-11` for visual + interaction consistency. |
| **R4-W10** | `src/components/layout/page-header.tsx` (every consumer) | autoFocusTitle path | a11y | `autoFocusTitle` prop sets `tabIndex={-1}` + ref-based focus on `<h1>`, but no `aria-live="polite"` is attached. SR behaviour on focused-but-not-live heading is engine-dependent — VoiceOver re-announces, NVDA does not. Round-3 C3 spec called for `aria-live="polite"` on the success page processing-state branch but the prop is not on PageHeader. | Add `aria-live?: 'polite' \| 'off'` prop to PageHeader; auto-set to `polite` when `autoFocusTitle === true` (focus + live region work complementary for SPA-navigation announcements). |
| **R4-W11** | `src/app/(staff)/admin/renewals/_components/tier-upgrade-suggestions.tsx` | (file missing) | Spec scope / completeness | Round-4 review prompt assumed Phase 6 ships a `tier-upgrade-suggestions.tsx` component, but the file does not exist. US5 (P3) Acceptance Scenarios + spec edge cases reference Tier Upgrade Suggestions UI (Accept/Dismiss/Escalate). If US5 is intentionally deferred to a follow-up phase, this should be tracked in `tasks.md` Phase 10 backlog. | Confirm with spec owner whether US5 UI is in F8 scope or deferred. If in scope: schedule a wave. If deferred: add to `phase-10-backlog.md` with rationale. |
| **R4-W12** | `tests/integration/auth/{account-lifecycle,invite-with-member-link}.test.ts` | :90, :72, :488 | Test / typecheck (raw `tsc`) | Direct `tsc --project tsconfig.json` against the integration auth tests reveals 3 `TS2345` errors on `CreateUserInput` (missing `tenantId`) — separate from the working-tree fix already in place for production routes. `pnpm typecheck` exits 0 in this session because the working-tree edits cover the affected files; if CI invokes `tsc` directly with a different include path, errors would surface. | After R4-BLK-1 commit lands, re-verify `pnpm typecheck` exits 0. Optionally tighten CI to invoke `tsc` directly on `tests/**` to catch the include-path divergence early. |
| **R4-W13** | `src/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer.ts` | `scoreMembers` per-member generator @80–163 + 194–213 | Performance / dead code | `scoreMembers` documented as "batched-but-sequential — one query per member" — dead code relative to the cron path which calls `recomputeAtRiskScoresBatch` (CTE batched). The "38× speedup" claim has no perf-test backing (no `tests/integration/perf/renewals-at-risk-5k.test.ts` exists; only dispatch 5 k). SC-005 confidence is LOW. | (a) Add `// NOT the cron path — see recomputeAtRiskScoresBatch` to `scoreMembers`. (b) Create `renewals-at-risk-5k.test.ts` gated on `RUN_PERF=1`. Until measured, SC-005 SLO claim stays UNVERIFIED. |
| **R4-W14** | `src/app/api/cron/renewals/at-risk-recompute-coordinator/route.ts` | 152–162 (Upstash fail-open warn-log) | Observability / consistency | `dispatch-coordinator` adds `errStack: errInstance.stack?.slice(0, 500)` to its warn-log on Upstash rate-limit failure (Wave K15-2). At-risk-recompute coordinator omits `errStack`. Consistency-only — not a security finding. | Add `errStack` to match dispatch-coordinator pattern. |
| **R4-W15** | `src/i18n/messages/th.json` `admin.outboxHealth.{permanentFailed,stuckPending}` | TH plural | i18n / quality | Pre-existing F7 carry-forward — TH CLDR has no `one` category; both keys contain `{count, plural, one {…} other {…}}`. The `one` branch is unreachable but adds dead translation weight. Not a CI failure today. | Collapse to `{count, plural, other {…}}` (identical content; ICU cleanup only). |
| **R4-W16** | `src/i18n/messages/sv.json` `portal.renewal.success.cycleStatusValue.cancelled` | "Avbrutet" vs "Avbruten" | i18n / quality | Admin uses `"Avbruten"` (utrum); portal uses `"Avbrutet"` (neutrum). Portal referent is `"förnyelse"` (utrum, -en) → `"Avbruten"` is correct. Minor grammatical-gender drift. | Unify portal copy to `"Avbruten"`. |

### 🟢 Suggestions

| ID | File | Line(s) | Category | Finding |
|----|------|---------|----------|---------|
| R4-S1 | `src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx:248` | ARIA APG | Tabpanel `<div id="at-risk-widget-rows">` lacks `role="tabpanel"` + `aria-labelledby={activeTabId}`. ARIA-Tabs APG pattern not fully met (visual + keyboard work; SR semantics missing). |
| R4-S2 | `src/app/(staff)/admin/renewals/_components/outreach-dialog.tsx:188–196` | a11y | Character counter `<p id="outreach-note-counter">` lacks `aria-live="polite"` — SR users typing in textarea don't hear count change (WCAG 4.1.3). |
| R4-S3 | `tests/unit/api/cron/renewals/at-risk-coordinator.test.ts` | coverage | No test case for "one tenant returns 500 → coordinator marks failed but continues + returns 200 with `tenants_failed: 1`". Sibling `dispatch-coordinator.test.ts` has it. Coordinator fault-isolation gap at unit layer. |
| R4-S4 | `tests/unit/renewals/domain/at-risk-score.test.ts:511–512` | brittleness | `JSON.stringify(r1) === JSON.stringify(r2)` substring assertion — replace with `expect(r1).toEqual(r2)` for actionable diff. |
| R4-S5 | `tests/unit/renewals/application/use-cases/snooze-at-risk-member.test.ts:62–71` | flakiness | ±1000 ms wall-clock tolerance instead of `vi.useFakeTimers({ now })`. Windows CI runners may exceed 1 s slack. |
| R4-S6 | `tests/e2e/portal-renewal-success.spec.ts:125` | flakiness | `seedF8Renewals()` restore in `finally` block — no try/catch; restore failure swallows error + breaks suite-order. Wrap in try/catch + `console.warn`. |
| R4-S7 | `tests/unit/renewals/domain/tier-upgrade-suggestion.test.ts:103–168` | brittleness | 5 happy-path `.ok).toBe(true)` produce zero structural diff on failure. Use `expect(result).toMatchObject({ ok: true })` or destructure `{ ok, error }; expect(ok, error?.kind).toBe(true)`. |
| R4-S8 | `docs/observability.md` § F8 | observability | No F8 section exists. SC-003 + SC-005 SLO commitments referenced in code comments but not in observability contract. Per-tenant latency histograms (`renewals_dispatch_per_tenant_duration_ms`, `renewals_at_risk_recompute_duration_ms`) absent. Maintainer decision required before `/speckit.verify` can confirm SLOs observably. |
| R4-S9 | `tests/e2e/at-risk-widget.spec.ts` (T176 labelling) | docs | Memory entry `T176 mobile E2E pass` references at-risk-widget E2E, but task name suggests `admin-pipeline-mobile.spec.ts`. Clarify in `tasks.md` to avoid future confusion. |
| R4-S10 | `src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts:637–645` | perf | `listAtRiskWidgetMembers` summary query bypasses partial index `members_at_risk_idx` (predicate mismatch on `risk_snoozed_until`). Heap recheck adds ~10 ms at 5 k members. Acceptable at MVP scale. |

---

## Constitution Alignment (v1.4.0, 10 Principles)

| Principle | Verdict | Evidence |
|---|---|---|
| **I — Data Privacy & Security (NON-NEG)** | ✅ PASS | Two-layer isolation (RLS+FORCE + explicit tenantId predicate) holds across all F8 surfaces. Cross-tenant probe integration tests 14/14 pass. Per-tenant fault isolation in coordinators correct. R4-BLK-1 working-tree fix correctly addresses 0098 NOT NULL constraint without bypassing RLS. |
| **II — Test-First (NON-NEG)** | ⚠️ PARTIAL | 4107 unit + contract green; 174 integration green on live Neon Singapore; 32 Python unit green; FR-029 8-factor + 512-case property-based suite excellent. R4-BLK-6 (AS5/FR-034 missing test body) + R4-S3 (fault-isolation coordinator gap) need closure. |
| **III — Clean Architecture (NON-NEG)** | ✅ PASS | Domain pure (zero `next/drizzle/react` imports verified). Application uses ports only. `_lib/` co-location pattern in Application + Presentation is project-internal helper convention (consistent with F7). `src/proxy.ts` is the Next.js 16 `middleware.ts` rename — justified, documented inline. Module barrels export public surface only. |
| **IV — PCI DSS (NON-NEG)** | ✅ n/a | F8 only reads payment counts via F5 bridge port — no card data on F8 surfaces. F5 owns SAQ-A. |
| **V — Internationalization** | ❌ PARTIAL → FAIL post-flag-flip | R4-BLK-2 (10 audit-event-type translations missing) breaks `pnpm check:i18n` on release branches. R4-W15+W16 are pre-existing quality polish. After R4-BLK-2 fix → PASS. |
| **VI — Inclusive UX (Mobile-First + WCAG 2.1 AA)** | ❌ PARTIAL | R4-BLK-4 (focus-visible on band tabs WCAG 2.4.7) + R4-BLK-5 (touch target on Contact+Snooze WCAG 2.5.5) fail. R4-W8/W9/W10/S1/S2 are polish. After R4-BLK-4+5 fix → PASS. |
| **VII — Performance & Observability** | ⚠️ PARTIAL | SC-003 (pipeline p95 < 500 ms) MEDIUM confidence — methodology sound, indexes in place, awaiting `RUN_PERF=1` measurement. SC-005 (at-risk p95 < 60 s @ 5 k) LOW confidence — no perf test for `recomputeAtRiskScoresBatch`. R4-W4 (audit_log index) + R4-W6 (OTel spans) + R4-W7 (cron field-aliasing) + R4-S8 (docs/observability.md F8) are coverage gaps. |
| **VIII — Reliability (state↔audit atomicity)** | ⚠️ PARTIAL | All state-mutation paths atomic with audit emit (verified). R4-BLK-3 (3 events missing from `F8_ENUM_SHIPPED` → silent audit-row drop on defensive deny paths in production) violates audit-completeness invariant. R4-W1 (wall-clock `closedAt`) + R4-W2 (raw `e.message`) are reliability/UX polish. After R4-BLK-3 fix → PASS. |
| **IX — Code Quality** | ✅ PASS | `pnpm typecheck` 0 errors against working-tree state. `pnpm lint` clean. `pnpm check:i18n` blocked only by R4-BLK-2. Round-3 dead-code culling continues; `branded-ids.ts` deletion holds. |
| **X — Simplicity (YAGNI)** | ✅ PASS | `_lib/dispatch-one-cycle.ts` has 2 callers (cron + admin send-now); `cycle-detail-fetchers.ts` has 1 caller. No speculative abstractions. R4-W11 (missing `tier-upgrade-suggestions.tsx`) confirms scope discipline (US5 P3 deferral acknowledged). |

---

## Spec Coverage Matrix (Phase 6 / US4 / US5 / US6)

| FR | User Story | Implementation | Test |
|---|---|---|---|
| FR-029 (8-factor at-risk score) | US4-AS1 | `src/modules/renewals/domain/at-risk-score.ts` | ✅ unit (512-case prop-based + boundary) + integration |
| FR-029a (F6 fallback to 7 factors) | US4 clarification | `event-attendees-stub.ts` + `EventAttendeesPort.isAvailable()` | ✅ contract test |
| FR-030 (band thresholds 17/35/52 vs 25/50/75) | US4-AS1 | Domain const tables | ✅ unit |
| FR-031 (snooze with auto-expiry) | US4-AS3 | `snoozeAtRiskMember` use-case | ✅ unit + integration |
| FR-032 (contact pre-fill outreach) | US4-AS4 | `recordAtRiskOutreach` use-case + `outreach-dialog.tsx` | ✅ unit + E2E |
| FR-033 (cron per-tenant fault isolation) | US4-AS6 | `at-risk-coordinator/route.ts` + `at-risk-per-tenant/route.ts` | ⚠️ unit (R4-S3 gap) |
| FR-034 (member-role widget hidden) | US4-AS5 | UI `actorRole` prop check | ❌ E2E missing (R4-BLK-6) |
| FR-035 (server-side authz on mutating routes) | US4 spec edge | `requireRenewalAdminContext` + `f8_role_violation_blocked` audit | ✅ verified |
| FR-052 (kill-switch deny path) | spec edge | `/api/admin/renewals/route.ts:60-77` | ✅ but R4-BLK-3 audit drop |
| FR-005b (auto-reactivation block) | US3 spec | `block-auto-reactivation.ts` + `unblock-auto-reactivation.ts` | ✅ unit |
| FR-027 (HMAC token verify, 7-step) | US3-AS1+7 | `verify-renewal-link-token.ts` | ✅ unit + integration |
| FR-012a (bounce thresholds 1/3/5) | US2 spec edge | `detect-bounce-threshold.ts` | ✅ integration (3 distinct trigger paths) |
| US5 (Tier Upgrade Suggestions UI) | P3 | ❌ `tier-upgrade-suggestions.tsx` missing — see R4-W11 | n/a |
| US6 (Manual Escalation Task Queue) | P3 | partial — `escalation_task_*` audit + repo present | partial |

**Phase 6 FR coverage**: 12/14 fully implemented + 1 deferred (US5 UI) + 1 test-gap (FR-034) = ~85% spec compliance. Backend complete, UI surfaces defer.

---

## Test Coverage Assessment

- **Unit + contract**: 4107 GREEN (1 skipped) — Round-3 close pinned
- **Integration on live Neon Singapore**: ~180 GREEN — Phase 6 cross-tenant + at-risk + bounce-threshold + auto-reactivation full coverage
- **Python unit**: 32 GREEN (first Python test surface — `extract_demo_members.py`)
- **E2E**: ~10 GREEN (lapse-cycles-cron, admin-cycle-detail, portal-renewal-success, at-risk-widget, mobile, etc.) — `--workers=1` mandate honoured
- **i18n parity**: 2048 keys × 3 locales structural OK; quality gate fails on R4-BLK-2 (10 missing audit-event-type keys)
- **Coverage thresholds** (`vitest.config.ts`): Domain 100% line + Application 80%+ + 100% branch on 11 security-critical use-cases (last verified GREEN)

**Test-quality polish needed (R4-S3 to R4-S7)**: 5 brittleness/flakiness items + 1 fault-isolation coverage gap. Non-blocking but advisable before ship.

---

## Metrics

- **Total Round-4 findings**: 36
  - 🔴 Blocker: **6** (1 commit gap, 1 i18n, 1 audit whitelist, 2 a11y, 1 test gap)
  - 🟡 Warning: **16** (3 reliability, 2 i18n quality, 4 perf/observability, 3 a11y polish, 2 reliability polish, 1 test quality, 1 spec scope)
  - 🟢 Suggestion: **10** (4 test polish + 4 a11y polish + 2 documentation)
- **Files reviewed**: ~60 across `src/modules/renewals/**`, `src/app/(staff)/admin/renewals/**`, `src/app/(member)/portal/renewal/**`, `src/app/api/cron/renewals/**`, `src/lib/{lapsed-portal-scope,auth-deps}.ts`, all 19 F8 migrations, all 3 i18n locale files, ~30 test files
- **Constitution principles evaluated**: 10/10
  - 4 NON-NEG: PASS (I, III, IV) + PARTIAL (II — closes after R4-BLK-6)
  - V: PARTIAL → PASS after R4-BLK-2
  - VI: PARTIAL → PASS after R4-BLK-4 + R4-BLK-5
  - VII: PARTIAL (perf measurement + observability gaps — non-Constitution-blocking)
  - VIII: PARTIAL → PASS after R4-BLK-3
  - IX, X: PASS
- **Phase 6 FR coverage**: ~85% (US5 UI deferred + FR-034 test gap)
- **Spec drift**: 0 (no scope creep)
- **Round-1+2+3 closures held**: 68/68 (100%)

---

## Recommended Actions (Prioritised)

### Must fix before ship (6 Blockers)

1. **R4-BLK-1** — single `[Spec Kit] fix(F8): F1 tenantId propagation` commit covering all 13 working-tree files. Run `pnpm typecheck && pnpm test:integration tests/integration/auth tests/integration/members --workers=1` post-commit.
2. **R4-BLK-2** — add 10 audit-event-type translations to `audit.eventType.*` in `en.json` + `th.json` + `sv.json`. Run `pnpm check:i18n` to confirm 2058 keys × 3 locales.
3. **R4-BLK-3** — add `renewal_kill_switch_blocked`, `lapsed_member_action_blocked`, `renewal_cross_member_probe` to `F8_ENUM_SHIPPED` Set in `drizzle-renewal-audit-emitter.ts:67`. Add unit test asserting `F8_ENUM_SHIPPED.has(event)` for the 5 REQUIRED_EVENTS.
4. **R4-BLK-4** — add `focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2` to at-risk-widget band tab buttons. Add axe-core E2E assertion.
5. **R4-BLK-5** — match Contact + Snooze button sizes (`size="default"` h-9) and wrap in `flex flex-col gap-2 sm:flex-row sm:justify-end w-full sm:w-auto`. Add Playwright 375 px viewport assertion.
6. **R4-BLK-6** — add `test('AS5: member role cannot access at-risk widget — redirected', …)` to `tests/e2e/at-risk-widget.spec.ts` mirroring manager-role pattern.

### Strongly recommended before ship (16 Warnings)

7. **R4-W1** — inject `now` into `processTimeout` of `reconcile-pending-reactivations.ts:398`.
8. **R4-W2** — replace raw `e.message` in `cancel-cycle.ts:233` + `mark-paid-offline.ts:343` with sanitised `'internal error — see server logs'`.
9. **R4-W3** — add `action` (HTTP method) to `lapsed_member_action_blocked` audit payload.
10. **R4-W4** — `EXPLAIN ANALYZE` on `gatherAtRiskFactorsForTenant` against Neon Singapore; add `audit_log_f8_tier_change_idx` migration if seq-scan.
11. **R4-W5** — move `tenantRenewalSettingsRepo.findByTenant` inside `runInTenant(externalTx, ...)` block in `recompute-at-risk-scores-batch.ts:118`.
12. **R4-W6** — add OTel spans to per-tenant at-risk + lapse + reconcile coordinator routes.
13. **R4-W7** — document `cron_dispatch_orchestrated` field aliasing in `docs/observability.md` § F8 + audit alert filters for `cron_kind` presence.
14. **R4-W8** — confirm/add `motion-safe:animate-pulse` gate on `WidgetSkeleton`.
15. **R4-W9** — change lapsed-tab DropdownMenuTrigger to `h-11 w-11` for consistency.
16. **R4-W10** — add `aria-live` prop to `PageHeader`; auto-set `polite` when `autoFocusTitle === true`.
17. **R4-W11** — confirm US5 (Tier Upgrade Suggestions UI) scope decision; either schedule wave or move to `phase-10-backlog.md`.
18. **R4-W12** — re-verify `pnpm typecheck` post-R4-BLK-1; consider tightening CI to invoke `tsc` directly.
19. **R4-W13** — comment `scoreMembers` as non-cron path; create `renewals-at-risk-5k.test.ts` gated `RUN_PERF=1`.
20. **R4-W14** — add `errStack` to at-risk-recompute coordinator warn-log for consistency with dispatch.
21. **R4-W15** — TH outboxHealth ICU plural cleanup (drop unreachable `one` branch).
22. **R4-W16** — SV portal `cycleStatusValue.cancelled` grammatical-gender fix to `"Avbruten"`.

### Optional polish (10 Suggestions)

23–32 — see Suggestions table above (test brittleness/flakiness/coverage + ARIA APG completeness + outreach-counter aria-live + observability docs).

---

## Verdict

❌ **CHANGES REQUIRED**

Phase 6 (US4 At-Risk Member Detection) backend is architecturally sound and well-tested at the use-case + integration layer. Constitution Principles I (tenant isolation), III (Clean Architecture), IV (PCI n/a), IX (code quality), X (simplicity) all PASS. Round-1 + Round-2 + Round-3 closures (68 findings) all hold without regression — a strong signal of fix-discipline.

The 6 Round-4 Blockers are mechanical to fix:
- **3 are code-only** (audit whitelist + 2 UI a11y) requiring < 30 minutes of engineering
- **1 is a commit** of an already-correct working-tree (5 minutes)
- **1 is i18n** (10 keys × 3 locales — translations proposed in i18n agent's report)
- **1 is a missing test body** for a security invariant already enforced in code (~30 LOC E2E)

Total Blocker remediation effort: ~2 hours of focused work + verification runs.

The 16 Warnings include 4 perf/observability gaps that are SC-005 evidence concerns (not architectural defects); the perf-test for `recomputeAtRiskScoresBatch` should be authored and run before the `FEATURE_F8_RENEWALS=true` flag-flip, but does not block the merge.

**Strengths to preserve (do not regress)**:
- 9-agent parallel review surfaced 36 findings with no overlap on already-closed items — closure discipline is strong
- Property-based 512-case at-risk Domain test suite is exemplary
- Round-3 `cycle_not_found` vs `unexpected` distinction in `fetchMemberDisplay` (silent-degradation guardrail)
- Two-layer tenant isolation pattern (`runInTenant` + explicit `eq(table.tenantId, ctx.tenantId)`) consistently applied across F2-F8 boundaries
- HMAC token 7-step verification (FR-027) including timing-safe compare + tenant cross-check + single-use enforcement
- Cron coordinator fault isolation pattern (per-tenant + zero-tenant 200 + Bearer + `cron_dispatch_orchestrated` audit) ready for multi-tenant scale-out

**Conditions for `/speckit.staff-review.run` Round 5**:
1. Close all 6 Blockers (R4-BLK-1 through R4-BLK-6)
2. Commit the working-tree as a single `[Spec Kit] fix(F8)` commit
3. Run full local CI chain: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1`
4. Re-run `/speckit-staff-review-run` Round 5 for Blocker-closure verification

After Round 5 ✅, gates remaining for `/speckit.ship`: maintainer GPG sign on security checklist (T277-class), cron-job.org configuration (T277b-class), and the SC-003 + SC-005 perf-evidence runs.

---

## Sub-agent Provenance

| Agent | ID | Focus | Key findings |
|---|---|---|---|
| chamber-os-architect | af93ae153dbba1860 | Constitution + architecture | R4-BLK-1 (working-tree commit), R4-BLK-2 (typecheck — re-verified false at HEAD with working-tree) |
| security-threat-modeler | a82e3b48f7817e74a | STRIDE + tenant isolation | T-06 (audit `action` field) → R4-W3, T-13 (errStack) → R4-W14 |
| reliability-guardian | aa8403f5c70e0612d | Atomicity + advisory locks | M-1 (wall-clock `closedAt`) → R4-W1, M-2 (raw `e.message`) → R4-W2 |
| drizzle-migration-reviewer | afac849dbc670dbe2 | Migrations 0096–0114 + journal | Confirmed BLK-1 (journal monotonic) hold; flagged 3 events missing from F8_ENUM_SHIPPED → R4-BLK-3 |
| senior-tester | a656429c882b590d3 | Test coverage + brittleness | R4-BLK-6 (AS5 missing test), R4-S3–S7 (test polish) |
| performance-slo-guardian | ac79fa85a75631726 | SC-003 + SC-005 SLOs | P-01–P-09 → R4-W4/W5/W6/W13 + R4-S10 |
| i18n-translation-reviewer | a9622bace6560c1e2 | 2048 keys × 3 locales | R4-BLK-2 (10 audit event-type keys missing), R4-W15/W16 |
| mobile-a11y-ux-reviewer | a80c9792ab2c584c3 | WCAG 2.1 AA + mobile-first | R4-BLK-4 (focus-visible band tabs), R4-BLK-5 (touch target), R4-W8/W9/W10/W11/S1/S2 |
| observability-instrumentor | acca5a07e5925631a | Audit/metrics/SLO emission | G1–G3 (whitelist) → reinforces R4-BLK-3, G4–G5 (OTel spans) → R4-W6, G6 (field aliasing) → R4-W7, S8 (docs/observability F8) |

---

**Post-Review Actions**

After fixing the 6 Blockers (R4-BLK-1 to R4-BLK-6):
1. Run `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout`
2. Run `pnpm test:integration` against live Neon Singapore
3. Run `pnpm test:e2e --workers=1` (full E2E sweep including new AS5 test)
4. Re-run `/speckit-staff-review-run` Round 5 for verification
5. If Round 5 ✅: address remaining 16 Warnings (or document as Phase-10 backlog deferrals with rationale)
6. Maintainer GPG-signs the security checklist
7. Configure cron-job.org endpoints
8. Run `RUN_PERF=1 pnpm test:integration tests/integration/perf/` to capture SC-003 + SC-005 evidence
9. `/speckit.ship`
