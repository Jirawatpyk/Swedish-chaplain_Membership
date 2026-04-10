# F1 Quickstart — Auth & RBAC Developer Guide

**Feature**: 001-auth-rbac
**Audience**: Developers picking up F1 implementation
**Prerequisites**: Node.js 22 LTS, pnpm 9, Docker (for local Postgres), Vercel CLI, a Vercel team with Marketplace access

This quickstart walks through:
1. Bootstrapping the repo for F1 development
2. Provisioning Vercel Marketplace resources (Neon, Upstash, Resend)
3. Running the dev server, migrations, tests, and seed script locally
4. Deploying a preview and promoting to production

It is NOT a user manual for the authentication feature itself — for that, see
`spec.md`.

---

## 1. One-time local setup

### 1.1 Install tooling

```bash
# Node LTS via volta / nvm / fnm
node -v      # → v22.x
pnpm -v      # → 9.x
docker -v    # for local Postgres / Upstash Redis emulation
vercel --version   # Vercel CLI (install: npm i -g vercel)
```

### 1.2 Install dependencies

```bash
cd swecham-membership     # repo folder (to be renamed from Swedish chaplain_membership)
pnpm install
```

This installs all packages declared in `package.json` including:
- `next`, `react`, `typescript`
- `drizzle-orm`, `drizzle-kit`, `pg`
- `@node-rs/argon2`
- `next-intl`, `zod`, `react-hook-form`
- `@upstash/ratelimit`, `@upstash/redis`, `resend`
- `tailwindcss@^4`, `lucide-react`
- `vitest`, `playwright`, `@axe-core/playwright`, `msw`
- `pino`, `@vercel/otel`, `@opentelemetry/api`

### 1.3 Link to Vercel

```bash
vercel link
```

Follow the prompts to link this repo to the `swecham` Vercel team. If the
team does not exist yet, create it in the dashboard first.

---

## 2. Provision Vercel Marketplace resources

F1 depends on three Marketplace products. Each is a one-click provision.

### 2.1 Neon Postgres

```bash
# Via the Vercel dashboard:
# Project → Storage → Create Database → Neon
# Region: Singapore (ap-southeast-1)
# Plan: Free (sufficient for F1)
```

After provisioning, `DATABASE_URL` is automatically added to your Vercel
environment variables (Preview + Production). Pull it locally:

```bash
vercel env pull .env.local
```

### 2.2 Upstash Redis

```bash
# Dashboard → Storage → Create Database → Upstash for Redis
# Region: Singapore
# Plan: Free
```

This adds `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to env vars.

### 2.3 Resend (transactional email)

```bash
# Dashboard → Integrations → Marketplace → Resend → Install
```

This adds `RESEND_API_KEY`. Verify your sending domain in the Resend dashboard
(typically `swecham.example`).

### 2.4 Refresh local env

```bash
vercel env pull .env.local
```

Confirm `.env.local` now contains:

```dotenv
DATABASE_URL=postgres://...
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=SweCham <noreply@zyncdata.app>
APP_BASE_URL=http://localhost:3100
APP_ALLOWED_ORIGINS=http://localhost:3100,http://localhost:3000
AUTH_COOKIE_SIGNING_SECRET=<generated below>
```

**Port note**: the dev server runs on **port 3100** (not 3000) to avoid
colliding with other local Express projects the operator may keep on 3000.
`package.json` pins it via `next dev --port 3100`. `APP_ALLOWED_ORIGINS`
includes both ports so either one works during local dev.

### 2.5 Generate auth cookie signing secret

```bash
# Random 32-byte base64 secret
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the output as `AUTH_COOKIE_SIGNING_SECRET` in `.env.local` AND in Vercel
env vars (Preview + Production) via `vercel env add`.

---

## 3. Database migrations

```bash
# Generate a migration from the current Drizzle schema
pnpm drizzle-kit generate

# Apply migrations to the linked Neon DB
pnpm drizzle-kit migrate
```

