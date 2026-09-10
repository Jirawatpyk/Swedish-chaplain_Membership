# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Project**: **Chamber-OS** — a SaaS membership management platform for chambers of commerce and membership organisations. **SweCham / TSCC (Thai-Swedish Chamber of Commerce)** is the first tenant, deployed at `swecham.dxtspace.com`. The platform is designed as **Multi-Tenant Aware, Single-Tenant Deployed (MTA+STD)** — F1 shipped single-tenant; F2 onwards use `tenant_id`-scoped schemas so future tenants can be onboarded without schema migration. See `docs/saas-architecture.md` for the multi-tenant strategy.

**Scope**: Chamber-OS is the **membership management backend + admin portal + member self-service portal**. It is NOT a public website / CMS — tenants are expected to have their own public sites.

**Folder name caveat**: the directory is historically `Swedish chaplain_membership`. "chaplain" is a typo for "chamber". Refer to the product as **Chamber-OS** (platform) or **SweCham / TSCC** (first tenant), never "chaplain". Rename is tracked as R6 in `docs/phases-plan.md` (manual action — cannot be done from inside the active working directory).

**Repository status (as of 2026-07-28)**: **F1–F9 SHIPPED + member-number (055, PR #70) SHIPPED — SweCham/TSCC is LAUNCHING (prod live with real members + money; money/tax paths are live-stakes).** F1 Auth & RBAC (PR #1) · F2 Membership Plans · F3 Members & Contacts · F4 Invoices & Receipts · F5 Online Payment / Stripe + PromptPay (PR #16) · F6 EventCreate Integration (PR #26, flag-flipped to production 2026-05-19) · F7 Email Broadcast / E-Blast (PR #23) · F8 Renewal Tracking + Smart Reminders (PR #24). Member numbers (055, PR #70): per-tenant `SCCM-NNNN` surfaced across the Members directory, command palette, portal badge, and F4 tax PDFs. **As of 2026-07-28: auto-invoice on payment + void-on-reissue are SHIPPED** (#261–#263 — migration `0281` adds `coverage_from/to` + a GiST EXCLUDE guard; 3 env flags ON in prod + tenant `auto_invoice_enabled`); most recent work = renewals urgency pill/tabs aligned to true benefit-access (#266–#268) + invoices filter UX redesign (#264–#265). Migrations are at `0299` (current — this number is kept live, unlike the rest of this dated paragraph; `0294`–`0297` applied to prod 2026-09-07 on the deploy of PR #346, `0298`–`0299` on the deploy of PR #352, 2026-09-10). Still in flight: observability / env-boot / go-live-readiness hardening, money-remediation residuals, plan-change billing Phase 2. (Run `git branch --show-current` for the live branch — feature branches rotate faster than this doc, so this section names the workstream, not a branch.) The **F9 launch gate is CLEARED** — `015-admin-dashboard` merged to `main` (PR #29, `1056d5a2`, 2026-05-31). `docs/go-live-readiness.md` (the master launch plan) locks launch scope at F1–F9 (all merged); remaining work is operational/data readiness + flag-flips, NOT feature work. See § Recent Changes for full per-feature provenance and the human-gated residuals on each feature. Source modules: `src/modules/auth/**` (F1) · `src/modules/tenants/**` + `src/modules/plans/**` (F2) · `src/modules/members/**` (F3) · `src/modules/invoicing/**` (F4) · `src/modules/payments/**` (F5) · `src/modules/events/**` (F6) · `src/modules/broadcasts/**` (F7/F7.1) · `src/modules/renewals/**` (F8) · `src/modules/insights/**` (F9 — admin dashboard, audit viewer, timeline, benefit usage, directory + E-Book/JSON export; shipped PR #29) · presentation in `src/app/(staff)/admin/**` + `src/app/(member)/portal/**` + `src/components/layout/**`.

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

Pre-push (**~50 s**) runs twelve static gates — `check:layout` + `check:template-seed` + `check:fixme` + `check:dates` + `check:env-example` + `check:env-boot` + `check:money-recipient` (108 — every money email addresses the LIVE primary contact, never the frozen snapshot) + `check:f8-error-id` (every F8 renewals route names ITSELF in the errorId taxonomy — the shared admin gate used to log one hardcoded id for all 24 callers) + the four RBAC/audit-truth gates `check:staff-page-guard` + `check:api-route-guard` + `check:authorization-role-reads` + `check:actor-role-truth` (14 s for the four, measured) — then `tests/unit/architecture/` (24 s — the settlement-tx money guard), plus **two conditional integration gates**: the per-module one when `src/modules/<m>/**` is touched, and an **API-route gate** when `src/app/api/**/route.ts` is touched, which runs the integration tests that IMPORT that route (matched on the literal `@/app/api/.../route` import path, not on a name heuristic — `[id]` is a glob character class and prefix matching paired routes with unrelated suites). On the FIRST push of a branch the diff baseline is `merge-base origin/main HEAD`, i.e. everything the branch adds — it used to be `HEAD~1`, so a 39-commit branch that rewrote `src/modules/invoicing` pushed with the hook printing "no src/modules/* changes" and a broken cron rode along for the whole branch. Emergency override: `SKIP_INTEGRATION_PREPUSH=1 git push`; if you use it, run the touched risk surface manually and disclose it in the PR. The 190-file `tests/contract/` run moved to CI; run it locally with `pnpm vitest run tests/contract/` (~4.3 min) before opening a PR. Additional `check:*` gates available (NOT in pre-push): `check:strict-aria`, `check:audit-events`, `check:audit-counts`, `check:bundle-budgets`, `check:multi-tenant`, `check:portal-guard`, `check:plan-divergence`, `check:f71a-schema`, `check:f9-schema`.

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

Dispatch the **25 project subagents in `.claude/agents/`** (`chamber-os-architect`, `financial-integrity-reviewer`, `thai-tax-compliance-auditor`, `senior-tester`, `enterprise-ux-designer`, `security-engineer`, …) for gate work — not `general-purpose`. Any UI-touching task or PR also gets an `enterprise-ux-designer` pass. File-mutating agents run **sequentially**; read-only reviewers may run concurrently. Saved **Workflow** scripts live in `.claude/workflows/` (see its README): `review-branch` (per-module finders → dedup → adversarial verify → `whole-branch-reviewer` seam pass; round 2 takes `seen`), `sweep-class` (close one defect class everywhere — form discovery → per-bucket finders → positive control → completeness critic → loop until dry), `spec-review-panel` (project-agent lenses on a spec, premises checked against code, before `/speckit.plan`). A workflow runs only on explicit opt-in ("use a workflow" / `ultracode`), never on Claude's own initiative; `/speckit-*` skills stay Claude-executed, not delegated.

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
- **All cron triggers are native Vercel Cron** (`vercel.json`, 40+ jobs) since the 2026-07-17 Pro migration: **UTC-only** (Asia/Bangkok schedules are −7 h) and invoked with **GET**, so POST handlers need `export const GET = POST`. cron-job.org is a paused standby — any "cron-job.org external" note left in an older `specs/` artefact is superseded. See `docs/runbooks/cron-jobs.md`.
- **DB is Neon-branched: `pnpm db:migrate` → the `dev` branch, NOT prod (since 2026-06-23).** `.env.local` points at the `dev` Neon branch (prod backup: `.env.local.bak.prod`, gitignored). Prod + preview migrate **automatically on Vercel deploy** via the `vercel-build` script (`run-migrations.ts && next build`); manual prod = `pnpm db:migrate:prod` (`.env.production`). Integration tests **refuse to run against prod** (guard in `tests/integration-setup.ts` keyed on `TEST_DB_HOST_BLOCKLIST`). Branches: `main`=prod · `dev`=local/tests · `preview/*`=per-PR (auto). Full map: `docs/runbooks/db-environment-branching.md`.
- **`default: { return _exhaustive }` is FAIL-OPEN — it returns the value at runtime.** The `never` type only proves the arm is unreachable *to the compiler*; when a variant slips past it anyway (a DB enum widened without the union, a parsed string), that arm hands back the variant itself, which is truthy, so an unknown case is silently ACCEPTED rather than refused. In 108 it made an unknown orphan reason get audited under the wrong event type. Write `void _exhaustive; return <safe>` — and note the fix always lands one hop away from where the wrong value shows up. `rg "return _exhaustive"` still finds ~11 in `src/`, including `payments/domain/tenant-payment-settings.ts:114`, whose comment claims it prevents the very false positive its runtime arm produces.
- **A source-scanning gate whose regex anchors on `\n` is INERT on every Windows checkout.** With `core.autocrlf=true` a TypeScript union terminates `;\r\n`, so `/export type X =([\s\S]*?);\n/` returns null, the parsed set comes back EMPTY, and every rule built on it silently checks nothing. **CI can never catch this** — Linux checks out LF, so the gate is green on the branch and dead on the maintainer's machine, which is the only machine it was written to protect. Match `;\r?\n` (or strip `\r` before parsing), and give every source-parsing gate a **positive control** that fails when its own parse yields zero members: a check that cannot tell "nothing to find" from "not looking" is not a check. `check:f8-error-id` had that guard and it is the sole reason the breakage surfaced, after six clean review rounds (#351).

<!-- `.specify/scripts/powershell/update-agent-context.ps1` maintains the block below, but only PARTLY. Measured against a real run, not read off the source: -->
<!--   · `## Active Technologies` — the script APPENDS a plan's new entries. With no blank line inside the section they land at its end, so keep it one unbroken list. -->
<!--   · `Last updated:` — the stamp is refreshed in place. Keep that line to ONE date and nothing else datelike; the script rewrites the stamp that follows the label. -->
<!--   · `## Recent Changes` — NOT auto-written. The script's branch for it is unreachable (the `## Active Technologies` exit consumes the heading first), so this section is hand-curated. -->
<!-- Hand-editing either section is therefore safe. Durable guidance still belongs ABOVE this marker, where nothing generated can reach it. -->

## Active Technologies
- **Baseline, every feature F1–F9 and after**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · Node 22 LTS · Next.js 16 App Router · React 19 · Drizzle ORM · next-intl · Neon Postgres `ap-southeast-1`. The per-feature entries below list only what a feature ADDED; most features since 016 add **zero new npm dependencies** (Constitution X), so a plan that adds one has to say why.
- **Tenancy (F2+)**: `runInTenant(ctx, fn)` + Postgres RLS (`SET LOCAL app.current_tenant`) is the isolation pattern · `src/modules/tenants/` is a Domain-only module hosting the `TenantContext` branded type · `DEBUG_RLS_STATE` is a dev-only tenant-context assertion.
- **Advisory-lock namespaces are deliberately DISJOINT, and mean different things**: `invoicing:` (F4 — per tenant+document_type+fiscal_year, exists to keep §87 numbering gap-free) · `payments:` (F5 — per tenant+invoice, a TOCTOU guard, NOT numbering) · `broadcasts:` (F7 — per tenant+broadcast). Same primitive, three contracts; never reuse a namespace across modules.
- **Audit events**: F2 +10 · F3 +23 · F4 +16 · F5 +17 · F7 +43. The canonical list lives in code, never here — e.g. `src/modules/broadcasts/application/ports/audit-port.ts`. `audit_log.retention_years` is `SMALLINT NOT NULL DEFAULT 5` with CHECK `IN (5,10)`; six F4 tax-document types are backfilled to 10 years per Thai RD §87/3 + GDPR Art. 6(1)(c) (migration 0039). Adding a type touches 5 places — see § Gotchas.
- **F2 plans** (`002-membership-plans`): `cmdk`, the headless command-palette primitive behind smart-chamber feature #4.
- **F3 members** (`005-members-contacts`): `src/modules/members/` · `@tanstack/react-table@^8` (server-side pagination/sort/filter on the directory) · `i18n-iso-countries@^7` · tables `members` + `contacts` with a pg_trgm GIN index, RLS+FORCE policies, and a `last_activity_at` SECURITY DEFINER trigger (migrations 0009 + 0010). **That trigger fires only on an audit payload key `member_id` — snake_case**; two features emitted `memberId` and the trigger never fired for either (fixed #336/#337).
- **F4 invoicing** (`007-invoices-receipts`): `src/modules/invoicing/` · `@react-pdf/renderer@4.3.0` **exact-pin** (deterministic bilingual PDFs) · `@js-joda/core@^6` + `@js-joda/timezone@^2` (correct Asia/Bangkok fiscal-year boundary for the sequential-number allocator) · `thai-baht-text@^2` · `sharp@^0.34` (server-side logo re-encode — EXIF strip, MIME/dimension enforce) · `fast-check@^4` dev (property test for the credit-note VAT-sum invariant) · Sarabun TTF (OFL) committed under `public/fonts/sarabun/`, embedded at build time. Tables `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences`. Env `FEATURE_F4_INVOICING` + `BLOB_READ_WRITE_TOKEN` + `CRON_SECRET`.
- **F5 payments** (`009-online-payment`): `src/modules/payments/` · `stripe@^22` server + `@stripe/stripe-js@^9` + `@stripe/react-stripe-js@^6` (Elements — SAQ-A preserved) · env `STRIPE_API_VERSION` (pinned, FR-026) + `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` + `STRIPE_WEBHOOK_SECRET` + `FEATURE_F5_ONLINE_PAYMENT`. Tables `payments`, `refunds`, `tenant_payment_settings`, `processor_events`; migrations 0033–0050. **The concurrent-initiate guard is three layers**: a partial unique index on `processor_payment_intent_id`, a tenant-filtered `SELECT … FOR UPDATE`, and `pg_advisory_xact_lock` per (tenant, invoice) that closes the TOCTOU window *before* the row probe — plus the Stripe idempotency key `inv-{invoiceId}-attempt-{n}`. `/api/internal/metrics/stale-pending-count` emits the `payments.stale_pending_count` gauge every 5 min.
- **F6 events** (`012-eventcreate-integration`): table `csv_import_records` + per-row `attendee_pdpa_consent_text` on `event_registrations` · streaming parser at `src/modules/events/infrastructure/streaming-csv-importer.ts` · error-rows CSV to a private Vercel Blob bucket, TTL-swept. No payment data (Principle IV n/a).
- **F7 broadcasts** (`010-email-broadcast` + `014-email-broadcast-advance`): `src/modules/broadcasts/` — 4 aggregates (Broadcast / BroadcastDelivery / MarketingUnsubscribe / RecipientSegment) · Tiptap@3.22.5 + isomorphic-dompurify@2.36.0 (both exact-pin) + email-validator@^2 + @tanstack/react-virtual@^3. **The Resend Broadcasts surface is separate from F1/F4 transactional** — its own API key, suppression list, webhook endpoint and reputation pool; the webhook is pinned to the Node runtime for Svix HMAC raw-body verification. Env `RESEND_BROADCASTS_API_KEY` + `RESEND_BROADCASTS_WEBHOOK_SECRET` + `UNSUBSCRIBE_TOKEN_SECRET` (≥32 bytes, distinct from `AUTH_COOKIE_SIGNING_SECRET`) + `BROADCASTS_FROM_EMAIL` + `FEATURE_F7_BROADCASTS`.
- **F7 content + state rules**: sanitiser allowlist (FR-002a) is `p`/`br`/`strong`/`em`/`u`/`a[href]`/`ul`/`ol`/`li`/`h1-h4`/`blockquote`/`hr`, schemes `http`/`https`/`mailto`, **no `<img>`**; subject ≤200, body ≤200 KB; applied in Application and the raw body is never persisted. Quota reserves at `submitted` and consumes at `sending→sent`, with `currentQuotaYear` in the tenant's TZ. A broadcast is cancellable until `approved` and immutable after submit (DB trigger `broadcasts_immutable_after_submit_fn`). SLO budgets are still **UNVERIFIED** against prod RUM: compose TTFB <600 ms · submit <1.2 s · queue <500 ms @1k · approve&send <1.5 s · webhook <250 ms · unsubscribe <400 ms.
- **088 invoice/tax redesign**: `document_type` enum `+= 'bill'` · `invoices.bill_document_number_raw` + partial unique index · `members.is_head_office` + `branch_code` · `tenant_invoice_settings.wht_note_th/_en` + `seller_is_head_office` + `seller_branch_code` · amended CHECK constraints on `invoices`.
- **016 RBAC v2**: role pgEnum `+= 'super_admin','marketing'` · `audit_event_type += 'permission_denied'` · `users_last_admin_guard()` rewritten UNION→strict. The permission catalogue and `ROLE_BUNDLES` are pure Domain data in `src/modules/auth/domain/permissions/`; the evaluator is single-leg `hasPermission(role, key)` — `FEATURE_RBAC_V2` and the legacy shim are deleted. **`ROLE_BUNDLES` is not the whole model**: super-admin keys come from the EVALUATOR, so ask it, never read the bundle.
- **108 contact recipient rules** (all four PRs merged; flag state in § Recent Changes): migrations `0292`–`0297` · permission key `contacts.marketing` (catalogue 42 keys; admin / super_admin / marketing — **never** manager) · `contacts_check_member_primary()` SECURITY DEFINER with `row_security = off`, behind two DEFERRABLE INITIALLY DEFERRED constraint triggers, enforces exactly-one-live-primary at COMMIT · `contacts_tenant_lower_email_all_idx` is **not** partial, so a carry-forward opt-out lookup can still match REMOVED rows · `MembersBridgePort.filterMarketingOptedOut` drops opted-out addresses from every segment at dispatch, fail-closed · money emails resolve the LIVE primary contact through the widened `RecipientLocalePort`, and F5 gets a `BillingRecipientPort`.

## Recent Changes

Full per-feature provenance (F1–F8 + every F7.1a/b review round) is archived in [`docs/changelog.md`](docs/changelog.md). Rolling summary:

- **#353 follow-ups CLOSED in one PR (2026-09-10, branch `111-broadcasts-followups`).** Nine review findings from the eight rounds on #353, plus the tasks.md sweep. Behaviour changes worth knowing: (1) the 24 h reconciler consumes quota ONLY on a resource Resend reports `sent` — every other present status (`draft`/`queued`/`sending`/`cancelled`/unknown) is a third outcome, `unresolved_provider_status`, left in `sending` for an operator and counted on `broadcasts.reconcile_unresolved_status.total{observed_status}` (it used to `markSent` on ANY present resource, which is where the round-6 dispatch defect reached its harm); (2) dispatch probes an inherited id BEFORE Step 2, so a re-resolve refused on this tick can no longer fail a broadcast a prior tick already sent; (3) the three arms that leaked a minted Resend broadcast now reclaim it through the new `deleteBroadcast` port method — the persist-fault arm reads the row back first, because a lost commit-ack looks like a failed write and deleting in that case would destroy the id the next tick inherits; (4) `broadcasts.dispatch_resolve_failed.total` carries a closed `phase` label (live leg: lock/resolve/inherited_status/persist_broadcast_id; import leg: gateway/resolve/terminal_write) — the NAME is kept so the catalogued alarm keeps firing; (5) `getAudienceContactCount` answers a plain `{ count, complete }` — its `not_found` arm was dead code (the list endpoint never 404s a missing audience, MEASURED). Ledger: `specs/108-contact-recipient-rules/reviews/followups-20260910.md`. tasks.md: T006/T140/T141/T142 closed as SUPERSEDED with reasons; T094 is blocked on SweCham's secondary-contact import (prod 2026-09-10: 150 members / 0 secondaries — the flip changes nothing until then) and on the operator decision; T099 on T094; **T110 is NOT blocked** — deferred by choice (resend 4.8 → 6.x is a major bump under a gateway that just took eight review rounds).
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

Last updated: 2026-09-10

**108 is COMPLETE** (PR-C #346 `91505b8f2`). The 1:N contact audience ships behind `FEATURE_CONTACT_MARKETING_RECIPIENTS` (default OFF, and the variable is currently ABSENT from Vercel), but **nine changes in that PR are UNFLAGGED and live on merge** — full list with operator consequences in `specs/108-contact-recipient-rules/quickstart.md` § Rollback matrix row C. The two most surprising: `marketing_unsubscribes.contact_id` (migration `0297`) is written by **every** unsubscribe with no flag read, so dropping the column while this code is deployed 42703s the GDPR Art. 21 path; and **the sender is no longer excluded from a custom list or the attendee segment** (pre-108 their primary address was filtered out of every segment kind). Rolling any of the nine back is a code revert, not a flag flip.

**Setting the env var IS the flip on this repo** — `vercel.json` has no `ignoreCommand`, so every merge to `main` deploys production, and a flag set early is armed for whoever merges next, including a docs-only PR. Add `FEATURE_CONTACT_MARKETING_RECIPIENTS` only when ready to redeploy immediately. **T094 is still open**: it completes at first-send observation, not at flag-set. Every precondition is cleared, with each one's measured state written in `specs/108-contact-recipient-rules/reviews/cutover.md` — including two that EXPIRE on SweCham's pending secondary-contact import (T093 and the GDPR Art. 14 attestation are vacuous only while prod holds 0 secondary contacts; re-run `scripts/inventory-primary-contact-invariant.ts` after the import). Still genuinely open: FR-043's 400 ms @ 5,000 band has no test at all, and the 3 s @ 20,000 budget is asserted only through `ciScaled(3_000)` — both must be measured from `sin1`, never from CI or a workstation.

**Enforced audience ceiling, as merged and unflagged: 500** (`DELIVERABLE_RECIPIENTS_PER_TICK`, PR #352). `addContactsToAudience` is a serial loop at a measured ~2.08 req/s — latency-bound, not rate-limited, since the account allows 10 req/s — so 300 s drains ~623, and audiences of 501–5,000 were being accepted and then failing silently; the clamp replaces silent non-delivery with a legible refusal. With `FEATURE_F7_IMPORT_AUDIENCE` ON the ceiling is whatever the flags configure, because `POST /contacts/imports` carries the whole audience in one ~412 ms call regardless of size (migrations `0298`–`0299`). Independent second bound: the Resend account is on the **Free** plan — 1,000 contacts, 3 segments — so only two broadcasts can be in flight at once.

Merged since #346: **#348** an unrecognised processor environment is not a consistent key · **#349** finish the assertNever migration TD-M4 started in May · **#350** every F8 renewals route names ITSELF in the errorId taxonomy, plus the gate that keeps it so · **#351** that gate was inert on every Windows checkout (see § Gotchas) · **#352** Phase 9 cutover · **#353** persist `resend_broadcast_id` BEFORE the send, closing the F4 double-send window · **#354** smoke cap raised to 30 with a soft budget. Current workstream: broadcasts follow-ups.

Full history → `docs/changelog.md`.
