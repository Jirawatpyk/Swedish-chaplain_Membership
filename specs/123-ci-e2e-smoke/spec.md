# Spec 123: e2e in CI and a post-deploy smoke test

**Size**: L (CI infrastructure, secrets, a disposable database per run, a new public endpoint, production checks) · **Slices**: 2 · **Flow**: `feature-flow` · **Created**: 2026-10-17

## Why

- **e2e has no CI job.** It runs only on the maintainer's machine, and every PR needs a manual local verification round (the R## rounds) to catch UI regressions. Of 184 spec files, none runs automatically.
- **Nothing checks production after a deploy.** Every merge to `main` deploys to production. The only check today is the deployment status reaching `READY`; no one tests that the live site answers and reaches its database.

## Decisions taken with the maintainer (2026-10-17)

| Question | Answer |
|---|---|
| How much e2e per PR? | A `@critical` subset on chromium + mobile-chrome per PR, plus the full suite on chromium every night. Not a required check at first. |
| Which database? | A new Neon branch per run, created from the CI branch, which holds no real data. It is migrated and seeded by the existing scripts, then deleted. |
| How deep is the production smoke? | Public pages plus a new `/api/health` that pings the database. A failure alerts through a GitHub issue; there is no automatic rollback. |
| Blob, Redis and app mode in CI | A separate Blob store and Upstash database for CI; `next build` + `next start`. |

## User stories

### US1 — Production is checked after every deploy (slice 1)

As the maintainer, I learn within minutes when a production deploy leaves the site down or cut off from its database, so I can roll back before members notice.

**Done when**
- DW-1: When Vercel reports a **production** deployment as successful, the `post-deploy-smoke` GitHub workflow runs against that deployment's production URL. A preview deployment never triggers it.
- DW-2: The workflow passes only if `GET /admin/sign-in` and `GET /portal/sign-in` return 200 with a sign-in form, and `GET /api/health` returns 200 with body `{"status":"ok"}`.
- DW-3: `GET /api/health` runs `select 1` against the database with a 3-second limit. If that fails or times out, it returns 503 with `{"status":"degraded"}`. The body never holds a version, an environment name, a tenant, a hostname or error text. The response carries `Cache-Control: no-store` and needs no session.
- DW-4: A failed run opens a GitHub issue labelled `prod-smoke`, or comments on the open one. The issue names the deployment URL, the commit and every failed check.
- DW-5: `docs/runbooks/post-deploy-smoke.md` says what a failure means and how to roll back (`vercel promote <previous-deployment-url>`).

### US2 — Every PR runs the critical e2e paths (slice 2)

As the maintainer, I see a PR break a critical user path in CI, without running e2e locally by hand.

**Done when**
- DW-6: Every non-fork PR runs the `e2e-critical` workflow. It creates a Neon branch `ci-e2e/<run-id>` from the CI branch, migrates it, seeds the personas and fixtures, boots the app, and runs every spec tagged `@critical` on chromium and mobile-chrome with `--workers=1`. Fork PRs skip it with a notice, because they get no secrets.
- DW-7: The `@critical` tag sits on the specs named in `plan.md` § Critical set. Together they cover admin sign-in, the dashboard, the members directory, issuing and viewing an invoice, the payment flow with Stripe stubbed, member sign-in, and the member portal home and profile. The job finishes in 25 minutes or less.
- DW-8: The run's Neon branch is deleted in an `always()` step, pass or fail. A sweep deletes any `ci-e2e/*` branch older than 24 hours.
- DW-9: The workflow refuses to run against any host in `TEST_DB_HOST_BLOCKLIST`, and against any branch whose name does not start with `ci-e2e/`. Neither the dev branch nor prod can be its target.
- DW-10: On failure, the Playwright HTML report and traces are uploaded as an artifact kept for 7 days. They hold only seeded synthetic data.
- DW-11: A nightly workflow runs the full suite on chromium with the same scaffolding. A failure opens or comments on a GitHub issue labelled `e2e-nightly`.
- DW-12: `e2e-critical` is **not** a required check. `docs/operational-state.md` records when it started, so it can be made required after two weeks with a flake rate of 2% or less (a later decision).

