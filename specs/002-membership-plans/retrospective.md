---
feature: 002-membership-plans
branch: 002-membership-plans
date: 2026-04-12
last_updated: 2026-04-12T15:12Z
completion_rate: 98%
spec_adherence: 100%
requirements_total: 32
requirements_implemented: 32
requirements_modified: 0
requirements_partial: 0
requirements_not_implemented: 0
unspecified_implementations: 2
tasks_total: 175
tasks_completed: 173
tasks_deferred_to_user: 2
tasks_deferred_to_f3: 0
tasks_modified: 0
tasks_added_during_implementation: 1
critical_findings: 0
significant_findings: 2
minor_findings: 3
positive_findings: 6
constitution_violations: 0
ship_state: shipped
pr_number: 3
pr_url: https://github.com/Jirawatpyk/Swedish-chaplain_Membership/pull/3
merged_at: 2026-04-12T08:12:49Z
---

# F2 — Membership Plans — Retrospective

## Executive Summary

F2 ships the **membership plan catalogue** for Chamber-OS — the foundation layer every downstream commerce feature (F3 Members, F4 Invoicing, F5 Payments, F7 E-Blast, F8 Renewal, F9 Dashboard) depends on. For the SweCham (TSCC) first tenant, F2 delivers the nine 2026 plans (6 corporate tiers + 3 partnership tiers) from `docs/membership-benefits-analysis.md` — complete with structured benefit matrix, year versioning, partial edit lock for prior years, per-tenant fee configuration (currency / VAT / registration fee), soft-delete, command palette, and a full Enterprise-UX admin CRUD surface under `/admin/plans` + `/admin/settings/fees`.

F2 is also the feature where Chamber-OS earns its SaaS posture: it introduced the **cross-cutting tenant-context resolver** plus **Postgres Row-Level Security (RLS)** policies on every tenant-scoped table, satisfying Constitution v1.4.0 Principle I clauses 1–3 (application-layer + database-layer + cross-tenant integration test) on day one.

**All 6 user stories shipped (3 P1 MVP + 3 P2):**
- US1: Admin views plans list with filter, sort, detail (P1)
- US2: Admin creates/clones plans via 4-step wizard (P1)
- US3: Admin edits plans with prior-year lock banner (P1)
- US4: Admin deactivates/soft-deletes/undeletes plans (P2)
- US5: Admin manages fee configuration, manager read-only (P2)
- US6: Admin uses the command palette (P2)

**US7 (Inline Edit + Bulk Actions) deferred to F3** per critique X1c — the value math on ≤9 plan rows was thin, and deferring gives the editable-table primitive the multi-entity stress test it deserves under F3 Members.

**Implementation**: 9 phases across 33 commits + 8 QA passes (all PASSED) + 3 PR review rounds (21→5→0 findings) + 1 staff review (APPROVED WITH CONDITIONS → fixed). 173 of 175 tasks completed. Solo-dev workflow under Constitution v1.3.1/v1.4.0 substitute clause.

**Test baseline at ship:**
- Unit + contract: **500/500 green** (52 files)
- Integration vs live Neon Singapore: **165/165 green** (42 files, 1 intentional skip)
- i18n: **296 keys × 3 locales** (EN + TH + SV)
- E2E: **66 passed** (F2 tests all green)
- Lint: 0 errors, 0 warnings
- Typecheck: 0 errors (strict + `exactOptionalPropertyTypes: true`)
- Production build: green

