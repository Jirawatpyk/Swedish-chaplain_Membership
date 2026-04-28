# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Project**: **Chamber-OS** — a SaaS membership management platform for chambers of commerce and membership organisations. **SweCham / TSCC (Thailand-Swedish Chamber of Commerce)** is the first tenant, deployed at `swecham.zyncdata.app`. The platform is designed as **Multi-Tenant Aware, Single-Tenant Deployed (MTA+STD)** — F1 shipped single-tenant; F2 onwards use `tenant_id`-scoped schemas so future tenants can be onboarded without schema migration. See `docs/saas-architecture.md` for the multi-tenant strategy.

**Scope**: Chamber-OS is the **membership management backend + admin portal + member self-service portal**. It is NOT a public website / CMS — tenants are expected to have their own public sites.

**Folder name caveat**: the directory is historically `Swedish chaplain_membership`. "chaplain" is a typo for "chamber". Refer to the product as **Chamber-OS** (platform) or **SweCham / TSCC** (first tenant), never "chaplain". Rename is tracked as R6 in `docs/phases-plan.md` (manual action — cannot be done from inside the active working directory).

**Repository status (as of 2026-04-21)**: **F1 (Auth & RBAC) SHIPPED via PR #1.** **F2 (Membership Plans) REVIEW-READY on `002-membership-plans`.** **F3 (Members & Contacts) REVIEW-READY on `005-members-contacts`.** **Branch `006-layout-container-tier2` REVIEW-READY on PR #9** (layout primitives, not canonical F5). **F4 (Invoices & Receipts) REVIEW-READY on `007-invoices-receipts`** — entire Phase 10 complete: auto-email + manual resend (T105–T108), dispatcher + F4 dual-emit (T106 + vercel.json crons), overdue derivation wired to 4 UIs (T109), audit behavioral coverage **17/18 F4 event types** (T113a — only post-MVP Blob-outage auto-rerender deferred), perf benchmarks (T110 PDF render **p95=88ms < 800ms**; T110a invoice-list **p95=324ms < 500ms @ 5k×2 rows**; T111 50-writer seq **~10s < 30s**), T112 retention + archive invariant (FR-029/030), and the full 10g staff-review carry-forward batch (T120 host-header MTA dual-bind migration 0031, T121 CR/LF strip helper, T122 pdf_render_failed emit, T123 VAT source-chain pin, T125 un-fixme mutating CN E2E, T126 `renderAndUploadPdf` helper refactoring 4 sites, T127 CN-PDF synthetic-line golden). Test suite state: **~1300 unit+contract green** + **~340 integration green** on live Neon Singapore + **~1190 i18n keys × 3 locales**. Security/UX/a11y checklists 100%. Constitution v1.4.0 Principle I tenant-isolation test (Review-Gate blocker) green across F3+F4. SC-003 byte-identical PDF, SC-005 list-perf, and SC-002 (F3) all met with headroom. Human-gated residuals: T114 manual SR + cross-browser + staging traces + reduced-motion, T117 maintainer co-sign on security checklist, T118 ≥6 `/speckit.review` + ≥2 `/speckit.staff-review` rounds, T124 a11y SR QA (folds into T114), T115t throwaway-tenant E2E infra (deferred to Phase 10+ per tasks.md rationale). Source modules: `src/modules/auth/**` (F1) + `src/modules/tenants/**` + `src/modules/plans/**` (F2) + `src/modules/members/**` (F3) + `src/modules/invoicing/**` (F4) + presentation surfaces in `src/app/(staff)/admin/**` + `src/app/(member)/portal/**` + `src/components/layout/**` (006).

## Language for AI sessions

User prefers **Thai** for conversational turns. Code, specs, commit messages, and technical docs remain in **English** (for international collaborators and long-term stability).

## Governance — read before proposing architecture changes

