# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Project**: **Chamber-OS** — a SaaS membership management platform for chambers of commerce and membership organisations. **SweCham / TSCC (Thailand-Swedish Chamber of Commerce)** is the first tenant, deployed at `swecham.zyncdata.app`. The platform is designed as **Multi-Tenant Aware, Single-Tenant Deployed (MTA+STD)** — F1 shipped single-tenant; F2 onwards use `tenant_id`-scoped schemas so future tenants can be onboarded without schema migration. See `docs/saas-architecture.md` for the multi-tenant strategy.

**Scope**: Chamber-OS is the **membership management backend + admin portal + member self-service portal**. It is NOT a public website / CMS — tenants are expected to have their own public sites.

**Folder name caveat**: the directory is historically `Swedish chaplain_membership`. "chaplain" is a typo for "chamber". Refer to the product as **Chamber-OS** (platform) or **SweCham / TSCC** (first tenant), never "chaplain". Rename is tracked as R6 in `docs/phases-plan.md` (manual action — cannot be done from inside the active working directory).

**Repository status (as of 2026-04-11)**: **F1 (Auth & RBAC) is SHIP-READY on branch `001-auth-rbac`**. 188/191 tasks shipped; the 3 remaining checkboxes are documented deferrals to `/speckit.ship` release QA (T167 superseded by Lighthouse CI, T181 Vercel dashboard panels, T187 staging quickstart walk-through). Test suite state: **480/480 green** = 288 unit+contract + 82 integration vs live Neon Singapore + 113 passed + 1 flaky + 3 intentional skips of 117 Playwright E2E runs across chromium/mobile-chrome/mobile-safari. 6 `/speckit.review` passes + 2 `/speckit.staff-review` rounds closed all findings. `security.md § 5` checklist 13/13 PASS (co-signed by staff-review agent + solo maintainer). Vercel production env vars confirmed (`APP_BASE_URL`, `APP_ALLOWED_ORIGINS`, `RESEND_FROM_EMAIL` all point at `swecham.zyncdata.app`). `src/`, `drizzle/migrations/` (0000-0005 applied), `tests/`, `scripts/`, and `package.json` all exist and are current. Retrospective at `specs/001-auth-rbac/retrospective.md` reports 100% spec adherence. Next Spec Kit gate: **`/speckit.ship`**. F2–F9 are still in planning and have no source code yet — do not assume files exist outside of `src/modules/auth/**` + the Auth presentation surfaces listed in `specs/001-auth-rbac/plan.md`.

## Language for AI sessions

User prefers **Thai** for conversational turns. Code, specs, commit messages, and technical docs remain in **English** (for international collaborators and long-term stability).

## Governance — read before proposing architecture changes

- `.specify/memory/constitution.md` — **v1.3.1** (amended 2026-04-11; v1.3.0 added F1 lessons-learned, v1.3.1 PATCH clarifies that solo-maintainer exemption also covers the no-direct-push rule), authoritative. 10 principles (4 NON-NEGOTIABLE: Data Privacy & Security, Test-First, Clean Architecture, PCI DSS) plus 6 Core (i18n, Inclusive UX, Perf & Observability, Reliability, Code Quality, Simplicity). Principle III requires every `src/modules/*` module to ship a public barrel + ESLint `no-restricted-imports` rule. Principle IX + Gate 9 + § Governance + § Development Workflow Additional rules carry a **solo-maintainer substitute** clause for the default ≥2-reviewers + no-direct-push rules, applicable when no second human reviewer is available. Amendments go through a PR with ≥2 maintainer approvals (or the solo-maintainer substitute) + a Sync Impact Report.
- Every `/speckit.plan` runs a **Constitution Check** against all 10 principles. Any deviation lives in `plan.md` § Complexity Tracking with a rejected simpler alternative — unjustified violations block the gate.
- The escape clause that allows Singapore hosting (Constitution § Compliance: Hosting & Residency) is used by F1. See `specs/001-auth-rbac/plan.md` Complexity Tracking.

## Key project docs (read in this order for context)

1. `.specify/memory/constitution.md` — principles and quality gates (v1.3.1, may need v1.4.0 MINOR bump for explicit tenant-isolation under Principle I — pending governance decision)
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
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:integration && pnpm test:e2e
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
- TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`) — unchanged from F1 (002-membership-plans)

- TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`) (001-auth-rbac)

## Recent Changes

- 001-auth-rbac: Added TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`)

Last updated: 2026-04-11
