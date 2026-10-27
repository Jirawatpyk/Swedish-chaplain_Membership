---
paths:
  - "src/**"
  - "drizzle/**"
---

# Architecture — source layout, layers, tenancy, migrations

Loaded when Claude reads or edits `src/` or `drizzle/`. The one-line summary stays in `CLAUDE.md`; the detail lives here.

## Source layout (F1 skeleton — still accurate for F1–F9)

```text
src/
├── app/                               # Presentation (Next.js routes, server actions)
│   ├── (staff)/                       # Route group: admin + manager portal → /admin/**
│   ├── (member)/                      # Route group: member self-service → /portal/**
│   ├── (auth-public)/                 # Shared: /forgot-password, /reset-password/[token], /invite/[token]
│   └── api/**                         # route.ts handlers: auth, cron/**, internal/** (metrics, retention), webhooks
├── config/                            # runtime config objects (nav, feature maps)
├── hooks/                             # shared client hooks
├── modules/<context>/                 # Bounded contexts: auth, tenants, plans, members, invoicing, payments,
│   │                                  #   events, broadcasts, renewals, insights
│   ├── domain/                        # Pure types + policies — NO framework imports
│   ├── application/                   # Use cases — NO drizzle/next/react imports
│   └── infrastructure/                # DB repos, email client, hasher, rate-limit adapter
├── components/
│   ├── ui/                            # legacy shadcn/ui on Base UI — deleted at spec 122 US13 (AURA replaces it)
│   ├── auth/                          # sign-in-form, reset-password-form, idle-warning-dialog, …
│   ├── shell/                         # user-menu, theme-toggle, skip-to-content, empty-state, error-state
│   └── layout/                        # staff-shell, staff-top-bar, member-header, member-nav, page-header
├── i18n/
│   ├── config.ts, request.ts          # next-intl
│   └── messages/{en,th,sv}.json       # en.json is canonical
├── lib/
│   ├── db.ts                          # Drizzle client singleton + runInTenant
│   ├── logger.ts                      # pino structured logger (forbidden fields: password, session id, tokens, Authorization)
│   ├── otel-tracer.ts                 # tracer helper; @vercel/otel is registered in root instrumentation.ts
│   ├── env.ts                         # zod-validated process.env, runs at boot
│   └── result.ts                      # Result<T,E> helper for explicit error handling
└── proxy.ts                           # Next.js 16 renamed middleware→proxy — there is NO src/middleware.ts.
                                       # session lookup + route guards + CSRF Origin allow-list + HSTS
                                       # + per-request nonce header + tenant header

drizzle/migrations/                    # HAND-WRITTEN SQL from 0019 onwards + meta/_journal.json
docs/runbooks/                         # ~60 incident runbooks (cron-jobs, db-environment-branching, void-on-reissue, …)
tests/
├── contract/                          # One file per API / inter-module boundary
├── integration/<module>/              # Real Postgres (live Neon `dev` branch), use cases end-to-end
├── unit/<module>/                     # Domain + pure logic (+ unit/architecture/ barrel guards)
├── e2e/                               # Playwright + axe-core; includes i18n coverage and reduced-motion specs
└── helpers/, stubs/, support/, load/  # shared fixtures, test doubles, k6/perf harnesses
specs/<nnn-feature>/                   # Spec Kit artefacts — one dir per feature branch
```

`tests/unit/broadcast/` and `tests/unit/broadcasts/` are two different folders.

## Clean Architecture (Principle III, NON-NEGOTIABLE)

- **Domain**: zero imports from `next`, `drizzle-orm`, `resend`, `@upstash/*`, `react`. Enforced by an ESLint `no-restricted-imports` rule scoped to `src/modules/*/domain/**`.
- **Application**: orchestrates Domain via its own port interfaces. No ORM, HTTP, framework, or React imports.
- **Infrastructure**: implements Application ports; Drizzle-inferred types live here and MUST NOT leak into Application or Domain.
- **Presentation**: calls Application use cases only; never touches Domain or Infrastructure directly.
- **Cross-context imports go through a module's public barrel** — never into a sibling's `domain/` or `application/`. Blocked by ESLint `no-restricted-imports`; every module ships a barrel + rule (Principle III).
- Client-reachable code under `src/lib/` imports a module barrel **type-only**; a value import drags server code into the client bundle.
- A deviation requires a line in `plan.md` § Complexity Tracking with the rejected simpler alternative.

## Tenancy (F2+)