- `.specify/memory/constitution.md` — **v1.4.0** (amended 2026-04-11; v1.4.0 MINOR adds explicit SaaS tenant-isolation requirements under Principle I with 5 sub-clauses: app-layer, db-layer, integration test, audit, super-admin), authoritative. 10 principles (4 NON-NEGOTIABLE: Data Privacy & Security, Test-First, Clean Architecture, PCI DSS) plus 6 Core (i18n, Inclusive UX, Perf & Observability, Reliability, Code Quality, Simplicity). Principle I now requires **two-layer tenant isolation** (application + database) with a mandatory cross-tenant integration test as a Review-Gate blocker. Principle III requires every `src/modules/*` module to ship a public barrel + ESLint `no-restricted-imports` rule. Principle IX + Gate 9 + § Governance + § Development Workflow Additional rules carry a **solo-maintainer substitute** clause for the default ≥2-reviewers + no-direct-push rules, applicable when no second human reviewer is available. Amendments go through a PR with ≥2 maintainer approvals (or the solo-maintainer substitute) + a Sync Impact Report.
- Every `/speckit.plan` runs a **Constitution Check** against all 10 principles. Any deviation lives in `plan.md` § Complexity Tracking with a rejected simpler alternative — unjustified violations block the gate.
- The escape clause that allows Singapore hosting (Constitution § Compliance: Hosting & Residency) is used by F1. See `specs/001-auth-rbac/plan.md` Complexity Tracking.

## Key project docs (read in this order for context)

