# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Project**: **Chamber-OS** — a SaaS membership management platform for chambers of commerce. **SweCham / TSCC (Thai-Swedish Chamber of Commerce)** is the first tenant, live at `swecham.dxtspace.com` with real members and money — money and tax paths are live-stakes. **Multi-Tenant Aware, Single-Tenant Deployed (MTA+STD)**: `tenant_id`-scoped schemas + RLS, so a new tenant needs no schema migration (`docs/saas-architecture.md`).

**Scope**: membership backend + admin portal (`/admin`) + member self-service portal (`/portal`). NOT a public website / CMS.

**Folder name caveat**: the directory is historically `Swedish chaplain_membership` — "chaplain" is a typo for "chamber". Call the product **Chamber-OS** (platform) or **SweCham / TSCC** (tenant), never "chaplain".

**Where things are**: modules `src/modules/{auth,tenants,plans,members,invoicing,payments,events,broadcasts,renewals,insights}/**`; staff UI `src/app/(staff)/admin/**`; member UI `src/app/(member)/portal/**`. Latest migration: `ls drizzle/migrations/*.sql | tail -1`. Feature history and PR provenance: `docs/changelog.md`. Production flag state: `docs/operational-state.md`.

## How the instructions are split

| File | Loads | Holds |
|---|---|---|
| `CLAUDE.md` (this file) | every session | identity, commands, stack, where to look |
| `.claude/rules/rules.md` | every session | conventions, secrets, testing discipline, cross-cutting gotchas |
| `.claude/rules/architecture.md` | when touching `src/` or `drizzle/` | source layout, Clean Architecture, tenancy, advisory locks, audit log, migrations |
| `.claude/rules/modules/*.md` | when touching that module | per-module stack, tables, flags, traps (invoicing, payments, members, broadcasts, auth-rbac, events) |
| `.claude/rules/ui-aura.md` | when touching UI, messages or e2e | AURA migration, i18n, UX playbook, e2e conventions |
| `.claude/skills/review-and-ship/` | on demand | which agent reviews what, `/code-review`, Workflows, Spec Kit gates, merge flow |
| `.claude/skills/feature-flow/` + `docs/workflow.md` | on demand | the change lifecycle, Definition of Done, decisions, retros |
| `.claude/skills/new-migration/`, `add-audit-event/` | on demand | the fragile build steps: a hand-written migration; a new audit event type |
| `.claude/skills/run-chamber-os/` | on demand | how to run a branch on :3400 for verification (personas, Playwright attach, UI probes) |
| `.claude/settings.json` `permissions.deny` + the `.claude/hooks/guard.mjs` PreToolUse hook | always | kept small on purpose (D-016): no reading secrets (`.env*`, the PII workbooks), no editing a migration already on `main`, no prod write script by any spelling (D-025), and the deny list (format, stash, `db:generate`, `db:push`, the prod write scripts: `db:migrate:prod`, `seed:system-actors:prod`) |

A fact that matters only for one module goes in that module's rule, not here. Keep this file under 200 lines.

**When compacting**, keep: the current branch and worktree, the files modified, the commands run with their results, open review findings, and any decision the user made in this session.

## Language for AI sessions

User prefers **Thai** for conversational turns. Code, specs, commit messages, and technical docs remain in **English**.

## When to consult the advisor

When the `advisor` tool is available, call it at these three points:

- **Before the real work starts**: after exploring the code, but before writing a plan or code.
- **When stuck or about to change approach**: for example the same error keeps coming back, or a fix does not hold.
- **Before saying the work is done**: after the work is saved (files written, changes committed).

## Governance