The migration creates: `users`, `sessions`, `password_reset_tokens`,
`invitations`, `audit_log`, plus the enum types, indices, and the append-only
grants from `data-model.md` § 7.1.

**For local integration tests** we use a separate Postgres instance — see
§ 5.2.

---

## 4. Running the dev server

```bash
pnpm dev
```

Opens `http://localhost:3100`. The app supports three routes at start:

- `/admin/sign-in` — staff portal sign-in
- `/portal/sign-in` — member portal sign-in
- `/forgot-password` — shared recovery entry point

Before you can sign in, you need at least one admin account — see § 6.

---

## 5. Tests

### 5.1 Unit tests

```bash
pnpm test           # vitest run (watch: pnpm test:watch)
pnpm test:coverage  # with coverage thresholds
```

Coverage enforced in `vitest.config.ts`:
- Domain: 100% line
- Application: 80% line, 80% branch
- Security-critical use cases: 100% branch (sign-in, change-password, reset-password, role policy, sign-out)

### 5.2 Integration tests

Integration tests run **against live Neon Singapore** using the
`DATABASE_URL` from `.env.local` — NOT against a local Docker container.
This trade was made during Phase 5 implementation: integration tests already
need to catch real Postgres behaviour (triggers, enum values, RLS, etc.) that
a Docker container could diverge from as migrations evolve. Running against
the same Neon instance the dev server uses is higher fidelity and removes
the "did I forget to `drizzle-kit migrate` the Docker DB?" failure mode.

```bash
pnpm test:integration
```

The integration test helper (`tests/integration/helpers/test-users.ts`) creates
rows with unique email suffixes per test run (`test-${Date.now()}-${rand}@swecham.test`)
and deletes them in `afterEach`. Cascade cleans up sessions / tokens / invitations;
`audit_log` rows are preserved by the append-only trigger (0001 migration).
Stale rows from crashed runs can be cleaned up manually — see
`docs/runbook/auth.md § 4` for the SQL.

**Historical note**: a Docker-based workflow was described in earlier drafts
of this quickstart. It has been retired. If you need a disposable Postgres
for experiments outside the test suite, use a Neon branch via
`neonctl branches create` instead.

### 5.3 E2E tests

```bash
# First-time only: install Playwright browsers
pnpm exec playwright install --with-deps

# Run E2E against a local dev server
pnpm test:e2e

# Run only the a11y suite
pnpm test:e2e --grep "@a11y"

# Run only the i18n coverage suite
pnpm test:e2e --grep "@i18n"
```

Playwright is configured in `playwright.config.ts` to run against
`http://localhost:3100` by default (the dev server port; see § 4). For CI,
point `PLAYWRIGHT_BASE_URL` at the Vercel preview deploy URL.

**Local worker cap**: `playwright.config.ts` pins local runs to
`workers: 3` (one per browser project). This is a workaround for Turbopack's
on-demand compile model — 6 parallel workers hitting the same uncompiled
route cause cascade timeouts. CI uses `workers: 1` (deterministic).

**E2E env vars required**: `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`,
`E2E_MANAGER_EMAIL`, `E2E_MANAGER_PASSWORD`, `E2E_MEMBER_EMAIL`,
`E2E_MEMBER_PASSWORD`, `E2E_LOCKOUT_EMAIL`, `E2E_LOCKOUT_PASSWORD`. If any
pair is missing, the dependent specs call `test.skip()` silently — which
can result in a misleading "N passed" summary. Export all four pairs or
seed the 4 E2E users via `pnpm tsx scripts/seed-e2e-user.ts` (which also
prints the exact export lines).

### 5.4 i18n coverage check

A standalone script ensures every key used in source exists in every locale:

```bash
pnpm check:i18n
```

- Missing EN keys → **build fails** (EN is canonical).
- Missing TH or SV keys → **warning** + fallback to EN at runtime (allowed in
  dev, blocked in CI for release branches).

### 5.5 Full test pipeline (as CI runs it)

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:integration && pnpm test:e2e
```

---

## 6. Bootstrap the first admin account

The first admin account is created via a one-off seed script (see
`research.md` § 12).

```bash
# Set the target email (must be a real inbox)
export BOOTSTRAP_ADMIN_EMAIL=first.admin@swecham.example