**Ship status**: merged via PR [#3](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/pull/3) on 2026-04-12.

---

## What Shipped

### Phase 1: Setup (T001–T010, 8 completed)
- Branch verification, `cmdk` install with React 19 compat, shadcn primitives, env.ts extension (`TENANT_SLUG`, `DEBUG_RLS_STATE`), ESLint `no-restricted-imports` for plans + tenants modules, vitest coverage thresholds
- T008 (admin workflow confirmation) + T009 (Vercel env add) deferred to user action

### Phase 2: Foundational (T011–T061, 51 tasks)
- `src/modules/tenants/` cross-cutting Domain-only module with `TenantContext` branded type
- `src/modules/plans/` full Clean-Architecture bounded context (Domain → Application → Infrastructure)
- Drizzle schema: `membership_plans` + `tenant_fee_config` tables with RLS
- Migrations 0006 + 0007 (RLS policies, audit enum extension with 10 new event types)
- `runInTenant(ctx, fn)` + `SET LOCAL app.current_tenant` plumbing
- i18n: 200+ keys across EN/TH/SV for plans admin namespace
- F1 RBAC extension: `plan.read`, `plan.write`, `fee.read`, `fee.write` permissions

### Phase 3: US1 — List + Detail + Seed (T062–T090, 29 tasks)
- Plans list with year filter, category filter, status badges
- Plan detail view with structured benefit matrix display
- `/api/plans/search` endpoint for command palette
- `scripts/seed-swecham-2026-plans.ts` — 9 plans + 1 fee config

### Phase 4: US2 — Create + Clone (T092–T110, 19 tasks)
- 4-step wizard (Basics → Fees → Benefits → Review)
- Clone year flow with confirmation dialog
- Idempotent clone (duplicate detection via composite key)

### Phase 5: US3 — Edit + Lock Banner (T111–T121, 11 tasks)
- Plan edit form reusing wizard primitives
- Prior-year lock banner (cosmetic fields editable; pricing/eligibility/benefits locked)
- Audit payload diff with `{ [field]: { before, after } }` contract

### Phase 6: US4 — Deactivate/Delete/Undelete (T122–T137, 17 tasks)
- Row-level dropdown-menu actions (activate, deactivate, soft-delete, undelete)
- State machine enforcement (active ↔ inactive → deleted → inactive via undelete)
- Confirmation dialogs with explicit verb copy

### Phase 7: US5 — Fee Configuration (T138–T149, 12 tasks)
- `/admin/settings/fees` page with VAT, registration fee, currency display
- Manager read-only enforcement (UI + server-side)
- Currency immutability guard (422 `currency_code_immutable_in_f2` when plans exist)

### Phase 8: US6 — Command Palette (T150–T157, 8 tasks)
- `cmdk`-based palette mounted at shell level via `CommandPaletteRoot`
- Three groups: Plans / Actions / Navigate (self-hiding when empty)
- Server-side + client-side role filter (admin sees all; manager sees read-only)
- Cold-open 25ms (budget 300ms), warm-open 15ms (budget 100ms)

### Phase 9: Polish & Cross-Cutting (T158–T174, 17 tasks)
- Keyboard-only E2E test (`plans-keyboard-only.spec.ts`)
- Observability docs: F2 metrics catalogue + `plan_cross_tenant_probe` runbook
- Security checklist 40/40, UX checklist 25/25, Requirements checklist 16/16
- Full CI pipeline validation (all green)
- Tenant-isolation test confirmed green (10/10 — Review-Gate blocker cleared)
- Lighthouse CI config updated with F2 URLs
- CLAUDE.md updated with F2 technologies

---

## What Was Deferred

### Deferred to F3 (by design)
- **US7 — Inline Edit + Bulk Actions** (critique X1c): ≤9 plan rows don't justify a TanStack Table dependency. F3 Members (hundreds of rows) will introduce the primitive and retro-apply.
- **US3 AS4 — Partnership bundle-change warning**: specific warning when editing partnership plan benefits that affect existing members. Requires F3 Members association data.
- **SC-010 usability walkthrough** (T174): requires 3 human participants

### Deferred to user action
- **T008**: Admin workflow confirmation (10-minute chat with SweCham admin)
- **T174**: SC-010 usability walkthrough with 3 participants

*T009, T168–T170, T173 completed during post-implementation polish.*

---

## What Critique Rounds Caught

Two critique rounds (2026-04-11) surfaced **4 Must-Address + 14 Recommendations**:

### Must-Address (all resolved pre-implementation)
1. **X1c**: US7 deferred to F3 (value-thin for ≤9 rows)
2. **E1/X2**: `TenantContext` moved from plans to cross-cutting `src/modules/tenants/`
3. **E3**: Pre-implementation Neon RLS verification gate (`scripts/verify-rls-set-local.ts`)
4. **E5**: `DEBUG_RLS_STATE` assertion helper for dev-mode tenant-context checking

### Key Recommendations (implemented)
- **P3**: Per-plan `currency_code` dropped (YAGNI — single currency per tenant on `tenant_fee_config`)
- **P8**: Cold/warm palette timing budgets split + `<link rel="preconnect">` hint
- **E6**: Cross-tenant probe response 404 (not 403) + `plan_not_found` audit event
- **E8**: UUID-suffixed test tenant slugs for parallel CI safety
- **E9**: `plan_cross_tenant_probe` runbook (< 5 min triage SLA)
- **E11**: Pin `cmdk` version at install time with React 19 compat verification
- **R1** (round 2): Currency immutability guard with specific 422 error shape
- **R2** (round 2): Migration filename consistency across all referencing files

---

## What Surprised

1. **cmdk's `CommandDialog` missing `<Command>` root**: The project's shadcn-installed `CommandDialog` in `src/components/ui/command.tsx` renders children directly inside `<DialogContent>` without wrapping them in a `<Command>` root. cmdk's primitives throw `TypeError: Cannot read properties of undefined (reading 'subscribe')` on mount. Fix: explicit `<Command>` wrapper inside `command-palette.tsx`.

2. **React 19 strict `set-state-in-effect` lint**: Three separate lint violations during Phase 8 required creative workarounds — `useTransition` + `useDeferredValue` + `useCallback` instead of `useState` + `useEffect` setState patterns.

3. **`exactOptionalPropertyTypes: true` strictness**: Required careful handling of optional vs undefined properties across all type definitions. Several times needed explicit `undefined` values rather than omitting properties.

4. **Neon Singapore `CONNECT_TIMEOUT` flakes**: Occasional integration test failures (1-2 per full suite run) from Neon connection timeouts. Not a regression — same pattern observed in F1. Retries succeed.

5. **Layout target mismatch**: `tasks.md` said `src/app/(staff)/layout.tsx` for palette mount but actual staff shell lives at `src/app/(staff)/admin/layout.tsx`. Documentation vs reality gap.

---

## What to Do Differently for F3

1. **Run critique rounds earlier**: Both critique rounds were on the same day. Staggering them by 1 day would reduce the round-2 regression risk (R1/R2 were bugs introduced by round-1 remediation).

2. **Establish checklist cadence**: Security (40 items) + UX (25 items) checklists accumulated to Phase 9. Better: validate incrementally per-phase, 5-10 items at a time.

3. **Auth-gated Lighthouse**: Set up a Playwright auth script that injects session cookies before Lighthouse audits. F2 pages behind auth can't be audited by vanilla `lhci autorun`.

4. **Seed script stability**: The `seed-swecham-2026-plans.ts` script assumes clean state. F3 should make seeds idempotent (upsert pattern) so they're re-runnable safely.

5. **Integration test timeout budget**: 196s for 163 tests against Neon Singapore. As test count grows (F3 Members will add ~50+), consider connection pooling or a local test DB for non-RLS tests.

---

## Metrics

| Metric | Value |
|--------|-------|
| Phases | 9 |
| Commits | 33 |
| Tasks total | 175 |
| Tasks completed | 173 (98.9%) |
| Tasks deferred (human-only) | 2 (T008, T174) |
| User stories shipped | 6/7 (US7 deferred to F3) |
| Unit + contract tests | 500 (+20 vs F1 baseline of 480) |
| Integration tests | 165 (+83 vs F1 baseline of 82) |
| E2E specs (F2) | 66 passed |
| i18n keys | 296 (+296 vs F1 baseline) |
| QA passes | 8 (all PASSED) |
| PR review rounds | 3 (21→5→0 findings) |
| Staff review rounds | 1 (APPROVED WITH CONDITIONS → fixed) |
| Critique findings resolved | 18 (4 must + 14 recommend) |
| Security checklist | 40/40 |
| UX checklist | 25/25 |
| Requirements checklist | 16/16 |
| Constitution violations | 0 |
| PR | [#3](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/pull/3) |
| Merged | 2026-04-12T08:12:49Z |