- `.specify/memory/constitution.md` (**v2.1.0**) holds the **principles**: 10, of which 4 are NON-NEGOTIABLE — Data Privacy & Security, Test-First, Clean Architecture, PCI DSS — plus i18n, Inclusive UX, Perf & Observability, Reliability, Code Quality, Simplicity. Principle I requires **two-layer tenant isolation** (application + database) with a cross-tenant integration test. The **process** — lifecycle, reviews, merging — is not in the constitution; it lives in `docs/workflow.md` (D-018).
- A deviation from a principle lives in the feature's `plan.md` § Complexity Tracking with the rejected simpler alternative.
- Key docs: `docs/phases-plan.md` (features and resolved decisions) · `docs/saas-architecture.md` (read before designing any tenant-scoped feature) · `docs/membership-benefits-analysis.md` (authoritative tier data; supersedes the deleted Excel-derived `docs/database-analysis.md`) · `docs/smart-chamber-features.md` (the 21-feature catalogue) · `docs/event-integration-analysis.md` · `docs/email-broadcast-analysis.md` · `docs/ux-standards.md` + `docs/ux-patterns.md` · `docs/code-conventions.md` · `docs/observability.md` · `docs/go-live-readiness.md` · `docs/runbooks/` (~60 runbooks).

## Tech stack

- **Next.js 16** App Router + Turbopack (`cacheComponents` was tried and reverted — data caching uses `unstable_cache`; see `next.config.ts`) · React 19 · **TypeScript 5.7+ strict** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) · Node 22 LTS
- **Neon Postgres + Drizzle ORM** · Upstash Redis (rate limits) — both Singapore
- **Auth**: custom session-based (Lucia v3 guide pattern), argon2id via `@node-rs/argon2`
- **UI**: AURA (`@jirawatpyk/aura-react` + `@jirawatpyk/aura-tokens`, exact-pinned) replacing the legacy shadcn/Base UI kit (spec 122) · Tailwind CSS v4 · lucide-react · toasts only via `@/lib/toast`
- **i18n**: next-intl — EN default + TH + SV; **TH is mandatory for Thai tax documents**
- **Forms / validation**: react-hook-form + zod; zod validates every system boundary and `process.env` (`src/lib/env.ts`)
- **Email**: Resend (transactional) + a separate Resend Broadcasts surface · **Payments**: Stripe Elements / Payment Intents (SAQ-A) + PromptPay, live
- **Testing**: Vitest + Playwright + `@axe-core/playwright` (WCAG 2.1 AA) + MSW + Testing Library
- **Observability**: pino JSON logs + `@vercel/otel` + Vercel Analytics / Speed Insights
- **Hosting**: Vercel `sin1` + Neon `ap-southeast-1` — a documented deviation from "Thailand primary" (no major cloud has a TH region; PDPA § 28 + GDPR SCCs cover SG). Don't move to a Thai-local provider without amending the deviation in `specs/001-auth-rbac/plan.md`.
- Most features since 016 add **zero new npm dependencies** (Constitution X), so a plan that adds one has to say why.

## Commands

**Use `pnpm`, not `npm`.** Dev and start run on **port 3100**; Claude may start it (Browser pane `preview_start` / the launch config) and open it in the built-in browser, but doesn't kill a :3100 server the user is using. Integration tests hit the live Neon **`dev`** branch via `.env.local`, never prod.

```bash
pnpm install
pnpm dev                       # Next.js dev with Turbopack on :3100
pnpm lint                      # ESLint, cached (only changed files re-lint); errors block merge
pnpm typecheck                 # tsc --noEmit under strict
pnpm test                      # Vitest run  (watch: pnpm test:watch)
pnpm test:coverage             # with Vitest coverage thresholds (what CI enforces)
pnpm test:integration <path>   # live Neon DEV branch; pass file PATHS — a `-- <pattern>` runs all ~40 min
pnpm test:e2e                  # Playwright against :3100 (the main checkout's code); for a branch use run-chamber-os
pnpm test:e2e --grep "@a11y"   # axe-core WCAG 2.1 AA scan only
pnpm check:i18n                # fails on missing EN keys
pnpm db:migrate                # apply to the DEV branch; prod auto-migrates on deploy (vercel-build)
pnpm db:verify                 # assert the live schema matches expectations (prod: pnpm db:verify:prod — read-only, allowed for Claude since D-024)
pnpm build                     # production build
# pnpm db:generate             # DO NOT USE — migrations are hand-written SQL (see .claude/rules/architecture.md)
```

