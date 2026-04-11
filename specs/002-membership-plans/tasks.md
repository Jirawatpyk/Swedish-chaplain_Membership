# Tasks: F2 — Membership Plans

**Input**: Design documents from `/specs/002-membership-plans/`
**Prerequisites**: [plan.md](./plan.md) ✅ · [spec.md](./spec.md) ✅ · [research.md](./research.md) ✅ · [data-model.md](./data-model.md) ✅ · [contracts/plans-api.md](./contracts/plans-api.md) ✅ · [quickstart.md](./quickstart.md) ✅ · [checklists/requirements.md](./checklists/requirements.md) ✅ · [checklists/security.md](./checklists/security.md) ✅ · [checklists/ux.md](./checklists/ux.md) ✅ · [critiques/critique-2026-04-11T091021Z.md](./critiques/critique-2026-04-11T091021Z.md) ✅ · [critiques/critique-2026-04-11T095811Z.md](./critiques/critique-2026-04-11T095811Z.md) ✅

**Tests**: **MANDATORY** per Constitution v1.4.0 Principle II (NON-NEGOTIABLE Test-First Development). Every user story's acceptance tests are authored RED and committed before the matching use-case implementation. Contract + integration + E2E + unit suites all exist.

**Organization**: Tasks are grouped by user story for independent implementation. US1–US3 are all P1 (MVP trio: list + create/clone + edit). US4–US6 are P2. US7 (Inline Edit + Bulk Actions) is **deferred to F3** per critique X1c.

## Format: `[ID] [P?] [Story?] Description with exact file path`

- **[P]** — Parallelizable (different files, no dependencies on incomplete tasks)
- **[Story]** — Task belongs to that user story (setup / foundational / polish have no story label)

## Path Conventions

Web application, single Next.js project. Paths rooted at repository root unless noted:

- `src/` — application source
- `drizzle/migrations/` — Drizzle-kit generated + hand-edited SQL
- `tests/` — contract + integration + unit + e2e
- `scripts/` — one-off CLI scripts
- `specs/002-membership-plans/` — F2 spec artefacts
- `docs/` — cross-cutting docs (observability, ux-standards, …)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Repo / environment / tooling prep so every downstream phase has a clean foundation. No business logic.