# Run the seed
pnpm tsx scripts/seed-bootstrap-admin.ts
```

Output:

```
✓ Created pending admin user: first.admin@swecham.example
✓ Generated invitation token (7-day TTL)
Open this URL in a browser to set your password:

  http://localhost:3100/invite/01934f...

Audit log: account_created (actor=system:bootstrap, target=first.admin@swecham.example)
```

Open the URL, set a password, and you are now signed in as an admin. You can
now invite more staff via the staff portal UI.

The script refuses to run if any admin already exists — it is safe to invoke
repeatedly without risk of duplicate bootstrap.

---

## 7. Deploy to Vercel

### 7.1 Preview deploy (per PR)

Every PR automatically gets a preview deploy. The build command runs:

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm build
```

If any step fails, the preview deploy fails. Fix and push again.

### 7.2 Production deploy

Production is deployed automatically on merge to `main` (after PR review
with **≥2 reviewers** for security-sensitive F1). The first production
deploy also needs a one-time bootstrap admin seed:

```bash
# From local machine, against the production DB
DATABASE_URL=$(vercel env pull --environment=production stdout DATABASE_URL) \
  BOOTSTRAP_ADMIN_EMAIL=real.admin@swecham.se \
  pnpm tsx scripts/seed-bootstrap-admin.ts
```

The seed script prints an invitation URL pointing at the production domain.
Send that URL to the first admin via a secure channel (in person, or via a
different messaging system).

### 7.3 Rollback & emergency read-only mode

**Primary rollback mechanism — Vercel promote**:

```bash
# List recent production deployments
vercel ls

# Promote an older deployment back to production
vercel promote <deployment-url>
```

Rollbacks revert the code AND the serverless function instance, but do NOT
revert database migrations. Destructive DB migrations are avoided in F1 by
design; if a rollback requires undoing a migration, that is a runbook concern
(out of F1 scope).

**Emergency read-only mode — `READ_ONLY_MODE` env var**:

If the new auth is misbehaving and a full Vercel rollback is too coarse
(e.g., you want to preserve a fix in a different module that's also in the
latest deploy), set `READ_ONLY_MODE=true` in Vercel env vars:

```bash
# Via CLI
vercel env add READ_ONLY_MODE production
# Enter: true

# Or via Vercel dashboard:
# Project → Settings → Environment Variables → add READ_ONLY_MODE = true (Production scope)
# Then: Deployments → Redeploy latest production (picks up the new env var)
```

When `READ_ONLY_MODE=true`:
- All state-changing POST / PUT / PATCH / DELETE routes under `/api/**`
  return **503 `read-only-mode`** with a localised message
- Sign-in is explicitly **allowed** (it creates a session row but is
  tolerated as a read-after-write exception)
- Reads continue to work normally — users can still sign in, view data,
  and navigate the UI
- A banner appears on every authenticated page: "Read-only mode active —
  changes are temporarily disabled"
- The env-var change is **reversible in 30 seconds** without a code deploy

Revert by setting `READ_ONLY_MODE=false` (or removing the var) and
redeploying.

Use this when:
- A specific endpoint is causing data corruption and you want to freeze
  writes while you debug
- You're preparing a critical migration and want to quiesce the system
- A security incident demands a write freeze while you investigate

Do **not** use this as a routine maintenance mechanism — it's an
emergency lever.

---

## 8. Observability

### 8.1 Logs

Vercel Functions logs are accessible via:

```bash
vercel logs <deployment-url>
```

Or via the dashboard → Deployments → [choose deployment] → Functions tab.

Log format is structured JSON (pino) with these canonical fields:

```json
{
  "level": "info",
  "time": "2026-04-09T10:23:15.123Z",
  "requestId": "0192f0a1-1234-7000-8000-000000000000",
  "userId": "hashed:a1b2c3...",
  "event": "sign_in_success",
  "portal": "staff",
  "msg": "User signed in"
}
```