- `runInTenant(ctx, fn)` + Postgres RLS (`SET LOCAL app.current_tenant`) is the isolation pattern, **plus** an explicit `tenant_id` predicate on every tenant-scoped table reference (D-029) — RLS is the second wall, not the only one. Gate a repo with `tests/helpers/tenant-sql-shape.ts` (`recordingDb` + `tenantPredicateViolations`) — a call-map case per method, not only the text scans (`unfencedWheres` / `unfencedRawSql`): a correlated subquery's `tenantId` hides an unfenced root from them, and a nested `sql` fragment truncates a raw body (s7 retro). `src/modules/tenants/` is a Domain-only module hosting the `TenantContext` branded type. `DEBUG_RLS_STATE` is a dev-only tenant-context assertion.
- **Tenant-scoped repos MUST thread `tx` from `runInTenant`, never the global `db` singleton.** A repo method on a `tenant_id`-scoped table that reaches for the pool-global `db` gets a fresh connection without `SET LOCAL app.current_tenant`, silently bypassing RLS (it can read/write across tenants and the RLS+FORCE policies won't save you).
- `err()` returned inside `runInTenant` **commits** the transaction — put refusal guards above the first write.
- `neondb_owner` has `BYPASSRLS`: an ad-hoc SELECT as the owner sees every tenant, so a cross-tenant leak can never be reproduced from a psql session.
- Principle I requires a cross-tenant integration test for every tenant-scoped surface (Review-Gate blocker).

## Advisory-lock namespaces — deliberately DISJOINT

`invoicing:` (F4 — per tenant+document_type+fiscal_year, keeps §87 numbering gap-free) · `payments:` (F5 — per tenant+invoice, a TOCTOU guard, NOT numbering) · `broadcasts:` (F7 — per tenant+broadcast) · `broadcasts-image:` (F119 — per tenant+content_hash, serialises the image sweep against a dedup upload; `hashtextextended`). Same primitive, four contracts; never reuse a namespace across modules.

## Audit log

- The canonical lists and their counts live in code, never here — e.g. `F7_AUDIT_EVENT_TYPES` (static-asserted) in `src/modules/broadcasts/application/ports/audit-port.ts`.
- `audit_log.retention_years` is `SMALLINT NOT NULL DEFAULT 5` with CHECK `IN (5,10)`; six F4 tax-document types are backfilled to 10 years per Thai RD §87/3 + GDPR Art. 6(1)(c) (migration 0039).
- **Adding an audit event type touches five places**:
  1. `auditEventTypeEnum` in `src/modules/auth/infrastructure/db/schema.ts` (every new value);
  2. the module's own taxonomy list (F5 / F7 / F8 / F9), or `AUDIT_EVENT_TYPES` in `src/modules/auth/domain/audit-event.ts` for an F1 audit-taxonomy event;
  3. the count in `tests/unit/auth/domain/audit-event.test.ts` when `AUDIT_EVENT_TYPES` grew (or the module's count test);
  4. the count in `tests/integration/audit/completeness.test.ts` when `AUDIT_EVENT_TYPES` grew (pre-push does NOT run this folder for another module's event);
  5. `audit.eventType.<value>` in all three locale files, which `tests/unit/insights/audit-event-label-coverage.test.ts` enforces.

  Add the value with an idempotent `ALTER TYPE … ADD VALUE` migration. The TS tuple is not the whole enum: `ALL_AUDIT_EVENT_TYPES = tuple ∪ DB_ONLY_AUDIT_EVENT_TYPES` (`DB_ONLY_` is legacy drift; never add to it), and three values contain a hyphen, so parse enum values with `'([^']+)'`, never `[a-z0-9_]+`.
- **Audit-truth invariant**: no `audit_log` row states a role its actor did not hold — record `?? null`, never `?? 'admin'`; `pnpm check:actor-role-truth` (pre-push) guards it.
- Audit payloads carry snake_case `member_id` — the `last_activity_at` trigger reads only that key.

## Migrations

- **`db:generate` is abandoned — migrations 0019+ are HAND-WRITTEN SQL.** Drizzle snapshots stop at `0018`, so `drizzle-kit generate` cannot produce a correct diff (it also blocks on a TTY prompt). Write the `.sql` file by hand and register it in `drizzle/migrations/meta/_journal.json`; apply with `pnpm db:migrate` (`scripts/run-migrations.ts`).
- **A duplicate `when` timestamp makes `db:migrate` a silent no-op** — it prints "✓ applied" while applying nothing. Verify the DDL landed via `information_schema`, then bump `when` by +100000 ms. When two branches add migrations in parallel, merge the other branch first and renumber yours.
- **Apply the migration + run integration tests before committing schema changes.** When a commit adds a migration *and* code that references the new enum/column, run `pnpm db:migrate` then the touched integration suites first. Unit-test mocks hide the schema gap.
- Before writing defensive code around a constraint, query `pg_indexes` / `information_schema` to see whether it exists.
- A migration pre-check `DO` block has no tenant filter. It must pass on the shared `dev` branch and the persistent CI Neon branch, both full of leftover `test-*` tenants, not only on prod. Measure the whole branch before writing the predicate.
- `db:migrate` targets the `dev` Neon branch; prod + preview migrate on Vercel deploy (`vercel-build`). Map: `docs/runbooks/db-environment-branching.md`.