- [X] T001 Verify current branch is `002-membership-plans` and working tree clean: `git status && git branch --show-current`
- [X] T002 [P] Install `cmdk` with React 19 compat verified: `pnpm add cmdk && pnpm view cmdk version && pnpm view cmdk peerDependencies` — pin exact resolved version in `package.json` (critique E11)
- [X] T003 [P] Install F2 shadcn primitives: `pnpm dlx shadcn add command table select popover tabs scroll-area separator switch radio-group textarea label` — NO `checkbox` (deferred with US7)
- [X] T004 [P] Extend `src/lib/env.ts` zod schema: add `TENANT_SLUG` (required, `[a-z0-9-]{1,63}`) and `DEBUG_RLS_STATE` (optional boolean, asserts FALSE when `NODE_ENV=production`)
- [X] T005 [P] Extend `eslint.config.mjs` with three new `no-restricted-imports` blocks (per `quickstart.md § 3`): (a) framework-import ban on `src/modules/tenants/domain/**` + `src/modules/plans/domain/**`; (b) cross-context barrier forbidding deep imports into `@/modules/plans/{domain,application,infrastructure}/*`; (c) cross-context barrier forbidding deep imports into `@/modules/tenants/domain/*`
- [X] T006 [P] Extend `vitest.config.ts` coverage thresholds: `src/modules/tenants/domain/**` 100% line; `src/modules/plans/domain/**` 100% line; `src/modules/plans/application/**` ≥80% line + 80% branch + 100% branch on security-critical use cases (`update-plan`, `clone-plans-to-year`, `soft-delete-plan`, `update-fee-config`, tenant-scoping paths)
- [X] T007 Write throwaway `scripts/verify-rls-set-local.ts` per research.md § 2.4, run against dev Neon Singapore with `DATABASE_URL` from `.env.local`, verify Step 2 returns 0 rows / Step 3 returns N rows / Step 4 returns 0 rows, commit one-line receipt to `specs/002-membership-plans/research.md § 2.4` (*"Verified on Neon Singapore YYYY-MM-DD"*), then delete the script (critique E3 — pre-implementation gate)
- [ ] T008 Pre-implementation admin workflow confirmation with SweCham admin (critique P1): 10-minute chat confirming the dominant annual workflow is "clone December → tweak → activate January" — record outcome in `specs/002-membership-plans/research.md` as a Phase 0 receipt
- [ ] T009 Add `TENANT_SLUG=swecham` to `.env.local` and to Vercel prod + preview env via `vercel env add TENANT_SLUG`
- [ ] T010 [P] Add `<link rel="preconnect" href="/" crossOrigin="anonymous" />` hint placeholder — actual insertion lands in T148 when the admin shell edit occurs (tracked here so it isn't forgotten) — critique P8

**Checkpoint**: Setup complete. Dev env ready, Neon RLS behaviour empirically verified, admin workflow confirmed, env validator hardened.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-cutting infrastructure that MUST exist before any user story can be implemented. Includes the `tenants` module, RLS migrations, the Review-Gate-blocker integration test, Plans domain skeleton, i18n keys, and F1 RBAC extension.

**⚠️ CRITICAL**: No user story work can begin until this phase is 100% complete and every tenant-scoped test passes against live Neon.

### Tenants module (NEW cross-cutting Domain-only module — critique E1/X2)

- [X] T011 [P] Create `src/modules/tenants/` directory structure with subdirectory `domain/`
- [X] T012 [P] Create `src/modules/tenants/domain/tenant-context.ts` — branded `TenantContext` type + `asTenantContext(slug)` constructor + `[a-z0-9-]{1,63}` slug validator throwing on invalid input
- [X] T013 [P] Create `src/modules/tenants/index.ts` — public barrel exporting `TenantContext` type and `asTenantContext` only
- [X] T014 [P] Create `tests/unit/tenants/domain/tenant-context.test.ts` — covers valid slugs, empty string rejection, uppercase rejection, special-character rejection, >63 char rejection, exact brand-type preservation round-trip

### Tenant-context resolver + `runInTenant` + DEBUG_RLS_STATE dev assertion

- [X] T015 [P] Create `src/lib/tenant-context.ts` — `resolveTenantFromRequest(req): TenantContext` that returns `asTenantContext(env.TENANT_SLUG)` constant for F2 with TODO comment pointing at research.md § 1.1 F10 migration path
- [X] T016 Extend `src/lib/db.ts` with `runInTenant<T>(ctx: TenantContext, fn: (tx) => Promise<T>): Promise<T>` that wraps `db.transaction` with `SET LOCAL app.current_tenant = ${ctx.slug}` as the first statement — MUST use `SET LOCAL` never session-level `SET` (research.md § 2.3)
- [X] T017 Extend `src/lib/db.ts` with `DEBUG_RLS_STATE`-gated dev-mode `assertTenantContextSet(tx)` helper that throws a loud stack-traced error pointing at research.md § 2.5 when `current_setting('app.current_tenant', TRUE)` returns NULL (critique E5)
- [X] T018 Extend `src/proxy.ts` to call `resolveTenantFromRequest` on every protected admin request and attach the resolved `TenantContext` to the request context (same pattern as F1 session)

### Database schema — plans + fee config

- [X] T019 [P] Create `src/modules/plans/infrastructure/db/schema.ts` with Drizzle definitions for 8 new pgEnums (`plan_category`, `member_type_scope`, `directory_listing_size`, `event_discount_scope`, `website_page_type`, `homepage_logo_category`, `directory_ad_position`, `video_frequency_scope`) + `membershipPlans` table (composite PK `(tenant_id, plan_id, plan_year)`) + `tenantFeeConfig` table + 3 partial indexes per data-model.md § 3.2–§ 3.3
- [X] T020 Run `pnpm drizzle-kit generate` → rename generated file to `drizzle/migrations/0006_plans_and_fee_config.sql`
- [X] T021 Hand-edit `drizzle/migrations/0006_plans_and_fee_config.sql` appending RLS blocks for both new tables: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation_on_membership_plans` + `CREATE POLICY tenant_isolation_on_fee_config` per data-model.md § 3.2–§ 3.3

### Database schema — audit_log extension (critique E10 + R2)

- [X] T022 Extend `src/modules/auth/infrastructure/db/schema.ts` `auditEventTypeEnum` Drizzle definition: append 10 new snake_case values (`plan_created`, `plan_updated`, `plan_cloned`, `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`, `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated`) and add `payload: jsonb` + `tenantId: text` nullable columns to `auditLog`
- [X] T023 Create `drizzle/migrations/0007_audit_log_f2_extension.sql` as hand-written SQL per research.md § 12: (a) 10 independent top-level `DO $$ BEGIN IF NOT EXISTS (...) THEN ALTER TYPE audit_event_type ADD VALUE '...'; END IF; END $$;` statements (cannot live inside `BEGIN…COMMIT` per Postgres); (b) `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS payload jsonb`; (c) `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id text`; (d) `ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; (e) `CREATE POLICY audit_log_tenant_isolation ON audit_log FOR ALL USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', TRUE)) WITH CHECK (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', TRUE))`
- [X] T024 Apply both migrations to dev Neon via `DATABASE_URL=<dev-neon> pnpm drizzle-kit migrate` and verify in Neon SQL console: `SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables WHERE tablename IN ('membership_plans', 'tenant_fee_config', 'audit_log')` should show all three with `t/t`; `SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_event_type')` should show 27 values (17 F1 + 10 F2)

### Shared test helpers

- [X] T025 [P] Create `tests/helpers/test-tenant.ts` — `createTestTenant(prefix: 'test-swecham' | 'test-chamber')` returning `{ ctx: TenantContext, cleanup: () => Promise<void> }` with UUID-suffixed slugs per quickstart § 6.1 + critique E8; cleanup deletes rows by tenant_id from `membership_plans`, `tenant_fee_config`, `audit_log`
- [X] T026 [P] Create `tests/integration/plans/rls-debug-state.test.ts` — RED FIRST — asserts `DEBUG_RLS_STATE=true` causes `assertTenantContextSet` to throw when a query runs outside `runInTenant`, and asserts `DEBUG_RLS_STATE=false` suppresses the throw (prod-mode behaviour)

### Tenant isolation integration test — **REVIEW-GATE BLOCKER** (critique Constitution v1.4.0 Principle I clause 3)

- [X] T027 Create `tests/integration/plans/tenant-isolation.test.ts` — RED FIRST — create two tenants via `createTestTenant`, insert 3 plans into each via `runInTenant`, then: (a) `SELECT` from Tenant A's context MUST return only A's 3 rows (not 6); (b) `SELECT` from Tenant B's context MUST return only B's 3 rows; (c) `UPDATE` from A targeting a B plan_id returns 0 rows affected; (d) `DELETE` from A targeting a B plan_id returns 0 rows affected; (e) `INSERT` with an explicit mismatched tenant_id in the VALUES list fails with a RLS policy violation; (f) `SELECT` without any `SET LOCAL app.current_tenant` returns 0 rows (secure default); (g) audit_log entries scoped to Tenant A's slug are invisible from Tenant B's context; (h) audit_log entries with NULL tenant_id (F1 identity events) ARE visible from both contexts (permissive policy)

### Plans module Domain layer (pure types, no framework imports)

- [X] T028 [P] Create `src/modules/plans/` directory structure: `domain/`, `application/`, `infrastructure/`, and empty `index.ts` barrel placeholder
- [X] T029 [P] Create `src/modules/plans/domain/plan.ts` — `Plan` entity type, branded `PlanSlug` + `PlanYear` types, `PlanCategory` enum (`'corporate' | 'partnership'`), `MemberTypeScope` enum (`'company' | 'individual' | 'both'`)
- [X] T030 [P] Create `src/modules/plans/domain/benefit-matrix.ts` — typed `BenefitMatrix` per data-model.md § 2.2 with discriminated-union partnership benefits block (nullable for corporate plans)
- [X] T031 [P] Create `src/modules/plans/domain/money.ts` — `Money` helper type `{ amount_minor_units: number; currency_code: string }`, `formatMoney(m, locale)` via `Intl.NumberFormat`, `addVat(m, vatRate)` integer-only, `parseMinorUnits` with non-negative-integer invariant, ISO 4217 allow-list `{ THB, SEK, EUR, USD, JPY, SGD, GBP, DKK, NOK, CHF }`
- [X] T032 [P] Create `src/modules/plans/domain/locale-text.ts` — `LocaleText` type `{ en: string; th?: string; sv?: string }`, zod schema requiring `en`, `hasMissingTranslations(text): ('th' | 'sv')[]`, `pickLocaleText(text, activeLocale): { value, missing }` helper
- [X] T033 [P] Create `src/modules/plans/domain/locked-field-rule.ts` — `LOCKED_FIELDS_ON_PRIOR_YEAR` const array (`annual_fee_minor_units`, `min_turnover_minor_units`, `max_turnover_minor_units`, `max_duration_years`, `max_member_age`, `member_type_scope`, `includes_corporate_plan_id`, `benefit_matrix`) + `detectLockedFieldChanges(oldPlan, patch, currentYear): LockedField[]` pure function per research.md § 8
- [X] T034 [P] Create `src/modules/plans/domain/plan-state.ts` — state machine `active ↔ inactive → soft_deleted → (undelete) → inactive` with `canTransition(from, to, {hasMembers}): Result` rules
- [X] T035 [P] Create `src/modules/plans/domain/fee-config.ts` — `TenantFeeConfig` type per data-model.md § 2.3 (integer minor-units only, no per-plan currency — critique P3)
- [X] T036 [P] Create `src/modules/plans/domain/audit-event.ts` — discriminated union of the 10 new F2 audit event types + `auditPayloadSchema` discriminated-union zod schema keyed by `event_type` per data-model.md § 2.6a (critique P9 normative diff shape) + `eventSeverity: Record<F2Event, 'info'|'high'>` derived-severity lookup
- [X] T037 [P] Create `src/modules/plans/domain/policies.ts` — `canAdminMutatePlan`, `canManagerReadPlan`, `canCloneYear` pure policy functions; do NOT duplicate F1's `canAccess` — this file's helpers delegate to F1's policy matrix after T038 extends it
- [X] T038 [P] Create `src/modules/plans/domain/plan-validators.ts` — zod `planSchema` with `superRefine` enforcing corporate/partnership integrity (partnership MUST have `includes_corporate_plan_id` + `benefit_matrix.partnership`; corporate MUST NOT) and turnover-range ordering per data-model.md § 5

### Plans module Domain layer — unit tests (parallel with implementation since they test pure Domain)

- [X] T039 [P] Create `tests/unit/plans/domain/plan.test.ts` — brand invariants, enum exhaustiveness
- [X] T040 [P] Create `tests/unit/plans/domain/benefit-matrix.test.ts` — valid / invalid partnership block, invalid enum values
- [X] T041 [P] Create `tests/unit/plans/domain/money.test.ts` — non-negative integer invariant, float rejection, formatMoney for THB / SEK / JPY locale formatting, addVat integer math (example: 3_600_000 * 7/100 → 252_000)
- [X] T042 [P] Create `tests/unit/plans/domain/locale-text.test.ts` — EN required, TH/SV optional, missing-translation detection, pickLocaleText fallback chain
- [X] T043 [P] Create `tests/unit/plans/domain/locked-field-rule.test.ts` — prior-year vs current-year boundary (`plan_year < currentYear` vs `plan_year === currentYear`), every locked field rejected, every cosmetic field allowed, mixed-field patches return exact failing list
- [X] T044 [P] Create `tests/unit/plans/domain/plan-state.test.ts` — every valid transition + every invalid transition + soft-delete with members blocked
- [X] T045 [P] Create `tests/unit/plans/domain/policies.test.ts` — admin/manager/member × plans/fee-config × read/create/update/delete/clone matrix
- [X] T046 [P] Create `tests/unit/plans/domain/plan-validators.test.ts` — corporate/partnership integrity superRefine + turnover range ordering
- [X] T047 [P] Create `tests/unit/plans/domain/audit-event.test.ts` — auditPayloadSchema accepts every valid event shape, rejects malformed shapes, discriminated-union exhaustiveness

### Plans module Application layer — ports + composition root

- [X] T048 Create `src/modules/plans/application/ports.ts` — port interfaces: `PlanRepo`, `FeeConfigRepo`, `AuditPort`, `ClockPort`, `MemberAttachmentChecker` (critique P7) — all methods take `tenant: TenantContext` explicitly; import `TenantContext` from `@/modules/tenants`
- [X] T049 [P] Create `src/modules/plans/infrastructure/members/stub-member-attachment-checker.ts` — F2 stub implementing `MemberAttachmentChecker.countActivePlanMembers(tenant, planId, year): Promise<number>` returning `0` always with file-header comment pointing to critique P7 and F3 replacement plan
- [X] T050 [P] Create `src/modules/plans/infrastructure/db/plan-repo.ts` — skeleton class implementing `PlanRepo` via `runInTenant` from `@/lib/db`; methods `findByTenantAndYear`, `findOne`, `insert`, `update`, `softDelete`, `undelete`, `cloneYear`, `countActiveForTenant` — actual method bodies filled in US1–US5 phases
- [X] T051 [P] Create `src/modules/plans/infrastructure/db/fee-config-repo.ts` — skeleton implementing `FeeConfigRepo` via `runInTenant`; methods `findByTenant`, `update`, `countActiveForTenantExcludingDeleted` (used by T138 currency-immutability guard)
- [X] T052 [P] Create `src/modules/plans/infrastructure/audit/plan-audit-adapter.ts` — implements `AuditPort.record(tenant, event)` by inserting into F1 `audit_log` table with `event_type`, `payload` (validated via auditPayloadSchema), `tenant_id = tenant.slug`, `actor_user_id` from session, `request_id` from proxy context, `summary` auto-derived from payload (≤500 chars)
- [X] T053 [P] Create `src/modules/plans/application/record-audit-event.ts` — thin Application wrapper over `AuditPort` that runs `auditPayloadSchema.safeParse(payload)` and returns `Result<void, AuditShapeError>`
- [X] T054 Create `src/modules/plans/plans-deps.ts` — composition root wiring every Infrastructure singleton (plan-repo, fee-config-repo, plan-audit-adapter, stub-member-attachment-checker) into a single `PlansDeps` export consumed by API route handlers and server actions
- [X] T055 Create `src/modules/plans/index.ts` — public barrel exporting Application use cases (skeleton now, filled in later phases), Domain cross-boundary types (`Plan`, `MemberTypeScope`, `PlanCategory`, `LocaleText`, `Money`, `F2AuditEvent`), and branded-type constructors. NO internal infrastructure exports.

### F1 RBAC extension (cross-module edit — authorised via F1 public barrel contract)

- [X] T056 Extend `src/modules/auth/domain/policies.ts`: add `'plan'` + `'fee_config'` to `Resource` union, add `'clone'` to `Action` union, extend `canAccess` lookup with rows for admin (full CRUD + clone + fee-config-update), manager (read-only on both), member (deny all); add unit test cases to `tests/unit/auth/domain/role-policies.test.ts` for new matrix entries

### i18n scaffolding

- [X] T057 [P] Extend `src/i18n/messages/en.json` — add canonical EN copy for `admin.plans.*` (list headers, filter labels, empty states, action verbs, success/error toasts, confirmation dialogs, prior-year lock banner), `admin.settings.fees.*` (all labels + immutability message), `palette.*` (prompts, groups, empty state)
- [X] T058 [P] Extend `src/i18n/messages/th.json` with Thai translations for every new key (per Clarifications Q3 — EN required, TH mandatory at release)
- [X] T059 [P] Extend `src/i18n/messages/sv.json` with Swedish translations for every new key
- [X] T060 [P] Extend `scripts/check-i18n-coverage.ts` to scan `admin.plans.*`, `admin.settings.fees.*`, `palette.*` namespaces with fail-on-missing-EN and warn-on-missing-TH-or-SV (CI-blocking on release branches)

### Shared idempotency middleware

- [X] T061 [P] Create `src/lib/idempotency.ts` — `Idempotency-Key` header validator + storage wrapper reading/writing to the F1 `idempotency_keys` table; 24h retention; returns `{ status: 'first' | 'replay' | 'conflict' }` for POST/PATCH/DELETE handlers

**Checkpoint**: Foundation complete. `pnpm lint && pnpm typecheck && pnpm test tests/unit/tenants tests/unit/plans/domain` all green. `tests/integration/plans/tenant-isolation.test.ts` and `rls-debug-state.test.ts` authored RED, blocking every downstream phase until they flip to green in the appropriate user-story phase. User story work may now begin in parallel.

---

## Phase 3: User Story 1 — Admin views the annual membership plan catalogue (Priority: P1) 🎯 MVP FOUNDATION

**Goal**: Admin opens `/admin/plans`, sees 9 seeded SweCham 2026 plans (6 corporate + 3 partnership) with localised names, annual fees in THB, category badges, active state, filter bar, and shimmer skeleton during load. Palette search backend + command palette UI also land here because they power US6 and reuse the same search-plans use case.

**Independent Test**: Seed 9 SweCham 2026 plans, sign in as admin, navigate to `/admin/plans`, verify exactly 9 rows with correct fees, filter by category = partnership → 3 rows, filter by year = 2027 → empty state, switch language EN/TH/SV and verify localised plan names. Zero other user stories required.

### Tests for User Story 1 (RED FIRST — commit failing, then implement)

- [X] T062 [P] [US1] Create `tests/contract/plans/list-plans.test.ts` — GET `/api/plans` request + response shape, query-param validation, `meta.currency_code` returned from `tenant_fee_config`, `missing_translations` flag on each row, pagination absent in F2
- [X] T063 [P] [US1] Create `tests/contract/plans/get-plan.test.ts` — GET `/api/plans/{year}/{planId}` shape, 404 on missing, 404-never-403 on cross-tenant probe, `plan_not_found` audit event appended
- [X] T064 [P] [US1] Create `tests/contract/plans/palette-search.test.ts` — GET `/api/plans/search` shape, role-filtered actions, localised plan names in active locale, `limit` query param
- [X] T065 [P] [US1] Create `tests/integration/plans/list-plans-filtering.test.ts` — two seeded tenants via helper, filter by category / year / search query / activeOnly / showDeleted — verify tenant isolation + filter correctness
- [X] T066 [P] [US1] Create `tests/integration/plans/get-plan-404-cross-tenant.test.ts` — probing Tenant B's plan_id from Tenant A's context returns 404 (not 403), logs `plan_not_found` event via T052 adapter
- [X] T067 [P] [US1] Create `tests/integration/plans/missing-translation-indicator.test.ts` — plan with `{en,th}` but no `sv` returns `missing_translations: ['sv']` for admin only
- [X] T068 [P] [US1] Create `tests/e2e/plans-list.spec.ts` — seed → sign-in → navigate `/admin/plans` → assert 9 rows → filter category=partnership → 3 rows → switch language EN→TH→SV → assert plan names re-render; tagged `@i18n`
- [X] T069 [P] [US1] Create `tests/e2e/plans-a11y.spec.ts` — `@axe-core/playwright` scan on `/admin/plans` + `/admin/plans/2026/premium` detail view returning zero violations; tagged `@a11y`
- [X] T070 [P] [US1] Create `tests/e2e/plans-reduced-motion.spec.ts` — navigate with `prefers-reduced-motion: reduce` emulation, assert shimmer gradient animation disabled, skeleton pulse fallback rendered; tagged `@reduced-motion`
- [X] T071 [P] [US1] Create `tests/e2e/plans-i18n-coverage.spec.ts` — iterate EN/TH/SV locales on `/admin/plans`, assert no untranslated keys surface, plan names render in active locale with missing-translation indicator for admin

### Application layer for User Story 1

- [X] T072 [P] [US1] Implement `src/modules/plans/application/list-plans.ts` — takes `{filter: {year?, category?, q?, activeOnly?, showDeleted?}}` + deps `{planRepo, feeConfigRepo, tenant, clock}` — loads plans via `planRepo.findByTenantAndYear` and fee-config via `feeConfigRepo.findByTenant`, hydrates `Money` display values, computes `missing_translations` flag, sorts by `(plan_category DESC, sort_order ASC)`
- [X] T073 [P] [US1] Implement `src/modules/plans/application/get-plan.ts` — returns `Result<Plan, {type:'not_found'}>`; on not_found, invokes `AuditPort.record` with `plan_not_found` event carrying `{ requested_plan_id, requested_year, method, route }` payload (critique E6)
- [X] T074 [P] [US1] Implement `src/modules/plans/application/search-plans.ts` — in-memory filter over the plans result set; returns `{ plans, actions, navigate }` grouped response; actions filtered by role (admin vs manager)

### Infrastructure for User Story 1

- [X] T075 [US1] Implement `PlanRepo.findByTenantAndYear` in `src/modules/plans/infrastructure/db/plan-repo.ts` — uses `runInTenant(ctx, tx => tx.select().from(membershipPlans).where(...))` with all filter predicates; relies on RLS for tenant scoping (no explicit `WHERE tenant_id = ?` — research.md § 7.1)
- [X] T076 [US1] Implement `PlanRepo.findOne` in the same file — returns undefined on miss (repo layer) and the Application layer maps undefined → `not_found`
- [X] T077 [US1] Implement `FeeConfigRepo.findByTenant` in `src/modules/plans/infrastructure/db/fee-config-repo.ts` via `runInTenant`

### Presentation layer — API routes for User Story 1

- [X] T078 [P] [US1] Create `src/app/api/plans/route.ts` GET handler — parses query via zod, calls `listPlans` use case, serialises response per contracts/plans-api.md § 1; returns 401 if unauthenticated, 403 if member role
- [X] T079 [P] [US1] Create `src/app/api/plans/[year]/[planId]/route.ts` GET handler — parses path params, calls `getPlan` use case, returns 404 on not_found (never 403 for cross-tenant), serialises per § 2
- [X] T080 [P] [US1] Create `src/app/api/plans/search/route.ts` GET handler — calls `searchPlans` use case with role-aware action filtering, wraps in `unstable_cache` with 30s TTL tagged by tenant slug for palette perf

### Presentation layer — UI components for User Story 1

- [X] T081 [P] [US1] Create `src/components/plans/plan-list-skeleton.tsx` — shimmer skeleton in the **exact shape of the final table** (same row count, same column widths) per UX standards § 2.1 for CLS = 0; reduced-motion fallback disables shimmer gradient and uses static opacity pulse
- [X] T082 [P] [US1] Create `src/components/plans/money-display.tsx` — reads currency from `tenant_fee_config.currency_code` via React context and formats minor_units via `Intl.NumberFormat` per active locale
- [X] T083 [P] [US1] Create `src/components/plans/locale-text-display.tsx` — picks active locale with fallback to EN, renders missing-translation indicator badge (admin-only, derived from session role)
- [X] T084 [P] [US1] Create `src/components/plans/plans-table.tsx` — plain shadcn `<Table>` with sortable headers (plan name / category / annual fee / year / active state / updated at), filter bar (category select + year select + text search + activeOnly switch + showDeleted switch), category badges, row-level dropdown-menu for Edit/Activate/Deactivate/Delete (wired in later US3/US4 tasks); **NO inline edit** (deferred to F3 with US7)
- [X] T085 [US1] Create `src/app/(staff)/admin/plans/layout.tsx` — plans-section shell with breadcrumb + "New plan" CTA + "Clone year" CTA buttons
- [X] T086 [US1] Create `src/app/(staff)/admin/plans/page.tsx` — list page rendering `<PlanListSkeleton>` during load, `<PlansTable>` with data from `listPlans`, empty state when no plans exist for the filtered year
- [X] T087 [US1] Create `src/app/(staff)/admin/plans/[year]/[planId]/page.tsx` — read-only detail view showing full benefit matrix grouped by category (Brand Visibility / Events / Additional / Partnership-only)

### Seed data for User Story 1 (MVP depends on the 9 SweCham 2026 plans being loadable)

- [X] T088 [P] [US1] Create `scripts/seed-swecham-2026-plans.ts` — two-stage idempotent per critique P4: **Stage A** (own transaction) upserts `tenant_fee_config` with `(swecham, THB, 0.07, 100_000)`; **Stage B** (own transaction) refuses if any plan exists for `(swecham, 2026)` else inserts the 9 plans from data-model.md § 6.1 + § 6.2 with localised names from § 6.3 and writes 9 `plan_created` + 1 `fee_config_updated` audit events; guards tenant slug = `'swecham'`; outputs per-stage status
- [X] T089 [P] [US1] Create `tests/integration/plans/seed-idempotency.test.ts` — covers all three partial-state recovery scenarios from quickstart § 5: fresh DB, fee_config-only, plans-only-no-fee-config
- [X] T090 [US1] Run `TENANT_SLUG=swecham pnpm tsx scripts/seed-swecham-2026-plans.ts` against dev Neon → verify 9 plans + 1 fee config row + 10 audit entries; spot-check 3 rows in Neon SQL console to confirm `annual_fee_minor_units` values match PDF
- [ ] T091 [US1] Run `pnpm dev` on port 3100, manually verify US1 acceptance scenarios 1–6 from spec.md (list shows 9 rows, filter works, language switch re-renders plan names, shimmer loads, member role is denied)

**Checkpoint**: User Story 1 fully functional and independently testable. **`tests/integration/plans/tenant-isolation.test.ts` (T027) MUST now pass green — if still red, stop-the-line until the RLS + repo implementation is corrected.** Spec SC-001 (< 2s first paint p95) + SC-004 (100% i18n coverage) + SC-005 (exact 9 seed rows) + SC-006 (axe-core clean) verified. MVP ready for demo.

---

## Phase 4: User Story 2 — Admin creates / clones plans for a new year (Priority: P1) 🎯 MVP

**Goal**: Admin clones the SweCham 2026 catalogue into 2027 with one click (9 new inactive rows), and can also create a brand-new plan from scratch via the 4-step wizard (basics → fees → benefits → review). Historical 2026 plans remain untouched after cloning.

**Independent Test**: Sign in as admin, click "Clone 2026 → 2027" → confirm dialog → verify 9 new 2027 inactive plans appear under the 2027 filter, original 2026 rows unchanged. Or: click "New plan" → complete wizard with all required fields → verify new plan appears in the list + audit log shows `plan_created`.

### Tests for User Story 2 (RED FIRST)

- [ ] T092 [P] [US2] Create `tests/contract/plans/create-plan.test.ts` — POST `/api/plans` request validation, 201 + created plan shape, 400 on invalid body, 422 on corporate/partnership mismatch, 409 on duplicate `(tenant, plan_id, year)`, 409 on idempotency conflict
- [ ] T093 [P] [US2] Create `tests/contract/plans/clone-plans.test.ts` — POST `/api/plans/clone`, 201 shape with `{source_year, target_year, cloned_count, cloned_plan_ids}`, 409 `target_year_populated` when target has rows, 409 `source_year_empty` when source empty
- [ ] T094 [P] [US2] Create `tests/integration/plans/clone-idempotency.test.ts` — clone 2026→2027, verify 9 new rows; clone again → 409; delete the 9 2027 rows then clone again → succeeds
- [ ] T095 [P] [US2] Create `tests/integration/plans/create-plan-validation.test.ts` — exhaustive zod schema tests against planSchema including corporate/partnership integrity and turnover ordering
- [ ] T096 [P] [US2] Create `tests/integration/plans/audit-diff-create-clone.test.ts` — verifies `plan_created` and `plan_cloned` audit entries round-trip through `auditPayloadSchema.safeParse` with `success: true` (critique P9)
- [ ] T097 [P] [US2] Create `tests/e2e/plans-create-wizard.spec.ts` — admin navigates to `/admin/plans/new`, completes 4 wizard steps, submits, verifies new row appears in list; also tests clone flow via the "Clone 2026 → 2027" button from the list

### Application layer for User Story 2

- [ ] T098 [P] [US2] Implement `src/modules/plans/application/create-plan.ts` — validates input via `planSchema`, checks duplicate via `planRepo.findOne`, inserts via `planRepo.insert`, appends `plan_created` audit event; transactional (single DB transaction for both insert + audit); takes explicit `idempotencyKey` parameter
- [ ] T099 [P] [US2] Implement `src/modules/plans/application/clone-plans-to-year.ts` — loads all non-deleted plans for `(tenant, source_year)`, checks target year is empty, opens transaction, bulk-inserts N new plans with `plan_year = target_year` + `is_active = activate_cloned || false` + new `created_at`/`updated_at`/`created_by`, appends one `plan_cloned` audit event with the full new plan_ids list

### Infrastructure for User Story 2

- [ ] T100 [US2] Implement `PlanRepo.insert` in `plan-repo.ts` via `runInTenant` — single-row insert, relies on composite PK uniqueness for duplicate detection
- [ ] T101 [US2] Implement `PlanRepo.cloneYear` in `plan-repo.ts` via `runInTenant` — opens transaction, performs target-year existence check, bulk insert via Drizzle `insert().values([...])`, returns new plan_ids

### Presentation layer — API routes for User Story 2

- [ ] T102 [P] [US2] Extend `src/app/api/plans/route.ts` with POST handler — zod body validation, `Idempotency-Key` header required, calls `createPlan` use case, returns 201 with created plan
- [ ] T103 [P] [US2] Create `src/app/api/plans/clone/route.ts` POST handler — zod body `{source_year, target_year, activate_cloned?}`, idempotency key required, calls `clonePlansToYear`, returns 201 with clone summary

### Presentation layer — UI components for User Story 2

- [ ] T104 [P] [US2] Create `src/components/plans/locale-text-input.tsx` — tabbed en/th/sv editor with EN required + TH/SV optional indicators, tab-switching preserves field state, missing-locale badges surface live
- [ ] T105 [P] [US2] Create `src/components/plans/money-input.tsx` — integer-only numeric input rendering the tenant currency prefix (e.g. `฿`), converts user input to minor_units on change, rejects non-integer and out-of-range values
- [ ] T106 [P] [US2] Create `src/components/plans/benefit-matrix-editor.tsx` — grouped editor per the PDF structure (Brand Visibility / Events / Additional Benefits / Partnership-only) with category-conditional visibility: `partnership` block hidden when plan_category = `corporate`
- [ ] T107 [P] [US2] Create `src/components/plans/clone-year-dialog.tsx` — confirmation `<AlertDialog>` per UX standards § 4.1 with title verb "Clone 2026 → 2027?", body listing the 9 plans to clone, primary button "Clone 9 plans", secondary "Cancel"
- [ ] T108 [US2] Create `src/components/plans/plan-form-wizard.tsx` — 4-step react-hook-form wizard (Basics → Fees → Benefits → Review) with zod resolver using `planSchema`, per-step validation blocking Next button until fields pass, final Save disabled until all steps valid
- [ ] T109 [US2] Create `src/app/(staff)/admin/plans/new/page.tsx` — wizard page wrapping `<PlanFormWizard>` with submit handler POST `/api/plans` + toast success + redirect to new plan's edit page
- [ ] T110 [US2] Create `src/app/(staff)/admin/plans/clone/page.tsx` — clone UI with source/target year selectors + "Clone 9 plans to 2027" button invoking `<CloneYearDialog>` + POST `/api/plans/clone` + toast success

**Checkpoint**: User Story 2 fully functional. SC-002 (< 30s task-completion) verified for clone flow. US1 + US2 combined gives the chamber a complete annual catalogue lifecycle on MVP day.

---

## Phase 5: User Story 3 — Admin edits plan details, fees, and benefits (Priority: P1) 🎯 MVP

**Goal**: Admin can edit every field on a current-year plan and save, with audit diff capturing before/after. Prior-year plans enforce the partial lock (cosmetic editable, pricing/eligibility/benefits/scope frozen) per Clarifications Q4 + FR-014.

**Independent Test**: Edit a current-year plan's name and annual fee → save → audit log shows `plan_updated` with diff `{plan_name: {before, after}, annual_fee_minor_units: {before, after}}`. Attempt same edit on a 2026 plan when current year is 2027 → save is blocked with `422 prior_year_locked_fields` naming the fields.

### Tests for User Story 3 (RED FIRST)

- [ ] T111 [P] [US3] Create `tests/contract/plans/update-plan.test.ts` — PATCH request + response shape, 422 `prior_year_locked_fields` with `details.locked_fields` and `suggested_action: 'clone_to_current_year'`, 404 on missing, 422 on partnership/corporate mismatch
- [ ] T112 [P] [US3] Create `tests/integration/plans/prior-year-lock.test.ts` — seeded 2026 plan, clock fixture advances to 2027 → edit cosmetic field (plan_name.en) succeeds → edit locked field (annual_fee_minor_units) returns 422 with field name → test every field in `LOCKED_FIELDS_ON_PRIOR_YEAR` and every cosmetic field
- [ ] T113 [P] [US3] Create `tests/integration/plans/concurrent-edit-lww.test.ts` — two concurrent `updatePlan` calls from different sessions; last-write-wins with the overwritten session receiving a warning toast (Application-layer returns a `{overwrittenBy: userId}` marker)
- [ ] T114 [P] [US3] Create `tests/integration/plans/audit-diff-update.test.ts` — mutate plan → read latest `audit_log` entry → validate `payload` via `auditPayloadSchema.safeParse({success: true})` → verify `diff` shape is `{[field]: {before, after}}` with only changed fields (critique P9)
- [ ] T115 [P] [US3] Create `tests/e2e/plans-edit.spec.ts` — admin opens Premium 2026 for edit → sees persistent lock banner → annual_fee input is disabled with lock-icon tooltip → edits plan_name.en → saves → toast "Plan updated"; also covers the API-level 422 rejection for direct PATCH with locked field

### Application layer for User Story 3

- [ ] T116 [US3] Implement `src/modules/plans/application/update-plan.ts` — loads existing plan via `planRepo.findOne`, computes `detectLockedFieldChanges(oldPlan, patch, currentYear)` from `ClockPort`, returns `Result.err({type: 'prior_year_locked_fields', locked_fields})` if non-empty, otherwise validates patch against `planSchema.partial()`, applies via `planRepo.update`, appends `plan_updated` audit event with `diff: {[field]: {before, after}}` capturing only changed fields

### Infrastructure for User Story 3

- [ ] T117 [US3] Implement `PlanRepo.update` in `plan-repo.ts` — via `runInTenant`, updates row + performs secondary locked-field guard (defence-in-depth per research.md § 8) re-running `detectLockedFieldChanges` inside the transaction; logs high-severity `defence-in-depth triggered` warning if guard fires

### Presentation layer — API route for User Story 3

- [ ] T118 [US3] Extend `src/app/api/plans/[year]/[planId]/route.ts` with PATCH handler — idempotency-key required, zod partial body validation, calls `updatePlan` use case, maps error types to HTTP codes (`prior_year_locked_fields` → 422, `not_found` → 404)

### Presentation layer — UI components for User Story 3

- [ ] T119 [P] [US3] Create `src/components/plans/prior-year-lock-banner.tsx` — localised persistent banner explaining the partial-lock rule per FR-014, with "Clone to current year and edit there" button that navigates to `/admin/plans/clone?from={year}&to={currentYear}`
- [ ] T120 [P] [US3] Create `src/components/plans/plan-edit-form.tsx` — reuses `<LocaleTextInput>`, `<MoneyInput>`, `<BenefitMatrixEditor>` from US2 wizard components; on prior-year plan, disables locked-field inputs with lock icon + tooltip; renders `<PriorYearLockBanner>` at top when applicable
- [ ] T121 [US3] Create `src/app/(staff)/admin/plans/[year]/[planId]/edit/page.tsx` — edit page wrapping `<PlanEditForm>` with PATCH submit handler

**Checkpoint**: User Story 3 fully functional. MVP trio (US1+US2+US3) complete — chamber can list, create, clone, and edit the catalogue. FR-014 prior-year lock enforced at Domain + Application + Infrastructure layers.

---

## Phase 6: User Story 4 — Admin deactivates and soft-deletes plans (Priority: P2)

**Goal**: Admin can deactivate active plans (blocking future signups per FR-009) and soft-delete inactive plans that have zero attached members. Deleted plans can be restored via "Show deleted" toggle + Undelete action.

**Independent Test**: Deactivate an active plan → toast "Plan deactivated" → row badge flips to Inactive. Delete an inactive plan → soft-delete timestamp set → row hidden from default list → toggle "Show deleted" → row reappears → Undelete → row returns as Inactive (not Active).

### Tests for User Story 4 (RED FIRST)

- [ ] T122 [P] [US4] Create `tests/contract/plans/activate-deactivate.test.ts` — POST activate/deactivate endpoints, no-op idempotency, audit events `plan_activated` / `plan_deactivated`
- [ ] T123 [P] [US4] Create `tests/contract/plans/delete-plan.test.ts` — DELETE shape, 409 `plan_has_active_members` when MemberAttachmentChecker returns > 0 (F2 stub always returns 0 so this path is only coverable via mock), `plan_soft_deleted` audit
- [ ] T124 [P] [US4] Create `tests/contract/plans/undelete-plan.test.ts` — POST undelete, target state is Inactive (US4 AS4), `plan_undeleted` audit
- [ ] T125 [P] [US4] Create `tests/integration/plans/soft-delete-with-members.test.ts` — swaps in a stub MemberAttachmentChecker returning 3 → delete refuses with 409 and payload `{affected_member_count: 3}`; stub returning 0 → delete succeeds (critique P7)
- [ ] T126 [P] [US4] Create `tests/e2e/plans-deactivate.spec.ts` — full US4 acceptance flow: deactivate → confirm dialog → toast → badge; delete → confirm dialog → row hidden; show-deleted toggle → row reappears; undelete → row returns inactive
- [ ] T126a [P] [US4] Create `tests/integration/plans/audit-diff-state-mutations.test.ts` — close SC-007 coverage for US4 events (analyze C1): mutate plan via activate → read latest audit_log row → assert `event_type = 'plan_activated'` AND `auditPayloadSchema.safeParse(payload).success === true` AND payload matches `{is_active: {before: false, after: true}}`; repeat for deactivate (single-field diff `is_active`), soft-delete (`deleted_at` diff with before: null / after: ISO-8601 string), undelete (`deleted_at` diff with before: ISO / after: null PLUS `is_active` forced false per US4 AS4)

### Application layer for User Story 4

- [ ] T127 [P] [US4] Implement `src/modules/plans/application/activate-plan.ts` — loads plan, idempotent no-op if already active, calls `planRepo.setActive(true)`, appends `plan_activated` audit
- [ ] T128 [P] [US4] Implement `src/modules/plans/application/deactivate-plan.ts` — mirrors T127 with `plan_deactivated` audit
- [ ] T129 [P] [US4] Implement `src/modules/plans/application/soft-delete-plan.ts` — loads plan, calls `memberAttachmentChecker.countActivePlanMembers(tenant, planId, year)`, returns `Result.err({type: 'has_active_members', count})` if > 0, else calls `planRepo.softDelete` setting `deleted_at = clock.now()`, appends `plan_soft_deleted` audit
- [ ] T130 [P] [US4] Implement `src/modules/plans/application/undelete-plan.ts` — clears `deleted_at`, forces `is_active = false` (US4 AS4), appends `plan_undeleted` audit

### Infrastructure for User Story 4

- [ ] T131 [US4] Implement `PlanRepo.setActive(planId, year, active)` + `PlanRepo.softDelete(planId, year, deletedAt)` + `PlanRepo.undelete(planId, year)` in `plan-repo.ts` via `runInTenant`

### Presentation layer — API routes for User Story 4

- [ ] T132 [P] [US4] Create `src/app/api/plans/[year]/[planId]/activate/route.ts` POST handler
- [ ] T133 [P] [US4] Create `src/app/api/plans/[year]/[planId]/deactivate/route.ts` POST handler
- [ ] T134 [P] [US4] Extend `src/app/api/plans/[year]/[planId]/route.ts` with DELETE handler → `softDeletePlan` use case
- [ ] T135 [P] [US4] Create `src/app/api/plans/[year]/[planId]/undelete/route.ts` POST handler

### Presentation layer — UI for User Story 4

- [ ] T136 [US4] Extend `<PlansTable>` row-level dropdown-menu with Activate / Deactivate / Delete / Undelete actions — each wired to the matching API route with `<AlertDialog>` confirmation per UX standards § 4.1 + sonner toast on success or rollback on failure
- [ ] T137 [US4] Extend `<PlansTable>` filter bar with "Show deleted" switch that toggles the `showDeleted` query param

**Checkpoint**: User Story 4 fully functional. FR-010 member-attachment refusal testable via stub swap (prepares for F3 real implementation). FR-039 confirmation dialogs verified.

---

## Phase 7: User Story 5 — Admin configures per-tenant fee defaults (Priority: P2)

**Goal**: Admin views and edits per-tenant fee config (VAT rate + registration fee). **`currency_code` is immutable in F2 once plans exist** (critique R1) — attempting to change it returns `422 currency_code_immutable_in_f2` with plan count and remediation pointer.

**Independent Test**: Open `/admin/settings/fees` → see THB currency, 7% VAT, 1,000 THB registration fee → edit VAT to 7.5% → save → audit log shows `fee_config_updated` with `diff: {vat_rate: {before: 0.07, after: 0.075}}`. Attempt to change `currency_code` via API → 422 blocked with `details.non_deleted_plan_count = 9`.

### Tests for User Story 5 (RED FIRST)

- [ ] T138 [P] [US5] Create `tests/contract/plans/fee-config.test.ts` — GET + PATCH shape, PATCH body validation (vat_rate range, registration_fee_minor_units non-negative integer), manager role can GET but not PATCH
- [ ] T139 [P] [US5] Create `tests/contract/plans/fee-config-currency-immutable.test.ts` — PATCH with `{currency_code: 'JPY'}` against a tenant with seeded plans returns 422 `currency_code_immutable_in_f2` with `details.current_currency_code`, `details.attempted_currency_code`, `details.non_deleted_plan_count`, `details.remediation` (critique R1)
- [ ] T140 [P] [US5] Create `tests/integration/plans/fee-config-update.test.ts` — edit vat_rate + registration_fee → audit event captures diff → manager PATCH returns 403
- [ ] T141 [P] [US5] Create `tests/integration/plans/fee-config-currency-immutable.test.ts` — seeds 9 plans then PATCH with currency change → 422; deletes all 9 plans then PATCH with currency change → succeeds (proves the lock is per-plan-count, not absolute)
- [ ] T142 [P] [US5] Create `tests/integration/plans/audit-diff-fee-config.test.ts` — same diff-shape round-trip assertion as T114 but for `fee_config_updated`
- [ ] T143 [P] [US5] Create `tests/e2e/fee-config.spec.ts` — admin edits VAT → saves → toast; manager signs in → fee-config page shows read-only values with edit controls hidden or disabled

### Application layer for User Story 5

- [ ] T144 [P] [US5] Implement `src/modules/plans/application/get-fee-config.ts` — simple delegation to `feeConfigRepo.findByTenant`
- [ ] T145 [P] [US5] Implement `src/modules/plans/application/update-fee-config.ts` — if patch contains `currency_code` different from current, calls `planRepo.countActiveForTenant` and returns `Result.err({type: 'currency_code_immutable_in_f2', non_deleted_plan_count})` when > 0 (critique R1); otherwise validates via zod and updates via `feeConfigRepo.update` + appends `fee_config_updated` audit with diff

### Infrastructure for User Story 5

- [ ] T146 [US5] Implement `FeeConfigRepo.update` in `fee-config-repo.ts` via `runInTenant`
- [ ] T147 [US5] Implement `PlanRepo.countActiveForTenant` in `plan-repo.ts` — counts rows where `deleted_at IS NULL`

### Presentation layer for User Story 5

- [ ] T148 [P] [US5] Create `src/app/api/fee-config/route.ts` GET + PATCH handlers — PATCH maps `currency_code_immutable_in_f2` error to 422 with the exact `details` shape from contracts/plans-api.md § 13
- [ ] T149 [US5] Create `src/app/(staff)/admin/settings/fees/page.tsx` — form with VAT + registration-fee fields (editable for admin, disabled for manager), currency-code read-only display, explanatory note about F10 currency migration path

**Checkpoint**: User Story 5 fully functional. Critique R1 currency immutability enforced end-to-end. FR-017 manager read-only verified.

---

## Phase 8: User Story 6 — Admin uses the command palette (Priority: P2)

**Goal**: Admin presses ⌘K / Ctrl+K anywhere in `/admin`, palette opens with search input focused, types 3+ chars → plans and actions matching query appear grouped, Enter navigates to target, Esc returns focus. Role-filtered actions — member sees no admin-only items.

**Independent Test**: Press ⌘K → palette opens in < 300 ms (first open) / < 100 ms (subsequent, cached) → type "plat" → "Platinum Partnership" appears → Enter → navigates to `/admin/plans/2026/platinum/edit` → press ⌘K again → type "clone" → "Clone 2026 → 2027" action appears → Enter → clone dialog opens.

### Tests for User Story 6 (RED FIRST)

- [ ] T150 [P] [US6] Create `tests/integration/plans/search-plans-filter.test.ts` — in-memory filter correctness: exact match, prefix match, case-insensitive, cross-locale (search matching EN name when active locale is TH)
- [ ] T151 [P] [US6] Create `tests/e2e/command-palette.spec.ts` — `⌘K` opens, Esc closes with focus returning to previously-active element, arrow navigation, Enter selects, role filtering (member role sees no `plan.create` action), reduced-motion disables open animation; includes cold-open timing assertion p95 < 300 ms (critique P8) and warm-open < 100 ms

### Presentation layer for User Story 6

- [ ] T152 [P] [US6] Create `src/components/command-palette/registry.ts` — type definitions for `PaletteEntity` (plan), `PaletteAction` (create, clone_year, edit_fee_config), `PaletteNavigate` (plans, settings), role-filter helper
- [ ] T153 [P] [US6] Create `src/components/command-palette/groups.tsx` — three CommandGroup sections (Plans / Actions / Navigate) with empty-state copy
- [ ] T154 [P] [US6] Create `src/components/command-palette/command-palette.tsx` — root `<Command>` component with global `⌘K` / `Ctrl+K` keyboard listener via `useEffect` + `window.addEventListener('keydown')`, lazy-loads `/api/plans/search` on first open via `useQuery` (NOT on mount — critique E7), portal mount to document.body, `React.useDeferredValue` on filter term with 50 ms debounce, Esc key closes and restores focus
- [ ] T155 [P] [US6] Create `src/components/shell/command-palette-root.tsx` — thin wrapper that mounts `<CommandPalette>` once at shell level, passes role from session context
- [ ] T156 [US6] Mount `<CommandPaletteRoot>` in `src/app/(staff)/layout.tsx` so it is available on every admin page
- [ ] T157 [US6] Add `<link rel="preconnect" href={origin} crossOrigin="anonymous" />` to `src/app/(staff)/layout.tsx` `<head>` to warm DNS + TLS for the palette lazy-load path per critique P8 cold-start mitigation

**Checkpoint**: All 6 live user stories complete. Spec SC-008 split budget verified. US6 unlocks keyboard-accelerator across every admin page, priming F3+ for multi-entity search.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Verification, observability, documentation, and release-readiness across all user stories.

- [ ] T158 [P] Create `tests/e2e/plans-keyboard-only.spec.ts` — exercises the full F2 admin surface using only `page.keyboard.press` (no `page.click`, no `page.hover`); covers US1 list navigation, US2 wizard, US3 edit with lock banner, US4 dropdown-menu actions, US5 fee-config form, US6 palette; enforces the "zero mouse calls" rule via a test-file lint
- [ ] T159 [P] Extend `docs/observability.md` with new section **F2 Plans** — documents the `plan_cross_tenant_probe` runbook per critique E9 (threshold 1/min alarm, 5/hr investigation; triage: inspect audit_log entries for alerting window → identify actor_user_id → check pattern → decide disable + incident review; target < 5 min triage) and references `specs/002-membership-plans/plan.md § VII`
- [ ] T160 [P] Run `pnpm lhci autorun` against `/admin/plans` + `/admin/settings/fees` + `/admin/plans/new` + `/admin/plans/2026/premium/edit` — assert LCP < 2.5s, CLS < 0.1, INP < 200 ms on mid-range mobile profile (Constitution VI)
- [ ] T161 [P] Run `pnpm check:i18n` on release-branch mode — assert zero missing EN keys and zero missing TH/SV keys under `admin.plans.*`, `admin.settings.fees.*`, `palette.*` namespaces (SC-004)
- [ ] T162 [P] Run `specs/002-membership-plans/checklists/requirements.md` validation — all 16 items pass
- [ ] T163 [P] Run `specs/002-membership-plans/checklists/security.md` validation — all 40 items pass (Constitution v1.4.0 Principle I five clauses traced end-to-end)
- [ ] T164 [P] Run `specs/002-membership-plans/checklists/ux.md` validation — all 25 items pass
- [ ] T165 Run full local CI pipeline: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:integration && pnpm test:e2e` — 100% green expected; any failure stops the line and becomes a follow-up bug task
- [ ] T166 Verify `tests/integration/plans/tenant-isolation.test.ts` is green (it was committed RED in T027) — this is the **Review-Gate blocker** per Constitution v1.4.0 Principle I clause 3
- [ ] T167 Verify `tests/integration/plans/rls-debug-state.test.ts` is green (committed RED in T026)
- [ ] T168 Apply migrations `0006` + `0007` to prod Neon Singapore via `DATABASE_URL=<prod-neon> pnpm drizzle-kit migrate` and verify in Neon SQL console that both tables exist with RLS enabled and the audit_event_type enum has 27 values
- [ ] T169 Run `TENANT_SLUG=swecham pnpm tsx scripts/seed-swecham-2026-plans.ts` against prod Neon → verify 9 plans + 1 fee config row + 10 audit events
- [ ] T170 Confirm `TENANT_SLUG=swecham` is set in Vercel prod + preview env; confirm `DEBUG_RLS_STATE` is **not** set in prod
- [ ] T171 [P] Create `specs/002-membership-plans/retrospective.md` — F2 shipment retrospective following F1 structure: what shipped, what deferred (US7 → F3), what critique rounds caught, what surprised, what to do differently for F3
- [ ] T172 Update `CLAUDE.md` **Active Technologies** + **Recent Changes** sections with F2 additions: `cmdk` command palette primitive, `src/modules/tenants/` cross-cutting module, `runInTenant` + RLS pattern, `DEBUG_RLS_STATE` dev assertion, 10 new audit event types
- [ ] T173 Manually smoke-test every user story from `quickstart.md § 7` (US1 list, US2 create + clone, US3 edit + lock banner, US4 deactivate/delete, US5 fee-config with manager read-only, US6 palette) against `pnpm dev` on port 3100 — record outcomes as a checklist at the bottom of retrospective.md
- [ ] T174 Record SC-010 usability walkthrough with 3 participants per critique P6 tightened criteria (2/3 complete clone + edit within 3 minutes + all 3 rate ≥ 4/5 ease-of-use) — record in retrospective.md

**Checkpoint**: F2 ready for `/speckit.verify` → `/speckit.review` (≥6 passes) → `/speckit.staff-review` (≥2 rounds) → `/speckit.ship`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies — can start immediately after branch verification
- **Phase 2 Foundational**: Depends on Setup completion; T011–T061 BLOCK all user story phases. T007 (Neon verification) and T008 (admin workflow confirmation) are mandatory pre-impl gates before starting T011.
- **Phase 3 US1**: Depends on Foundational (all T011–T061); strictly required because list/get/palette-search use cases need the Domain + repos
- **Phase 4 US2**: Depends on Foundational + US1 presentation skeleton (T085 layout is parent of T109 new-page). Can run in parallel with US3 at the Application layer.
- **Phase 5 US3**: Depends on Foundational + US2 form components (US3 reuses `<PlanFormWizard>` primitives). Can run in parallel with US4/US5/US6 at the Application layer.
- **Phase 6 US4**: Depends on Foundational + US1 `<PlansTable>` (US4 extends the row-level dropdown-menu actions)
- **Phase 7 US5**: Depends on Foundational only — isolated from plan CRUD; can run fully in parallel with US2/US3/US4/US6
- **Phase 8 US6**: Depends on Foundational + US1 `search-plans` use case (T074) + F1 shell layout
- **Phase 9 Polish**: Depends on all desired user stories being complete (at minimum US1+US2+US3 for MVP demo; US4–US6 for full F2 ship)

### Within Each User Story

- **Tests MUST be written RED first and committed** before the matching implementation task (Constitution Principle II NON-NEGOTIABLE)
- Domain unit tests can parallel Domain implementation (same commit or adjacent)
- Application use cases depend on Domain + ports being complete
- Infrastructure repos depend on Application ports being declared
- Presentation (API routes + components) depends on Application use cases being green

### Critical Path (MVP = US1 + US2 + US3)

```
T001→T010 (Setup) →
T011→T061 (Foundational — critical path, blocks everything) →
T027 (tenant isolation test RED — remains RED until US1 infrastructure lands) →
T062→T091 (US1 list + palette backend + seed) — flips T027 to green →
T092→T110 (US2 create + clone) →
T111→T121 (US3 edit + lock banner) →
T158→T174 (Polish) → ship
```

### Parallel Opportunities

- **Setup**: T002 / T003 / T004 / T005 / T006 all [P] — run in one batch
- **Foundational Domain** (T011–T014 tenants, T028–T047 plans domain + tests): ~30 tasks marked [P], parallelizable up to the limit of developer attention
- **Foundational Application ports + repos** (T048–T055): sequential due to single-file edits
- **Foundational i18n** (T057–T060): fully parallel
- **Within US1**: 10 test tasks (T062–T071) parallel, 3 Application use cases (T072–T074) parallel, 3 API routes (T078–T080) parallel, 4 UI components (T081–T084) parallel
- **Cross-story**: US2 / US3 / US4 / US5 / US6 can all run in parallel at Application + Presentation layer after Foundational completes — if a second developer joins before ship, each takes one story

### Solo-maintainer strategy

Since this is a solo-dev project (Constitution v1.3.1 substitute applies):

1. Ship **Setup + Foundational + US1** first → validate MVP → demo to SweCham admin
2. Ship US2 + US3 in one batch → chamber has full CRUD → invite feedback
3. Ship US4 + US5 + US6 in a second batch → polish round
4. Polish phase → ship

## Parallel Example: User Story 1 Tests

```bash
# Launch all US1 tests RED first (they MUST fail before implementation)
Task: "Contract test for list-plans in tests/contract/plans/list-plans.test.ts"      # T062
Task: "Contract test for get-plan in tests/contract/plans/get-plan.test.ts"          # T063
Task: "Contract test for palette-search in tests/contract/plans/palette-search.test.ts"  # T064
Task: "Integration test list-plans-filtering in tests/integration/plans/list-plans-filtering.test.ts"  # T065
Task: "Integration test get-plan-404-cross-tenant in tests/integration/plans/get-plan-404-cross-tenant.test.ts"  # T066
Task: "Integration test missing-translation-indicator in tests/integration/plans/missing-translation-indicator.test.ts"  # T067
Task: "E2E plans-list in tests/e2e/plans-list.spec.ts"                              # T068
Task: "E2E plans-a11y in tests/e2e/plans-a11y.spec.ts"                              # T069
Task: "E2E plans-reduced-motion in tests/e2e/plans-reduced-motion.spec.ts"          # T070
Task: "E2E plans-i18n-coverage in tests/e2e/plans-i18n-coverage.spec.ts"            # T071
```

---

## Implementation Strategy

### MVP First (US1 + US2 + US3 together — all P1)

1. Phase 1 Setup → Phase 2 Foundational — critical path for everything
2. Phase 3 US1 — list + palette backend + seed (the foundational read surface)
3. Phase 4 US2 — create + clone (the year-rollover workflow)
4. Phase 5 US3 — edit with prior-year lock (the correction workflow)
5. **STOP + VALIDATE**: manual smoke test all 3 stories via `pnpm dev`, run full CI, demo to SweCham admin
6. Deploy to Vercel preview for admin acceptance

### Incremental delivery after MVP

1. MVP (above) → ship to preview
2. US4 (deactivate/delete) → preview → feedback round
3. US5 (fee config) + US6 (palette) → preview → feedback round
4. Polish phase → prod ship via `/speckit.ship`

Each increment is a complete, independently-testable, independently-deployable slice.

---

## Task Count Summary

| Phase | Task range | Count | Focus |
|---|---|---|---|
| Phase 1 Setup | T001–T010 | **10** | Env, deps, Neon verification, admin workflow confirmation |
| Phase 2 Foundational | T011–T061 | **51** | Tenants module, resolver + runInTenant, migrations, RLS, Domain skeleton, ports, i18n, RBAC, idempotency — blocks everything |
| Phase 3 US1 (P1 MVP) | T062–T091 | **30** | List, get, palette backend, seed — ~20% tests, ~20% domain/app, ~20% infra, ~40% presentation + seed |
| Phase 4 US2 (P1 MVP) | T092–T110 | **19** | Create, clone, wizard, money-input, locale-text-input, benefit-matrix-editor |
| Phase 5 US3 (P1 MVP) | T111–T121 | **11** | Edit, locked-field guard, prior-year lock banner |
| Phase 6 US4 (P2) | T122–T137 (+ T126a) | **17** | Activate, deactivate, soft-delete, undelete, show-deleted toggle, audit-diff US4 events (C1) |
| Phase 7 US5 (P2) | T138–T149 | **12** | Fee config GET/PATCH, currency immutability (critique R1) |
| Phase 8 US6 (P2) | T150–T157 | **8** | Command palette with lazy-load + preconnect (critique P8) |
| Phase 9 Polish | T158–T174 | **17** | Keyboard-only E2E, observability runbook, Lighthouse, checklists, prod migrations + seed, retrospective |
| **Total** | **T001–T174 + T126a** | **175** | F2 full scope post-X1c + analyze C1 US4 audit-diff coverage |

### Task breakdown by category

- **Tests (authored RED first)**: 53 tasks (30% of total) — 8 contract + 17 integration + 11 E2E + 13 unit + 4 helpers — Constitution Principle II compliance
- **Domain layer**: 11 tasks — tenants module + plans module pure types + policies + validators + audit-event schema
- **Application layer**: 14 use cases — list, get, search, create, clone, update, activate, deactivate, soft-delete, undelete, get-fee, update-fee, record-audit + stub checker
- **Infrastructure**: 12 tasks — Drizzle schemas, 2 migrations, 2 repos (plan-repo + fee-config-repo), audit adapter, stub member checker, test-tenant helper
- **Presentation — API**: 13 route handlers
- **Presentation — UI**: 18 components + 7 pages
- **Setup / i18n / ESLint / env / idempotency / RBAC**: 20 cross-cutting tasks
- **Polish / verification / release**: 17 tasks

### Independent test criteria per user story

- **US1**: 9 rows visible on list, filter + search + locale switch work, shimmer renders in final-table shape, axe-core clean
- **US2**: Clone 2026 → 2027 creates 9 new inactive rows without touching 2026, wizard creates a brand-new plan end-to-end with audit_log entry
- **US3**: Current-year plan edit saves with full diff in audit_log; prior-year plan edit blocks locked fields with field-named 422 and offers clone-to-current-year path
- **US4**: Deactivate → badge flips, soft-delete → row hidden, show-deleted → row reappears, undelete → returns as Inactive (not Active); stub member check enables 409 path
- **US5**: View + edit VAT/registration fee works for admin, read-only for manager, currency immutability enforced with 422 + plan count
- **US6**: ⌘K opens < 300 ms first-open / < 100 ms subsequent, search + navigate + action + Esc + role filtering all functional; keyboard-only test passes

### Suggested MVP scope

**US1 + US2 + US3** (all P1). With Setup + Foundational + these three stories, the chamber has a complete catalogue management loop: view → create → clone → edit. US4–US6 are polish on top and can ship in a second increment.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks, can run in parallel batches
- `[US1]`–`[US6]` = task maps to that user story for traceability and independent delivery
- **Every test must be committed RED before its matching implementation** — Constitution v1.4.0 Principle II NON-NEGOTIABLE
- **`tests/integration/plans/tenant-isolation.test.ts` is the Review-Gate blocker** — Constitution v1.4.0 Principle I clause 3
- Critique references are inline: X1c (US7 deferred), R1 (currency immutability), R2 (migration filename), E1/X2 (tenants module), E3 (Neon verification), E5 (DEBUG_RLS_STATE), E6 (probe detection), E7 (palette lazy-load), E8 (test-isolation), E9 (runbook), E10 (audit schema), E11 (cmdk pin), P1 (admin workflow), P3 (no per-plan currency), P4 (seed 2-stage), P5 (copy-catalogue non-goal), P6 (SC-010 tightening), P7 (MemberAttachmentChecker port), P8 (SC-008 split + preconnect), P9 (audit diff shape)
- Commit after each task or logical group; use `[Spec Kit]` prefix for commits that move a gate forward
- Stop at any Checkpoint to validate independently before proceeding
- Avoid cross-story dependencies that would break independent deliverability — if a cross-story dependency is required, land it in the earlier story's phase or flag as a Foundational task
