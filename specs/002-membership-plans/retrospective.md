---
feature: 002-membership-plans
branch: 002-membership-plans
date: 2026-04-12
last_updated: 2026-04-12T11:00Z
completion_rate: 97%
spec_adherence: 100%
requirements_total: 32
requirements_implemented: 32
requirements_modified: 0
requirements_partial: 0
requirements_not_implemented: 0
unspecified_implementations: 2
tasks_total: 174
tasks_completed: 165
tasks_deferred_to_user: 6
tasks_deferred_to_f3: 3
tasks_modified: 0
tasks_added_during_implementation: 0
critical_findings: 0
significant_findings: 2
minor_findings: 3
positive_findings: 6
constitution_violations: 0
ship_state: ready_for_review
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

**Implementation**: 9 phases across 17 commits + 8 QA passes (all PASSED). 165 of 174 tasks completed. Solo-dev workflow under Constitution v1.3.1/v1.4.0 substitute clause.

**Test baseline at ship:**
- Unit + contract: **495/495 green** (52 files)
- Integration vs live Neon Singapore: **163/164 green** (41 files, 1 intentional skip)
- i18n: **268 keys × 3 locales** (EN + TH + SV)
- Lint: 0 errors, 0 warnings
- Typecheck: 0 errors (strict + `exactOptionalPropertyTypes: true`)
- Production build: green

**Recommendation**: proceed to `/speckit.review` → `/speckit.ship`.

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
- **T009**: `TENANT_SLUG=swecham` in Vercel prod/preview env
- **T168–T170**: Prod Neon migration + seed + env var verification
- **T173**: Manual smoke test of all user stories

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
| Commits | 17+ |
| Tasks total | 174 |
| Tasks completed | 165 (95%) |
| Tasks deferred | 9 (6 user-action + 3 F3) |
| User stories shipped | 6/7 (US7 deferred) |
| Unit + contract tests | 495 |
| Integration tests | 163 (+81 vs F1 baseline of 82) |
| i18n keys | 268 (+268 vs F1 baseline) |
| QA passes | 8 (all PASSED) |
| Critique findings resolved | 18 (4 must + 14 recommend) |
| Security checklist | 40/40 |
| UX checklist | 25/25 |
| Requirements checklist | 16/16 |
| Constitution violations | 0 |

---

## Post-Ship Addendum — 2026-04-15 (E2E Stabilization Sweep)

After F4 merged, a full Chromium serial E2E run against `main` exercised every F2 spec end-to-end for the first time. Several F2-area issues surfaced that hadn't manifested when only the unit/integration/contract layers were green at ship.

### Component fixes back-applied to F2 code

- **plans-table — plan name is now a real link** (`<a href={planDetailUrl}>`). Keyboard users can Tab → Enter to reach a plan detail; before this the row only had a dropdown trigger button. UX + a11y improvement.
- **plans-table Switches got `aria-labelledby`** — Base UI Switch renders `<span role="switch">`, not `<input>`, so `<Label htmlFor>` association is silent. Added `id` on Label + `aria-labelledby` on Switch for both filter switches (Active-only + Show-deleted).
- **benefit-matrix-editor BoolField + 7 Selects** got the same `aria-labelledby` pattern. axe was reporting 165 WCAG 2.1 AA violations on `/admin/plans/new` from these unlabeled controls; now zero.
- **plan-form-wizard + plan-edit-form Selects** (3 total) got explicit `aria-label` on `SelectTrigger` since the closest visible Label is sometimes hidden by a wrapper.
- **plan-form-wizard `<Label>` for plan_id** got a missing `htmlFor` so `getByLabel(/plan id/i)` can resolve it.
- **plans/page.tsx — validate `?year=` query before `asPlanYear`**: `?year=9999` (or any out-of-range integer) used to throw 500 because the gate `!Number.isNaN(Number(q))` accepted out-of-range integers. Now validates `[2000, 2100]` explicitly.

### Test-side fixes that affected F2 specs

- **`waitForURL` regex** `/\/admin(\/|$)/` matched `/admin/sign-in` and made signIn() return before the login POST completed. 25 specs across F1/F2/F3/F4 needed the same fix.
- **Plan-id row selector**: `getByRole('row').filter({ has: '[data-plan-id]' })` doesn't match because `data-plan-id` is ON the `<tr>` itself, not a descendant. Replaced with `tr[data-plan-id]`.
- **Base UI Select interaction**: `selectOption()` fails because Base UI Select.Trigger is a `<button>`, not a native `<select>`. Use URL filter or click-trigger + click-option pattern.
- **Plans-deactivate state isolation**: re-fetch row + status between restore + activate steps; captured stale text caused the activate branch to skip.
- **plans-create-wizard clone**: pick a unique target year per run so re-runs don't 409 on `target_year_populated`.
- **command-palette navigate**: click the matched option directly (cmdk Enter propagation is unreliable under React 19).

See `specs/004-page-layout-standard/retrospective.md` § Post-Ship Addendum for the full L10–L20 lessons (most apply to F2 too).

### Final F2 E2E status (chromium)

All F2 tests pass: plans-list, plans-create-wizard, plans-edit, plans-deactivate, plans-keyboard-only, plans-i18n-coverage, plans-a11y, plans-reduced-motion, fee-config, command-palette. 1 skipped (`plans-edit prior-year lock banner` — needs a 2025 seed; Domain logic is unit-tested).

---

## Post-ship R6 audit closure (2026-05-19)