1. `.specify/memory/constitution.md` — principles and quality gates (v1.4.0, includes SaaS tenant-isolation requirements under Principle I)
2. `docs/phases-plan.md` — **10 core + 4 SaaS = 14 features** across 5 phases. Includes 6 resolved decisions (SV+EN+TH locales, TH-primary hosting, Stripe, 3 roles, no day-1 Excel migration, folder rename) + 2026-04-11 SaaS pivot update + scope boundary vs `swecham.com`.
3. `docs/saas-architecture.md` — **multi-tenant strategy (MTA+STD)**, Postgres RLS, auth model (cross-tenant users, tenant-scoped membership), billing layers, white-label scope, migration path, pricing vision. Read this before designing any F2+ feature.
4. `docs/membership-benefits-analysis.md` — authoritative 2026 Membership Package tier data from the PDF (6 corporate + 3 partnership tiers, full benefit matrix, data model, Q1–Q5 for F2 clarify). **Supersedes the deleted `docs/database-analysis.md`** which was Excel-derived and inaccurate.
5. `docs/event-integration-analysis.md` — F6 EventCreate integration strategy (Zapier webhook → attendee import → benefit quota). No CRUD event management — we use EventCreate externally.
6. `docs/email-broadcast-analysis.md` — F7 Email Broadcast / E-Blast system (paid benefit delivery via Resend Broadcasts API). New feature added to fill the critical gap for E-Blast quota delivery.
7. `docs/smart-chamber-features.md` — **21 smart chamber features catalogued** (6 in MVP: benefit dashboard, at-risk detection, smart renewal, command palette, inline+bulk, timeline; 15 post-MVP: undo, NL search, saved filters, CSV import, realtime, engagement score, auto-upgrade suggestions, activity feed, compliance tracker, proactive alerts, public directory widget, GDPR export).
8. `docs/ux-standards.md` — enterprise UX playbook (shimmer skeletons, toasts, confirmation dialogs, idle warning, theming, keyboard & focus management). F1 auth screens MUST pass the § 15 checklist before merge.
9. `docs/observability.md` — metrics, SLOs, alerts, log schema
10. `specs/001-auth-rbac/` — F1 feature bundle (shipped via PR #1)

**Note**: `docs/database-analysis.md` was **deleted 2026-04-11** — it was Excel-derived and known to be inaccurate after the 2026 Membership Package PDF was provided. The reusable analyzer script lives at `.specify/scripts/analyze_excel.py`. Git history preserves the old content.

## Current feature: F1 — Auth & RBAC (`001-auth-rbac`)

- `specs/001-auth-rbac/spec.md` — user stories (P1/P2/P3), acceptance scenarios, measurable success criteria, FRs
- `specs/001-auth-rbac/plan.md` — architecture, tech stack, Constitution Check, source tree
- `specs/001-auth-rbac/research.md` — resolved implementation choices + rationale for each
- `specs/001-auth-rbac/data-model.md` — entities, state machines, SQL schema, append-only audit grants
- `specs/001-auth-rbac/contracts/auth-api.md` — REST endpoint contracts
- `specs/001-auth-rbac/security.md` — 16-threat model (T-01 credential stuffing … T-16 argon2 DoS) mapped to mitigations and tests; security reviewer MUST sign § 5 checklist
- `specs/001-auth-rbac/tasks.md` — TDD-ordered task list for `/speckit.implement`
- `specs/001-auth-rbac/quickstart.md` — developer onboarding + local dev setup (Vercel link, Neon/Upstash/Resend provisioning, Docker test DB, Playwright)

**F1 shape in one paragraph**: three roles (`admin`, `manager` read-only on finance, `member` self-service), two portals (`/admin` for staff, `/portal` for members, plus shared `/forgot-password` and `/invite/[token]`), email+password only, invitation-based account creation, custom session-based auth (Lucia v3 guide pattern) with 30 min idle / 12 h absolute TTL, 16-event append-only audit trail, SV+EN+TH from day one, WCAG 2.1 AA, PDPA+GDPR dual compliance, placeholder landing page on `/portal` until F3 adds real member content. F1 deploys to Vercel `sin1` + Neon `ap-southeast-1` (see § Hosting deviation below).

## Locked-in tech stack (F1 onwards)

- **Framework**: Next.js 16 App Router + Cache Components + Turbopack; React 19
- **Language**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`); Node 22 LTS
- **Auth**: custom session-based (Lucia v3 guide pattern), argon2id via `@node-rs/argon2`
- **Storage**: Neon Postgres + Drizzle ORM; Upstash Redis for rate limiting — **both Singapore region**
- **UI**: shadcn/ui + Tailwind CSS v4 + lucide-react + Radix primitives; `next-themes` for light/dark; `sonner` for toasts
- **i18n**: next-intl — **EN default + TH + SV**. Missing EN key fails the build; missing TH/SV falls back to EN with a dev warning and CI failure on release branches. **TH is mandatory for Thai tax-compliant invoices/receipts** (F4).
- **Forms**: react-hook-form + zod (zod also validates every system boundary and `process.env` via `src/lib/env.ts`)
- **Email**: Resend (transactional), `@react-email/components` for templates
- **Payments**: Stripe — **planned for F5, no code yet**. Stripe Elements / Payment Intents to preserve SAQ-A.
- **Testing**: Vitest + Playwright + `@axe-core/playwright` (WCAG 2.1 AA) + MSW + `@testing-library/react`
- **Observability**: `pino` JSON logs + `@vercel/otel` traces + Vercel Analytics / Speed Insights
- **Hosting**: Vercel (`sin1` Singapore) — documented deviation from "Thailand primary" (no major cloud has a TH region)

## Planned source layout (F1)

```text
src/
├── app/                               # Presentation (Next.js routes, server actions, middleware)
│   ├── (staff)/                       # Route group: admin + manager portal → /admin/**
│   ├── (member)/                      # Route group: member self-service → /portal/**
│   ├── (auth-public)/                 # Shared: /forgot-password, /reset-password/[token], /invite/[token]
│   ├── api/auth/**                    # route.ts handlers for every auth endpoint
│   └── middleware.ts                  # session lookup + route guards + CSRF Origin allow-list + HSTS
├── modules/<context>/                 # Bounded contexts (auth, then members, invoices, …)
│   ├── domain/                        # Pure types + policies — NO framework imports
│   ├── application/                   # Use cases — NO drizzle/next/react imports
│   └── infrastructure/                # DB repos, email client, hasher, rate-limit adapter
├── components/
│   ├── ui/                            # shadcn/ui primitives (skeleton extended with shimmer per ux-standards § 2.1)
│   ├── auth/                          # sign-in-form, reset-password-form, idle-warning-dialog, …
│   ├── shell/                         # user-menu, theme-toggle, skip-to-content, empty-state, error-state
│   └── layout/                        # staff-shell, member-shell
├── i18n/
│   ├── config.ts, request.ts          # next-intl
│   └── messages/{en,th,sv}.json       # en.json is canonical
├── lib/
│   ├── db.ts                          # Drizzle client singleton
│   ├── logger.ts                      # pino structured logger (forbidden fields: password, session id, tokens, Authorization)
│   ├── otel.ts                        # @vercel/otel setup
│   ├── env.ts                         # zod-validated process.env, runs at boot
│   └── result.ts                      # Result<T,E> helper for explicit error handling
└── middleware.ts

drizzle/migrations/                    # SQL migrations from drizzle-kit
tests/
├── contract/                          # One file per auth API endpoint
├── integration/auth/                  # Real Postgres (Docker), use cases end-to-end
├── unit/auth/                         # Domain + pure logic
└── e2e/                               # Playwright + axe-core; includes i18n coverage and reduced-motion specs
scripts/
├── seed-bootstrap-admin.ts            # One-off: first admin account (refuses if any admin exists)
└── check-i18n-coverage.ts             # CI: every auth key present in every locale
specs/<nnn-feature>/                   # Spec Kit artefacts — one dir per feature branch
```

**Cross-context imports MUST go through a module's public interface** — do not reach into a sibling's `domain/` or `application/`. Violations are blocked by ESLint `no-restricted-imports`.

## Clean Architecture enforcement (Principle III, NON-NEGOTIABLE)

- **Domain**: zero imports from `next`, `drizzle-orm`, `resend`, `@upstash/*`, `react`. Enforced by an ESLint `no-restricted-imports` rule scoped to `src/modules/*/domain/**`.
- **Application**: orchestrates Domain via its own port interfaces. No ORM, HTTP, framework, or React imports.
- **Infrastructure**: implements Application ports; Drizzle-inferred types live here and MUST NOT leak into Application or Domain.
- **Presentation**: calls Application use cases only; never touches Domain or Infrastructure directly.
- A deviation requires a line in `plan.md` § Complexity Tracking with the rejected simpler alternative.

## Commands

All commands below are current F1 commands from `package.json` (committed). **Use `pnpm`, not `npm`** — the lockfile is `pnpm-lock.yaml`. Dev and start both run on **port 3100** (port 3000 is reserved for other local Express projects on the primary dev workstation). Integration tests hit **live Neon Singapore** using `.env.local`, not a Docker container — the quickstart Docker note is historical.

Daily dev:

```bash
pnpm install
pnpm dev                       # Next.js dev with Turbopack on :3100
pnpm lint                      # ESLint; errors block merge
pnpm typecheck                 # tsc --noEmit under strict
pnpm test                      # Vitest run  (watch: pnpm test:watch)
pnpm test:coverage             # with Vitest coverage thresholds
pnpm test:integration          # against live Neon Singapore via DATABASE_URL from .env.local
pnpm test:e2e                  # Playwright, all suites
pnpm test:e2e --grep "@a11y"   # axe-core WCAG 2.1 AA scan only
pnpm test:e2e --grep "@i18n"   # locale coverage only
pnpm check:i18n                # fails on missing EN keys; warns (CI-blocks on release) on TH/SV
pnpm drizzle-kit generate      # generate migration from Drizzle schema
pnpm drizzle-kit migrate       # apply to $DATABASE_URL
pnpm build                     # production build
```

Full CI pipeline — reproduce locally before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e
```

Coverage thresholds (enforced in `vitest.config.ts`): Domain 100% line; Application 80% line + 80% branch; **100% branch on security-critical use cases** (sign-in, change-password, reset-password, role policy, sign-out).

One-off: bootstrap the first admin (safe to re-run — refuses if any admin exists):

```bash
BOOTSTRAP_ADMIN_EMAIL=first.admin@swecham.example pnpm tsx scripts/seed-bootstrap-admin.ts
```

Vercel workflow:

```bash
vercel link                         # link to swecham team
vercel env pull .env.local          # refresh local env from Vercel
vercel logs <deployment-url>        # function logs
vercel promote <old-deployment-url> # rollback production
```

Emergency write freeze: set `READ_ONLY_MODE=true` in Vercel env + redeploy — returns 503 `read-only-mode` on all state-changing `/api/**` routes while keeping sign-in and reads alive. Reversible in ~30 seconds without a code deploy. See quickstart § 7.3.

## Spec Kit workflow — the current primary daily workflow

All feature work flows through the 10 gates (Constitution § Development Workflow & Quality Gates):

`/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.checklist` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement` → `/speckit.verify` → `/speckit.review` → `/speckit.ship`

Each gate blocks the next until its exit criteria pass. Skipping requires a `plan.md` Complexity Tracking entry **and** ≥2 maintainer approvals. Auth, RBAC, payment, PII, audit log, and GDPR surfaces require **≥2 reviewers** at the Review gate, one of whom signs the security checklist (`security.md § 5` for F1).

Use `[Spec Kit]` prefix on commits that move a feature through a gate (`[Spec Kit] F1 spec + clarify`, `[Spec Kit] F1 tasks + close /speckit.analyze findings`, etc.). Conventional Commits are enforced by the commit-msg hook.

## Testing discipline (Principle II, NON-NEGOTIABLE)

- **TDD**: failing test → commit red → implement → commit green. Every user story in a spec MUST have ≥1 acceptance test authored before implementation starts.
- **Contract tests** at every external and inter-module boundary (`tests/contract/`).
- **Integration tests hit real Postgres** (Docker container on port 55432), not mocks — catches SQL, migration, and transaction bugs that mocks hide.
- A red test suite on `main` is a stop-the-line event — no new work until green.

## Conventions

- **Package manager**: pnpm (NOT npm). Lockfile `pnpm-lock.yaml`.
- **Commits**: Conventional Commits, enforced by commit-msg hook. Use `[Spec Kit]` prefix for Spec Kit workflow commits.
- **Branches**: one feature per branch (`nnn-feature-name`); spec directory name matches exactly (e.g. `001-auth-rbac`).
- **PR review**: ≥1 reviewer normal, **≥2 for security-sensitive** (auth, RBAC, payment, PII, audit log, GDPR surfaces). One of the two signs the security checklist.
- **Timestamps**: always store **ISO 8601 UTC (Gregorian)**. Thai Buddhist Era (BE = CE + 543) is **display-only** for `th-TH` user-facing surfaces. Mixing BE into storage is a ship blocker (off-by-543-years class).
- **Primary currency THB**; SEK/EUR/USD presentable where applicable. Thai tax invoices need VAT 7%, tax IDs on both parties, TH language, sequential tax-receipt numbering (F4 surface).

## Hosting deviation (documented in F1 plan § Complexity Tracking)

- Constitution says **Thailand primary**. F1 uses **Vercel `sin1` (Singapore) + Neon `ap-southeast-1` + Upstash Singapore** because no major cloud (AWS/GCP/Azure/Vercel) has a TH region. Nearest ≈25 ms from Bangkok.
- Thailand PDPA Section 28 cross-border provisions cover SG transfers. Swedish/EU member data subjects are covered by GDPR **standard contractual clauses (SCCs)** with Vercel and Neon.
- Revisit only if scale, regulation, or legal counsel demands true in-country residency — do not silently move to a Thai-local provider without amending this deviation.

## Secrets & confidential data

- **NEVER commit** `docs/*.xlsm` / `docs/*.xlsx` — the Excel workbooks contain SweCham member PII (~131 members / 164 contacts). Blocked by `.gitignore`; a leak triggers rotation + postmortem.
- Secrets live in **Vercel env vars only** (never `.env` in git), validated at boot by `src/lib/env.ts` (zod schema) — the app refuses to start with a missing/invalid env var.
- **Forbidden in logs**: plaintext passwords, session IDs, reset tokens, invitation tokens, `Authorization` headers, raw email bodies. CI lint rule blocks common mistakes. Hash user IDs in logs where cross-request correlation is needed.

<!-- The block below is regenerated by `.specify/scripts/powershell/update-agent-context.ps1`. -->
<!-- Do not hand-edit `## Active Technologies` or `## Recent Changes` — add durable guidance above this marker instead. -->

## Active Technologies
- TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) (001-auth-rbac, 002-membership-plans)
- `cmdk` — headless command palette primitive (F2, powers smart-chamber feature #4)
- `src/modules/tenants/` — cross-cutting Domain-only module hosting `TenantContext` branded type (F2+)
- `runInTenant(ctx, fn)` + Postgres RLS (`SET LOCAL app.current_tenant`) — tenant isolation pattern (F2+)
- `DEBUG_RLS_STATE` — dev-only assertion for tenant-context verification (F2+)
- 10 new audit event types: `plan_created`, `plan_updated`, `plan_cloned`, `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`, `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated` (F2)
- TypeScript 5.7+ (strict mode) / Node 22 LTS + Next.js 16 App Router, React 19, shadcn/ui (Sidebar, Sheet, Tooltip), Tailwind CSS v4, lucide-react, next-intl, next-themes (003-nav-menu)
- N/A — no database changes. Client-side localStorage for collapse preference. (003-nav-menu)
- TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`) — unchanged from F1 (004-page-layout-standard)
- N/A — no database changes. Client-side `localStorage` for sidebar collapse (existing from F3). (004-page-layout-standard)
- TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2 (005-members-contacts)
- `@tanstack/react-table@^8` — TanStack Table v8 for members directory (server-side pagination, sort, filter) (005-members-contacts)
- `i18n-iso-countries@^7` — ISO 3166-1 country code lookup on member create/edit form (005-members-contacts)
- `src/modules/members/` — F3 bounded context: Domain (MemberEntity, ContactEntity, value objects), Application (12 use-cases), Infrastructure (DrizzleMembersRepository, DrizzleContactsRepository) (005-members-contacts)
- 2 new DB tables `members` + `contacts` with pg_trgm GIN index, RLS+FORCE policies, `last_activity_at` SECURITY DEFINER trigger; migrations 0009 + 0010 (005-members-contacts)
- 23 new F3 audit event types: `member_created`, `member_updated`, `member_archived`, `member_undeleted`, `contact_added`, `contact_promoted`, `contact_removed`, `member_plan_changed`, `member_plan_override`, `member_status_changed`, `member_self_update`, `member_portal_view`, `member_email_change_requested`, `member_email_change_confirmed`, `member_email_change_reverted`, `member_invitation_sent`, `member_invitation_accepted`, `member_invitation_revoked`, `member_invitation_expired`, `member_session_invalidated`, `member_cross_tenant_probe`, `member_bulk_archive`, `member_bulk_status_change` (005-members-contacts)
- Smart chamber features shipped in F3: timeline (event feed), inline+bulk edit, at-risk detection logic (last_activity_at), archive+undelete with session/invitation cascade (005-members-contacts)
- WCAG 2.2 SC 2.4.11 (Focus Not Obscured) + SC 2.5.8 (Target Size ≥24×24px) opportunistic adoption via E2E assertions (005-members-contacts)
- TypeScript 5.7+ strict (existing F1–F4 config; no change) + Next.js 16 App Router, React 19, Tailwind CSS v4, shadcn/ui (no new deps) (006-layout-container-tier2)
- N/A (presentation-only) (006-layout-container-tier2)
- TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3 (007-invoices-receipts)
- `@react-pdf/renderer@4.3.0` (exact-pin) — deterministic bilingual PDF engine for Thai-tax documents (FR-016 / SC-003) (007-invoices-receipts)
- `@js-joda/core@^6` + `@js-joda/timezone@^2` — correct Asia/Bangkok fiscal-year boundary for sequential-number allocator (007-invoices-receipts)
- `thai-baht-text@^2` — Thai amount-in-words on invoices/receipts (007-invoices-receipts)
- `sharp@^0.34` — server-side logo re-encode (EXIF strip, MIME/dimension enforce) for tenant-invoice-settings (FR-034) (007-invoices-receipts)
- `fast-check@^4` (dev) — property-based testing for credit-note VAT sum invariant (007-invoices-receipts)
- Sarabun TTF (OFL) committed under `public/fonts/sarabun/` — 400/500/700 weights embedded into PDFs at build time (007-invoices-receipts)
- `src/modules/invoicing/` — F4 bounded context: Domain (Invoice, CreditNote, TenantInvoiceSettings, SequentialNumberAllocator), Application (use-cases), Infrastructure (react-pdf adapter, Vercel Blob adapter, Drizzle repos) (007-invoices-receipts)
- 5 new DB tables: `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences`; 16 new audit event types; Postgres advisory lock per (tenant_id, document_type, fiscal_year) for §87 no-gaps numbering (007-invoices-receipts)
- `FEATURE_F4_INVOICING` kill-switch + `BLOB_READ_WRITE_TOKEN` + `CRON_SECRET` env vars (007-invoices-receipts)
- TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3+F4 (009-online-payment)
- `stripe@^22` (server SDK, exact-minor pin) + `@stripe/stripe-js@^9` + `@stripe/react-stripe-js@^6` (client Elements) — Stripe Payment Intents + PromptPay QR + webhook signature verification (009-online-payment)
- `STRIPE_API_VERSION` env var pinning (FR-026 / Q5) + `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` + `STRIPE_WEBHOOK_SECRET` + `FEATURE_F5_ONLINE_PAYMENT` kill-switch (009-online-payment)
- `src/modules/payments/` — F5 bounded context: Domain (Payment, Refund, TenantPaymentSettings, ProcessorEvent aggregates), Application (initiate-payment, confirm-payment, fail-payment, cancel-payment, issue-refund, process-webhook-event, process-charge-refunded, sweep-stale-pending-refunds, list-succeeded-payment-methods, load-invoice-payment-activity), Infrastructure (Stripe gateway, drizzle repos, audit emitter) (009-online-payment)
- 4 new DB tables: `payments`, `refunds`, `tenant_payment_settings`, `processor_events`; 17 new audit event types (`payment_initiated`, `payment_succeeded`, `payment_failed`, `payment_canceled`, `payment_method_switched`, `payment_auto_refunded_stale_invoice`, `payment_auto_refunded_concurrent_manual_mark`, `payment_environment_mismatch`, `payment_cross_tenant_probe`, `out_of_band_refund_detected`, `webhook_signature_rejected`, `webhook_api_version_mismatch`, `tenant_payment_settings_updated`, `online_payment_toggled`, `refund_initiated`, `refund_succeeded`, `refund_failed`); migrations 0033–0050 (009-online-payment)
- `audit_log.retention_years SMALLINT NOT NULL DEFAULT 5` + CHECK `retention_years IN (5,10)` + F4 tax-document backfill (migration 0039) — 6 F4 event types backfilled to 10-year retention per Thai RD §87/3 + GDPR Art. 6(1)(c) (009-online-payment, R2-E4 Review-Gate blocker)
- Concurrent-initiate guard (three-layer): (1) partial unique index `payments_processor_payment_intent_id_uniq`; (2) tenant-filtered `SELECT … FOR UPDATE` on `payments(processor_payment_intent_id)` (CR-2 review 2026-04-27 explicit tenantId filter); (3) `pg_advisory_xact_lock(hashtextextended('payments:'||tenantId||':'||invoiceId, 0))` per-(tenant, invoice) added at staff-review R2 to close TOCTOU window before the FOR UPDATE row probe (auto-released at tx-end; namespace `payments:` is disjoint from F4 `invoicing:` so no contention with §87 numbering locks). Plus Stripe idempotency key `inv-{invoiceId}-attempt-{n}`. F5 advisory lock has different semantics from F4 (TOCTOU guard, NOT gap-free numbering). (009-online-payment)
- External cron-job.org HTTP trigger at `/api/internal/metrics/stale-pending-count` (5-min cadence, Bearer auth) — Vercel Hobby-plan-compatible alternative to native cron for `payments.stale_pending_count` gauge (009-online-payment)

## Recent Changes

- 009-online-payment: F5 Online Payment (Stripe + PromptPay) — 6 user stories (US1–US6) + Phase 9 polish across 9 phases. Added `src/modules/payments/` bounded context (4 aggregates, 10 use-cases), 4 new DB tables (`payments`, `refunds`, `tenant_payment_settings`, `processor_events`), 18 new migrations (0033–0050), 17 F5 audit event types, `audit_log.retention_years` column with F4 tax-document backfill (R2-E4 Review-Gate blocker — Thai RD §87/3 + GDPR Art. 6(1)(c) compliance). Card payments via Stripe Elements (SAQ-A scope preserved — Constitution Principle IV NON-NEGOTIABLE: zero card data on app server), PromptPay QR via Stripe PaymentIntents `next_action.promptpay_display_qr_code`. Webhook handler pinned to Node runtime for raw-body access; signature verification pre-parse; idempotent via `processor_events` upsert; API version pinned via `STRIPE_API_VERSION` env. F4 atomic reuse via `markPaidFromProcessor` + `issueCreditNoteFromRefund` barrel extensions — F5 does not re-implement F4 state machine, tax numbering, or PDF engine. Concurrent-initiate guard three-layer: partial unique index on `processor_payment_intent_id` + tenant-filtered `SELECT FOR UPDATE` + per-(tenant, invoice) `pg_advisory_xact_lock` for TOCTOU guard (added at staff-review R2; disjoint `payments:` namespace from F4 `invoicing:` §87-numbering locks) + `inv-{invoiceId}-attempt-{n}` Stripe idempotency key. Out-of-band refund detection (FR-011a) via `charge.refunded` webhook branch — no F4 CN, audit-only. External cron-job.org trigger for `payments.stale_pending_count` (Vercel Hobby plan compatible). 18 OTel metrics + 10 alert rules (T166 added 3 metrics + 1 alert) + full distributed trace `portal_click → api_payments_initiate → stripe_create_intent → webhook_receive → webhook_verify → f4_markpaid → receipt_email_enqueued`. Performance budgets: initiate p95 < 1.2s; webhook split SLO-F5-002a (canceled/failed p95 < 500ms prod) + SLO-F5-002b (succeeded post-T166 p95 < 1000ms dev / < 750ms prod — async-receipt-PDF migration 0056 + `FEATURE_F5_ASYNC_RECEIPT_PDF` flag, measured 859ms async vs 1657ms legacy = 48.2% p95 reduction). SAQ-A re-attestation pre-ship (security.md § 4 + saq-a-attestation.md § 5). Vercel Rolling Releases 10% → 50% → 100% with 30-min observation windows for first prod deploy. EN+TH+SV at release; WCAG 2.1 AA on all surfaces. Branch `009-online-payment` REVIEW-READY.
- 006-layout-container-tier2 (ad-hoc UI-infra, not canonical F5): three-tier content-type-based layout containers (`TableContainer` 96rem / `FormContainer` 42rem / `DetailContainer` 72rem) replacing single `ContentContainer`. 19 admin + portal routes migrated (each page + loading skeleton). `pnpm check:layout` script enforces every page/loading file imports exactly one container + page/loading pair uses SAME variant (FR-007 CLS-0). Wired into `.husky/pre-push` + full-CI chain. `docs/ux-standards.md` § 18 documents the Container Selection Guideline + Content-Type Mapping table. Legacy `content-container.tsx` + `--content-max-width-{admin,portal}` tokens removed. Bonus fixes: Tailwind v4 `@source not "specs/**" "docs/**"` prevents markdown example strings leaking into generated CSS; restored `mb-[var(--field-label-gap)]` on `Label` primitive (documented in `docs/shadcn-customizations.md` but missing from code); `admin.members.create.fields.phone` i18n dropped "(E.164)" jargon across 3 locales. 100% spec adherence, 0 constitution violations. PR #9.
- 005-members-contacts: F3 Members & Contacts — 7 user stories (US1–US7) + Phase 10 polish shipped across 10 phases. Added `src/modules/members/` bounded context, 2 new DB tables (`members`, `contacts`), migrations 0009+0010, pg_trgm GIN index (SC-002 p95=258ms < 500ms @ 5k rows), RLS+FORCE policies, SECURITY DEFINER trigger, 14/14 tenant-isolation integration tests (Constitution v1.4.0 Principle I Review-Gate), 23 F3 audit event types, TanStack Table v8 directory with server-side search/filter/sort, smart features (timeline, inline+bulk edit, command palette integration), archive+undelete with session/invitation cascade (US7), member self-service portal (US5), 722 i18n keys × 3 locales (EN+TH+SV), WCAG 2.2 AA opportunistic adoption (SC 2.4.11 + SC 2.5.8), full observability § 14 (12 metrics, 6 SLOs, 3 runbooks). Security/UX/a11y checklists 100% complete. Human-gated items pending: T155a manual SR pass, T156 co-sign, T158 staging traces.
- 004-page-layout-standard: F4 Page Layout Enterprise Standardization — PageHeader + ContentContainer + BreadcrumbNav primitives, 11 admin + portal pages migrated, Button 32→36px + cursor/disabled, typography scale (.text-h1–.text-h4 + .text-body + .text-caption) + Thai line-height override, universal focus ring, form/table/overlay token alignment. 12 new i18n keys (breadcrumb.* + layout.*), 24 new unit tests for layout primitives. `docs/shadcn-customizations.md` catalogues every primitive modification.
- 002-membership-plans: F2 Membership Plans — 6 user stories (US1–US6) shipped across 9 phases. Added `cmdk` command palette, `src/modules/tenants/` + `src/modules/plans/` bounded contexts, Postgres RLS tenant isolation, 2 new DB tables (`membership_plans`, `tenant_fee_config`), migrations 0006 + 0007, 268 i18n keys (EN+TH+SV), 495 unit+contract tests, 163 integration tests on live Neon Singapore. US7 (Inline Edit + Bulk Actions) deferred to F3.
- 001-auth-rbac: F1 Auth & RBAC shipped via PR #1. 188/191 tasks, 480/480 tests.

Last updated: 2026-04-27 (009-online-payment Phase 9 — review-ready)
