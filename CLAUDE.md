# Swedish chaplain_membership Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-09

## Active Technologies

- TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`) (001-auth-rbac)

## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

npm test; npm run lint

## Code Style

TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`): Follow standard conventions

## Recent Changes

- 001-auth-rbac: Added TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`)

<!-- MANUAL ADDITIONS START -->

## Project identity

- **Name**: SweCham / TSCC Membership System — Thailand-Swedish Chamber of Commerce
- **Note**: folder is historically `Swedish chaplain_membership` ("chaplain" is a typo for "chamber"). Rename tracked as R6 in `docs/phases-plan.md`. Refer to the product as **SweCham / TSCC**, not "chaplain".
- **Governance**: `.specify/memory/constitution.md` **v1.2.0** — authoritative. Read before proposing architecture changes.

## Key project docs (read these first for context)

- `.specify/memory/constitution.md` — 10 principles (4 NON-NEGOTIABLE), governance, quality gates
- `docs/phases-plan.md` — 9-feature roadmap, 3 phases, 6 resolved decisions (SV+EN+TH, TH hosting, Stripe, 3 roles, no day-1 migration)
- `docs/database-analysis.md` — domain model derived from the Excel workbook (8 entities, 9 FK relationships, business rules)
- `specs/<nnn-feature>/` — per-feature spec, plan, research, data-model, contracts, quickstart, tasks

## Locked-in tech stack (F1 onwards)

- **Framework**: Next.js 16 App Router + Cache Components + Turbopack
- **Language**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`)
- **Auth**: custom session-based (Lucia v3 guide pattern), argon2id via `@node-rs/argon2`
- **Storage**: Neon Postgres + Drizzle ORM; Upstash Redis for rate limiting — both Singapore region
- **UI**: shadcn/ui + Tailwind CSS v4 + lucide-react icons + Radix primitives
- **i18n**: next-intl, three locales **EN (default) + TH + SV**. TH mandatory for tax surfaces
- **Forms**: react-hook-form + zod
- **Email**: Resend (transactional)
- **Payments**: Stripe (planned for F5; not yet in code)
- **Testing**: Vitest + Playwright + @axe-core/playwright + MSW
- **Observability**: pino logs + @vercel/otel traces + Vercel Analytics
- **Hosting**: Vercel (sin1 Singapore) — deviation from "Thailand primary" documented per Constitution escape clause (no major cloud has a TH region)

## Clean Architecture (Principle III) — enforced by ESLint

```
src/app/**                    → Presentation (Next.js routes, server actions, middleware)
src/modules/<context>/
  ├── domain/**               → pure types + policies, NO framework imports (ESLint no-restricted-imports)
  ├── application/**          → use cases, NO drizzle/next/react imports
  └── infrastructure/**       → DB repos, email, hashing, rate limit adapters
src/components/**             → shadcn/ui primitives + shared app components
src/i18n/messages/            → en.json (canonical, build-fails on missing), th.json, sv.json
src/lib/**                    → cross-cutting utilities (db client, logger, env validation)
```

Bounded contexts import only **public interfaces** from other contexts (no reaching into `domain/` / `application/` of a sibling).

## Conventions

- **Package manager**: pnpm (NOT npm) — lockfile is `pnpm-lock.yaml`
- **Commits**: Conventional Commits enforced via commit-msg hook; use `[Spec Kit]` prefix for Spec Kit workflow commits (`[Spec Kit] Add specification`, etc.)
- **Branches**: one feature per branch (`nnn-feature-name`), spec directory matches
- **Tests**: TDD — write failing test first, commit red, then implement. Coverage ≥80% business, **100% branch** on security-critical paths (auth, RBAC, payment, audit)
- **PR review**: ≥1 reviewer normally, **≥2 for security-sensitive** (auth, RBAC, payment, PII, audit log, GDPR surfaces)
- **Timestamps**: always store ISO 8601 UTC. Thai Buddhist Era (BE) is display-only in `th-TH` locale

## Secrets & Confidential data

- **NEVER commit** `docs/*.xlsm` / `docs/*.xlsx` (SweCham member PII, ~131 members / 164 contacts) — blocked by `.gitignore`
- Secrets in Vercel env vars only, validated at boot by `src/lib/env.ts` zod schema
- Do not log plaintext passwords, session IDs, reset tokens, or `Authorization` headers

## Spec Kit workflow (10 gates)

`/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.checklist` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement` → `/speckit.verify` → `/speckit.review` → `/speckit.ship`

Each gate documented in Constitution § Development Workflow & Quality Gates. Constitution Check in `plan.md` runs against the 10 principles.

## Language for AI sessions

User prefers Thai responses for conversational turns; code / specs / technical docs are in English (for international collaborators and long-term project stability).

<!-- MANUAL ADDITIONS END -->
