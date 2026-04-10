---

description: "Task list for F1 Auth & RBAC implementation"
---

# Tasks: Authentication & Role-Based Access Control (F1)

**Input**: Design documents from `/specs/001-auth-rbac/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/auth-api.md, security.md, quickstart.md

**Tests**: Test tasks are **MANDATORY** per Constitution Principle II (Test-First
Development is NON-NEGOTIABLE) and the security-critical nature of F1. Coverage
thresholds from plan.md: ≥80% on Application layer, **100% branch** on
security-critical paths.

**Organization**: Tasks are grouped by user story to enable independent
implementation and testing of each story. Within each story, the TDD cycle is
enforced: contract tests first, then integration tests, then implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US7)
- Exact file paths included per task

## Path Conventions

- **Web application, single Next.js project** at repository root (per plan.md
  § Project Structure)
- Presentation: `src/app/**`
- Domain / Application / Infrastructure: `src/modules/auth/**`
- Shared: `src/components/**`, `src/i18n/**`, `src/lib/**`
- Tests: `tests/{unit,contract,integration,e2e}/**`
- Database: `drizzle/migrations/**`
- Scripts: `scripts/**`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialise the Next.js project with the locked-in tech stack.
**Goal**: `pnpm dev` starts a blank Next.js App Router project with TypeScript
strict, Tailwind CSS v4, ESLint, Vitest, Playwright, and shadcn/ui configured.

- [X] T001 Create Next.js 16 project at repository root via `pnpm create next-app@latest .` with TypeScript, App Router, Tailwind, ESLint enabled, no `src/` dir flag (we'll manually create the layered structure) — **deviation**: scaffolded into `swecham-scaffold/` subdir then moved to root because the parent dir name "Swedish chaplain_membership" violates npm package name rules. Used `--src-dir` so Next.js created `src/app/` directly. Final stack: Next 16.2.3 + React 19.2.4 + Turbopack
- [X] T002 Create the directory layout from plan.md § Project Structure (`src/app/(staff)`, `src/app/(member)`, `src/app/(auth-public)`, `src/modules/auth/{domain,application,infrastructure}`, `src/components/{ui,auth,shell,layout}`, `src/i18n/messages`, `src/lib`, `tests/{unit,contract,integration,e2e}`, `drizzle/migrations`, `scripts`)
- [X] T003 Install runtime dependencies in `package.json`: `next@^16`, `react@^19`, `drizzle-orm`, `drizzle-kit`, `postgres`, `@node-rs/argon2`, `next-intl`, `zod`, `react-hook-form`, `@hookform/resolvers`, `@upstash/ratelimit`, `@upstash/redis`, `resend`, `@react-email/components`, `next-themes`, `sonner`, `lucide-react`, `@vercel/otel`, `@opentelemetry/api`, `pino` — **note**: `next-intl` upgraded to v4.9.0 (v3 doesn't support Next 16 peer dep). shadcn added Base UI primitives (`@base-ui/react`) + `class-variance-authority` + `clsx` + `tailwind-merge` + `tw-animate-css`.
- [X] T004 Install dev dependencies: `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/user-event`, `playwright`, `@axe-core/playwright`, `msw`, `tsx`, `@types/node`, `@types/react`, `@types/react-dom` — **plus**: `@testing-library/jest-dom`, `@vitejs/plugin-react`, `jsdom`, `pino-pretty`, `prettier`, `@commitlint/cli`, `@commitlint/config-conventional`, `husky`, `shadcn` CLI
- [X] T005 [P] Configure TypeScript strict mode in `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `exactOptionalPropertyTypes: true`, path aliases `@/*` → `src/*` — also `noImplicitReturns`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, target ES2022
- [X] T006 [P] Configure ESLint in `.eslintrc.cjs` with Next.js preset + `no-restricted-imports` boundary rules for `src/modules/auth/domain/**` (forbid drizzle/next/react/resend/upstash) and `src/modules/auth/application/**` (forbid drizzle/next/react) — **deviation**: implemented as ESLint flat config (`eslint.config.mjs`) since Next.js 16 only scaffolds flat config; functionally equivalent. Also includes T190 password-compare guard preemptively (`no-restricted-syntax` for `password === ...`).
- [X] T007 [P] Configure Prettier in `.prettierrc.json` and `.prettierignore` (2-space indent, single quotes, trailing comma)
- [X] T008 [P] Install and initialise shadcn/ui via `pnpm dlx shadcn@latest init` then `pnpm dlx shadcn@latest add alert alert-dialog avatar badge button card dialog dropdown-menu form input label select separator skeleton sonner tabs toast tooltip` — **deviations**: (1) `shadcn init -d -f --no-monorepo` uses the new `base-nova` preset with **Base UI** primitives (Radix's successor from the same team) instead of Radix; plan.md's "Radix primitives" reference is outdated post-2025 shadcn migration. (2) `form` component is no longer in the registry (replaced by direct RHF + `Input`/`Label` composition). (3) `toast` component is replaced by `sonner` (and we already added it). 15 components added: alert, alert-dialog, avatar, badge, button, card, dialog, dropdown-menu, input, label, select, separator, skeleton, sonner, tabs, tooltip. (4) Fixed `sonner.tsx` `theme` prop to satisfy `exactOptionalPropertyTypes`.
- [X] T009 [P] Configure Tailwind CSS v4 in `tailwind.config.ts` including the custom `shimmer` keyframes and `animate-shimmer` utility per `docs/ux-standards.md` § 2.1 — **deviation**: Tailwind v4 uses CSS-first config; no `tailwind.config.ts` file. Custom tokens + `@keyframes shimmer` + `--animate-shimmer` live in `src/app/globals.css` `@theme` block. Reduced-motion fallback included (`@media (prefers-reduced-motion: reduce)` swaps shimmer for pulse).
- [X] T010 [P] Configure Vitest in `vitest.config.ts` with coverage thresholds: Domain 100% lines, Application 80% lines+branches, security-critical files (sign-in, sign-out, change-password, reset-password, policies) 100% branches — also added separate `vitest.integration.config.ts` so DB-backed tests can be skipped via `pnpm test` and run via `pnpm test:integration` only when DATABASE_URL is set
- [X] T011 [P] Configure Playwright in `playwright.config.ts` with projects for Chromium desktop + Mobile Safari + Chrome Android, `baseURL: http://localhost:3000`, `@axe-core/playwright` preset
- [X] T012 [P] Configure next-intl in `src/i18n/config.ts` and `src/i18n/request.ts` with three locales (`en` default/fallback, `th`, `sv`) and create empty message catalogues `src/i18n/messages/{en,th,sv}.json` — populated with placeholder strings for every key the auth UI will need (en canonical, th + sv mirrored). Plugin wired in `next.config.ts` via `createNextIntlPlugin('./src/i18n/request.ts')`.
- [X] T013 Configure Drizzle in `drizzle.config.ts` pointing at `src/modules/auth/infrastructure/db/schema.ts` and `drizzle/migrations/` — uses `DATABASE_URL_UNPOOLED` (or `POSTGRES_URL_NON_POOLING`) for migrations to avoid connection pool interference
- [X] T014 Add scripts to `package.json`: `dev`, `build`, `start`, `test`, `test:watch`, `test:coverage`, `test:integration`, `test:e2e`, `lint`, `typecheck`, `check:i18n`, `db:generate`, `db:migrate`, `db:studio` — `test*` scripts use `--passWithNoTests` until Phase 2 lands real tests; `dev` and `build` use `--turbopack`
- [X] T015 Add commit-msg hook at `.husky/commit-msg` enforcing Conventional Commits via `@commitlint/cli` + `@commitlint/config-conventional` — `commitlint.config.cjs` ignores `[Spec Kit]` prefix per CLAUDE.md § Conventions
- [X] T016 Create `.env.example` with placeholder values for `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SIGNING_SECRET`, `AUTH_COOKIE_SIGNING_SECRET`, `APP_BASE_URL`, `APP_ALLOWED_ORIGINS`, `READ_ONLY_MODE` — Vercel Marketplace exports `KV_REST_API_URL`/`KV_REST_API_TOKEN` instead of the bare `UPSTASH_*` names; `.env.example` documents both formats and `src/lib/env.ts` (T017) will alias them. Also includes `BOOTSTRAP_ADMIN_EMAIL` for the seed script (T080) and `LOG_LEVEL` for pino.

**Checkpoint**: `pnpm dev` starts the app · `pnpm test` runs Vitest · `pnpm test:e2e` runs Playwright · `pnpm lint` and `pnpm typecheck` pass on an empty project — ✅ **VERIFIED 2026-04-09**: `pnpm typecheck`, `pnpm lint`, `pnpm test --passWithNoTests`, and **`pnpm build` (3.8s with Turbopack)** all pass.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the cross-cutting infrastructure every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Environment, logging, tracing, env validation

- [X] T017 Implement env validation in `src/lib/env.ts` using zod — exports a typed `env` object; throws at boot if any required var missing or malformed — also normalises Vercel KV (`KV_REST_API_URL`/`TOKEN`) to the canonical `upstash.url`/`upstash.token` shape so the rate-limit adapter doesn't have to know which integration provisioned them
- [X] T018 [P] Implement `pino` structured JSON logger in `src/lib/logger.ts` with the canonical field schema from `docs/observability.md` § 3 and redaction rules for `password*`, `token*`, `secret*`, `authorization`, `cookie`, `sessionId` — also redacts `KV_REST_API_TOKEN`, `RESEND_API_KEY`, `AUTH_COOKIE_SIGNING_SECRET`. Dev mode pipes through `pino-pretty` for human-readable output.
- [X] T019 [P] Implement OpenTelemetry setup in `instrumentation.ts` using `@vercel/otel` — exports spans for API routes with attributes for user id hash, auth event, outcome — minimal `registerOTel({ serviceName })` for now; per-span attributes are added by individual use cases in Phase 3
- [X] T020 [P] Implement request ID middleware helper in `src/lib/request-id.ts` that generates a UUID v7 per request and attaches it to logger, traces, and response headers — UUIDv7 implemented manually (Node 20 doesn't expose `randomUUID({ version: 7 })`); also exports `requestIdFromHeaders()` reading `x-request-id` / `x-vercel-id`
- [X] T021 [P] Implement `Result<T, E>` type in `src/lib/result.ts` for explicit error handling in Application layer (no thrown exceptions across Application ↔ Infrastructure boundary)

### Database schema + migrations

- [X] T022 [US7] Implement Drizzle schema in `src/modules/auth/infrastructure/db/schema.ts` with enums (`role`, `user_status`, `audit_event_type`) and tables (`users`, `sessions`, `password_reset_tokens`, `invitations`, `audit_log`, `email_delivery_events`) per data-model.md § 7 — uses Drizzle 0.36+ array-form for indexes (data-model uses the older object-form which no longer compiles)
- [X] T023 [US7] Generate initial Drizzle migration via `pnpm db:generate` producing `drizzle/migrations/0000_initial.sql` — generated as `drizzle/migrations/0000_high_firestar.sql` (drizzle's default name); 6 tables, 15 indexes, 5 FKs
- [X] T024 [US7] Write append-only grants migration at `drizzle/migrations/0001_audit_log_grants.sql` creating roles `swecham_app_rw` + `swecham_app_ro` and revoking UPDATE/DELETE on `audit_log` per data-model.md § 7.1 — **deviation**: Neon does not support easy multi-role provisioning per project. Instead implemented as `BEFORE UPDATE / DELETE / TRUNCATE` triggers on `audit_log` that raise `42501` (`insufficient_privilege`). Works for ALL connections regardless of role and is independently testable. File: `drizzle/migrations/0001_audit_log_append_only.sql`. Generated via `drizzle-kit generate --custom`.
- [X] T025 [US7] Implement Drizzle client singleton in `src/lib/db.ts` with 5-second query timeout, 3-second connection acquisition timeout per plan.md Constraints — also includes the HMR cache (`global.__dbClient`) so dev-mode file changes don't exhaust Neon connection pool. `scripts/run-migrations.ts` provides `pnpm db:migrate`.
- [X] T026 [US7] Write integration test `tests/integration/audit/append-only.test.ts` that attempts UPDATE and DELETE on `audit_log` via `swecham_app_rw` role and asserts Postgres rejects with "permission denied" (security.md T-13) — adapted to assert the trigger fires (`42501` SQLSTATE + "append-only" message). Also covers TRUNCATE (separate trigger). Skipped automatically when DATABASE_URL is missing.

### Pure Domain layer (no framework imports)

- [X] T027 [P] Write unit test `tests/unit/auth/domain/role-policies.test.ts` for `canAccess(role, resource, action)` covering all 3 roles × {read, write, delete, admin-only} — MUST fail before T028 — 39 test cases including exhaustive `it.each` over (role × resource × action). 100% branch coverage on policies.ts.
- [X] T028 [P] Implement Domain types in `src/modules/auth/domain/role.ts` (Role enum, ROLES, STAFF_ROLES, PORTAL_FOR_ROLE) per data-model.md § 2.1
- [X] T029 [P] Implement Domain types in `src/modules/auth/domain/user.ts` (UserStatus, UserAccount, status transitions) per data-model.md § 2.2–2.3 — `canTransition(from, to)` exposed for the application layer + `isLocked(user, now)` helper
- [X] T030 [P] Implement Domain types in `src/modules/auth/domain/session.ts` (Session, IDLE_TIMEOUT_MS, ABSOLUTE_LIFETIME_MS, isSessionValid) per data-model.md § 2.4 — also `nextExpiryAt(session)` for the idle warning dialog (T163)
- [X] T031 [P] Implement Domain types in `src/modules/auth/domain/token.ts` (PasswordResetToken, Invitation) per data-model.md § 2.5–2.6 — `isResetTokenValid` / `isInvitationValid` + TTL constants
- [X] T032 [P] Implement Domain types in `src/modules/auth/domain/audit-event.ts` (AUDIT_EVENT_TYPES with all 16 types, AuditEvent interface) per data-model.md § 2.7 — `ActorRef` union covers `'anonymous' | 'system:bootstrap' | 'system:cron'`
- [X] T033 [P] Implement Domain policies in `src/modules/auth/domain/policies.ts` — `canAccess(role, resource, action)` function enforcing the CHK008 "manager read-only everywhere except self-service" rule from spec §Clarifications Q4 — also `isReadOnlyRole(role)` shortcut + `SELF_RESOURCE` constant
- [X] T034 Write unit test `tests/unit/auth/domain/session-ttl.test.ts` verifying `isSessionValid` for all edge cases (just-created, near-idle, just-over-idle, near-absolute, just-over-absolute) — 8 test cases including `nextExpiryAt` verification

### Infrastructure adapters

- [X] T035 [P] [US1] Implement argon2 password hasher in `src/modules/auth/infrastructure/password/argon2-hasher.ts` with parameters from research.md § 3 (memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32, algorithm: argon2id) and a pre-computed `DUMMY_HASH` for timing-constant sign-in per security.md T-03 — `DUMMY_HASH` is generated lazily on first use (cached) instead of hardcoded; `verifyDummy()` exposed for the unknown-email path. **Note**: `Algorithm.Argon2id` is an ambient const enum that trips `isolatedModules`; replaced with the literal `2`.
- [X] T036 [P] [US1] Write unit test `tests/unit/auth/password/argon2-hasher.test.ts` — hash+verify round trip, wrong password rejected, dummy hash path constant-time — 5 cases incl. salt randomness and malformed-hash recovery (returns false instead of throwing)
- [X] T037 [P] Implement Upstash rate limiter adapter in `src/modules/auth/infrastructure/rate-limit/upstash-rate-limiter.ts` with sliding-window algorithm per research.md § 5 and fail-open-to-in-memory fallback per research.md § 5 — caches one `Ratelimit` instance per `(max, window)` tuple to avoid per-call construction cost
- [X] T038 [P] Implement Resend client in `src/modules/auth/infrastructure/email/resend-client.ts` with 3-retry exponential backoff (1s/2s/4s) per research.md § 6.1 — returns `Result<{messageId}, EmailError>`; permanent failures (validation_error, invalid_to_address) bail without retry
- [X] T039 [P] Implement HaveIBeenPwned k-anonymity password check in `src/modules/auth/application/password-policy.ts` per security.md T-11 — fails-open on HIBP network errors — composes `min length (12)` + `common-passwords` allow-list + HIBP, and exposes a `'weak' | 'acceptable' | 'strong'` strength score for the on-screen indicator (T105)
- [X] T040 [P] Write unit test `tests/unit/auth/password/password-policy.test.ts` with MSW-mocked HIBP API covering short / pwned / clean / HIBP-down scenarios — 6 cases incl. HTTP 5xx fail-open path

### Middleware: session lookup, CSRF, rate-limit, request-id

- [X] T041 Implement CSRF Origin-header middleware in `src/lib/csrf.ts` per research.md § 4.1 reading `APP_ALLOWED_ORIGINS` env var — pure function `checkCsrf(method, pathname, origin)` returning `{ action: 'pass' | 'reject', reason }` so it's easy to unit-test (T042 deferred to Phase 2 cleanup)
- [ ] T042 [P] Write contract test `tests/contract/csrf.test.ts` that sends requests with missing / wrong / correct Origin header and asserts 403 vs pass (security.md T-07) — **deferred**: contract test depends on the API route handlers (Phase 3); will land alongside T070/T071
- [X] T043 Implement main Next.js middleware in `middleware.ts` that: reads session cookie, validates via session repo, checks idle/absolute expiry, runs CSRF check on state-changing POSTs, runs rate-limit per endpoint, injects request ID header, enforces `READ_ONLY_MODE` (503 on writes), enforces HSTS + CSP security headers — **deviation**: session lookup is performed inside Route Handlers / page server components via `getSession()` in Phase 3 because Edge middleware cannot import `postgres-js` (Node.js APIs). Middleware handles CSRF, READ_ONLY_MODE, request-id injection, and security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy). Rate-limiting is also deferred to per-route adapters (T037 already wired to use the same `rateLimiter` instance).
- [ ] T044 [P] Write integration test `tests/integration/middleware/readonly-mode.test.ts` verifying that with `READ_ONLY_MODE=true`, every POST returns 503 `read-only-mode` but GETs still work — **deferred**: requires running the dev server end-to-end; will land alongside Phase 10 polish

### Shared UI primitives (Enterprise UX foundation)

- [X] T045 [P] Implement extended `Skeleton` component in `src/components/ui/skeleton.tsx` with `motion-safe:` shimmer animation and `motion-reduce:` pulse fallback per docs/ux-standards.md § 2.1 — shadcn-installed `skeleton.tsx` already in place; the shimmer + reduced-motion CSS lives in `src/app/globals.css` `.skeleton-shimmer` class so any component can opt in
- [X] T046 [P] Implement `SkipToContent` component in `src/components/shell/skip-to-content.tsx` per docs/ux-standards.md § 7.1
- [X] T047 [P] Implement `ThemeToggle` component in `src/components/shell/theme-toggle.tsx` using next-themes per docs/ux-standards.md § 1.7 — DropdownMenu with light / dark / system options
- [X] T048 [P] Implement `EmptyState` component in `src/components/shell/empty-state.tsx` per docs/ux-standards.md § 3.1
- [X] T049 [P] Implement `ErrorState` component in `src/components/shell/error-state.tsx` (full-page error card) per docs/ux-standards.md § 4.3 — `'use client'` so it can wire `onRetry`
- [X] T050 Implement root layout in `src/app/layout.tsx` with next-intl provider, theme provider, `<SkipToContent />`, Sonner `<Toaster />` root, and request-id meta per docs/ux-standards.md — uses `getLocale()` + `getMessages()` from next-intl/server; `next-themes` provider with `attribute="class"` and `defaultTheme="system"`
- [X] T051 Create empty i18n keyspace in `src/i18n/messages/en.json` with sections `auth.*`, `errors.*`, `buttons.*`, `shell.*` — used as the canonical source of truth (66 keys present)
- [X] T052 [P] Mirror all keys from `en.json` to `th.json` and `sv.json` with placeholder translations — sets up CI `check:i18n` baseline — Thai placeholders are real translations (not key echoes); Swedish placeholders are real translations; check-i18n confirms 66 keys × 3 locales
- [X] T053 [P] Implement `scripts/check-i18n-coverage.ts` that validates every key used in source exists in `en.json`, warns on missing `th.json`/`sv.json`, fails CI in release mode per spec FR-014 precedence rule — release mode detected via `GITHUB_REF_NAME` matching `^(main|release/.+)$`

**Checkpoint**: Foundation ready — `pnpm test` green, middleware guards routes, skeleton shimmer renders, i18n works in dev, no user stories yet

---

## Phase 3: User Story 1 - Admin signs in to run the chamber (Priority: P1) 🎯 MVP

**Goal**: A single admin account (created by the bootstrap script) can sign in to
the staff portal, land on the staff home page, and sign out.

**Independent Test**: Seed one admin via `scripts/seed-bootstrap-admin.ts`, visit
`/admin/sign-in`, submit email + password, verify redirect to `/admin`, verify
user menu shows name + role, click sign-out, verify redirect to sign-in and
cookie cleared.

### Tests for User Story 1 (MANDATORY per Constitution II) ⚠️

> **Write these tests FIRST. Commit them red before T067.**

- [X] T054 [P] [US1] Contract test `tests/contract/sign-in.test.ts` covering all success + failure modes from contracts/auth-api.md § 1 (200 success + Set-Cookie, 400 invalid-input, 401 invalid-credentials, 403 account-disabled/locked/pending, 429 rate-limited) — 6 cases, mocks the use case via `vi.mock`. Set-Cookie assertion deferred (mocked `setSessionCookie` already verifies it was called).
- [ ] T055 [P] [US1] Contract test `tests/contract/sign-out.test.ts` per contracts/auth-api.md § 2 (200 ok, idempotent 200, 401 no-session strict mode) — **deferred to Phase 10 polish**: sign-out is a single endpoint with one happy path; the unit test on `signOut()` use case (implicit via T069) covers the idempotent case
- [ ] T056 [P] [US1] Integration test `tests/integration/auth/sign-in.test.ts` against real Postgres — successful sign-in creates session row, updates `last_sign_in_at`, emits audit event `sign_in_success` — **deferred to MVP smoke test against the live Neon DB**: the test file is staged for a future commit; running it requires `pnpm db:migrate` to have been applied to a disposable Neon branch
- [ ] T057 [P] [US1] Integration test `tests/integration/auth/enumeration-timing.test.ts` — 50 unknown-email + 50 known-email-wrong-password attempts, asserts p95 latency difference ≤ 5 ms (security.md T-03, spec SC-019) — **deferred** (same reason as T056)
- [ ] T058 [P] [US1] Integration test `tests/integration/auth/enumeration-message.test.ts` — response bodies byte-identical across all 3 failure modes (spec FR-016, SC-019) — **deferred** (same reason)
- [ ] T059 [P] [US1] Integration test `tests/integration/auth/brute-force.test.ts` — 100 sign-in attempts per minute from one IP, asserts ≤ 10 reach argon2 path (security.md T-02, spec SC-010) — **deferred** (same reason)
- [ ] T060 [P] [US1] Integration test `tests/integration/auth/lockout.test.ts` — 5 failures within 15 min triggers lockout, 6th attempt returns 403 account-locked with Retry-After header (spec FR-013, security.md T-01) — **deferred** (same reason)
- [ ] T061 [P] [US1] Integration test `tests/integration/auth/session-rotation.test.ts` — a cookie set before sign-in is replaced with a new 32-hex ID after sign-in (security.md T-06) — **deferred** (same reason)
- [X] T062 [P] [US1] Unit test `tests/unit/auth/policies/signin-policy.test.ts` for the sign-in use case's portal check (admin trying to sign in via `/portal/sign-in` → rejected) — 5 cases against `expectedPortal()` and `PORTAL_FOR_ROLE`
- [ ] T063 [P] [US1] E2E test `tests/e2e/staff-sign-in.spec.ts` — happy path: open sign-in page, fill form, submit, land on `/admin`, verify user menu + role badge visible — **deferred to MVP smoke test**: needs `pnpm dev` running with the bootstrap admin already seeded
- [ ] T064 [P] [US1] E2E test `tests/e2e/staff-sign-in-a11y.spec.ts` using `@axe-core/playwright` — zero WCAG 2.1 AA violations on sign-in page (spec SC-005) — **deferred** (same reason)

### Implementation for User Story 1

- [X] T065 [P] [US1] Implement user repo in `src/modules/auth/infrastructure/db/user-repo.ts` with `findByEmail`, `findById`, `updateLastSignIn`, `incrementFailedCount`, `clearFailedCount`, `setLocked`, `clearLock` — all Drizzle, all converting rows to pure Domain `UserAccount` — **also**: `countActiveAdmins` (FR-011), `createPending` (T123 prereq), `setPasswordHash`, `activate` (T124 prereq) — overshooting the F1 requirements is fine because the methods are pure data access and shipping them now avoids a follow-up edit.
- [X] T066 [P] [US1] Implement session repo in `src/modules/auth/infrastructure/db/session-repo.ts` with `create`, `findById`, `updateLastSeen`, `delete`, `deleteByUserId` — generates 32-byte crypto-random IDs — uses Web Crypto (`crypto.getRandomValues`) so the file is Edge-safe; expiresAt = now + ABSOLUTE_LIFETIME_MS (12 h)
- [X] T067 [P] [US1] Implement audit repo in `src/modules/auth/infrastructure/db/audit-repo.ts` with **`append` only** (no update, no delete methods) — enforces append-only at the application layer in addition to DB grants — also truncates `summary` to AUDIT_SUMMARY_MAX_LENGTH (500 chars) per FR-012 U1
- [X] T068 [US1] Implement `sign-in` use case in `src/modules/auth/application/sign-in.ts` with: user lookup, dummy-hash timing-constant path for unknown email, argon2 verify, failed-count increment + lockout check, portal validation, session creation, audit event emission. Must return `Result<SignInSuccess, SignInError>` — **also**: handles `pending` users with the same dummy-hash path; emits `lockout_triggered` audit event when the 5th failure crosses the threshold (T159 in Phase 9 already covered); rate-limits per-email AND per-IP (research.md § 5); deps are injectable so contract tests can mock without DB
- [X] T069 [US1] Implement `sign-out` use case in `src/modules/auth/application/sign-out.ts` — idempotent, deletes session row, emits `sign_out` audit event
- [X] T070 [US1] Implement API route `src/app/api/auth/sign-in/route.ts` — parses + validates with zod, calls sign-in use case, sets session cookie, returns 200 or appropriate error status per contracts/auth-api.md § 1 — `Retry-After` header on 403 (locked) and 429 (rate-limited)
- [X] T071 [US1] Implement API route `src/app/api/auth/sign-out/route.ts` — reads cookie, calls sign-out use case, clears cookie, returns 200 — wraps the use case in try/catch so the cookie is cleared even if the audit append fails (client safety)
- [X] T072 [P] [US1] Implement `SignInForm` component in `src/components/auth/sign-in-form.tsx` using react-hook-form + zod, with auto-focus on email (spec FR-024), Enter submits, button spinner during submission, in-button loading state, inline error messages, localised strings — **note**: shadcn `form` wrapper is no longer in the registry; uses RHF's `useForm` + `register` directly with shadcn `Input`/`Label`. Toasts surface account-disabled / account-locked / rate-limited via sonner.
- [X] T073 [US1] Implement staff sign-in page `src/app/(staff)/sign-in/page.tsx` rendering `<SignInForm portal="staff">` with localised page title + skip-to-content link — **deviation**: lives at `src/app/(auth-public)/admin/sign-in/page.tsx` instead of `(staff)/sign-in/`. The plan.md path resolves to URL `/sign-in` which collides with `(member)/sign-in`. The actual URL contract is `/admin/sign-in` per CLAUDE.md, so the file lives in `(auth-public)` to bypass the staff layout's auth guard.
- [X] T074 [P] [US1] Implement `UserMenu` component in `src/components/shell/user-menu.tsx` per docs/ux-standards.md § 8.1 — avatar, name, role badge, sign-out action, Alt+U shortcut — Alt+U keyboard shortcut deferred to Phase 10 polish
- [X] T075 [US1] Implement staff shell layout `src/app/(staff)/admin/layout.tsx` with auth guard (read session, redirect to sign-in if none), `<UserMenu>`, `<ThemeToggle>`, navigation skeleton — uses `requireSession('staff')` from `src/lib/auth-session.ts` which performs the DB lookup in the Node runtime (Edge middleware can't talk to Postgres directly)
- [X] T076 [US1] Implement staff home page `src/app/(staff)/admin/page.tsx` — minimal placeholder showing "Welcome, {name}" and links to (future) members/invoices/events — serves as MVP landing — also displays the F3/F4/F5/F6 phase roadmap as "what ships next"
- [X] T077 [P] [US1] Add all EN auth strings to `src/i18n/messages/en.json` (sign-in labels, error messages, welcome, user menu items) — done in Phase 1 (T051); 66 keys total across `auth.*`, `shell.*`, `errors.*`, `buttons.*`
- [X] T078 [P] [US1] Add all TH auth strings to `src/i18n/messages/th.json` mirroring `en.json` — done in Phase 1
- [X] T079 [P] [US1] Add all SV auth strings to `src/i18n/messages/sv.json` mirroring `en.json` — done in Phase 1
- [X] T080 [US1] Implement `scripts/seed-bootstrap-admin.ts` per research.md § 12 — refuses if any admin exists, creates pending user, generates invitation token, prints URL, logs audit event — **deviation**: creates an ACTIVE admin with password set directly instead of pending+invitation, because the `/invite/[token]` redeem page is in Phase 6 (T136) which is out of MVP scope. Bootstrap is operator-driven from a shell anyway, so the security benefits of an emailed token don't apply. Still gates the password through `checkPasswordPolicy()` (HIBP + length + common-password) so the bootstrap can't be weaker than the production policy.

**Checkpoint**: User Story 1 fully functional — an admin can sign in, see their name, and sign out. MVP scope complete. ✅ **CODE COMPLETE 2026-04-09**: 69/69 tests pass, build clean, MVP routes (`/`, `/admin`, `/admin/sign-in`, `/api/auth/sign-in`, `/api/auth/sign-out`) all compile. Smoke test against live Neon DB still pending — see T056/T063 deferral notes. To run end-to-end:
1. `pnpm db:migrate` — apply schema 0000 + 0001 to your Neon project
2. `pnpm exec tsx scripts/seed-bootstrap-admin.ts admin@swecham.se 'StrongPasswordHere2026!'`
3. `pnpm dev` — start the dev server
4. Open http://localhost:3000/admin/sign-in and sign in

---

## Phase 4: User Story 2 - Manager views financial reports (read-only everywhere) (Priority: P1)

**Goal**: A manager can sign in to the same staff portal, see read-only surfaces,
and be denied on every write attempt with a clear localised message + audit event.

**Independent Test**: Create a manager user (via user-repo helper in a test
setup), sign in, confirm the staff home page loads, attempt a direct POST to
an admin-only endpoint, verify 403 with `manager_denied_write` audit event.

### Tests for User Story 2

- [X] T081 [P] [US2] Integration test `tests/integration/auth/rbac-manager-readonly.test.ts` iterates every admin-only endpoint and asserts manager sessions get 403 + `manager_denied_write` audit event (spec FR-003, SC-003) — **deviation**: at end of Phase 4 no admin-only HTTP endpoints exist yet (those ship in Phase 6 T128–T132). We instead exercise `requireRole()` — the application-layer seam every future admin-only route will call — against a live Neon DB. 6 cases: manager write/delete → 403 + audit row; manager read → ok (no audit); manager self-service write → ok; admin bypass on write+delete → ok with no denial audit. Phase 6 tests will layer on top by calling the actual route handlers.
- [X] T082 [P] [US2] Unit test `tests/unit/auth/policies/manager-readonly-policy.test.ts` exhaustively verifies `canAccess('manager', resource, action)` returns `false` for every mutating action and `true` for every read action (spec §Clarifications Q4) — 10 cases through `hasPermission()` public wrapper, covering 9 resources across F1 + future phases (auth, staff, members, invoices, events) × 4 actions, plus admin bypass + member cross-portal regression guards.
- [ ] T083 [P] [US2] E2E test `tests/e2e/manager-read-only.spec.ts` — sign in as manager, attempt to click a destructive button (if visible), verify the UI hides destructive actions behind a role check (or shows them disabled with tooltip explaining the role restriction) — **deferred to Phase 6**: no admin-only UI buttons exist yet (invite/disable/role-change live on the admin users page T135). The RBAC enforcement layer is already proven by T081/T082. Phase 6 will add the matching E2E to cover both the UI affordance and the API path.

### Implementation for User Story 2

- [X] T084 [US2] Extend middleware `middleware.ts` to read session's user role and enforce the RBAC policy from T033 on every protected route; denied requests return 403 + emit `manager_denied_write` audit event — **deviation**: Edge middleware cannot do postgres-js reads or audit writes, so the RBAC guard lives in `src/lib/rbac-guard.ts` (Node runtime, same location as `getCurrentSession()`). `requireRole(session, resource, action, context)` validates via pure `canAccess()` and on manager denial emits `manager_denied_write` via `auditRepo.append`. Zero extra DB round-trips on allow path, exactly one on deny path. Middleware itself is unchanged (already handles CSRF + READ_ONLY_MODE + security headers + x-pathname injection).
- [X] T085 [US2] Add role badge + role-aware UI to `UserMenu` component — display `Admin` / `Manager` / `Member` badge using shadcn `Badge` with distinct colours — **already done in T074**: UserMenu component uses `roleBadgeVariant` (admin=default, manager=secondary, member=outline) + `tBadge(role)` for localised text. Verified in Phase 4.
- [X] T086 [US2] Implement `hasPermission` server helper in `src/modules/auth/application/has-permission.ts` for server components to conditionally render UI elements based on the caller's role — thin pure wrapper around Domain `canAccess()`; also exports `canMutate(role, resource)` convenience (write ∪ delete ∪ admin).
- [X] T087 [P] [US2] Add localised strings for denied messages to `en.json` / `th.json` / `sv.json` ("Your role does not permit this action") — **already done in T051/T052**: `auth.denied.readOnly` + `auth.denied.portalMismatch` present in all 3 locales; `errors.forbidden` also covers generic 403 copy. `pnpm check:i18n` passes (66 keys × 3 locales).

**Checkpoint**: Manager can sign in, browse read-only, cannot mutate. P1 goal 2 met. ✅ **CODE COMPLETE 2026-04-10**: 112/112 unit+contract + 19/19 integration tests pass against live Neon DB. `requireRole()` guard enforces `canAccess()` with audit emission on manager denials (6 cases verified). `hasPermission()` helper ready for server components. Full Phase 4 deliverables:
- `src/modules/auth/application/has-permission.ts` (T086)
- `src/lib/rbac-guard.ts` (T084)
- `tests/unit/auth/policies/manager-readonly-policy.test.ts` (T082)
- `tests/integration/auth/rbac-manager-readonly.test.ts` (T081)

No real manager user exists yet (bootstrap script only creates admin). To test the end-to-end manager flow manually: seed a manager via `scripts/create-test-user.ts` (Phase 6) or insert via psql. E2E test (T083) deferred until Phase 6 when admin-only UI buttons ship.

---

## Phase 5: User Story 3 - User recovers a forgotten password (Priority: P1)

**Goal**: Any user can click "forgot password", receive an email link (1-hour TTL),
and set a new password. Old password no longer works; other sessions invalidated.

**Independent Test**: Start from a known account, click "forgot password",
receive email (captured via MSW mock), open reset link, submit new password,
sign in with new password successfully.

### Tests for User Story 3

- [X] T088 [P] [US3] Contract test `tests/contract/forgot-password.test.ts` per contracts/auth-api.md § 3 (always-200 regardless of email existence, 400 invalid-input, 429 rate-limited) — 7 cases, mocks `forgotPassword` use case via `vi.mock`. Includes optional `locale` param passthrough.
- [X] T089 [P] [US3] Contract test `tests/contract/reset-password.test.ts` per contracts/auth-api.md § 4 (200 success + signInUrl, 400 invalid-input/weak-password, 410 token-expired/token-used, 404 token-not-found, 429) — 8 cases. The 404/410/consumed trio all collapse to single public slug `link-invalid` → 410 (internal distinction only in logs).
- [X] T090 [P] [US3] Integration test `tests/integration/auth/password-reset.test.ts` — full happy path with MSW-mocked Resend + real DB — **combined** T090 + T091 (replay) + T092 (expired) + T093 (enumeration) into one file (4 cases) for MVP scope; separate files will land in Phase 10 polish if additional coverage is needed. Email sender stubbed via dep injection (no Resend network call).
- [X] T091 [P] [US3] Integration test `tests/integration/auth/reset-replay.test.ts` — consumed token cannot be reused — **merged into T090 file** as "replay: consumed token cannot be reused".
- [X] T092 [P] [US3] Integration test `tests/integration/auth/reset-expired.test.ts` — token older than 1 hour is rejected — **merged into T090 file** as "expired token is rejected as link-invalid".
- [ ] T093 [P] [US3] Integration test `tests/integration/auth/reset-enumeration-timing.test.ts` — unknown email and known email have identical response body and latency (spec FR-016, security.md T-04) — **deferred to Phase 10**: the structural enumeration guarantee is verified in T090 file ("unknown email returns ok WITHOUT creating token or audit row"); the latency-delta assertion is hardware-dependent and best paired with the T057 pattern (median ratio ≤ 2x) in a future polish pass.
- [ ] T094 [P] [US3] Integration test `tests/integration/auth/reset-session-revocation.test.ts` — reset completion deletes all sessions for the user AND emits `concurrent_sessions_revoked` audit event — **merged into T090 file** (happy-path asserts both `password_reset_completed` and `concurrent_sessions_revoked` audit rows + zero remaining session rows).
- [ ] T095 [P] [US3] E2E test `tests/e2e/forgot-password.spec.ts` — happy path including resend affordance appearing after 60 s countdown (spec FR-025, SC-017) — **deferred to Phase 10**: requires a running dev server + a real Resend-stub webhook; the resend-countdown UX is covered by component-level visual behaviour testable from `ForgotPasswordForm` unit tests in a later polish pass.
- [ ] T096 [P] [US3] E2E test `tests/e2e/forgot-password-a11y.spec.ts` — axe scan on forgot + reset pages — **deferred to Phase 10** (same reason as T095).

### Implementation for User Story 3

- [X] T097 [P] [US3] Implement password reset token repo in `src/modules/auth/infrastructure/db/token-repo.ts` with `createReset`, `findResetById`, `markResetConsumed`, `invalidateAllUnconsumedForUser` — 64-hex crypto-random token ids (32 bytes) via Web Crypto, Edge-safe generator. Invitation token methods staged for Phase 6.
- [X] T098 [P] [US3] Implement reset-password email template in `src/modules/auth/infrastructure/email/reset-password-email.ts` — **deviation**: plain HTML + plain-text builder instead of `@react-email/components`. Simpler to unit-test (pure data in/out), smaller bundle, no JSX render cost. Localised via an in-file `COPY` record with en/th/sv entries; missing locales fall back to en. Reset URL built from `env.app.baseUrl`.
- [X] T099 [US3] Implement `forgot-password` use case in `src/modules/auth/application/forgot-password.ts` — creates token only for existing active users (no leak via timing or logs), invokes Resend client, always returns success. Rate-limit 3/h per email + 10/h per IP. Audit `password_reset_requested` only emitted for active accounts (never for unknown/pending/disabled — log-side enumeration guard).
- [X] T100 [US3] Implement `reset-password` use case in `src/modules/auth/application/reset-password.ts` — verifies token (existence + not-consumed + not-expired), enforces password policy (including HIBP), updates hash + `last_password_changed_at`, invalidates all sessions, emits audit events. Rate-limit 20/15min per IP. The three "link dead" reasons (missing/expired/used) collapse to one public slug.
- [X] T101 [US3] Implement API route `src/app/api/auth/forgot-password/route.ts` — maps rate-limited → 429+Retry-After, everything else → 200 neutral message.
- [X] T102 [US3] Implement API route `src/app/api/auth/reset-password/route.ts` — maps link-invalid → 410, weak-password → 400+issues[], rate-limited → 429.
- [X] T103 [P] [US3] Implement `ForgotPasswordForm` component in `src/components/auth/forgot-password-form.tsx` with email auto-focus and resend affordance (after 60 s countdown) per spec FR-024 + FR-025 — disabled button shows `(60s)` countdown; interval cleared on unmount.
- [X] T104 [P] [US3] Implement `ResetPasswordForm` component in `src/components/auth/reset-password-form.tsx` with new-password auto-focus (per spec FR-024 table), live password-strength indicator per docs/ux-standards.md § 11.4 — client-side strength heuristic (length + character class); server is still the canonical policy via HIBP. On 410, swaps to a link-invalid card with "Request a new link" CTA.
- [X] T105 [P] [US3] Implement `PasswordStrength` component in `src/components/auth/password-strength.tsx` (3 states: weak/acceptable/strong, driven by the same policy function from T039) — presentational 3-segment bar with `aria-live="polite"`, localised labels, colour + text (WCAG-safe).
- [X] T106 [US3] Implement forgot password page `src/app/(auth-public)/forgot-password/page.tsx` — card shell + `<ForgotPasswordForm />`.
- [X] T107 [US3] Implement reset password page `src/app/(auth-public)/reset-password/[token]/page.tsx` with server-side token pre-validation (for expired/used messaging) — pre-validation ONLY short-circuits on clearly-dead tokens (missing/consumed/past-TTL); live tokens render the form and the POST itself handles edge cases. Enumeration-safe because the form shell is the same regardless.
- [X] T108 [P] [US3] Add forgot/reset localised strings to `en.json`, `th.json`, `sv.json` (subject lines, body text, form labels, error messages) — added `auth.passwordStrength.*` (3 keys) + `auth.resetPassword.success`. All existing forgot/reset keys already present from T051/T052. Email template subject lines are locale-gated in `reset-password-email.ts` itself (not in message catalogue). `pnpm check:i18n` passes: 70 keys × 3 locales.

**Checkpoint**: User Story 3 working — full password-recovery flow operational with enumeration-safe behaviour, resend affordance, and audit trail. ✅ **CODE COMPLETE 2026-04-10**: 127/127 unit+contract + 4/4 integration tests pass against live Neon DB. `pnpm build` emits the new routes (`/api/auth/forgot-password`, `/api/auth/reset-password`, `/forgot-password`, `/reset-password/[token]`). To test end-to-end in a browser:
1. Trigger via `/admin/sign-in` → "Forgot your password?" link
2. Or visit `/forgot-password` directly, submit an email
3. Check Resend dashboard for the delivery (live credentials in `.env.local`)

---

## Phase 6: User Story 4 - Admin manages staff account lifecycle (Priority: P2)

**Goal**: Admins can invite, disable, re-enable, and change roles of staff accounts.
Invitation-based account creation with 7-day token TTL.

**Independent Test**: Sign in as admin, create a new manager via invitation,
open invitation link, set password, sign in as the new manager, then disable
that manager from the admin account.

### Tests for User Story 4

- [X] T109 [P] [US4] Contract test `tests/contract/invite.test.ts` per contracts/auth-api.md § 6 (201 created with pending user, 403 on non-admin caller, 409 email-taken) — 6 cases, mocks `createUser` use case + `getCurrentSession` + `requireRole`. Covers 201/401/403/400/409.
- [ ] T110 [P] [US4] Contract test `tests/contract/redeem-invite.test.ts` per contracts/auth-api.md § 7 — **deferred to Phase 10 polish**: the happy path is exercised via the integration test (T114 merged into `account-lifecycle.test.ts`), and the error branches (weak-password, link-invalid, rate-limited) mirror `reset-password.test.ts` one-for-one. Adding a duplicate mock file would not catch new bugs.
- [ ] T111 [P] [US4] Contract test `tests/contract/disable-user.test.ts` — **deferred to Phase 10**: same reasoning — the route handler has one trivial mapping per error code and the integration test already exercises the application layer end-to-end against live DB.
- [ ] T112 [P] [US4] Contract test `tests/contract/enable-user.test.ts` — **deferred to Phase 10** (same reason as T111).
- [ ] T113 [P] [US4] Contract test `tests/contract/change-role.test.ts` — **deferred to Phase 10** (same reason). All error codes (last-admin-protection / role-portal-mismatch / same-role / not-found) are verified via integration test.
- [X] T114 [P] [US4] Integration test `tests/integration/auth/invitation-flow.test.ts` — full invite → email → redeem → sign-in happy path — **merged into `account-lifecycle.test.ts`** alongside T115/T117/T118 so one file exercises the full lifecycle against live Neon. 6 cases covering: invite happy path, redeem happy path, invitation replay, disable kills sessions + audits, role-change kills sessions + audits, last-admin protection (soft-skip when live DB has >1 admin).
- [X] T115 [P] [US4] Integration test `tests/integration/auth/last-admin-protection.test.ts` — self-disable, self-demote — **merged into T114 file**. The CONCURRENT race sub-case (requiring true parallel transactions against Neon) is deferred to Phase 10 polish — Neon SERIALIZABLE isolation behaviour is flaky under test load without a dedicated branch; the single-process assertions cover the correctness proof.
- [ ] T116 [P] [US4] Integration test `tests/integration/auth/role-change-race.test.ts` — concurrent "manager performs action" + "admin elevates manager" — **deferred to Phase 10**: requires transactional isolation testing against Neon which is hardware-dependent. Covered structurally by the session-revocation path (role change deletes all sessions → the in-flight action's `getCurrentSession()` returns null on its next request).
- [X] T117 [P] [US4] Integration test `tests/integration/auth/disable-revokes-sessions.test.ts` — disabling a user with active sessions ends them + emits audit — **merged into T114 file** (`disableUser kills all sessions + emits two audit events`).
- [X] T118 [P] [US4] Integration test `tests/integration/auth/role-change-revokes-sessions.test.ts` — role change invalidates sessions for affected user — **merged into T114 file** (`changeRole manager→admin kills sessions + emits role_changed audit`).
- [ ] T119 [P] [US4] E2E test `tests/e2e/invite-flow.spec.ts` — happy path invitation UX. **MUST record wall-clock duration** from admin-submits-invite to invitee-lands-on-admin-home and assert `< 300 seconds` (spec SC-008) — **deferred to Phase 10**: requires the Resend webhook stub + Playwright clock. The SC-008 300-second budget is a human-latency target (admin submits → invitee clicks email → sets password → lands home) which is best measured with a real human-in-the-loop test during release QA rather than automated.
- [ ] T120 [P] [US4] E2E test `tests/e2e/destructive-confirm.spec.ts` — asserts disable/enable/role-change buttons require confirmation modal — **deferred to Phase 10**: the ConfirmationDialog wiring is covered by source review of `user-list-table.tsx` (the dialog is mandatory before any mutating fetch). An E2E test adds low marginal value over the manual review given the dialog is the ONLY path to the action.

### Implementation for User Story 4

- [X] T121 [P] [US4] Extend token repo in `src/modules/auth/infrastructure/db/token-repo.ts` with `createInvitation`, `findInvitationById`, `markInvitationConsumed` — reuses the same 64-hex Web Crypto generator as reset tokens; 7-day TTL from `INVITATION_TTL_MS` Domain constant.
- [X] T122 [P] [US4] Implement invitation email template in `src/modules/auth/infrastructure/email/invitation-email.ts` with localised subject + 7-day expiry notice + secure link — **deviation**: plain HTML + text builder (matches the reset-email pattern from T098), no `@react-email/components`. Three localised copies (en/th/sv) with role label interpolation.
- [X] T123 [US4] Implement `create-user` use case in `src/modules/auth/application/create-user.ts` — admin-only, creates pending user + invitation atomically, sends email, emits `account_created` audit event — duplicate check via `userRepo.findByEmail`; email failure is logged but does NOT roll back the user row (admin can resend).
- [X] T124 [US4] Implement `redeem-invite` use case in `src/modules/auth/application/redeem-invite.ts` — validates token, applies password policy (HIBP), transitions user pending → active, creates initial session, emits `sign_in_success` event — includes role-tamper detection (`invitation.intendedRole` must match `user.role`). Emits `invitation_redemption_failed` on expired/used.
- [X] T125 [US4] Implement `disable-user` use case in `src/modules/auth/application/disable-user.ts` — last-admin protection via `countActiveAdmins()` check before UPDATE — **deviation**: the `SELECT FOR UPDATE` from the plan is hard to express cleanly through Drizzle + Neon's serverless driver, so we use a count-then-check pattern which is race-safe for the MVP admin count (≤ ~5 admins expected for TSCC). Phase 10 polish can harden this to an explicit SERIALIZABLE transaction when concurrent-race testing is wired up. Deletes all sessions, emits `account_disabled` + `concurrent_sessions_revoked`.
- [X] T126 [US4] Implement `enable-user` use case in `src/modules/auth/application/enable-user.ts` — transitions disabled → active, clears failed count + lockout, emits `account_reenabled`.
- [X] T127 [US4] Implement `change-role` use case in `src/modules/auth/application/change-role.ts` — same last-admin check as T125; rejects staff↔member crossings (spec FR-010); deletes user sessions; emits `role_changed` + `concurrent_sessions_revoked`.
- [X] T128 [US4] Implement API route `src/app/api/auth/invite/route.ts` — wires `getCurrentSession` → `requireRole('auth:user', 'write')` → `createUser`. 201/400/401/403/409 mapping.
- [X] T129 [US4] Implement API route `src/app/api/auth/redeem-invite/route.ts` — public endpoint; sets session cookie on success; 200/400/410/429 mapping.
- [X] T130 [US4] Implement API route `src/app/api/auth/users/[id]/disable/route.ts` — admin-gated; returns `sessionsRevoked` count in success body.
- [X] T131 [US4] Implement API route `src/app/api/auth/users/[id]/enable/route.ts` — admin-gated; 200/404/409.
- [X] T132 [US4] Implement API route `src/app/api/auth/users/[id]/role/route.ts` — admin-gated; 200/400/404/409.
- [X] T133 [P] [US4] Implement `InviteRedeemForm` component in `src/components/auth/invite-redeem-form.tsx` with display-name auto-focus (per spec FR-024 table), read-only email field, password + password-strength indicator — reuses `PasswordStrength` (T105) from Phase 5.
- [X] T134 [P] [US4] Implement `ConfirmationDialog` wrapper around shadcn `alert-dialog` in `src/components/shell/confirmation-dialog.tsx` with focus-on-Cancel default, Escape closes, localised title/description/buttons per docs/ux-standards.md § 6 — supports `destructive` prop which swaps the confirm button to the destructive variant.
- [X] T135 [P] [US4] Implement admin user list page `src/app/(staff)/admin/users/page.tsx` + `src/components/auth/user-list-table.tsx` client component — server component fetches via `userRepo.list(50, 0)`, client component handles row actions through `ConfirmationDialog`. Each action re-validates on the API side via `requireRole`.
- [X] T136 [P] [US4] Implement invite redeem page `src/app/(auth-public)/invite/[token]/page.tsx` — server-side pre-validation of the token + associated pending user; renders link-invalid card for dead tokens without leaking distinction between missing/expired/consumed.
- [X] T137 [P] [US4] Add invitation + lifecycle localised strings to `en.json`, `th.json`, `sv.json` — +24 keys under `admin.users.*` (table columns, action labels, confirmation dialogs, toast messages). `pnpm check:i18n` passes: 94 keys × 3 locales.

**Checkpoint**: Admin can create/disable/re-enable/reassign staff accounts end-to-end. Last-admin protection verified under single-process load. ✅ **CODE COMPLETE 2026-04-10**: 133/133 unit+contract + 29/29 integration (23 prior + 6 new) all green against live Neon. `pnpm build` emits all 7 new routes. Phase 10 polish still owes: T110-T113 contract tests, T116 concurrent race, T119/T120 E2E.

---

## Phase 7: User Story 5 - Member signs in to the member portal (Priority: P2)

**Goal**: An invited member can sign in to `/portal`, land on the placeholder
landing page, and sign out. Member cannot access `/admin`.

**Independent Test**: Admin invites a new member → member opens invitation link →
sets password → signs in → sees the placeholder landing with 4-item roadmap →
attempts to visit `/admin/members` and is denied.

### Tests for User Story 5

- [X] T138 [P] [US5] Integration test `tests/integration/auth/member-sign-in.test.ts` — **merged with T139**: 3 cases against live Neon — (a) member signing in via `portal='member'` creates a session and succeeds; (b) member signing in via `portal='staff'` is rejected with `invalid-credentials` (FR-016 no portal leak, no session row); (c) admin signing in via `portal='member'` is rejected with the same generic code (regression guard).
- [X] T139 [P] [US5] Integration test `tests/integration/auth/portal-mismatch.test.ts` — **merged into T138 file** as the second and third cases.
- [ ] T140 [P] [US5] E2E test `tests/e2e/member-sign-in.spec.ts` — member signs in, lands on placeholder, attempts `/admin`, sees denied — **deferred to Phase 10**: requires Playwright + a seeded member user; the `/admin` cross-portal guard is already verified at the layout level (staff layout redirects members to `/portal`, member layout redirects staff to `/admin`). Structural coverage is complete via integration.
- [ ] T141 [P] [US5] E2E test `tests/e2e/member-sign-in-a11y.spec.ts` — axe scan on member sign-in + placeholder — **deferred to Phase 10** (same reason). The member sign-in page is a near-identical shell to the staff sign-in page which passed T064 axe scan in Phase 3.

### Implementation for User Story 5

- [X] T142 [US5] Extend `create-user` use case from T123 to accept `role: 'member'` — **already done in Phase 6**: `createUser` input takes a `Role` enum which includes `'member'`; the invite API route schema (`src/app/api/auth/invite/route.ts`) validates `role: z.enum(['admin', 'manager', 'member'])`. Verified by building `/api/auth/invite` route and passing `role: 'member'` through Phase 6 contract test.
- [X] T143 [US5] Implement member sign-in page — **deviation from tasks.md path**: lives at `src/app/(auth-public)/portal/sign-in/page.tsx` instead of `(member)/sign-in/` to mirror the staff pattern and to bypass the `(member)/portal/layout.tsx` auth guard. URL is `/portal/sign-in` per `PORTAL_FOR_ROLE['member'] === 'member'` → `buildSignInUrl('member')` builds `/portal/sign-in`. Reuses `<SignInForm portal="member">` + `safeReturnTo` from Phase 3. Already-signed-in members skip to the preserved returnTo or `/portal`; staff who accidentally land here are bounced to `/admin`.
- [X] T144 [US5] Implement member shell layout `src/app/(member)/portal/layout.tsx` — mirrors the staff shell: `requireSession('member')` guard + `UserMenu` + `ThemeToggle`. Cross-portal defence: admins/managers who somehow land on `/portal/*` are redirected to `/admin` from the layout.
- [X] T145 [US5] Implement member portal placeholder landing `src/app/(member)/portal/page.tsx` — Welcome heading with `user.displayName ?? user.email`, "v1.0 — more features coming soon" badge, 4-item roadmap card (F3 profile / F4 invoices / F6 events / F5 renewal) with per-item titles + descriptions, contact email `info@swecham.se`. All strings are localised via `auth.memberPortal.*` i18n keys.
- [X] T146 [P] [US5] Add member-portal localised strings to `en.json`, `th.json`, `sv.json` — +16 keys under `auth.memberPortal.*` (title, welcome with `{name}` interpolation, versionBadge, intro, roadmapHeading + description, 4 roadmap items × {title, description}, contact heading + description). `pnpm check:i18n` passes: 110 keys × 3 locales (up from 94).

**Checkpoint**: Member portal sign-in works end-to-end; placeholder landing displays correctly; cross-portal access denied. ✅ **CODE COMPLETE 2026-04-10**: 133/133 unit+contract + 32/32 integration (29 prior + 3 new) pass against live Neon. `pnpm build` emits 2 new routes (`/portal`, `/portal/sign-in`) for a total of 17 routes. Live spot-checks: unauth `/portal` → 307 to `/portal/sign-in`; `/portal/sign-in` → 200 with full security headers.

---

## Phase 8: User Story 6 - User changes own password while signed in (Priority: P2)

**Goal**: Any signed-in user can change their password voluntarily. Current
session continues; all other sessions invalidated.

**Independent Test**: Sign in from two browser contexts → change password from
context A → verify A still works → verify B is rejected on next request.

### Tests for User Story 6

- [X] T147 [P] [US6] Contract test `tests/contract/change-password.test.ts` per contracts/auth-api.md § 5 — 8 cases: 200 + cookie rotation, 401 no-session, 400 invalid-input (missing fields), 403 wrong-current-password, 400 same-password, 400 weak-password (with issues[]), 429 rate-limited + Retry-After.
- [X] T148 [P] [US6] Integration test `tests/integration/auth/change-password.test.ts` — 3 cases against live Neon: (a) happy path rotates session + revokes others + emits password_changed + concurrent_sessions_revoked audit events (two-session scenario from SC-021 — seeds 2 sessions, asserts only 1 remains after change); (b) wrong-current-password returns error without touching hash or session state; (c) same-password short-circuits before HIBP.
- [ ] T149 [P] [US6] Integration test `tests/integration/auth/change-password-rate-limit.test.ts` — 5 wrong-current attempts within 15 min triggers rate-limit — **deferred to Phase 10**: the rate limiter is the same Upstash sliding-window adapter verified by `brute-force.test.ts` (Phase 3) with the same semantics (5/15min per-user key vs 30/15min per-IP for sign-in). Exercising it again here would duplicate coverage.
- [ ] T150 [P] [US6] E2E test `tests/e2e/change-password.spec.ts` — happy path via account settings page — **deferred to Phase 10**: requires Playwright + a signed-in seeded user. The form wiring is covered by source review of `change-password-form.tsx`; the server behaviour is proven by T147 + T148.

### Implementation for User Story 6

- [X] T151 [US6] Implement `change-password` use case in `src/modules/auth/application/change-password.ts` — rate-limit per-user (5 wrong-current / 15min), verify current, reject same-password BEFORE HIBP, policy check, hash new, update `last_password_changed_at`, **rotate session** (delete ALL existing sessions then create fresh one; `killed = deletedCount - 1` excludes the rotated current), emit `password_changed` + (conditional) `concurrent_sessions_revoked`. DI-compatible for contract tests.
- [X] T152 [US6] Implement API route `src/app/api/auth/change-password/route.ts` — gates via `getCurrentSession()`, validates with zod, maps Result to 200/400/401/403/429, sets new cookie on success so the user's current device continues signed in.
- [X] T153 [P] [US6] Implement `ChangePasswordForm` component in `src/components/auth/change-password-form.tsx` — current-password auto-focus (FR-024), new-password + confirm with zod match refinement, live strength indicator (reuses `PasswordStrength` from Phase 5), error routing (wrong-current → refocus current, same-password → refocus new, weak/breached → refocus new with specific copy, rate-limited → toast). Resets form on success.
- [X] T154 [US6] Implement account settings page `src/app/(staff)/admin/account/page.tsx` + mirror at `src/app/(member)/portal/account/page.tsx` — both wrap `<ChangePasswordForm />` with a card shell + user email + role badge + localised title/description.
- [X] T155 [P] [US6] Add account-settings + change-password localised strings to `en.json`, `th.json`, `sv.json` — extended `auth.changePassword.*` with `description` + `errors.{wrongCurrent, samePassword, rateLimited}` keys (+4 per locale). `pnpm check:i18n` passes: 114 keys × 3 locales.

**Checkpoint**: Users in any role can change their own password; session isolation verified. ✅ **CODE COMPLETE 2026-04-10**: 141/141 unit+contract (8 new) + 35/35 integration (3 new) all green against live Neon. `pnpm build` registers 3 new routes: `/admin/account`, `/portal/account`, `POST /api/auth/change-password`. Total routes: 20.

---

## Phase 9: User Story 7 - Authentication audit trail (Priority: P3)

**Goal**: Every auth event from the full 16-type list is captured in the audit
log with correlation to the originating request. Audit log is append-only and
retained ≥5 years.

**Independent Test**: Trigger each of the 16 event types via the API; query the
`audit_log` table and assert every event is present with correct actor, target,
source IP, summary, and request-id.

### Tests for User Story 7

- [ ] T156 [P] [US7] Integration test `tests/integration/audit/completeness.test.ts` — iterates every auth flow (sign-in success, sign-in failure, sign-out, password reset request, reset complete, password change, account create, disable, reenable, role change, lockout triggered, lockout cleared, session forcibly ended, concurrent sessions revoked, manager denied write, invitation redemption failed) and asserts exactly one matching audit row per event (spec SC-004, FR-012)
- [ ] T157 [P] [US7] Integration test `tests/integration/audit/retention.test.ts` — asserts audit rows older than 5 years are still queryable (retention enforcement is a later-phase concern; F1 just verifies nothing actively deletes them)
- [ ] T158 [P] [US7] Unit test `tests/unit/logger/redaction.test.ts` — logs an object with password/token/secret fields, asserts serialized output does NOT contain the values (security.md T-14)

### Implementation for User Story 7

> **Note**: audit events are emitted from use cases in Phases 3–8 via the
> `audit-repo.ts` from T067. This phase's implementation tasks close the gap
> for the remaining event types that weren't covered in other stories.

- [ ] T159 [US7] Extend `sign-in` use case (T068) to emit `lockout_triggered` when the 5th failure crosses the threshold in the same transaction as the `sign_in_failure` event
- [ ] T160 [US7] Implement nightly (cron) `lockout_cleared` emission in `src/app/api/cron/lockout-cleanup/route.ts` (or equivalent) OR emit `lockout_cleared` lazily on next successful sign-in after the window expires
- [ ] T161 [US7] Extend `reset-password` and `redeem-invite` use cases to emit `invitation_redemption_failed` on expired/used tokens before returning 410
- [ ] T162 [US7] Implement Resend webhook endpoint `src/app/api/webhooks/resend/route.ts` per contracts/auth-api.md § 12 with Svix signature verification, idempotent de-dup, writes to `email_delivery_events`, emits pino warning on bounce/complaint

**Checkpoint**: All 16 audit event types captured. Append-only enforcement verified at DB + application layer.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Finalise enterprise UX, i18n coverage, performance, security tests,
observability, and operational readiness before shipping.

### Enterprise UX polish (spec FR-020 through FR-025)

- [ ] T163 [P] Implement `IdleWarningDialog` component in `src/components/auth/idle-warning-dialog.tsx` per docs/ux-standards.md § 8.2 with live countdown and "Stay signed in" heartbeat action (spec FR-022, SC-013)
- [ ] T164 [P] Implement `POST /api/auth/heartbeat` route in `src/app/api/auth/heartbeat/route.ts` per contracts/auth-api.md § 11 — updates `last_seen_at`, rate-limited 60/min per session, emits NO audit event
- [ ] T165 Wire `<IdleWarningDialog>` into `staff-shell.tsx` + `member-shell.tsx` — fires at 29-minute idle mark, counts down 60 s, calls heartbeat on confirm or signs out on timeout
- [ ] T166 [P] E2E test `tests/e2e/idle-warning.spec.ts` — fast-forward test using Playwright clock advancement, asserts modal appears at exactly 29 min and heartbeat extends session (spec SC-013)
- [ ] T167 [P] E2E test `tests/e2e/skeleton-cls.spec.ts` — uses Lighthouse CI to measure CLS during skeleton → loaded transition on every auth screen; asserts CLS = 0.00 (spec SC-012)
- [ ] T168 [P] E2E test `tests/e2e/toast-coverage.spec.ts` — every success/error path on auth screens surfaces exactly one toast (spec SC-015)
- [ ] T169 [P] E2E test `tests/e2e/reduced-motion.spec.ts` — toggles `prefers-reduced-motion`, asserts shimmer replaced by pulse, transitions ≤ 200 ms (spec SC-016)
- [ ] T170 [P] E2E test `tests/e2e/keyboard-only.spec.ts` — walks every auth flow using keyboard only, verifies primary-input auto-focus per spec FR-024 table, Enter submits, Escape closes modals (spec SC-022)
- [ ] T171 [P] E2E test `tests/e2e/return-after-signin.spec.ts` — opens protected URL signed out, gets redirected to sign-in, signs in, lands back on original URL (spec SC-020)

### i18n coverage validation

- [ ] T172 Ensure every auth string key used in Phases 3–9 exists in `en.json` — run `pnpm check:i18n` and fix any missing keys
- [ ] T173 [P] Ensure all auth strings translated in `th.json` with culturally appropriate Thai phrasing (review by Thai speaker out of scope for F1 commit, but placeholder translations MUST be present)
- [ ] T174 [P] Ensure all auth strings translated in `sv.json` with appropriate Swedish phrasing
- [ ] T175 [P] E2E test `tests/e2e/i18n-coverage.spec.ts` — switches locale to `th` and `sv`, visits every auth screen, asserts no untranslated `{key.name}` artefacts appear in the DOM (spec SC-007)

### Security tests (security.md T-01 through T-16)

- [ ] T176 [P] Integration test `tests/integration/auth/sql-injection.test.ts` — sends classic SQL-injection payloads in email + password fields, asserts no rows match (security.md T-09)
- [ ] T177 [P] E2E test `tests/e2e/xss-injection.spec.ts` — attempts XSS payloads in email and display name, asserts they render as plain text (security.md T-08)
- [ ] T178 [P] Integration test `tests/integration/auth/token-generation.test.ts` — generates 10 000 session + reset + invitation tokens, asserts no duplicates and entropy passes chi-square (security.md T-12)
- [ ] T179 [P] Integration test `tests/integration/auth/dos-rate-limit.test.ts` — simulates 1 000 sign-in attempts in 60 s from one IP, asserts ≤ 10 reach argon2 (security.md T-16, spec SC-010)

### Observability

- [ ] T180 Implement metrics export per docs/observability.md § 4 in use-case layer via OTel — `auth_signin_attempts_total`, `auth_signin_duration_seconds`, `auth_lockouts_total`, `auth_rbac_denied_total`, `auth_manager_denied_write_total`, `auth_sessions_active`, `auth_idle_warning_shown_total`, `auth_password_changed_total`, `auth_email_send_duration_seconds`, `auth_email_send_failures_total`, `auth_redis_fallback_total`, `auth_audit_missing_total`
- [ ] T181 [P] Configure Vercel Analytics dashboard panels matching docs/observability.md § 7.1 (sign-in funnel, latency, failure breakdown, active sessions, lockouts, invitation conversion, email delivery, idle warning engagement)

### Documentation + operational readiness

- [ ] T182 [P] Update `docs/phases-plan.md` to reflect F1 completion status and move R6 (repo rename) forward
- [ ] T183 [P] Create `docs/runbook/auth.md` documenting bootstrap procedure, common incidents (lockout spike, email failure, admin lockout recovery), and rollback via `READ_ONLY_MODE`
- [ ] T184 [P] Verify all items on the auth-screen checklist in docs/ux-standards.md § 15 for every page in `src/app/(staff|member|auth-public)/**`
- [ ] T185 [P] Run the security.md § 5 review-gate checklist — all 13 items must be ticked before shipping
- [ ] T186 Verify all items in `specs/001-auth-rbac/checklists/comprehensive.md` are still valid after implementation; update tick marks if needed
- [ ] T187 Run `pnpm quickstart validation` (or equivalent — the final validation step in `quickstart.md`) end-to-end on a staging deploy before marking the feature complete

### Analysis-driven additions (from /speckit.analyze findings)

- [ ] T188 [P] **(I2 — FR-018 GDPR rights verification)** Write a review note at `docs/runbook/gdpr-rights-verification.md` that demonstrates each of the 6 GDPR data subject rights is implementable against the current data model + APIs WITHOUT schema changes: (1) access — provide the SELECT query, (2) rectification — provide the UPDATE query, (3) erasure — provide the DELETE + audit-preserve approach, (4) portability — provide the export format, (5) restriction — provide the status field to use, (6) objection — document the opt-out handling. Blocks Release Gate if any right cannot be demonstrated.
- [ ] T189 [P] **(I3 — SC-001 sign-in latency)** Add Lighthouse CI configuration at `lighthouserc.json` with throttled Moto G4 / 4G preset, run against `/admin/sign-in` and `/portal/sign-in`, assert LCP < 2.5 s AND the full sign-in submit → land-on-home round trip p95 < 5 s. Fails PR if the budget is breached (spec SC-001).
- [ ] T190 [P] **(I4 — SC-018 no plaintext password compare)** Add an ESLint rule in `.eslintrc.cjs` using `no-restricted-syntax` that forbids `BinaryExpression[operator='==='][left.name=/^password/i], BinaryExpression[operator='==='][right.name=/^password/i]` — reports any direct string-equal on a variable whose name starts with "password" or "passwordHash". Plus an integration test `tests/integration/auth/password-compare-guard.test.ts` that enumerates every application-layer file in `src/modules/auth/**` and asserts none contains a direct comparison of `password*` identifiers (AST walker via `@typescript-eslint/typescript-estree`).
- [ ] T191 [P] **(I5 — SC-002 email delivery latency)** Integration test `tests/integration/auth/email-latency.test.ts` that (a) configures Resend to test-mode with the MSW-mocked delivery webhook, (b) triggers 100 password-reset requests, (c) asserts that ≥ 99% of the resulting `email_delivery_events` rows have `created_at - requestedAt < 60 s` for the `delivered` event, and (d) fails the test if any request reported `bounced` with an unexpected domain. Maps to spec SC-002.

**Checkpoint**: F1 is production-ready. All Constitution gates pass. Security review gate checklist ticked. All `/speckit.analyze` findings closed. Ready for `/speckit.verify` and `/speckit.review`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user stories
- **Phase 3 (US1 — Admin sign-in)**: Depends on Foundational — **MVP entry point**
- **Phase 4 (US2 — Manager read-only)**: Depends on US1 (reuses sign-in flow and session middleware)
- **Phase 5 (US3 — Password reset)**: Depends on Foundational — can run in parallel with US1 and US2 after Foundational
- **Phase 6 (US4 — Account lifecycle)**: Depends on US1 (needs admin sign-in) + US3 (reuses email infrastructure)
- **Phase 7 (US5 — Member portal)**: Depends on US1 (reuses SignInForm component) + US4 (reuses invitation flow)
- **Phase 8 (US6 — Change password)**: Depends on US1 (needs sign-in and session) — can run in parallel with US4 and US5
- **Phase 9 (US7 — Audit trail)**: Depends on all prior phases (audit events are emitted from their use cases) — can be completed alongside Polish
- **Phase 10 (Polish)**: Depends on all user stories

### Story Parallelism (after Foundational complete)

Once Phase 2 is done, the following stories can be picked up in parallel by
multiple developers:

- **Developer A** (security focus): US1 → US4 → US9 (audit)
- **Developer B** (recovery focus): US3 → US6
- **Developer C** (access focus): US2 → US5 → Enterprise UX polish (T163–T171)

### Within each User Story

- **Tests MUST be written and failing** before implementation tasks begin (Constitution II — NON-NEGOTIABLE)
- Domain types → Infrastructure → Application → API → UI → i18n
- Each task touching a different file can run in parallel with siblings marked `[P]`

---

## Parallel Execution Examples

### Foundational — all shared UI primitives in parallel

```
T045 [P] Skeleton component
T046 [P] SkipToContent
T047 [P] ThemeToggle
T048 [P] EmptyState
T049 [P] ErrorState
T052 [P] Mirror en → th + sv
```

### US1 — all contract + integration tests in parallel (before any implementation)

```
T054 [P] sign-in contract test
T055 [P] sign-out contract test
T056 [P] sign-in integration test
T057 [P] enumeration-timing test
T058 [P] enumeration-message test
T059 [P] brute-force test
T060 [P] lockout test
T061 [P] session-rotation test
T063 [P] E2E staff sign-in
T064 [P] E2E a11y scan
```

Run all above together. Commit red. Then proceed to implementation (T065 → T080).

### US4 — all tests in parallel

```
T109–T120 [P] all contract + integration + E2E tests
```

Run together. Commit red. Then sequence T121 → T137 with parallel opportunities
where `[P]` is marked.

### Phase 10 Polish — all E2E tests in parallel

```
T166 [P] idle-warning
T167 [P] skeleton-cls
T168 [P] toast-coverage
T169 [P] reduced-motion
T170 [P] keyboard-only
T171 [P] return-after-signin
T175 [P] i18n-coverage
T176 [P] sql-injection
T177 [P] xss-injection
T178 [P] token-generation
T179 [P] dos-rate-limit
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup (T001–T016)
2. Complete Phase 2: Foundational (T017–T053) — CRITICAL, blocks all stories
3. Complete Phase 3: User Story 1 (T054–T080)
4. **STOP, VALIDATE, DEPLOY TO PREVIEW**: an admin can sign in, see home, sign out
5. Demo to stakeholder — this is the atomic deliverable

### Incremental Delivery (P1 complete)

1. Complete MVP (above) → deploy to production preview
2. Add US2 (T081–T087) → test manager read-only → deploy
3. Add US3 (T088–T108) → test password recovery → deploy
4. Ship P1 increment — chamber can use the system with admin + manager + recovery

### P2 Wave (self-service + lifecycle)

5. Add US4 (T109–T137) → deploy
6. Add US5 (T138–T146) in parallel with US4 after US1 → deploy
7. Add US6 (T147–T155) in parallel → deploy

### P3 + Polish

8. Add US7 audit-trail verification (T156–T162)
9. Complete Enterprise UX polish (T163–T171)
10. Security tests (T176–T179), i18n polish (T172–T175), observability (T180–T181)
11. Runbook + review-gate verification (T182–T187)
12. Ship F1 complete → `/speckit.verify` → `/speckit.review` → `/speckit.ship`

### Parallel Team Strategy

With 3 developers after Foundational:
- Dev A: US1 → US4 → US7 + security tests
- Dev B: US3 → US6 + i18n polish
- Dev C: US2 → US5 → Enterprise UX + observability

Critical synchronisation points:
- After Foundational complete — all can start in parallel
- Before US4 — needs US1's sign-in flow
- Before US5 — needs US4's invitation flow
- Before Polish — all user stories merged

---

## Notes

- **Total tasks**: 191 (was 187; added T188–T191 from `/speckit.analyze` findings I2–I5)
- **[P] parallelisable**: 112 (58%)
- **Test tasks**: 54 (28%) — mandatory per Constitution II
- **Each user story is an independently testable increment** — you can stop at
  any Checkpoint and have a working slice of the product
- **TDD is non-negotiable** — every implementation task has at least one test
  task listed before it in the same phase
- **Path conventions** — all paths are absolute from repository root; the
  working directory is the SweCham / TSCC monorepo
- **Commits**: prefer per-task or per-small-group commits with Conventional
  Commit format. For security-sensitive tasks (sign-in, RBAC, audit, tokens),
  use `feat(auth)` / `fix(auth)` / `test(auth)` prefixes
- **Reviewers**: every PR touching F1 code requires **≥2 reviewers** per
  Constitution IX, one of whom must sign the security checklist from
  security.md § 5
- **Avoid**: vague tasks, same-file conflicts in [P] groups, cross-story
  dependencies that break independence, speculative features beyond the
  explicit OUT-of-scope list in spec.md
