# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Project**: **Chamber-OS** — a SaaS membership management platform for chambers of commerce and membership organisations. **SweCham / TSCC (Thai-Swedish Chamber of Commerce)** is the first tenant, deployed at `swecham.dxtspace.com`. The platform is designed as **Multi-Tenant Aware, Single-Tenant Deployed (MTA+STD)** — F1 shipped single-tenant; F2 onwards use `tenant_id`-scoped schemas so future tenants can be onboarded without schema migration. See `docs/saas-architecture.md` for the multi-tenant strategy.

**Scope**: Chamber-OS is the **membership management backend + admin portal + member self-service portal**. It is NOT a public website / CMS — tenants are expected to have their own public sites.

**Folder name caveat**: the directory is historically `Swedish chaplain_membership`. "chaplain" is a typo for "chamber". Refer to the product as **Chamber-OS** (platform) or **SweCham / TSCC** (first tenant), never "chaplain". Rename is tracked as R6 in `docs/phases-plan.md` (manual action — cannot be done from inside the active working directory).

**Repository status (as of 2026-07-28)**: **F1–F9 SHIPPED + member-number (055, PR #70) SHIPPED — SweCham/TSCC is LAUNCHING (prod live with real members + money; money/tax paths are live-stakes).** F1 Auth & RBAC (PR #1) · F2 Membership Plans · F3 Members & Contacts · F4 Invoices & Receipts · F5 Online Payment / Stripe + PromptPay (PR #16) · F6 EventCreate Integration (PR #26, flag-flipped to production 2026-05-19) · F7 Email Broadcast / E-Blast (PR #23) · F8 Renewal Tracking + Smart Reminders (PR #24). Member numbers (055, PR #70): per-tenant `SCCM-NNNN` surfaced across the Members directory, command palette, portal badge, and F4 tax PDFs. **As of 2026-07-28: auto-invoice on payment + void-on-reissue are SHIPPED** (#261–#263 — migration `0281` adds `coverage_from/to` + a GiST EXCLUDE guard; 3 env flags ON in prod + tenant `auto_invoice_enabled`); most recent work = renewals urgency pill/tabs aligned to true benefit-access (#266–#268) + invoices filter UX redesign (#264–#265). Migrations are at `0296` (current — this number is kept live, unlike the rest of this dated paragraph; 0294–0296 applied to prod 2026-09-06 on the deploy of PR #344). Still in flight: observability / env-boot / go-live-readiness hardening, money-remediation residuals, plan-change billing Phase 2. (Run `git branch --show-current` for the live branch — feature branches rotate faster than this doc, so this section names the workstream, not a branch.) The **F9 launch gate is CLEARED** — `015-admin-dashboard` merged to `main` (PR #29, `1056d5a2`, 2026-05-31). `docs/go-live-readiness.md` (the master launch plan) locks launch scope at F1–F9 (all merged); remaining work is operational/data readiness + flag-flips, NOT feature work. See § Recent Changes for full per-feature provenance and the human-gated residuals on each feature. Source modules: `src/modules/auth/**` (F1) · `src/modules/tenants/**` + `src/modules/plans/**` (F2) · `src/modules/members/**` (F3) · `src/modules/invoicing/**` (F4) · `src/modules/payments/**` (F5) · `src/modules/events/**` (F6) · `src/modules/broadcasts/**` (F7/F7.1) · `src/modules/renewals/**` (F8) · `src/modules/insights/**` (F9 — admin dashboard, audit viewer, timeline, benefit usage, directory + E-Book/JSON export; shipped PR #29) · presentation in `src/app/(staff)/admin/**` + `src/app/(member)/portal/**` + `src/components/layout/**`.

## Language for AI sessions

User prefers **Thai** for conversational turns. Code, specs, commit messages, and technical docs remain in **English** (for international collaborators and long-term stability).

## Governance — read before proposing architecture changes

- `.specify/memory/constitution.md` — **v1.4.2** (current), authoritative. v1.4.0 (MINOR, 2026-04-11) added explicit SaaS tenant-isolation requirements under Principle I with 5 sub-clauses (app-layer, db-layer, integration test, audit, super-admin); v1.4.1 + v1.4.2 are PATCH amendments (solo-maintainer co-sign footer-template precedent — no principle added, removed, or redefined). 10 principles (4 NON-NEGOTIABLE: Data Privacy & Security, Test-First, Clean Architecture, PCI DSS) plus 6 Core (i18n, Inclusive UX, Perf & Observability, Reliability, Code Quality, Simplicity). Principle I now requires **two-layer tenant isolation** (application + database) with a mandatory cross-tenant integration test as a Review-Gate blocker. Principle III requires every `src/modules/*` module to ship a public barrel + ESLint `no-restricted-imports` rule. Principle IX + Gate 9 + § Governance + § Development Workflow Additional rules carry a **solo-maintainer substitute** clause for the default ≥2-reviewers + no-direct-push rules, applicable when no second human reviewer is available. Amendments go through a PR with ≥2 maintainer approvals (or the solo-maintainer substitute) + a Sync Impact Report.
- Every `/speckit.plan` runs a **Constitution Check** against all 10 principles. Any deviation lives in `plan.md` § Complexity Tracking with a rejected simpler alternative — unjustified violations block the gate.
- The escape clause that allows Singapore hosting (Constitution § Compliance: Hosting & Residency) is used by F1. See `specs/001-auth-rbac/plan.md` Complexity Tracking.

## Key project docs (read in this order for context)

1. `.specify/memory/constitution.md` — principles and quality gates (v1.4.2; SaaS tenant-isolation requirements under Principle I added in v1.4.0)
2. `docs/phases-plan.md` — **10 core + 4 SaaS = 14 features** across 5 phases. Includes 6 resolved decisions (SV+EN+TH locales, TH-primary hosting, Stripe, 3 roles, no day-1 Excel migration, folder rename) + 2026-04-11 SaaS pivot update + scope boundary vs `swecham.com`.
3. `docs/saas-architecture.md` — **multi-tenant strategy (MTA+STD)**, Postgres RLS, auth model (cross-tenant users, tenant-scoped membership), billing layers, white-label scope, migration path, pricing vision. Read this before designing any F2+ feature.
4. `docs/membership-benefits-analysis.md` — authoritative 2026 Membership Package tier data from the PDF (6 corporate + 3 partnership tiers, full benefit matrix, data model, Q1–Q5 for F2 clarify). **Supersedes the deleted `docs/database-analysis.md`** which was Excel-derived and inaccurate.
5. `docs/event-integration-analysis.md` — F6 EventCreate integration strategy (Zapier webhook → attendee import → benefit quota). No CRUD event management — we use EventCreate externally.
6. `docs/email-broadcast-analysis.md` — F7 Email Broadcast / E-Blast system (paid benefit delivery via Resend Broadcasts API). New feature added to fill the critical gap for E-Blast quota delivery.
7. `docs/smart-chamber-features.md` — **21 smart chamber features catalogued** (6 in MVP: benefit dashboard, at-risk detection, smart renewal, command palette, inline+bulk, timeline; 15 post-MVP: undo, NL search, saved filters, CSV import, realtime, engagement score, auto-upgrade suggestions, activity feed, compliance tracker, proactive alerts, public directory widget, GDPR export).
8. `docs/ux-standards.md` — enterprise UX playbook (shimmer skeletons, toasts, confirmation dialogs, idle warning, theming, keyboard & focus management). F1 auth screens MUST pass the § 15 checklist before merge.
9. `docs/observability.md` — metrics, SLOs, alerts, log schema
10. `specs/001-auth-rbac/` — F1 feature bundle (shipped via PR #1)
11. `docs/go-live-readiness.md` — **master launch plan** (F1–F9 launch scope, all merged; F9 gate CLEARED — remaining = operational readiness + flag-flips); `docs/code-conventions.md` + `docs/ux-patterns.md` — coding + UX conventions added post-MVP

**Note**: `docs/database-analysis.md` was **deleted 2026-04-11** — it was Excel-derived and known to be inaccurate after the 2026 Membership Package PDF was provided. The reusable analyzer script lives at `.specify/scripts/analyze_excel.py`. Git history preserves the old content.

## F1 reference — Auth & RBAC (`001-auth-rbac`, shipped PR #1)

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
- **Payments**: Stripe `^22` + Elements / Payment Intents (SAQ-A preserved) + PromptPay QR — **live in prod** (F5, PR #16). `STRIPE_API_VERSION` is env-pinned.
- **Testing**: Vitest + Playwright + `@axe-core/playwright` (WCAG 2.1 AA) + MSW + `@testing-library/react`
- **Observability**: `pino` JSON logs + `@vercel/otel` traces + Vercel Analytics / Speed Insights
- **Hosting**: Vercel (`sin1` Singapore) — documented deviation from "Thailand primary" (no major cloud has a TH region)

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
└── proxy.ts                           # Next.js 16 renamed middleware→proxy — there is NO src/middleware.ts.
                                       # session lookup + route guards + CSRF Origin allow-list + HSTS
                                       # + per-request nonce header + tenant header

drizzle/migrations/                    # HAND-WRITTEN SQL from 0019 onwards + meta/_journal.json (see Gotchas)
docs/runbooks/                         # ~60 incident runbooks (cron-jobs, db-environment-branching, void-on-reissue, …)
tests/
├── contract/                          # One file per API / inter-module boundary
├── integration/<module>/              # Real Postgres (live Neon `dev` branch), use cases end-to-end
├── unit/<module>/                     # Domain + pure logic (+ unit/architecture/ barrel guards)
├── e2e/                               # Playwright + axe-core; includes i18n coverage and reduced-motion specs
└── helpers/, stubs/, support/, load/  # shared fixtures, test doubles, k6/perf harnesses
scripts/
├── seed-bootstrap-admin.ts            # One-off: first admin account (refuses if any admin exists)
└── check-i18n-coverage.ts             # gate: every key present in every locale (pnpm check:i18n)
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

All commands below are current F1 commands from `package.json` (committed). **Use `pnpm`, not `npm`** — the lockfile is `pnpm-lock.yaml`. Dev and start both run on **port 3100** (port 3000 is reserved for other local Express projects on the primary dev workstation). Integration tests hit **live Neon Singapore** using `.env.local` (which now points at the **`dev` Neon branch**, isolated from prod — see Gotchas), not a Docker container.

Daily dev:

```bash
pnpm install
pnpm dev                       # Next.js dev with Turbopack on :3100
pnpm lint                      # ESLint; errors block merge
pnpm typecheck                 # tsc --noEmit under strict
pnpm test                      # Vitest run  (watch: pnpm test:watch)
pnpm test:coverage             # with Vitest coverage thresholds
pnpm test:integration          # live Neon DEV branch via DATABASE_URL from .env.local (guarded off prod)
pnpm test:e2e                  # Playwright, all suites
pnpm test:e2e --grep "@a11y"   # axe-core WCAG 2.1 AA scan only
pnpm test:e2e --grep "@i18n"   # locale coverage only
pnpm check:i18n                # fails on missing EN keys; warns (CI-blocks on release) on TH/SV
# pnpm db:generate             # DO NOT USE — snapshots stop at 0018; migrations are hand-written SQL (see Gotchas)
pnpm db:migrate                # apply to the DEV branch (.env.local); prod auto-migrates on deploy (vercel-build)
pnpm db:verify                 # assert the live schema matches expectations (prod: pnpm db:verify:prod)
pnpm build                     # production build
```

Full gate list — run this before shipping anything non-trivial. CI runs: `quality-gates.yml` (`lint` + `next typegen` + `typecheck` + `check:i18n`/`layout`/`fixme`/`dates`/`env-example`/`env-boot` + the unit+contract suite sharded ×2 + the single-leg `RBAC contract` job), `architecture-guards`, **`integration-smoke.yml` (tenant isolation + money invariants, against a disposable Neon branch — this one is REQUIRED on `main`)**, plus the full instrumented coverage run (`coverage-nightly.yml` — blocking on every PR since 2026-08-14, also nightly as the direct-push tripwire), nightly F7+F8 multi-tenant readiness, a nightly integration sweep, template-seed drift, and Neon preview cleanup. **e2e still has no CI job** — it remains local-only, so budget >1 h end-to-end here:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:template-seed && pnpm check:money-recipient && pnpm test:integration && pnpm test:e2e
```

Pre-push (**~50 s**) runs eleven static gates — `check:layout` + `check:template-seed` + `check:fixme` + `check:dates` + `check:env-example` + `check:env-boot` + `check:money-recipient` (108 — every money email addresses the LIVE primary contact, never the frozen snapshot) + the four RBAC/audit-truth gates `check:staff-page-guard` + `check:api-route-guard` + `check:authorization-role-reads` + `check:actor-role-truth` (14 s for the four, measured) — then `tests/unit/architecture/` (24 s — the settlement-tx money guard), plus **two conditional integration gates**: the per-module one when `src/modules/<m>/**` is touched, and an **API-route gate** when `src/app/api/**/route.ts` is touched, which runs the integration tests that IMPORT that route (matched on the literal `@/app/api/.../route` import path, not on a name heuristic — `[id]` is a glob character class and prefix matching paired routes with unrelated suites). On the FIRST push of a branch the diff baseline is `merge-base origin/main HEAD`, i.e. everything the branch adds — it used to be `HEAD~1`, so a 39-commit branch that rewrote `src/modules/invoicing` pushed with the hook printing "no src/modules/* changes" and a broken cron rode along for the whole branch. Emergency override: `SKIP_INTEGRATION_PREPUSH=1 git push`; if you use it, run the touched risk surface manually and disclose it in the PR. The 190-file `tests/contract/` run moved to CI; run it locally with `pnpm vitest run tests/contract/` (~4.3 min) before opening a PR. Additional `check:*` gates available (NOT in pre-push): `check:strict-aria`, `check:audit-events`, `check:audit-counts`, `check:bundle-budgets`, `check:multi-tenant`, `check:portal-guard`, `check:plan-divergence`, `check:f71a-schema`, `check:f9-schema`.

Coverage thresholds (enforced in `vitest.config.ts`): Domain 100% line; Application 80% line + 80% branch; **100% branch on security-critical use cases** (sign-in, change-password, reset-password, role policy, sign-out).

One-off: bootstrap the first admin (safe to re-run — refuses if any admin exists):

```bash
BOOTSTRAP_ADMIN_EMAIL=first.admin@swecham.example pnpm db:seed-admin
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

Dispatch the **24 project subagents in `.claude/agents/`** (`chamber-os-architect`, `financial-integrity-reviewer`, `thai-tax-compliance-auditor`, `senior-tester`, `enterprise-ux-designer`, `security-engineer`, …) for gate work — not `general-purpose`. Any UI-touching task or PR also gets an `enterprise-ux-designer` pass. File-mutating agents run **sequentially**; read-only reviewers may run concurrently.

Use `[Spec Kit]` prefix on commits that move a feature through a gate (`[Spec Kit] F1 spec + clarify`, `[Spec Kit] F1 tasks + close /speckit.analyze findings`, etc.). Conventional Commits are enforced by the commit-msg hook.

## Testing discipline (Principle II, NON-NEGOTIABLE)

- **TDD**: failing test → commit red → implement → commit green. Every user story in a spec MUST have ≥1 acceptance test authored before implementation starts.
- **Contract tests** at every external and inter-module boundary (`tests/contract/`).
- **Integration tests hit real Postgres** (local dev: live Neon Singapore `dev` branch via `DATABASE_URL` in `.env.local`; in CI via `integration-smoke.yml` on every PR — required on `main` — plus the nightly F7+F8 readiness workflow and a nightly integration sweep, against disposable / `CI_DATABASE_URL` Neon branches), not mocks — catches SQL, migration, and transaction bugs that mocks hide. Run with `pnpm test:integration` (config `vitest.integration.config.ts`); the historical "Docker on port 55432" note is superseded.
- A red test suite on `main` is a stop-the-line event — no new work until green.

## Conventions

- **Package manager**: pnpm (NOT npm). Lockfile `pnpm-lock.yaml`.
- **Commits**: Conventional Commits, enforced by commit-msg hook. Use `[Spec Kit]` prefix for Spec Kit workflow commits.
- **Branches**: one feature per branch (`nnn-feature-name`); spec directory name matches exactly (e.g. `001-auth-rbac`).
- **PR review**: ≥1 reviewer normal, **≥2 for security-sensitive** (auth, RBAC, payment, PII, audit log, GDPR surfaces). One of the two signs the security checklist.
- **`main` is protected** (since 2026-07-28): **6** required status checks — `Lint · typecheck · static gates`, `Unit + contract (shard 1/2)`, `(shard 2/2)`, `Architecture governance tests`, `Integration smoke (tenant isolation + money invariants)`, and (since 2026-08-14) `Unit + contract coverage vs pinned thresholds` — the full instrumented coverage run (~30-40 min), so the coverage pins in `vitest.config.ts` gate every merge; it also still runs nightly as the direct-push tripwire. The integration-smoke requirement means a PR that breaks `pnpm db:migrate` against a fresh Neon branch cannot merge — 016's Migration C hit exactly that. No required reviewers (solo-maintainer substitute), `enforce_admins: false` so an admin can still override for a hotfix; force-push and branch deletion are blocked. Verify the live list with `gh api repos/Jirawatpyk/Swedish-chaplain_Membership/branches/main/protection --jq '.required_status_checks.contexts'` rather than trusting this line.
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

## Gotchas (hard-won, recurring)

- **Tenant-scoped repos MUST thread `tx` from `runInTenant`, never the global `db` singleton.** A repo method on a `tenant_id`-scoped table that reaches for the pool-global `db` gets a fresh connection without `SET LOCAL app.current_tenant`, silently bypassing RLS (it can read/write across tenants and the RLS+FORCE policies won't save you). Every query inside a `runInTenant(ctx, async (tx) => …)` block must use that `tx`. (F7.1a US2 incident, 2026-05-20.)
- **Apply the migration + run integration tests before committing schema changes.** When a commit adds a new Drizzle migration *and* code that references the new enum/column, run `pnpm drizzle-kit migrate` then `pnpm test:integration` first. Unit-test mocks hide the schema gap — the failure only surfaces against live Neon. (F4 R8 incident, 2026-05-15.)
- **Buddhist Era is display-only.** Storing BE (CE + 543) anywhere in the DB is an off-by-543-years ship blocker — see § Conventions.
- **`db:generate` is abandoned — migrations 0019+ are HAND-WRITTEN SQL.** Drizzle snapshots stop at `0018`, so `drizzle-kit generate` cannot produce a correct diff (it also blocks on a TTY prompt). Write the `.sql` file by hand and register it in `drizzle/migrations/meta/_journal.json`; apply with `pnpm db:migrate` (`scripts/run-migrations.ts`).
- **A duplicate `when` timestamp makes `db:migrate` a silent no-op** — it prints "✓ applied" while applying nothing. Verify the DDL landed via `information_schema`, then bump `when` by +100000 ms. When two branches add migrations in parallel, merge the other branch first and renumber yours.
- **`pnpm test:integration -- <pattern>` runs the WHOLE suite (~40 min).** Pass the file PATH positionally instead: `pnpm test:integration tests/integration/renewals/foo.test.ts`. Running a whole 80-file folder dies around "Worker exited" — batch it.
- **`pnpm typecheck` is in NO gate** (not pre-push, not CI). Run it as the final step after the last edit, before committing — and run full `pnpm lint` too, it catches errors typecheck + vitest miss.
- **Never run `pnpm format` / `prettier --write`** even though the script exists — it reformats unrelated files. Hand-format to match the surrounding code.
- **All cron triggers are native Vercel Cron** (`vercel.json`, 40+ jobs) since the 2026-07-17 Pro migration: **UTC-only** (Asia/Bangkok schedules are −7 h) and invoked with **GET**, so POST handlers need `export const GET = POST`. cron-job.org is a paused standby — any "cron-job.org external" note in § Active Technologies below is superseded. See `docs/runbooks/cron-jobs.md`.
- **DB is Neon-branched: `pnpm db:migrate` → the `dev` branch, NOT prod (since 2026-06-23).** `.env.local` points at the `dev` Neon branch (prod backup: `.env.local.bak.prod`, gitignored). Prod + preview migrate **automatically on Vercel deploy** via the `vercel-build` script (`run-migrations.ts && next build`); manual prod = `pnpm db:migrate:prod` (`.env.production`). Integration tests **refuse to run against prod** (guard in `tests/integration-setup.ts` keyed on `TEST_DB_HOST_BLOCKLIST`). Branches: `main`=prod · `dev`=local/tests · `preview/*`=per-PR (auto). Full map: `docs/runbooks/db-environment-branching.md`.

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
- `/api/internal/metrics/stale-pending-count` (5-min cadence, Bearer auth) emits the `payments.stale_pending_count` gauge — **native Vercel Cron** since the 2026-07-17 Pro migration (`vercel.json`; previously an external cron-job.org trigger on Hobby) (009-online-payment)
- F7 Email Broadcast (`010-email-broadcast`, shipped via PR #23) — full provenance in `specs/010-email-broadcast/`. Key tech additions:
  - **Stack**: Tiptap@3.22.5 (pin) + isomorphic-dompurify@2.36.0 (pin) + email-validator@^2 + @tanstack/react-virtual@^3
  - **Resend Broadcasts API surface** — separate from F1+F4 transactional (separate suppression list + webhook endpoint + reputation pool). Webhook pinned to Node runtime for Svix HMAC raw-body verify.
  - **Env**: `RESEND_BROADCASTS_API_KEY` + `RESEND_BROADCASTS_WEBHOOK_SECRET` + `UNSUBSCRIBE_TOKEN_SECRET` (≥32 bytes; distinct from `AUTH_COOKIE_SIGNING_SECRET`) + `BROADCASTS_FROM_EMAIL` + `FEATURE_F7_BROADCASTS` (default false; ships dark) + optional `TENANT_PRIVACY_POLICY_URL` + `TENANT_WEBSITE_URL`
  - **Bounded context**: `src/modules/broadcasts/` — 4 aggregates (Broadcast / BroadcastDelivery / MarketingUnsubscribe / RecipientSegment) + ~20 use-cases.
  - **DB**: 4 new tables + 2 columns on F3 `members` + 22 migrations (0064–0085) + 43 audit event types (5y retention default).
  - **Concurrency**: per-(tenant, broadcast) `pg_advisory_xact_lock('broadcasts:'+tid+':'+bid)` — namespace disjoint from F4 `invoicing:` and F5 `payments:`.
  - **Sanitiser allowlist** (FR-002a): `p`/`br`/`strong`/`em`/`u`/`a[href]`/`ul`/`ol`/`li`/`h1-h4`/`blockquote`/`hr`. **No `<img>`** (tracking-pixel — F7.1). URL schemes `http`/`https`/`mailto`. Subject ≤200 / body ≤200 KB. Application-layer; raw body never persisted.
  - **Cap**: 5,000 recipients/broadcast (submit + dispatch defence-in-depth). Pagination >5k → F7.1.
  - **Quota**: reserve@submitted, consume@sending→sent. `currentQuotaYear` uses tenant TZ.
  - **State machine**: cancellable until `approved`; immutable after submit (DB trigger `broadcasts_immutable_after_submit_fn`).
  - **Cron-job.org externals** (4 endpoints, all Bearer `CRON_SECRET`, retry-OFF): dispatch-scheduled */5 + reconcile-stuck-sending */15 + prune-expired-drafts daily + broadcasts-gauges */5. See `docs/runbooks/cron-jobs.md`.
  - **F6 EventAttendees stub-port**: F7 ships stub returning `[]`; F6 swaps in real impl at F6 ship.
  - **SLO budgets** (UNVERIFIED until T215 prod RUM): compose TTFB <600ms · submit <1.2s · queue <500ms @ 1k · approve&send <1.5s · webhook <250ms · unsubscribe <400ms.
  - **Audit event taxonomy**: see `src/modules/broadcasts/application/ports/audit-port.ts:32-97` for canonical 43-event list.
- TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3+F4+F5+F7 (011-renewal-reminders)
- TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3+F4+F5+F7+F8 (012-eventcreate-integration)
- TypeScript 5.7+ strict (unchanged from F1–F8) — `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` + Next.js 16 App Router · React 19 · Drizzle ORM · `@vercel/blob` (already used by F4 invoice PDF) · existing F6 Phase 7 streaming parser (`src/modules/events/infrastructure/streaming-csv-importer.ts`) · `i18n-iso-countries` (F3) · `react-hook-form` + `zod` for the event-picker form. **Zero new npm dependencies** (Constitution X). (012-eventcreate-integration)
- Neon Postgres `ap-southeast-1` (Singapore) — 1 new table `csv_import_records` + extension columns on existing `event_registrations` (per row attendee_pdpa_consent_text). Vercel Blob private bucket for error-rows CSV (TTL-swept). No payment data touched (Principle IV n/a). (012-eventcreate-integration)
- TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1–F8. (014-email-broadcast-advance)
- TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, + Next.js 16 App Router · React 19 · Drizzle ORM · next-intl (015-admin-dashboard)
- Neon Postgres `ap-southeast-1` + Drizzle. **4 new tables** (015-admin-dashboard)
- TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); Node 22 LTS + Next.js 16 App Router · React 19 · Drizzle ORM · `@react-pdf/renderer` (deterministic PDF) · `@js-joda/core`+`timezone` (Asia/Bangkok fiscal year) · `thai-baht-text` · `stripe` (payment path — passthrough only) · next-intl. **Zero new npm dependencies** (Constitution X). (088-invoice-tax-flow-redesign)
- Neon Postgres `ap-southeast-1` (Drizzle) + Vercel Blob (PDF artifacts). New DDL: `document_type` enum `+= 'bill'`; `invoices.bill_document_number_raw` + partial unique index; `members.is_head_office` + `branch_code`; `tenant_invoice_settings.wht_note_th/_en` + `seller_is_head_office` + `seller_branch_code`; amended CHECK constraints on `invoices`. (088-invoice-tax-flow-redesign)
- TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); Node 22 LTS + Next.js 16 App Router · React 19 · Drizzle ORM · next-intl. **Zero new npm dependencies** (Constitution X). (016-rbac-permissions)
- Neon Postgres `ap-southeast-1` (Drizzle). **No new tables, no column drops.** DDL: role pgEnum `+= 'super_admin','marketing'` · audit_event_type `+= 'permission_denied'` · `users_last_admin_guard()` UNION→strict rewrite · Migration C = operator-gated data-only promotion. Permission catalogue + `ROLE_BUNDLES` as pure Domain data in `src/modules/auth/domain/permissions/`; single-leg evaluator since PR 5 — the `FEATURE_RBAC_V2` flag and the legacy shim are deleted. (016-rbac-permissions)
- TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); Node 22 LTS + Next.js 16 App Router · React 19 · Drizzle ORM · next-intl · shadcn/ui `Switch`. **Zero new npm dependencies** (Constitution X). (108-contact-recipient-rules — **PR-A MERGED 2026-09-05, PR #340; PR-B MERGED 2026-09-05, PR #342; PR-D MERGED 2026-09-06, PR #344 `a586351cd`** (US4 staff marketing state + `/admin/marketing/audience`, US6 portal self-toggle; the opt-out is honoured at dispatch across every segment kind); PR-C still planned)
- Neon Postgres `ap-southeast-1` (Drizzle, hand-written SQL). **PR-A shipped migration `0292`** (`audit_event_type += 'auto_email_skipped_no_recipient'`, enum-only, applied to dev) plus `scripts/check-money-email-recipient.ts` wired into pre-push + `quality-gates.yml`. **PR-B shipped migration `0293`** (`contacts_check_member_primary()` SECURITY DEFINER with `row_security = off` + two DEFERRABLE INITIALLY DEFERRED constraint triggers + a deploy-failing pre-check; predicate narrowed by spec AMENDMENT to members with ≥ 1 contact row — see `specs/108-contact-recipient-rules/reviews/pr-b.md`, four review rounds, 61 findings). **PR-D (merged #344) shipped migrations `0294`** (`contacts` +3 nullable marketing opt-out columns `marketing_opt_out_{at,source,by_user_id}` + correlated CHECK + partial index), **`0295`** (`audit_event_type += contact_marketing_opted_out / contact_marketing_opted_in`) **and `0296`** (`contacts_tenant_lower_email_all_idx (tenant_id, lower(email), created_at DESC)`, non-partial — serves the self-opt-out carry-forward that must see removed rows), all applied to prod on deploy; permission key `contacts.marketing` (catalogue 42 keys; admin / super_admin / marketing — never manager); `MembersBridgePort.filterMarketingOptedOut` drops opted-out addresses from every segment at dispatch (fail-closed), metric `broadcasts_marketing_opt_out_filter_count`. Remaining planned DDL for PR-C: `marketing_unsubscribes.contact_id` · optional `broadcast_audience_members` working table; temporary flag `FEATURE_CONTACT_MARKETING_RECIPIENTS`. Money emails resolve the live primary contact via the widened `RecipientLocalePort`; F5 gets a `BillingRecipientPort`. (108-contact-recipient-rules)

## Recent Changes

Full per-feature provenance (F1–F8 + every F7.1a/b review round) is archived in [`docs/changelog.md`](docs/changelog.md). Rolling summary:

- **actor-role truth sweep CLOSED (#332–#335) + two dormant PRs from June landed (#336/#337), 2026-08-17.** The invariant now holds with no exceptions: **no `audit_log` row states a role its actor did not hold.** It took five rounds because each fix's blind spot caused the next — a hardcoded staff-role literal in an `actorRole:` position is invisible to `tsc` and lands in an append-only table. #333: the pre-auth kill-switch stamps `'system'` instead of a fabricated `'admin'`. #334: codebase-wide sweep + a permanent gate, `pnpm check:actor-role-truth` (`scripts/check-actor-role-truth.ts`, in pre-push) — it carries a **positive control**: every allowlist entry must be FOUND each run, so a regex that rots fails loudly instead of passing vacuously (it caught my own broken regex on the next run). The sweep's real find: the F7→F3 bridge hardcoded `{actorRole:'admin'}` *to satisfy F3's own authz check*, so that check admitted every caller including the Resend webhook — an attribution bug hiding a dead authorization check. #332 adds migration `0290` (`renewal_cycles.reject_actor_role`) so a cron replay stamps the persisted role rather than guessing; it also clamps `pathFromHeaders` on prefetch markers. #335 closes #334's three deferrals and records the marketing clear-halt **narrowing** decision as an `AMENDMENT` block in `specs/010-email-broadcast/spec.md` (free to take: prod has 0 marketing users and 0 halted members — checked read-only, not assumed). Rule of thumb this leaves behind: record `?? null`, **never** `?? 'admin'` — an honest null says "unknown", a default asserts a role nobody held.
- **`last_activity_at` recency completed for F6 + F7 (#336, #337, 2026-08-17)** — landed the work from PRs **#123 + #124**, both open and un-merged since 2026-06-22, rebased onto main (originals closed as superseded). Mechanism worth knowing: migration 0009's trigger bumps `members.last_activity_at` from **any** audit row whose payload carries a **snake_case `member_id`** (`payload ? 'member_id'`), and both features were emitting camelCase `memberId` — so the trigger had **never fired** for an event or a broadcast (measured against prod, 0 rows either side). #337 is therefore a +19-line source fix (emit the key the trigger already reads), gated on `actorRole === 'member_self_service'` so an `admin_proxy` submit does not refresh the *member's* recency. #336 needed migration `0291` instead because attendance is decoupled from the audit path on purpose (`member_timeline_v` already lists every matched registration; routing through an audit `member_id` would duplicate the timeline row); it bumps only on DETERMINISTIC matches and is forward-only + tenant-scoped. **`CREATE TRIGGER` has no `OR REPLACE`** — 0291 carries `DROP TRIGGER IF EXISTS` because #123's original did not, and the trigger it created on the *shared dev* Neon branch (while its migration was never recorded as applied) had been breaking `pnpm db:migrate` on dev since June.
- **money-path coverage remediation CLOSED (#329 + #330, 2026-08-14) + 016 post-ship review fixes MERGED (#331, `b2b8a3fe5`).** #329: 14 money-path files brought to their coverage pins + `coverage-nightly.yml`; the coverage job was then promoted to blocking on every PR (the 6th required check on `main`). #330: credit-note download access trail (reuses `invoice_pdf_downloaded`) + the logo AS-block hydration-race fix. #331: all 15 confirmed findings from the 016 post-ship adversarial review closed, incl. migration 0289 (last-admin-guard serialization via advisory lock).
- **016-rbac-permissions: RBAC v2 COMPLETE — PR 4 MERGED (#326, 2026-08-13) + PR 5 (legacy-leg deletion) authored the same night.** Roles widened 3→5 (`+super_admin`, `+marketing`); ~175 authorization sites on positive permission checks against a 40-key catalogue. PR 4: marketing assignable (both pickers + the users filter, lockstep-gated), declarative nav (`SurfaceGuard` + server-resolved `staffNavAllowedHrefs`, fail-closed), insights engagement/finance split, flag default→ON, typed-phrase super_admin promotion, plus a 4-agent remediation round (D7 deploy-freeze defused, seed-e2e target guard fail-closed, role-list copies 4+5 unified). PR 5 (T068–T071): the legacy leg is DELETED — single-leg evaluator `hasPermission(role, key)`; `legacy-shim` / `policies.ts` / `canAccess` / `requireRole` / `requireAdminContext` gone (the last three had zero live callers); `FEATURE_RBAC_V2` removed from env schema, CI and `.env.example`; the D7 gate deleted after its one real catch (it stopped Migration C from being silently skipped on dev); migration 0288 narrows `users_last_admin_guard()` to super_admin-only (3-part contract preserved); `administrativeRoles()` is flag-free; the observed-baseline collapsed to a (surface → key) register. PR 5 merged #327 (`37ee744a8`, 2026-08-14) after a clean 11 h soak; the operator deleted the Vercel env var the same morning — **016 is COMPLETE, all tasks closed**.
- 015-admin-dashboard: F9 Admin Dashboard SHIPPED (PR #29) — go-live gate CLEARED; insights / audit-viewer / timeline / benefit-usage / directory + E-Book/JSON export.
- 088-invoice-tax-flow-redesign: SHIPPED to prod (#149–151, flag ON) — `bill` document type, §86/4 buyer-TIN line, WHT note, head-office / branch-code.
- money-remediation + plan-change billing: plan changes now reach billing on all paths F3/F8/F4 (#233–#242); money tasks 8A/8B/8C+10 (#240, migrations 0268–0270).
- renewals (fixed-anchor): membership period fixed at registration; first payment only ACTIVATES (#246); + effective-paid coverage predicate + void-of-paid-membership guards (#248–#254).
- duplicate membership-bill guards (#243/#244) + members portal-status badge, needs-invite chip, bulk re-send (#255) + member-number (055, PR #70).
- 014-email-broadcast-advance: F7.1a/b Email Broadcast Advanced — recipient pagination + inline image upload (ClamAV-scanned, Vercel Blob) + template library. Review-clean + staff-review-clean; only ship-day operator gates remain (ClamAV Fly.io deploy, Vercel env vars, cron-job.org coordinators, staging QA, flag-flip). 938/938 broadcasts contract+unit GREEN.
- 012-eventcreate-integration: F6 EventCreate Integration SHIPPED (PR #26) + flag-flipped to production 2026-05-19 — CSV attendee import + webhook ingest + benefit-quota tracking; F8 at-risk bridge port live-wired.
- 011-renewal-reminders: F8 Renewal Tracking + Smart Reminders SHIPPED (PR #24) — pipeline dashboard, tier-aware reminder schedule, 8-factor at-risk scoring, auto tier-upgrade, manual escalation queue.

Last updated: 2026-09-06 (**108 PR-D MERGED** — PR #344 squash `a586351cd`, 51 commits, five review rounds / 216 findings closed; migrations 0294–0296 apply to prod on this deploy; a person's own marketing objection now follows the ADDRESS across every insert path incl. `scripts/import-members.ts`; the required smoke job has NO Redis, so Idempotency-Key route tests swap in an in-memory store on the `.env.example` placeholder host — operator follow-up: add `UPSTASH_REDIS_REST_URL/TOKEN` secrets to `integration-smoke.yml`. PR-C next. Previous: 2026-09-05 (**108 PR-A MERGED** — PR #340 `200a743fe`; money emails + the F5 PromptPay billing address now resolve the recipient LIVE from the member's primary contact instead of the frozen `member_identity_snapshot`. Migration `0292` applied to prod. No feature flag: the behaviour is live. Pre-merge and post-deploy prod inventory both read 150 active members, **zero** without a live primary contact — so no member's delivery changed. **Also merged: PR #339** — the pre-push integration gate now covers `src/app/api/**` (mapped by the literal `@/app/api/.../route` import, not a name heuristic) and gates a branch's FIRST push against `merge-base origin/main HEAD` rather than `HEAD~1`. That gap had let a broken `void-pdf-reconcile` cron ride 31 commits, and within an hour of the fix the same gate surfaced three more invoicing integration tests 108 had broken — one red since PR-A's first commit, missed by five review rounds. **PR-B MERGED the same day — PR #342 `f2eccb486`**: exactly one live primary contact per contact-bearing member is now guaranteed at the write, the tx and COMMIT (migration `0293`, applied to prod on deploy; V1 immediately before merge: 150 members · 0 violations · 0 contact-less), `promotePrimary` designates when there is no current primary, bulk `unarchive` enforces the same rule as the single undelete, and unarchive designates a primary in the same transaction. Lesson worth keeping: the persistent `ci` Neon branch is NOT shaped like `dev` — it carries a pre-wipe copy of the `swecham` tenant, and one row there failed 0293's pre-check on the first smoke run (`docs/runbooks/db-environment-branching.md`, memory). SweCham's secondary-contact import is now guarded (run `scripts/inventory-primary-contact-invariant.ts` right after it). **2026-09-06 — 108 PR-D built and reviewed on branch `108-pr-d-contact-marketing`** (8 TDD cycles + review cycles 9–12: five reviewers, 51 findings closed; the two privacy blockers were both "recorded but never read" classes — the opt-out is now consulted at dispatch through the real F7→F3 bridge with a live-Neon proof, and a person's own opt-out outranks staff by FR-025 AMENDMENT). `/speckit-review` ×3 + `/speckit-staff-review-run` are user-invoked gates that still precede the PR; PR-C not started. Full history → docs/changelog.md)