`/speckit-review` retrospective sweep on the shipped F2 surface (branch `014-email-broadcast-advance`, concurrent with F7.1a session) — 7-agent parallel review flagged **21 findings** (7 Critical + 14 Important) recorded in `specs/002-membership-plans/reviews/review-20260519-144559.md`. All 21 closed across 4 atomic commits + 1 cross-feature bonus.

### Resolved decisions

- **D1 (C1)** — wire F3 real `MemberAttachmentChecker` via NEW F3 barrel export `countActiveMembersOnPlan` + F2 adapter `drizzleMemberAttachmentChecker`. Constitution Principle III honoured (no deep cross-module imports). Stub deleted; soft-delete-with-members gains 2 new Scenarios with real F3 rows
- **D2 (I2)** — F2 use-case emits `plan_change_scheduled` + `plan_change_superseded`. F8 cross-module: composition root injects `f2AuditEmitter: F2AuditPort` (sub-barrel `@/modules/plans/server` exports `planAuditAdapter` to avoid client-bundle pino leak); F8 `accept-tier-upgrade` emits both events post-tx. `plan_change_{cancelled,applied}` remain declared with `TODO(renewal-applier):` markers — no Domain caller exists today (NOT F9; F9 = Admin Dashboard per docs/phases-plan.md)
- **D3 (C5)** — DELETE all US5 fee-config dead code (migration 0029 retired the table). 7 src files + 10 test files + seed comment cleaned. F1 `audit_event_type` pgEnum retains `fee_config_updated` as legacy backward-compat for historical audit rows
- **D4 (I9)** — Money fully branded (`unique symbol` phantom, A-grade pattern from `IanaTimezone`); LocaleText gets `asLocaleText` smart constructor + `LocaleTextLiteral` back-compat alias. Full LocaleText brand + `no-restricted-syntax` ESLint rule deferred to a future round (70+ call sites); BenefitMatrix branding deliberately skipped (every field already domain-typed enum/union — no safety gain)

### Commit chain

```
b5ce6f66  Batch 1d — C2/C3/I9 (shared lib + branded types)
ba33958e  Batch 1c — C1/C6/I2 (cross-module F2↔F3↔F8)
4d062da6  Bonus — F6.1 CSV RFC 4180 § 2.6 normalisation
fdba4206  Batch 1b — C5/I1/I3/I4/I5/I10/I12/I13 (F2-internal quick wins + dead-code delete)
88de9331  Batch 1a — C4/C7/I7/I8/I11/I14 (atomic fixes + new i18n keys)
```

### Notable build-error recovery (Batch 1a → 1b)

Batch 1a's C4 fix initially added `import { logger } from '@/lib/logger'` to `get-plan.ts` (Application layer). Because the F2 barrel re-exports `getPlan` and client components (`plans-table.tsx` via `locale-text-display.tsx`) import from `@/modules/plans`, the runtime `logger` import chained `pino` → `worker_threads` into the client bundle. Same trap documented at `src/modules/plans/index.ts:323-334` for the F7 bridge. Batch 1b relocated the audit-failure logging to `plan-audit-adapter.ts` (Infrastructure, server-only, NOT in barrel) — same observability intent, client-safe.

### Outcome metrics

- **21/21 F2 R6 findings closed (100%)** + 1 bonus F6.1 CSV normalise fix
- **5 atomic commits** on the audit branch
- **~75 unique files** touched (src + tests + i18n + docs + 1 cross-feature bonus)
- `pnpm typecheck` / `check:i18n` (2987 keys × 3) / `check:layout` (98 pairs) all PASS
- F7.1a concurrent session work was strictly excluded from every audit commit; no merge conflicts

### Cross-module touch summary (per user's "ทุก F ที่ F2 ไปแตะ" directive)

| F | Touched by audit | Outcome |
|---|------------------|---------|
| F1 | `auth_log` pgEnum legacy comment for `fee_config_updated` | Backward-compat preserved; F2 Domain no longer declares the event |
| F3 | NEW barrel export `countActiveMembersOnPlan` + use-case file | Cross-module wiring for F2 soft-delete FR-010 guard |
| F4 | None needed (`getTenantTaxPolicy` was already wired pre-audit) | — |
| F6 | F6.1 streaming-csv-importer CRLF→LF normalise | Bonus fix from same verification sweep |
| F7 | None (escape-hatch import documented at `index.ts:323-334`) | Pre-existing pattern; F7 unaffected by F2 R6 changes |
| F8 | RenewalsDeps + accept-tier-upgrade.ts emit `plan_change_*` post-tx via F2 emitter | Cross-module composition root; Constitution III honoured |

### Out of scope (deferred to future rounds)

- Full LocaleText brand (70+ call site refactor) + ESLint `no-restricted-syntax` rule
- BenefitMatrix branding (every field already domain-typed; over-engineering per CLAUDE.md)
- F3 + F4 + F6 idempotency-route 503 surface (shared lib now supports it; their routes ignore the new Result type — pre-existing fail-open behavior preserved until their own post-ship audits)
- F13 Admin Dashboard `plan_cross_tenant_probe` emitter (deferred per F2 spec; negative-coverage test `tests/unit/plans/cross-tenant-probe-emitter-coverage.test.ts` guards against accidental F2 emit until F13 ships)
- `plan_change_{cancelled,applied}` audit emitters (no Domain caller exists in F2/F8 today; renewal-applier use-case wires them when it ships)
