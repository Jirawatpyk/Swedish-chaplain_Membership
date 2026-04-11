# Implementation Plan: F2 — Membership Plans

**Branch**: `002-membership-plans` | **Date**: 2026-04-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-membership-plans/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessor**: F1 Auth & RBAC (shipped via PR #1, [`specs/001-auth-rbac/plan.md`](../001-auth-rbac/plan.md))

## Summary

F2 delivers the **membership plan catalogue** for Chamber-OS — the foundation layer every downstream commerce feature (F3 Members, F4 Invoicing, F5 Payments, F7 E-Blast, F8 Renewal, F9 Dashboard) depends on. For the SweCham (TSCC) first tenant, F2 ships the nine 2026 plans (6 corporate tiers + 3 partnership tiers) from `docs/membership-benefits-analysis.md` — complete with structured benefit matrix, year versioning, partial edit lock for prior years, per-tenant fee configuration (currency / VAT / registration fee), soft-delete, and a full Enterprise-UX admin CRUD surface under `/admin/plans` + `/admin/settings/fees`.

F2 is also the feature where Chamber-OS earns its SaaS posture: it introduces the **cross-cutting tenant-context resolver** plus **Postgres Row-Level Security (RLS)** policies on every tenant-scoped table, satisfying Constitution v1.4.0 Principle I clauses 1–3 (application-layer + database-layer + cross-tenant integration test) on day one. For the SweCham single-tenant deployment, the resolver returns a constant, but the full two-layer enforcement is live, pressure-tested by a two-tenant probe integration test, and ready to be connected to real subdomain / custom-domain resolution in F10 without any schema or test rewrites. Early smart-chamber surface **#4 Command Palette** ships in F2 as a cross-cutting keyboard accelerator. **#7 Inline Edit + Bulk Actions has been deferred to F3** per critique X1c (2026-04-11) — the value math on ≤9 plan rows was thin, and deferring gives the editable-table primitive the time and multi-entity stress test it deserves under F3.

**Technical approach**: Reuse the F1-shipped stack unchanged — Next.js 16 App Router + React 19 + TypeScript 5.7 strict + Drizzle ORM on Neon Postgres + shadcn/ui + Tailwind v4 + next-intl + Vitest + Playwright. Add one new bounded context plus two cross-cutting libs without disturbing F1's auth module: (a) `src/modules/plans/` as a full Clean-Architecture bounded context (Domain → Application → Infrastructure with a public barrel and ESLint boundary rule); (b) a new `src/modules/tenants/` **cross-cutting Domain-only module** that hosts the `TenantContext` branded type used by every F2+ tenant-scoped module (per critique E1/X2, `TenantContext` is not owned by plans — it is a platform-level concept and lives in its own tiny Domain module, with no database table in F2 per X Simplicity); (c) `src/lib/tenant-context.ts` as the concrete resolver + `runInTenant(ctx, fn)` helper + `SET LOCAL app.current_tenant` plumbing wired into `src/proxy.ts` for every protected request; (d) `src/components/command-palette/` as a reusable `cmdk`-based primitive. Enterprise UX is a first-class concern: every screen passes the `docs/ux-standards.md` § 15 checklist (shimmer skeletons in the final-table shape for CLS 0, sonner toasts, confirmation dialogs, keyboard-first flows, reduced-motion fallbacks, and light/dark parity). Money is stored as **integer minor units per field + a single authoritative `currency_code` on `tenant_fee_config`** per Clarifications Q5 + critique P3 (per-plan currency deliberately NOT stored — simplification under YAGNI). Soft-delete only; hard-delete is deliberately out of scope. No new external services — Stripe / payments remain an F5 problem.

## Technical Context

**Language/Version**: TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`) — unchanged from F1
**Runtime**: Node.js 22 LTS (Vercel default) — unchanged from F1
**Framework**: Next.js 16 (App Router, Cache Components, Turbopack dev server) — unchanged from F1
**Primary Dependencies** (new in F2 unless marked "from F1"):
  - **from F1**: `next@^16`, `react@^19`, `drizzle-orm` + `drizzle-kit`, `next-intl`, `zod`, `react-hook-form` + `@hookform/resolvers/zod`, `shadcn/ui` + `tailwindcss@^4` + `lucide-react`, `next-themes`, `sonner`, `@vercel/otel` + `@opentelemetry/api`, `pino`, `@testing-library/react`, `vitest`, `playwright`, `@axe-core/playwright`
  - **new in F2**:
    - `cmdk` — headless command palette primitive (used by shadcn/ui, already part of the ecosystem). Powers feature #4 (Command Palette) per `docs/smart-chamber-features.md` § 5. Version pinned at implementation time via `pnpm view cmdk@latest version` + React 19 compat verification (critique E11, 2026-04-11). Target: `cmdk@^1.1.x` (verify at install).
    - **Enterprise UX primitives** (shadcn-installed for F2): `command` (cmdk wrapper), `table`, `select`, `popover`, `tabs`, `scroll-area`, `separator`, `switch`, `radio-group`, `textarea`, `label`. Primitives already installed in F1 (`skeleton`, `alert-dialog`, `dialog`, `button`, `form`, `badge`, `tooltip`, `dropdown-menu`, `avatar`, `sonner`) are reused unchanged. Plans list uses a plain shadcn `<Table>` (HTML-based) — not TanStack Table — because US7's inline-edit / bulk-select is deferred to F3.
  - **deferred to F3** (critique X1c, 2026-04-11): `@tanstack/react-table` — headless table primitive for inline edit + bulk selection. Will be introduced by F3 Members & Contacts where hundreds of member rows immediately justify the primitive, and subsequently retro-applied to the Plans list if desired.
  - **rejected** (YAGNI): Typesense / Meilisearch / Postgres tsvector for palette search — 9 rows per tenant × ~20 tenants long-term = in-memory filter is sufficient through F5 at least. Revisit when entity search spans members + invoices + events (F7+).
  - **rejected** (YAGNI): a dedicated i18n content management system — plan names are the only tenant-editable localised content in F2 and a structured `{en,th,sv}` map on the plan record (Clarifications Q3) is enough.
**Storage**:
  - Primary: **PostgreSQL via Neon** (`ap-southeast-1` Singapore) — unchanged from F1; adds two new tables `membership_plans` and `tenant_fee_config` (+ new audit event types in the existing `audit_log` table).
  - Postgres RLS: **every F2-introduced table has RLS enabled and a tenant-isolation policy** that reads from `current_setting('app.current_tenant', TRUE)`. Set per-transaction via `SET LOCAL app.current_tenant = <tenant-slug>` from the resolver. See research.md § 2.
  - Session / rate-limit cache: **Upstash Redis** (Singapore) — unchanged from F1; F2 does not introduce new rate limits but reuses the Upstash client for admin-side mutation throttling if the per-connection SET LOCAL pattern combines with pgBouncer poorly (see research.md § 2.3).
**Testing**:
  - `vitest` — unit + Application tests (Domain 100% line, Application ≥80% + 100% branch on security-critical: tenant-isolation enforcement, locked-field guard, role guard, clone-year idempotency)
  - `playwright` — E2E including full keyboard-only run, reduced-motion run, i18n coverage run, axe-core WCAG 2.1 AA run
  - `@axe-core/playwright` — WCAG 2.1 AA automated scanning
  - **New in F2**: `tests/integration/plans/tenant-isolation.test.ts` — creates two tenants (`test-swecham-${uuid}` + `test-chamber-${uuid}` — UUID-suffixed per critique E8 so parallel CI runs never collide), inserts plans for both, and exercises cross-tenant reads and writes in both directions using two distinct DB connections with different `app.current_tenant` settings. Per Constitution v1.4.0 Principle I clause 3, this test is a Review-Gate blocker.
**Target Platform**: Web browsers (mobile Safari, Chrome Android, Chrome, Firefox, Safari, Edge — last 2 versions each). Deployed on Vercel `sin1` with DB in Neon `ap-southeast-1`, same as F1.
**Project Type**: Web application (Next.js full-stack, single repo, single deploy) — unchanged from F1. No separate backend, no separate frontend, no mobile.
**Performance Goals**:
  - **Spec SC-001**: Plans list cold first paint < 2 s p95 (broadband, 50 rows, including skeleton → loaded transition)
  - **Spec SC-008**: Command palette open < 100 ms p95
  - **Spec SC-009**: Bulk action on 10 rows + undo < 2 s p95 + < 1 s p95 respectively
  - **Constitution Principle VI**: LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on mid-range mobile over 4G
  - **Constitution Principle VII**: Plans API p95 < 400 ms, p99 < 800 ms
**Constraints**:
  - Tenant isolation enforced at BOTH application and database layers — cross-tenant probe returns 404 (not 403). Request path logs `plan_not_found` at info severity; a separate periodic scan (future F13) correlates across tenants and escalates to `plan_cross_tenant_probe` at high severity per critique E6 (2026-04-11). Request path itself never runs a `BYPASS RLS` query.
  - Money stored as **integer minor units per field** (currency code held once per tenant on `tenant_fee_config.currency_code`) — no floats on money fields (Constitution Principle IV intent + Clarifications Q5 + critique P3 simplification)
  - Previous-year plans are partially locked (cosmetic fields editable; pricing / eligibility / benefits / scope locked) per Clarifications Q4 + FR-014
  - Plan display name is required in `en`, optional with missing-translation indicator in `th`/`sv` per Clarifications Q3
  - SV+EN+TH at release; missing EN key is a build-breaker; missing TH/SV is a CI-failing warning on release branches (shared with F1)
  - WCAG 2.1 AA on every screen; full keyboard navigation; `prefers-reduced-motion` honoured
  - All timestamps ISO 8601 UTC; Thai Buddhist Era is display-only for `th-TH`
  - Soft-delete only — hard-delete forbidden for audit compliance
  - Append-only audit log reused from F1 — F2 adds new event types but does not mutate or extend the schema
**Scale/Scope**:
  - Today: 1 live tenant (SweCham), 9 plans (6 corporate + 3 partnership), 1 fee-config row
  - 5-year target: ~15-20 tenants (per `docs/saas-architecture.md` § 1), ~10-20 plans per tenant, <500 plan rows platform-wide
  - Admin concurrency: <5 staff concurrent per tenant, <100 concurrent platform-wide — single Vercel region and a single Neon instance remain sufficient

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0***

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security — including v1.4.0 Tenant Isolation clause**
  - **No new PII** in F2. `membership_plans` holds catalogue data (tier names, fees, benefits); `tenant_fee_config` holds per-tenant defaults. Neither touches personal data subjects — PII surfaces come in F3 (Members + Contacts). Lawful basis carry-over from F1 is unchanged.
  - **RBAC** inherited from F1. `admin` full CRUD; `manager` read-only; `member` blocked. Enforced by `rbac-guard.ts` extended with a `plans:*` resource family (research.md § 3).
  - **Tenant Isolation — two-layer defence-in-depth (Constitution v1.4.0 Principle I clauses 1-4):**
    1. **Application layer (clause 1):** every plan-touching use case in `src/modules/plans/application/**` takes a `TenantContext` as an explicit dependency parameter — not a string, not an implicit middleware magic. Forgetting to pass it is a TypeScript compile error. `TenantContext` lives in the **new `src/modules/tenants/` cross-cutting Domain module** (per critique E1/X2, 2026-04-11) so that F3 members, F4 invoices, F7 broadcasts, etc. can import it via `@/modules/tenants` without reaching into a sibling bounded context. The composition root in `src/modules/plans/plans-deps.ts` wires the resolver output from `src/lib/tenant-context.ts`.
    2. **Database layer (clause 2):** `membership_plans` and `tenant_fee_config` both have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy. `src/lib/db.ts` is extended with a `runInTenant(tenantCtx, fn)` helper that wraps every tenant-scoped transaction in `SET LOCAL app.current_tenant = $1`. **Dev-mode safety net** (critique E5, 2026-04-11): when `DEBUG_RLS_STATE=1` is set, `runInTenant` and `db` helpers raise a loud, stack-traced developer error if a query runs while `current_setting('app.current_tenant', TRUE)` is NULL. In production the flag is off and the RLS "zero rows on unset tenant" default silently secures — but during development the loud failure prevents the "I forgot `runInTenant`" class of bug from being mis-diagnosed as a data issue.
    3. **Test enforcement (clause 3):** `tests/integration/plans/tenant-isolation.test.ts` creates two tenants with UUID-suffixed slugs, inserts plans for each, and asserts zero cross-tenant visibility on SELECT / INSERT / UPDATE / DELETE from both directions. Review-Gate blocker.
    4. **Audit (clause 4):** Cross-tenant access attempts resolve to 404 in the request path (never 403 — existence MUST NOT leak). Request path logs a `plan_not_found` info-severity event with actor + requested plan identifier. A **separate periodic super-admin scan** (planned for F13; stub landing in F2 as a documented TODO) correlates `plan_not_found` events against the platform-wide plan inventory and escalates matches to a `plan_cross_tenant_probe` high-severity event. Rationale per critique E6: request-path code never runs `BYPASS RLS`, eliminating a privilege-escalation vector.
    5. **Super-admin impersonation (clause 5):** not applicable to F2 — no super-admin console exists yet. F13 will reintroduce this check.
  - **OWASP Top 10 coverage** (delta vs F1 for the touched admin surface): A01 Broken Access Control — RBAC + RLS defence-in-depth; A03 Injection — Drizzle parameterised queries, zod on every API boundary, no dynamic SQL; A04 Insecure Design — `TenantContext` is a Domain-layer branded type (not a raw string), preventing accidental cross-tenant calls at compile time; A08 Software & Data Integrity — append-only audit log; A09 Logging Failures — cross-tenant probe logs are high-severity.
  - **TLS 1.2+** enforced by Vercel + HSTS header set in `src/proxy.ts` — inherited from F1 unchanged.
  - **At-rest encryption**: Neon Postgres AES-256 at rest — inherited from F1 unchanged.

- [x] **II. Test-First Development**
  - **TDD ordering**: every user story (US1–US7) has at least one acceptance test authored red and committed before the matching use-case implementation lands. Integration test `tenant-isolation.test.ts` is authored red at the very start of the implementation phase.
  - **Coverage thresholds** (enforced via `vitest.config.ts` extension to the F1 config):
    - Domain layer (`src/modules/tenants/domain/**` + `src/modules/plans/domain/**`): 100% line — pure types, enums, state-transition rules, locked-field rules, benefit-matrix validation, tenant-context validators.
    - Application layer (`src/modules/plans/application/**`): ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases**: `enforce-tenant-context.ts`, `role-guard.ts`, `enforce-prior-year-lock.ts`, `clone-plans.ts` (idempotency), `delete-plan.ts` (member-attachment refusal).
  - **Contract tests** (`tests/contract/plans/`): one file per REST endpoint, asserting request/response shapes against zod schemas shared with the handlers.
  - **Integration tests** (`tests/integration/plans/`): hit live Neon Singapore, cover RLS enforcement, clone idempotency, locked-field validation, audit diff, seed idempotency, concurrent-edit last-write-wins.
  - **Red test suite on `main` = stop-the-line**, same as F1.

- [x] **III. Clean Architecture**
  - **Two new modules** (both siblings to F1 `auth`):
    1. `src/modules/tenants/` — **cross-cutting Domain-only module** hosting the `TenantContext` branded type + its constructor + validators. No Application, no Infrastructure, no database table. Pure types. Imported by every F2+ tenant-scoped module via `@/modules/tenants` barrel. Created now to prevent the F1-auth-style "types leak via a sibling's barrel" anti-pattern in F3+ (critique E1/X2, 2026-04-11).
    2. `src/modules/plans/` — full four-layer bounded context (Domain → Application → Infrastructure + Presentation via `src/app/`) with public barrel (`index.ts`) and ESLint `no-restricted-imports` rule extension that forbids deep imports into `plans/domain`, `plans/application`, `plans/infrastructure` from outside the module (same pattern as F1's auth module).
  - **Domain layer has zero framework imports** — in both new modules. `tenants/domain` holds only `TenantContext` + constructors. `plans/domain` holds the plan entity, benefit matrix type, `PlanYear`, `MemberTypeScope`, `Money`, locked-field rule, and state-transition rule — but NOT `TenantContext`, which is imported from `@/modules/tenants`. ESLint rule scoped to `src/modules/plans/domain/**` + `src/modules/tenants/domain/**` extends the F1 rule list.
  - **Application layer orchestrates Domain via ports** — `PlanRepo`, `FeeConfigRepo`, `AuditPort`, `ClockPort`, `TenantContext`. No Drizzle, Next, or React imports. Use cases return `Result<T, E>` (reusing F1's `src/lib/result.ts`).
  - **Infrastructure layer** owns Drizzle schema, migrations, repo implementations, and the RLS-aware `runInTenant` helper. Drizzle-inferred types do NOT leak into Application — the repo returns Domain types.
  - **Presentation layer** (`src/app/(staff)/admin/plans/**`, `src/app/api/plans/**`) calls the public barrel only; it never touches `plans/domain` or `plans/infrastructure` directly.
  - **Cross-module imports**: `plans` consumes `auth` for the session lookup + role guard only, via `auth`'s existing public barrel. No reverse dependency.

- [x] **IV. Payment Security (PCI DSS)** — **Not applicable in F2**. F2 does not process payments; it defines the catalogue the F5 payment flow will eventually price against. Money storage uses integer minor units per Clarifications Q5 (`amount_minor_units`) specifically so the future F5 path can do VAT maths without floats. F5 will re-validate SAQ-A.

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (SV + EN + TH)** — Static UI uses `next-intl` messages keyed under `admin.plans.*` and `admin.settings.fees.*` in `messages/{en,th,sv}.json`. Missing EN keys fail the build. TH+SV enforced on release branches via `pnpm check:i18n`. Tenant-editable plan display names are stored as a structured `{en,th,sv}` map on the plan record per Clarifications Q3 — `en` required at save time, `th`/`sv` optional with a visible "missing translation" indicator in admin views. Fee amounts formatted per locale (THB uses `฿36,000` with Thai grouping, SEK uses Swedish grouping, EUR uses European). Thai Buddhist Era is display-only.

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA + Enterprise Standards)** — `docs/ux-standards.md` § 15 checklist is a merge blocker. Shimmer skeleton renders in the exact shape of the final table for CLS 0 (ux-standards § 2.1). sonner toasts on every mutation success/failure (ux-standards § 4.2). Confirmation dialogs on every destructive action, including bulk (ux-standards § 4.1). aria-live region announces inline-edit saves + rollbacks for screen readers (ux-standards § 7.3). `prefers-reduced-motion` swaps shimmer for a non-animated skeleton pulse (ux-standards § 2.2). Light + dark parity via `next-themes`. Layouts start at 320px using Tailwind responsive utilities. Full keyboard navigation — Tab / Shift-Tab / Enter / Esc / arrow keys cover every interactive element including the palette, inline edit, bulk select, and the create wizard. Focus returns to the triggering element when the palette or dialog closes. Automated WCAG 2.1 AA scan via `@axe-core/playwright` in `tests/e2e/plans-a11y.spec.ts`.

- [x] **VII. Performance & Observability** — `pino` JSON logs (inherited) with a new `logger.child({ tenant })` pattern added by the resolver to stamp every log line with the current tenant for audit-grade traceability. `@vercel/otel` traces span Application → Infrastructure for every plan use case with `tenant.id`, `plan.year`, `plan.id`, `user.id` span attributes. Vercel Speed Insights + Lighthouse CI already in place from F1. SLOs: Plans list API p95 < 400 ms, palette open p95 < 100 ms (bulk SLO deferred with US7). The `plan_not_found` event is counted as `plans.plan_not_found.count` metric; when the F13 periodic scan escalates to `plan_cross_tenant_probe`, a PagerDuty-equivalent alert fires to the maintainer. **Runbook** (per critique E9, 2026-04-11): on alert, (1) inspect `audit_log` entries with `event_type='plan_cross_tenant_probe'` for the alerting window, (2) identify `actor_user_id` + requested plan identifier, (3) check for pattern (single admin typo vs. repeated probe), (4) decide on user disable + incident review. Target time-to-triage < 5 min. Threshold: 1 event / min (alarm), 5 events / hour (investigation). Runbook location: `docs/observability.md` § F2 Plans (added during implementation).

- [x] **VIII. Reliability (Error Handling + Data Integrity + Audit Trail)** — Every error path returns a typed `Result<T, E>` — no thrown exceptions across the use-case boundary. Transactional boundaries:
  - Clone year = one transaction wrapping all N inserts (FR-008)
  - Seed script = **two independent idempotent stages**, each in its own transaction (critique P4, 2026-04-11): Stage A upserts `tenant_fee_config` if missing; Stage B inserts the 9 plans only when zero plans exist for `(tenant, 2026)`. Partial-seeded state is handled cleanly.
  - Single-plan create / update / delete / activate / deactivate / soft-delete / undelete = one transaction including the audit-log append (FR-025)
  - ~~Bulk actions~~ deferred to F3 with US7
  - **Idempotency keys** on every mutation API endpoint (shared pattern with F1): `Idempotency-Key` header required on POST / PATCH / DELETE; server stores the key + request hash for 24 h; repeat key + same hash returns the original response; repeat key + different hash returns 409. Spec SC-003 cross-tenant probe returns 404 deterministically on every retry.
  - **Audit log extends F1's `audit_log` table** (critique E10 verification, 2026-04-11). F1 uses a Postgres `audit_event_type` pgEnum with 17 snake_case values and columns `(id, timestamp, event_type, actor_user_id, target_user_id, source_ip, summary, request_id)`. F2 migration `0007_audit_log_f2_extension.sql` does three things (each required): (a) `ALTER TYPE audit_event_type ADD VALUE 'plan_created'`, …, for **10 new event types** — **these statements must run outside any transaction block per Postgres `ALTER TYPE ADD VALUE` rules, so the migration is a series of top-level statements, not a `BEGIN…COMMIT` block**; (b) `ALTER TABLE audit_log ADD COLUMN payload jsonb` (nullable — F1 entries stay NULL) to carry field-level diffs; (c) `ALTER TABLE audit_log ADD COLUMN tenant_id text` (nullable) to scope F2 audit events to the originating tenant while keeping F1's cross-tenant identity-layer events (NULL tenant_id) visible everywhere. RLS policy on `audit_log` is `USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', TRUE))` — preserves F1 cross-tenant visibility for identity events while tenant-scoping F2 plan events. **Ten new event types** (all snake_case for F1 consistency): `plan_created`, `plan_updated`, `plan_cloned`, `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`, `plan_not_found` (logged by request-path on every admin 404 for the correlation scan to ingest), `plan_cross_tenant_probe` (escalated by the future F13 periodic scan from `plan_not_found` hits that resolve to another tenant — not emitted by request-path code), `fee_config_updated`. Retention ≥ 5 years (inherited).
  - Concurrent edit handling: last-write-wins with a toast telling the overwritten admin their change was replaced; no pessimistic lock.

- [x] **IX. Code Quality Standards** — TypeScript strict (including `noUncheckedIndexedAccess`), ESLint clean, Prettier, Conventional Commits enforced by commit-msg hook. **Solo-maintainer substitute from F1 applies unchanged** (Constitution v1.3.1 exemption): direct push to `main` after Review Gate sign-off is permitted because no second human reviewer is available; the substitute stack is ≥6 `/speckit.review` automated passes + ≥2 `/speckit.staff-review` rounds + the 480+ test coverage bar (now extended with the F2 integration + cross-tenant tests) + maintainer co-signature on the review checklist. Re-reviewed post-implementation.

- [x] **X. Simplicity (YAGNI)** — Key YAGNI decisions explicitly made:
  - **No `tenants` database table in F2** (but YES a `tenants` **module**). Per critique E1/X2, `src/modules/tenants/` exists as a pure Domain-only module hosting `TenantContext` and its validators — a handful of types, no Drizzle schema, no table. Tenant is a string slug resolved by `src/lib/tenant-context.ts`; for the single-tenant deploy the resolver returns `'swecham'` as a constant read from env. The RLS policies depend only on `current_setting('app.current_tenant')`, not on a FK to a tenants table. F10 will introduce the real `tenants` + `user_tenants` tables + subdomain-based resolution when a second chamber onboards, without touching the `tenants` module's Domain types.
  - **No per-plan currency column** (critique P3, 2026-04-11). Currency is stored once per tenant on `tenant_fee_config.currency_code`. Re-introduce per-plan currency if and when a tenant with a mixed-currency catalogue actually onboards — simple additive migration.
  - **No palette search backend** (tsvector / Typesense / Meilisearch). In-memory filter over 9–50 plans is sufficient through F5.
  - **No hard-delete.** Soft-delete only, with admin "Show deleted" + Undelete. Hard-delete would require separate DB-admin workflow — not worth the attack surface.
  - **No real-time collaboration / presence.** Last-write-wins with a warning toast.
  - **No plan-name content management system.** A `{en,th,sv}` structured record on the plan row handles it.
  - **No Excel import.** The 2026 seed comes from the PDF, not from any spreadsheet. The deleted `docs/database-analysis.md` is not a source of truth.
  - **No inline edit / bulk actions / editable table in F2** (critique X1c, 2026-04-11). US7 + `@tanstack/react-table` deferred to F3 where member-list cardinality stress-tests the primitive and justifies its cost.
  - Command palette is **scoped to plans only** in F2 — F3 will extend it with members, F4 with invoices, and so on. The `cmdk` primitive + grouping system are designed for this incremental growth; the F2 surface is genuinely used (keyboard accelerator across every admin page), not speculative.

**All 10 gates PASS.** No new F2-specific Constitution deviations. Two deviations inherited from F1 (hosting region + solo-dev review substitute) carry over unchanged — see Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/002-membership-plans/
├── plan.md                  # This file
├── spec.md                  # Feature specification (with Clarifications Q1–Q5)
├── research.md              # Phase 0 output (/speckit.plan)
├── data-model.md            # Phase 1 output (/speckit.plan)
├── quickstart.md            # Phase 1 output (/speckit.plan)
├── contracts/
│   └── plans-api.md         # Phase 1 output — REST endpoint contracts
├── checklists/
│   └── requirements.md      # Spec quality checklist (existing from /speckit.specify)
└── tasks.md                 # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── app/                                       # Presentation layer
│   ├── (staff)/admin/
│   │   ├── plans/
│   │   │   ├── layout.tsx                     # plans section shell + breadcrumb
│   │   │   ├── page.tsx                       # Plans list (US1, US6 palette entry, US7 inline/bulk)
│   │   │   ├── new/
│   │   │   │   └── page.tsx                   # Create wizard (US2) — 4 steps
│   │   │   ├── [year]/
│   │   │   │   └── [planId]/
│   │   │   │       ├── edit/
│   │   │   │       │   └── page.tsx           # Edit view (US3) — partial-lock banner if prior year
│   │   │   │       └── page.tsx               # Read-only detail
│   │   │   └── clone/
│   │   │       └── page.tsx                   # Clone year UI (US2 AS1)
│   │   └── settings/
│   │       └── fees/
│   │           └── page.tsx                   # Per-tenant fee config (US5)
│   └── api/
│       ├── plans/
│       │   ├── route.ts                       # GET list, POST create
│       │   ├── [year]/
│       │   │   └── [planId]/
│       │   │       ├── route.ts               # GET one, PATCH update, DELETE soft-delete
│       │   │       ├── activate/route.ts      # POST toggle active
│       │   │       ├── deactivate/route.ts    # POST toggle inactive
│       │   │       └── undelete/route.ts      # POST restore from soft-delete
│       │   ├── clone/
│       │   │   └── route.ts                   # POST clone year X → Y
│       │   └── bulk/
│       │       └── route.ts                   # POST bulk activate/deactivate/clone-selected
│       └── fee-config/
│           └── route.ts                       # GET current, PATCH update
│
├── modules/
│   ├── auth/                                  # [F1, unchanged] — plans consumes its barrel
│   ├── tenants/                               # NEW: F2 cross-cutting Domain-only module (critique E1/X2)
│   │   ├── index.ts                           # Public barrel — exports TenantContext + asTenantContext
│   │   └── domain/
│   │       └── tenant-context.ts              # branded `TenantContext` type + constructor + validators
│   │                                          # NO application/, NO infrastructure/, NO database table.
│   │                                          # Imported by F2+ every tenant-scoped module via @/modules/tenants.
│   └── plans/                                 # NEW: F2 bounded context
│       ├── index.ts                           # Public barrel (only external entry point)
│       ├── domain/                            # Pure — NO framework imports
│       │   ├── plan.ts                        # Plan entity, `MemberTypeScope`, `PlanCategory`, `PlanYear`
│       │   ├── benefit-matrix.ts              # typed benefit matrix per §2/§3 of membership-benefits-analysis.md
│       │   ├── money.ts                       # Money value object — integer minor_units only (currency on tenant)
│       │   ├── locale-text.ts                 # `{en,th,sv}` structured record type + validators
│       │   ├── locked-field-rule.ts           # prior-year partial lock — what is cosmetic vs frozen (FR-014)
│       │   ├── plan-state.ts                  # state machine: draft → active → inactive → soft-deleted → (undeletable)
│       │   ├── fee-config.ts                  # per-tenant fee config entity
│       │   ├── audit-event.ts                 # 10 new event types (snake_case matching F1)
│       │   └── policies.ts                    # canAdminMutatePlan, canManagerReadPlan, canCloneYear
│       ├── application/                       # Use cases — orchestrate Domain via ports
│       │   ├── list-plans.ts
│       │   ├── get-plan.ts
│       │   ├── create-plan.ts
│       │   ├── update-plan.ts                 # enforces prior-year locked-field rule
│       │   ├── activate-plan.ts
│       │   ├── deactivate-plan.ts
│       │   ├── soft-delete-plan.ts            # refuses if member-attached (FR-010)
│       │   ├── undelete-plan.ts
│       │   ├── clone-plans-to-year.ts         # atomic, refuses if target year already populated
│       │   ├── get-fee-config.ts
│       │   ├── update-fee-config.ts
│       │   ├── search-plans.ts                # Command palette backend (in-memory filter, lazy load)
│       │   ├── record-audit-event.ts          # thin adapter over F1 audit log
│       │   └── ports.ts                       # PlanRepo, FeeConfigRepo, AuditPort, ClockPort (TenantContext from @/modules/tenants)
│       ├── infrastructure/                    # Adapters — Drizzle, RLS
│       │   ├── db/
│       │   │   ├── schema.ts                  # membership_plans + tenant_fee_config Drizzle schema
│       │   │   ├── plan-repo.ts               # implements PlanRepo via runInTenant()
│       │   │   ├── fee-config-repo.ts
│       │   │   └── rls-policies.sql           # raw SQL the migration emits
│       │   └── audit/
│       │       └── plan-audit-adapter.ts      # writes into F1 audit_log (extended by 0007) with F2 event types
│       └── plans-deps.ts                      # Composition root — wires ports to infra singletons
│                                              # NOTE: bulk-*.ts use cases DEFERRED to F3 with US7 (critique X1c)
│
├── components/
│   ├── plans/                                 # Presentation components (reused across list/edit/new)
│   │   ├── plans-table.tsx                    # plain shadcn <Table> + sort/filter (no inline edit — US7 deferred)
│   │   ├── plan-form-wizard.tsx               # 4-step create wizard
│   │   ├── plan-edit-form.tsx                 # Edit form with prior-year lock banner
│   │   ├── benefit-matrix-editor.tsx          # Grouped benefit editor (Brand Visibility / Events / …)
│   │   ├── money-input.tsx                    # integer minor_units input (currency resolved from tenant_fee_config)
│   │   ├── locale-text-input.tsx              # en/th/sv tab strip with missing-translation indicator
│   │   ├── clone-year-dialog.tsx
│   │   ├── prior-year-lock-banner.tsx
│   │   └── plan-list-skeleton.tsx             # shimmer skeleton in final-table shape (CLS 0)
│   ├── command-palette/                       # NEW cross-cutting primitive (cmdk-based)
│   │   ├── command-palette.tsx                # Root component — shortcut handler + portal + lazy data load on first open (critique E7)
│   │   ├── registry.ts                        # searchable entity types + actions (plans only in F2)
│   │   └── groups.tsx                         # Plans / Actions / Navigate groups
│   ├── ui/                                    # shadcn primitives (some new in F2, see deps list)
│   │   ├── command.tsx                        # shadcn-cmdk wrapper (NEW)
│   │   ├── table.tsx                          # shadcn table base (NEW — plain HTML-based)
│   │   ├── select.tsx                         # (NEW)
│   │   ├── popover.tsx                        # (NEW)
│   │   ├── tabs.tsx                           # (NEW — needed by locale-text-input)
│   │   ├── switch.tsx                         # (NEW)
│   │   ├── radio-group.tsx                    # (NEW — wizard step selection)
│   │   ├── textarea.tsx                       # (NEW — description fields)
│   │   ├── scroll-area.tsx                    # (NEW — palette result list)
│   │   └── separator.tsx                      # (NEW)
│   └── shell/                                 # extended from F1 — add palette root
│       └── command-palette-root.tsx           # mounts palette once at the app shell level
│
├── i18n/messages/
│   ├── en.json                                # + admin.plans.*, admin.settings.fees.*, palette.* keys
│   ├── th.json
│   └── sv.json
│
├── lib/
│   ├── db.ts                                  # [extended] + runInTenant(tenantCtx, fn) helper + DEBUG_RLS_STATE dev assertion (critique E5)
│   ├── tenant-context.ts                      # NEW: concrete resolver — returns asTenantContext('swecham') for now; TenantContext TYPE is imported from @/modules/tenants
│   ├── money.ts                               # NEW: format / parse / VAT helpers over integer minor_units + ISO 4217 code (code comes from tenant_fee_config, NOT per-plan)
│   ├── idempotency.ts                         # NEW: shared Idempotency-Key middleware (reused F3+)
│   └── (existing F1 lib files unchanged)
│
└── proxy.ts                                   # [extended] — resolve tenant + inject into request context

drizzle/migrations/
├── 0006_plans_and_fee_config.sql              # membership_plans + tenant_fee_config tables + RLS policies
└── 0007_audit_log_f2_extension.sql            # extends audit_event_type pgEnum with 10 values (each an independent top-level ALTER TYPE ADD VALUE statement — Postgres forbids them inside a transaction block); ADD COLUMN audit_log.payload jsonb; ADD COLUMN audit_log.tenant_id text; RLS policy allows NULL tenant_id (F1 cross-tenant events) alongside tenant-scoped F2 events

tests/
├── contract/plans/
│   ├── list-plans.test.ts
│   ├── get-plan.test.ts
│   ├── create-plan.test.ts
│   ├── update-plan.test.ts                    # covers 422 prior_year_locked_fields
│   ├── delete-plan.test.ts
│   ├── clone-plans.test.ts
│   ├── fee-config.test.ts
│   └── palette-search.test.ts
├── integration/plans/
│   ├── tenant-isolation.test.ts               # ⚠ Review-Gate BLOCKER (Constitution v1.4.0 clause 3, UUID-suffixed tenants per critique E8)
│   ├── prior-year-lock.test.ts                # FR-014 partial-lock enforcement
│   ├── clone-idempotency.test.ts              # clone twice → 409
│   ├── seed-idempotency.test.ts               # re-run seed → refused; partial-seeded states recover (critique P4)
│   ├── audit-diff.test.ts                     # every mutation yields a reconstructable diff in audit_log.payload
│   ├── soft-delete-with-members.test.ts       # refused if plan has active members (will use F3 fixture)
│   ├── concurrent-edit-lww.test.ts            # last-write-wins with warning
│   └── rls-debug-state.test.ts                # DEBUG_RLS_STATE dev assertion fires on unset tenant (critique E5)
├── unit/plans/
│   ├── domain/
│   │   ├── plan.test.ts
│   │   ├── benefit-matrix.test.ts
│   │   ├── money.test.ts
│   │   ├── locale-text.test.ts
│   │   ├── locked-field-rule.test.ts
│   │   ├── plan-state.test.ts
│   │   └── policies.test.ts
│   └── application/
│       └── search-plans.test.ts               # palette in-memory filter logic
└── e2e/
    ├── plans-list.spec.ts                     # US1 + i18n run
    ├── plans-create-wizard.spec.ts            # US2
    ├── plans-edit.spec.ts                     # US3 + prior-year lock
    ├── plans-deactivate.spec.ts               # US4
    ├── fee-config.spec.ts                     # US5
    ├── command-palette.spec.ts                # US6 (with lazy-load assertion per critique E7)
    ├── plans-a11y.spec.ts                     # @axe-core/playwright WCAG 2.1 AA
    ├── plans-reduced-motion.spec.ts           # shimmer → pulse fallback
    ├── plans-keyboard-only.spec.ts            # full keyboard traversal incl. palette
    └── plans-i18n-coverage.spec.ts            # SV + EN + TH on every plans screen
    # (tests/e2e/inline-edit-bulk.spec.ts DEFERRED to F3 with US7 per critique X1c)

scripts/
├── seed-swecham-2026-plans.ts                 # NEW: one-off seed, idempotent, single transaction
└── check-i18n-coverage.ts                     # [extended] — also scans admin.plans.* keys
```

**Structure Decision**: **Web application, single Next.js project — continue the F1 pattern.** F2 adds:
1. A new bounded context `src/modules/plans/` as a sibling to `auth/` — same Clean Architecture shape (domain / application / infrastructure + public barrel + ESLint rule), same dependency inversion (Application depends on Domain via ports, Infrastructure implements ports, Presentation calls Application through the barrel).
2. A new **Domain-only cross-cutting module** `src/modules/tenants/` containing `TenantContext` and its constructors (critique E1/X2, 2026-04-11). This is a ~50-line module with no Application, no Infrastructure, no database table — it exists so that every F2+ tenant-scoped module (plans, members F3, invoices F4, …) can import `TenantContext` via `@/modules/tenants` without reaching into a sibling bounded context's `domain/` directory.
3. Two cross-cutting libs under `src/lib/`: `tenant-context.ts` (concrete resolver that imports the type from `@/modules/tenants`) and `money.ts` (format / VAT helpers over integer minor units). Both are reused by every F3+ feature unchanged.
4. A cross-cutting component `src/components/command-palette/` that grows entity-by-entity as each feature ships — starts with plans-only in F2.
5. Two migrations: `0006_plans_and_fee_config.sql` (tables + RLS policies) and `0007_audit_log_f2_extension.sql` (extends the F1 `audit_event_type` pgEnum with 10 new values + adds `payload jsonb` + `tenant_id text` columns to `audit_log` + adds a permissive RLS policy that accepts NULL tenant_id for F1 cross-tenant identity events).

Rationale: splitting into a separate service (e.g., "plans-api" backend microservice) would add deploy + operational complexity with zero benefit at this scale. Clean Architecture separation is enforced by directory layering + ESLint, not by a process boundary — exactly as F1 established. Adding `plans` as a sibling module preserves the F1 pattern so F3–F9 can replicate it mechanically.

## Complexity Tracking

> **No new F2-specific Constitution deviations.** Two deviations are inherited from F1 unchanged.

| Violation | Why Needed | Simpler Alternative Rejected Because | Inherited From |
|---|---|---|---|
| **Hosting region is Singapore, not Thailand** (Constitution § Compliance: "Thailand primary") | No major cloud provider has a Thailand region; Vercel `sin1` + Neon `ap-southeast-1` is nearest APAC. Thai PDPA § 28 cross-border transfers to Singapore are within the adequacy provisions; EU GDPR is covered by SCCs with Vercel and Neon. Constitution escape clause ("or nearest APAC if no TH region is available") applies. | A Thai-local provider (ByteArk, Nipa.cloud) would give literal residency but at the cost of Vercel's entire DX (preview deploys, edge, Cache Components) and operational burden. At <500 concurrent users the DX loss outweighs the residency gain. Revisit when scale, regulation, or legal counsel demands it. | [F1 plan.md](../001-auth-rbac/plan.md) — unchanged |
| **Solo-dev substitute for "≥2 reviewers on security-sensitive changes"** (Constitution Principle IX + § Development Workflow Gate 9 + Constitution v1.3.1 exemption) | Single-maintainer project — no second human reviewer available to form the standard review pair. Substitute stack: ≥6 `/speckit.review` automated passes + ≥2 `/speckit.staff-review` rounds + 480+ automated tests (extended to ≥560 after F2 lands new integration + cross-tenant + a11y + i18n + bulk suites) + maintainer co-signature on the review checklist. Reversible when a second maintainer joins. | Blocking F2 until a second reviewer exists would indefinitely defer Chamber-OS and leave SweCham on the legacy Excel workflow. Accepting self-review as "reviewer #2" would violate the independence principle the rule exists to protect. | [F1 plan.md](../001-auth-rbac/plan.md) — carried forward per v1.3.1 exemption |

All other Constitution gates pass with no new deviations. The v1.4.0 Tenant Isolation clause is satisfied in full by F2's two-layer enforcement — it is the reason F2 exists in its current shape and is not a violation of the new clause but its first compliant implementation.

## Phase 0 Status

See [research.md](./research.md). Resolves:
1. Tenant-context resolver + RLS implementation pattern (middleware vs. use-case parameter; `SET LOCAL` vs. pgBouncer interaction; `TenantContext` branded type)
2. Drizzle + Postgres RLS integration (how to apply policies via `drizzle-kit` migrations and keep dev + CI + prod consistent)
3. RBAC extension for plans (new `plans:*` resources in the policy matrix)
4. Command palette library decision (`cmdk` vs. alternatives, performance targets, result grouping pattern)
5. Editable table library decision (`@tanstack/react-table` vs. alternatives, inline edit + optimistic mutation + undo grace period pattern)
6. Money representation pattern (integer minor units, ISO 4217 codes, VAT math, display formatting across locales)
7. Plan display-name i18n storage validation pattern (zod schema for `{en,th,sv}` with required EN + optional TH/SV + missing-translation flag)
8. Prior-year partial-lock enforcement strategy (Application-layer rule module + repo-level secondary check)
9. Idempotency key pattern reuse from F1 for bulk + clone mutations
10. Enterprise UX pattern inventory for F2: skeleton shimmer shape matching, sonner toast patterns, confirmation dialog copy, aria-live announcements for inline edit, reduced-motion handling

## Phase 1 Status

See:
- [data-model.md](./data-model.md) — entities, fields, relationships, state machines, RLS policies, validation rules, SweCham 2026 seed rows
- [contracts/plans-api.md](./contracts/plans-api.md) — REST endpoint contracts for plans CRUD + clone + bulk + fee config + palette search
- [quickstart.md](./quickstart.md) — developer onboarding, migration steps, seed execution, local run, test matrix
- [`../../docs/membership-benefits-analysis.md`](../../docs/membership-benefits-analysis.md) — authoritative 2026 plan data (input)
- [`../../docs/saas-architecture.md`](../../docs/saas-architecture.md) — MTA+STD strategy (input)
- [`../../docs/smart-chamber-features.md`](../../docs/smart-chamber-features.md) — #4 Command Palette + #7 Inline Edit spec (input)
- [`../../docs/ux-standards.md`](../../docs/ux-standards.md) — Enterprise UX playbook (input)

## Post-Design Constitution Re-Check

*Must be executed AFTER Phase 1 artefacts (research.md, data-model.md, contracts/, quickstart.md) are generated, to catch gate violations that only surface during design.*

See end of [research.md](./research.md) § Post-Design Check.