`pnpm check` runs lint + `next typegen` + typecheck + the static gates in one go, exactly as CI's static job does. Run it **once, after the last edit** — it already contains lint and typecheck, so don't run them again separately. Gate layering (D-033): `pnpm check` locally on demand; the pre-push hook runs only the integration gates CI does not run; CI's required checks own the static and architecture gates. Full local gate before shipping anything non-trivial:

```bash
pnpm check && pnpm test:coverage && pnpm vitest run tests/contract/ && pnpm test:integration <touched paths>
```

Then run the touched e2e specs against the branch's own :3400 server: `E2E_BASE_URL=http://localhost:3400 pnpm exec playwright test --config=playwright.attach.config.ts <spec>` (the `run-chamber-os` skill).

`main`'s required checks and what the pre-push hook runs are in the `review-and-ship` skill. Other `check:*` gates, in neither `pnpm check` nor CI's static job: `check:strict-aria`, `check:audit-events`, `check:audit-counts`, `check:bundle-budgets`, `check:multi-tenant`, `check:portal-guard`, `check:plan-divergence`, `check:f71a-schema`, `check:f9-schema` (`check:i18n` runs in `pnpm check` and CI).

One-off: bootstrap the first admin (refuses if any admin exists): `BOOTSTRAP_ADMIN_EMAIL=first.admin@swecham.example pnpm db:seed-admin`.

Vercel: `vercel env pull .env.local` · `vercel logs <deployment-url>` · `vercel promote <old-deployment-url>` (rollback). **Emergency write freeze**: set `READ_ONLY_MODE=true` in Vercel env + redeploy — 503 `read-only-mode` on every state-changing `/api/**` route except the sign-in, sign-out and heartbeat POSTs (D-028), so sign-in and reads stay up; reversible in ~30 s.

## Precedence

When sources disagree, the higher one wins. If the conflict matters, stop and ask; don't pick silently.

1. The user's instruction in this session
2. `.specify/memory/constitution.md` — on principles
3. `docs/decisions.md` — the newest decision wins
4. `docs/workflow.md` — on process (the constitution no longer rules process)
5. The feature's spec (`specs/<nnn-name>/spec.md`)
6. `CLAUDE.md` and `.claude/rules/`
7. Existing code, comments and other docs

## Workflow

- `docs/workflow.md` is the lifecycle contract: sizes, the ten steps, the **Definition of Done**, **Decisions** and **Continuous improvement**. The `feature-flow` skill walks it; `review-and-ship` covers reviewers and merging.
- The process follows current Claude Code practice and is owned by `docs/workflow.md`, not the constitution (v2.1.0, D-018); the `/speckit.*` commands remain usable for a step.
- When a retro trigger in `docs/workflow.md` § Continuous improvement fires, run the retro: one line in `docs/retro.md`, plus the change that stops it recurring.
- Dispatch the project subagents in `.claude/agents/` for gate and review work, not `general-purpose`. Any UI-touching change also gets an `enterprise-ux-designer` pass.
- Saved Workflows (`.claude/workflows/`: `review-branch`, `sweep-class`, `spec-review-panel`) run only on explicit opt-in ("use a workflow" / `ultracode`).
- Merge only when the user asks. Every merge to `main` deploys to production.

<!-- `.specify/scripts/powershell/update-agent-context.ps1` maintains the block below, but only PARTLY. Measured against a real run, not read off the source: -->
<!--   · `## Active Technologies` — the script APPENDS a plan's new entries. With no blank line inside the section they land at its end, so keep it one unbroken list. -->
<!--   · There is no `## Recent Changes` or `Last updated:` here; both moved out (docs/changelog.md, docs/operational-state.md). Their absence makes those branches of the script no-ops. -->
<!-- Durable guidance belongs ABOVE this marker. When the script appends a feature's entry below, move it into that module's `.claude/rules/modules/*.md` at review. -->

## Active Technologies
- **Baseline, every feature**: see § Tech stack above; per-module additions live in `.claude/rules/modules/*.md`.