## Out of scope

- Automatic rollback, or Vercel Rolling Releases.
- Any production check that signs in. Holding a production password in GitHub secrets was rejected.
- Making `e2e-critical` a required check (a later decision, after the two weeks).
- Firefox, WebKit and mobile-safari in CI.
- Fixing the existing flaky specs, beyond what the `@critical` set needs.

## Premises checked against the code

- `.github/workflows/integration-smoke.yml` uses one shared CI Neon branch (`secrets.CI_DATABASE_URL`) with no Neon API calls. `neon-preview-cleanup.yml` and `neon-preview-sweep.yml` already use `neondatabase/delete-branch-action@v3` with `secrets.NEON_API_KEY` and `vars.NEON_PROJECT_ID`, so the key and project id exist.
- `.github/actions/ci-neon-env/action.yml` already builds `.env.local` from `.env.example`, refuses blocklisted hosts and runs `pnpm db:migrate`. `.env.example` boots the app (`check:env-boot`).
- `tests/e2e/global-setup.ts` assumes personas already exist (`scripts/seed-e2e-user.ts`), and its fixture steps are best-effort. The F4 admin fixtures render PDFs and upload them to Vercel Blob, so they need `BLOB_READ_WRITE_TOKEN`.
- `playwright.config.ts` boots `pnpm dev` on :3100. `playwright.attach.config.ts` targets an already running server through `E2E_BASE_URL`.
- Only one spec is tagged `@smoke` today, and there is no `@critical` tag.
- CI has no Redis, so routes that need an Idempotency-Key return 503 there.
- There is no health endpoint and no workflow triggered by `deployment_status`.

## Security and scale

- **`/api/health` is a new public surface.**
  - Risk: information disclosure. Mitigation: the body is one of two fixed strings.
  - Risk: using it to load the database. Mitigation: it runs only `select 1`, with a 3-second limit, and holds the result in memory for 10 seconds, so a flood costs one query per instance per 10 seconds.
  - It goes through the proxy like every `/api/*` route and is listed as public in the route-guard gate.
- **`NEON_API_KEY` in a PR workflow.**
  - Risk: the key can create and delete branches, including `main`. Mitigations:
    - The workflow runs only on `pull_request` from this repository. It is never triggered by `pull_request_target`, and forks get no secrets.
    - It creates branches only with the CI branch as their parent.
    - It deletes only the branch id it created in the same run.
    - The sweep deletes only `ci-e2e/*` branches.
- **Production smoke secrets:** none. Every URL it checks is public.
- **Scale:**
  - Each PR run creates one Neon branch, which lives for about 25 minutes. Neon's branch limit and compute hours are the cost to watch, and the plan states the budget.
  - The nightly full run is about 821 tests on chromium. The plan states its expected duration and whether it needs shards.

## Resolved questions (2026-10-17)

1. **Blob storage in CI:** a separate Vercel Blob store for CI. The maintainer creates it and stores its token as a GitHub secret. The invoice and PDF paths can then be in `@critical`, and CI never touches the production store.
2. **Redis in CI:** a separate Upstash database for CI, stored as GitHub secrets, so the payment path, rate limits and idempotency keys run for real.
3. **App mode:** the PR run uses `next build` + `next start`. It is closer to production, catches build-only bugs, and has no per-route cold compile. `next start` runs with `NODE_ENV=production`, and `src/lib/env.ts:922` deliberately refuses `E2E_X_TENANT_HEADER_ENABLED` there. So the 8 specs that need a throwaway tenant stay out of `@critical`, and the critical set uses the seeded `swecham` tenant only. The nightly full run uses `next dev`, so those 8 specs still run every night. The production guard is not loosened.
4. **Tenant data:** the CI Neon branch holds no `swecham` data. Slice 2 starts with one ordered seed entry point that calls the existing scripts (system actors, plans, invoice and payment settings, personas, portal invoices, F4/F5 fixtures) against a fresh branch.

Infrastructure the maintainer provides before slice 2 runs: the CI Blob store token, the CI Upstash URL and token, and confirmation that `NEON_API_KEY` may create branches. Claude never sees or prints their values.