**Never** log plaintext passwords, session IDs, reset tokens, or raw
`Authorization` headers. A CI lint rule blocks common mistakes.

### 8.2 Traces

`@vercel/otel` is initialised in `instrumentation.ts`. Each API request is a
span with attributes for `user.id.hash`, `auth.event`, `auth.outcome`. Traces
are automatically exported to the Vercel OpenTelemetry collector.

### 8.3 Audit log viewer

The `audit_log` table is queryable via a read-only Postgres role
(`swecham_app_ro`). A proper UI is deferred to a later feature; for F1, use:

```bash
psql $DATABASE_URL -c "
  SELECT timestamp, event_type, actor_user_id, target_user_id, summary
  FROM audit_log
  ORDER BY timestamp DESC
  LIMIT 50;
"
```

---

## 9. Common developer workflows

### 9.1 Add a new use case

1. Add a failing test in `tests/contract/<name>.test.ts` AND
   `tests/integration/auth/<name>.test.ts`. Commit them red.
2. Add the domain type in `src/modules/auth/domain/` if a new concept.
3. Add the use-case function in `src/modules/auth/application/<name>.ts`.
4. Add the infrastructure adapter (repo method, email template, etc.).
5. Add the API route handler in `src/app/api/auth/<name>/route.ts`.
6. Add the Presentation component if user-facing.
7. Add i18n keys in `en.json` (build fails without) and TH / SV (warning).
8. Add the E2E test in `tests/e2e/<name>.spec.ts`.
9. Commit green. PR. ≥2 reviewers on security-sensitive F1 paths.

### 9.2 Update a locale string

1. Add/edit the key in `src/i18n/messages/en.json`.
2. Add the same key in `th.json` and `sv.json`.
3. Run `pnpm check:i18n` to verify.
4. If you skip `th.json` or `sv.json`, a runtime warning is logged in dev
   but CI will fail for release branches.

### 9.3 Inspect a session

```bash
psql $DATABASE_URL -c "
  SELECT s.id, u.email, u.role, s.created_at, s.last_seen_at, s.expires_at
  FROM sessions s JOIN users u ON s.user_id = u.id
  ORDER BY s.last_seen_at DESC;
"
```

### 9.4 Forcibly end all sessions

```sql
-- In the DB console, as swecham_app_rw role
DELETE FROM sessions;
-- Audit log: insert session_forcibly_ended via the use case, NOT directly
```

(Use the `scripts/end-all-sessions.ts` helper to do this with audit logging
attached.)

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `vercel env pull` fails | Not linked to the right Vercel project | Re-run `vercel link` |
| Drizzle migration fails with "role does not exist" | App role not created | Apply `drizzle/migrations/000x_audit_log_grants.sql` first |
| Sign-in returns 401 immediately even for correct creds | Cookie not being set — check `APP_BASE_URL` matches the domain | |
| Sign-in p95 > 1s in dev | argon2 parameters too high for dev CPU | Do NOT lower for dev; accept slower dev UX. The prod hardware hits 50 ms |
| i18n keys missing in TH / SV | Run `pnpm check:i18n` to list | Add the missing keys |
| Playwright tests flaky | Usually auth cookie not being cleared between tests | Use `test.use({ storageState: { cookies: [], origins: [] } })` |
| Rate-limit errors on every sign-in in tests | Upstash shared between tests | Use the `@upstash/ratelimit` test mode or mock via MSW |

---

## 11. Where to look next

- Spec (business): [`spec.md`](./spec.md)
- Plan (architecture): [`plan.md`](./plan.md)
- Research (decisions + alternatives): [`research.md`](./research.md)
- Data model (entities + SQL): [`data-model.md`](./data-model.md)
- API contracts: [`contracts/auth-api.md`](./contracts/auth-api.md)
- Constitution (governance): [`../../.specify/memory/constitution.md`](../../.specify/memory/constitution.md)
- Phases plan (roadmap): [`../../docs/phases-plan.md`](../../docs/phases-plan.md)
