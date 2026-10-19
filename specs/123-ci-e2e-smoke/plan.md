# Plan: 123 — e2e in CI and a post-deploy smoke test

Spec: `specs/123-ci-e2e-smoke/spec.md` (commits `4fef69bee`, `0d98b8bce` on branch `123-ci-e2e-smoke-s1`, worktree `%TEMP%\f53`) · Size: L · 2 slices

## Context

e2e never runs in CI, so every PR needs a manual local verification round to catch UI regressions. After a merge deploys to production, nothing checks that the live site answers and can reach its database. The maintainer made these choices on 2026-10-17:

- **Per PR:** a `@critical` subset on chromium + mobile-chrome, against a fresh Neon branch per run (seeded, then deleted), using `next build` + `next start`.
- **Nightly:** the full suite on `next dev`.
- **Separate CI services:** a Blob store and an Upstash database just for CI.
- **Production smoke:** public pages + a new `/api/health`. A failure opens an issue; there is no automatic rollback.

## Slices

| # | Slice | Done-when | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | Post-deploy smoke: `/api/health`, the smoke script, the workflow, the runbook | DW-1…5 | security-engineer, reliability-guardian, observability-instrumentor | `123-ci-e2e-smoke-s1` | #582 · done |
| 2 | e2e in CI: seed chain, `@critical` tags, the PR workflow, the nightly workflow, the sweep | DW-6…12 | security-engineer, senior-tester, reliability-guardian, drizzle-migration-reviewer | `123-ci-e2e-smoke-s2` | #586 · done |

## Slice 1 — post-deploy smoke

**Files**
- `src/app/api/health/route.ts` (new): `GET` only, `export const dynamic = 'force-dynamic'`.
  - Runs `db.execute(sql\`select 1\`)` from `@/lib/db`, raced against a **3 s timer in Node**, because the pooler drops `statement_timeout`.
  - Returns 200 `{"status":"ok"}`, or 503 `{"status":"degraded"}` on error or timeout.
  - Keeps the result in a non-exported module variable for 10 s.
  - Sends `Cache-Control: no-store`.
  - Logs a degraded result as `logger.warn({ err: errKind(e), route: 'api.health' }, 'health.degraded')`, using `@/lib/logger` and `@/lib/log-id`.
  - The body never holds anything but the two fixed strings.
- `tests/contract/rbac/api-route-exhaustiveness.test.ts`: add `/api/health` to `PUBLIC_ROUTES`. No other gate flags it: `check:api-route-guard` only checks baseline rows, and the proxy lets an unauthenticated GET through.
- `scripts/post-deploy-smoke.ts` (new; plain `fetch`, zero dependencies). It takes a base URL and checks:
  - `/admin/sign-in` and `/portal/sign-in` return 200 and contain a password input;
  - `/api/health` returns 200 `{"status":"ok"}`.
  - It retries 3 times, 20 s apart, to cover alias lag. It prints one line per check and exits non-zero if any check fails. It runs the same locally and in CI.
- `.github/workflows/post-deploy-smoke.yml` (new):
  - Triggers: `on: deployment_status` (only when `state == 'success'` and `environment == 'Production'`) plus `workflow_dispatch` with a `base_url` input.
  - It targets `vars.PROD_BASE_URL`, not the per-deployment URL, which can sit behind deployment protection. **The maintainer sets the repo variable.** The docs name two domains (`swecham.dxtspace.com` and `swecham.zyncdata.app`), so the value is never hardcoded.
  - `permissions: contents: read, issues: write`.
  - On failure, `gh issue` opens an issue labelled `prod-smoke`, or comments on the open one, with the deployment URL, the commit SHA and the failed lines.
- `docs/runbooks/post-deploy-smoke.md` (new): written in the shape of `webhook-signature-rejected.md`. It says what each failed check means and how to roll back with `vercel promote <previous-deployment-url>`.

**Test plan (RED first)**

| Done-when | Test | Level |
|---|---|---|
| DW-3 ok / degraded / timeout / no-store / fixed body / 10 s cache | `tests/contract/api-health.test.ts`: mock `@/lib/db` `execute`, use fake timers for the 3 s and 10 s, and `vi.resetModules()` between cases (pattern: `tests/contract/heartbeat.test.ts`) | contract |
| DW-2 the smoke fails when health is 503, a sign-in page is not 200, or the password input is missing; it passes when everything is fine | `tests/unit/scripts/post-deploy-smoke.test.ts`, with `fetch` stubbed | unit |
| DW-1, DW-4 trigger, filters, permissions, issue step | `tests/unit/architecture/post-deploy-smoke-workflow.test.ts` reads the YAML: `deployment_status` filtered to Production + success, no `pull_request_target`, `issues: write`. It includes a positive control that fails if the parse finds zero jobs. The workflow is run for real after merge (Verify). | unit |

## Slice 2 — e2e in CI

**Step 0: a timing spike** (measure before choosing the set). The PR's own `e2e-critical` run first carries 3 candidate specs. It records build, seed and per-spec times, and the `@critical` list is sized to fit 25 minutes from those numbers. The times go in `plan.md` § Evidence.

**Plan change 2026-10-18 (maintainer-approved):** fresh-DB mode in `scripts/run-migrations.ts`; fixes the never-tested migrate-from-zero path (also a DR bug). When `drizzle.__drizzle_migrations` is missing or empty, `scripts/lib/migrate-fresh.ts` applies the journal one entry per transaction, decided by hash; each file first commits its own `ALTER TYPE … ADD VALUE` lines in autocommit, because 0308 builds a partial index on a value it adds itself. Any database with a recorded migration keeps the old single-transaction path. Tests: `tests/unit/scripts/migrate-fresh.test.ts`.
  - The per-file autocommit of each file's own `ADD VALUE` lines departs from the approved "skip the enum pre-pass in fresh mode". 0308 needs it: it builds a partial index on `'awaiting_member_approval'`, a value it adds itself. A scan of all 308 files found no other file that adds a value and uses it. The maintainer accepted it on 2026-10-18.

**Plan change 2026-10-18 (maintainer-approved): a migrated CI parent.** Spike 2 measured 520 s to migrate from zero, above the 3-minute line, so the CI parent is pre-migrated:
- `.github/workflows/ci-e2e-parent-refresh.yml` runs on push to `main` and `workflow_dispatch`, in one queued concurrency group that never cancels a run in progress.
  - It resolves `vars.NEON_CI_PARENT_BRANCH` through the Neon API with `NEON_CI_API_KEY` and refuses unless the branch id and project id Neon returns equal `vars.NEON_CI_PARENT_BRANCH` and `vars.NEON_CI_PROJECT_ID`.
  - It masks the URL and its password, then migrates through `ci-neon-env`, which applies the production blocklist.
  - Its first run applies the whole chain in fresh-DB mode; later runs take the normal path.
  - Guard: `tests/unit/architecture/ci-e2e-parent-refresh-workflow.test.ts`.
- PR runs still branch from that parent. Their migrate step stays and records its time, and applies only the PR's own migrations.
- The first refresh can run only after merge: `workflow_dispatch` needs the file on the default branch. Until then, PR runs still migrate from zero.
- **The nightly keeps the from-zero coverage** (built later):
  - On its fresh `ci-e2e/` branch, and only after the DW-9 guard has proved that it is a `ci-e2e/` branch of the CI project, it runs `DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`.
  - Then it migrates from zero, so fresh-DB mode and the seeds' empty-DB path are exercised every night.

**Files**
- `scripts/seed-ci-e2e.ts` (new orchestrator). It runs the existing seeds in this order, with `NODE_ENV` unset:
  1. `seed-system-actors`
  2. `seed-e2e-user`
  3. `seed-swecham-2026-plans`
  4. `seed-f4-invoice-settings`
  5. `seed-f5-e2e-payment-settings`
  6. `seed-e2e-portal-invoices` (with `FEATURE_088_TAX_AT_PAYMENT=true`)
  7. `seed-f5-e2e-reconciliation`
  8. `seed-f5-e2e-stale-invoice`
  9. `seed-f4-e2e-admin-fixtures`

  It collects their `export …` lines and appends them to `$GITHUB_ENV`. It refuses unless the host's branch name starts with `ci-e2e/`, and it uses `scripts/lib/seed-target-guard.ts`.
  - The plan year is pinned: plans are seeded for 2026 only. The orchestrator fails loudly if the current Bangkok year has no plans, so January 2027 cannot break the run silently. It is logged as a known follow-up.
- `.github/ci/e2e.env` (new, no secrets): the CI overrides for a production boot.
  - `APP_ALLOWED_ORIGINS=http://localhost:3100`; without it CSRF rejects every POST in production.
  - `FEATURE_F6_EVENTCREATE=false`, because otherwise boot requires `ZAPIER_DPA_EXECUTED`.
  - F7 needs an inbox and `TENANT_PRIVACY_POLICY_URL` to boot: either supply synthetic values or switch F7 off for PR runs. Decided in the spike.
  - `FEATURE_F8_RENEWALS=true`, and F9 on with the CI Blob token.
- `.github/workflows/e2e-critical.yml` (new). Trigger: `pull_request` only (never `pull_request_target`); fork PRs skip with a notice; concurrency is per ref with cancel-in-progress. Steps:
  1. setup (as in `quality-gates.yml`);
  2. `neondatabase/create-branch-action` with parent `vars.NEON_CI_PARENT_BRANCH` and name `ci-e2e/${{ github.run_id }}`;
  3. a guard step that refuses blocklisted hosts and any name without the `ci-e2e/` prefix;
  4. `.github/actions/ci-neon-env` with `migrate: 'true'`;
  5. `seed-ci-e2e`;
  6. `next build`, then `next start -p 3100` in the background, with a readiness wait;
  7. `playwright test --config=playwright.attach.config.ts --grep @critical`, one run each on `--project=chromium` and `--project=mobile-chrome`, `--workers=1`;
  8. on failure, upload the report and traces (7 days);
  9. `if: always()`: `neondatabase/delete-branch-action@v3` on the id created in step 2.

  Secrets: the existing `NEON_API_KEY`, plus the new `CI_BLOB_READ_WRITE_TOKEN`, `CI_UPSTASH_REDIS_REST_URL` and `CI_UPSTASH_REDIS_REST_TOKEN`. **The maintainer creates these;** Claude never reads or prints them.
- `.github/workflows/e2e-nightly.yml` (new): the same scaffolding on `schedule` + `workflow_dispatch`. It runs `next dev` with `E2E_X_TENANT_HEADER_ENABLED=1`, the full suite, chromium only, sharded if the spike shows it needs to be. Failures go to a `e2e-nightly` issue.
- `neon-preview-sweep.yml`: also delete any `ci-e2e/*` branch older than 24 h. The deletion is filtered by name prefix.
- `@critical` tags. The initial candidates, trimmed after the spike:
  - `staff-sign-in`, `member-sign-in`
  - `f9-dashboard`, `admin-journey`
  - `members-directory-search`
  - `invoice-draft-issue` (AS4 + AS6 only, tagged per test)
  - `invoicing/invoice-detail-reflow`
  - `payment-card-decline`, `payment-promptpay-happy-path`
  - `portal-invoices`, `member-nav`, `portal-layout`
  - `renewal-pipeline-dashboard`

  Throwaway-tenant specs and `/test-fixtures` specs are excluded.
- `docs/operational-state.md`: the date `e2e-critical` started as an advisory check. `docs/changelog.md` gets a line.

**Test plan (RED first)**

| Done-when | Test | Level |
|---|---|---|
| DW-9 refuses a target without the `ci-e2e/` prefix, or a blocklisted host | `tests/unit/scripts/seed-ci-e2e.test.ts` (guard function) | unit |
| DW-6, DW-8, DW-9 trigger, fork skip, `always()` delete, prefix, no `pull_request_target` | `tests/unit/architecture/e2e-ci-workflows.test.ts`: a YAML read with a positive control | unit |
| DW-7 the set exists and avoids the throwaway tenant | `tests/unit/architecture/e2e-critical-set.test.ts`: every `@critical` spec is in the plan's list, and none imports `throwaway-tenant` or `/test-fixtures` | unit |
| DW-6, DW-7, DW-10 the real run | the PR's own `e2e-critical` run: duration ≤ 25 min, both projects green, artifact present on a forced failure | CI evidence |
| DW-11, DW-12 | the nightly `workflow_dispatch` after merge; the operational-state line | CI evidence |

## Critical set

The specs tagged `@critical` and run by `e2e-critical.yml` on every PR (DW-7). The list is pinned by `tests/unit/architecture/e2e-critical-set.test.ts`, which also refuses a tagged spec that imports the throwaway tenant or `/test-fixtures`. Every spec runs on the seeded `swecham` tenant of the run's own `ci-e2e/` branch.

| Spec | DW-7 item it covers |
|---|---|
| `staff-sign-in.spec.ts` | admin sign-in |
| `f9-dashboard.spec.ts` | the dashboard (admin, manager and member views) |
| `members-directory-search.spec.ts` | the members directory |
| `critical-invoice-issue.spec.ts` | issuing an invoice: a draft from the member page, the issue call, the issued status and number on the detail page |
| `portal-invoices.spec.ts` | viewing invoices in the member portal |
| `payment-promptpay-happy-path.spec.ts` | the payment flow, with Stripe stubbed: `helpers/stripe-mock.ts` fakes `window.Stripe` and short-circuits `/api/payments/initiate` in the page (lines 195-231), so no live Stripe call is made |
| `member-sign-in.spec.ts` | member sign-in and the portal home |
| `critical-member-profile.spec.ts` | the member's own profile (read only) |
| `admin-journey.spec.ts` | the cross-module admin path (plans → members → invoices → dashboard → audit → renewals) |

**Candidates dropped, and why:**

| Candidate | Reason |
|---|---|
| `invoice-draft-issue.spec.ts` | Uses the throwaway tenant, which needs `E2E_X_TENANT_HEADER_ENABLED` and a production boot does not set it. `critical-invoice-issue.spec.ts` covers its AS1/AS3 path on the seed instead. |
| `member-nav.spec.ts` | One test needs F7 (`/portal/broadcasts/**`), which is off in CI; it is now gated on `FEATURE_F7_BROADCASTS`. It also cost 202 s per project. |
| `renewal-pipeline-dashboard.spec.ts` | AS1 hit its 5 s wall-clock bound from a US runner (5.7 s); the bound is now an env var, CI 15 s. It cost 118 / 168 s per project. |
| `invoicing/invoice-detail-reflow.spec.ts` | Mobile only: it skips on chromium, and a skip fails the job. |
| `portal-layout.spec.ts` | One test, and `critical-member-profile` and `portal-invoices` already render the portal shell. |
| `payment-card-decline.spec.ts` | Breadth, not safety: it uses the same in-page fetch override of `/api/payments/initiate` in `helpers/stripe-mock.ts` (lines 195-231) as `payment-promptpay-happy-path`, so neither calls Stripe live. PromptPay already covers the payment seam, and a second payment spec would spend budget on depth. |

## Fixes from the plan reviews (architect + security, 2026-10-18)

These are binding for the build. They correct the slice-2 steps above where they disagree.

**Seed chain** (`scripts/seed-ci-e2e.ts`)
- Order: `seed-f4-invoice-settings` runs **before** `seed-swecham-2026-plans`. The plans seed inserts placeholder invoice settings, and the F4 seed's `ON CONFLICT DO NOTHING` would then keep them.
- Set `BOOTSTRAP_ADMIN_EMAIL` to the e2e admin, or unset it; the `.env.example` value makes the plans seed throw.
- Run every seed with `TSX_TSCONFIG_PATH=tsconfig.scripts.json`.
- Parsing:
  - Parse `^\s*(export\s+)?[A-Z0-9_]+=` lines, because some seeds print without `export`.
  - Strip the quotes.
  - Emit `::add-mask::<value>` for every value before writing it to `$GITHUB_ENV`.
  - Never echo the lines themselves.
- Guard:
  - Take the `branch_id` from the create step, and resolve endpoint → branch name through the Neon API (the `neon-preview-sweep.yml` pattern); a Neon host does not carry the branch name.
  - Refuse a placeholder `TEST_DB_HOST_BLOCKLIST`, as `ci-neon-env/action.yml:44-50` does.

**Env for a production boot** (`.github/ci/e2e.env`), written to `$GITHUB_ENV` **before** `next build`:
- `E2E_BASE_URL=http://localhost:3100`
- `FEATURE_F6_EVENTCREATE=false`
- `FEATURE_F5_ONLINE_PAYMENT=true`
- `FEATURE_088_TAX_AT_PAYMENT=true` (at runtime as well as at seed time)
- F9: a synthetic `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32 characters) and a `BLOB_PRIVATE_READ_WRITE_TOKEN` distinct from the public one
- The CI Upstash secrets mapped to **`KV_REST_API_URL` / `KV_REST_API_TOKEN`**, which env.ts reads first. F7 is already off.

**Workflow**
- Add `pnpm exec playwright install --with-deps chromium`.
- Set `trace: 'retain-on-failure'`.
- Upload only `playwright-report/` and `test-results/`, never `.env*`.
- Pass every `${{ }}` value from an event or input through `env:` and quote it as `"$VAR"` in `run:`.
- Write issue bodies with `gh issue create --body-file`, and never include a response body from production.
- Use the minimum `permissions:` per job.

**Payment in `@critical`**
- `payment-card-decline` stubs only `confirmPayment`, while initiate hits Stripe. Stub initiate with `tests/e2e/helpers/payment-intent-stub.ts`, or drop the spec from `@critical`. Decide in the spike.
- Constitution IV then reads "no live Stripe call".

**Sweep**
- `ci-e2e/*` gets its own deletion switch and a 24 h age filter. It must not hang off `NEON_PREVIEW_SWEEP_ENABLED`.
- Filter by prefix **and** by `parent_id == the CI parent`, with the same denylist as the preview sweep.

**`/api/health`**
- Cache the **promise** single-flight for 10 s, for both ok and degraded, so concurrent misses run one query.
- Contract test: N concurrent calls → one `execute`.

**YAML tests**
- Parse the YAML as text with `\r?\n`, and add no YAML dependency.
- Assert:
  - no `${{ github.event.` and no `${{ inputs.` inside a `run:` block;
  - no upload path matches `.env*`;
  - the Neon key comes from the agreed source (below).

**Nightly and timing**
- The base config's `webServer` starts `pnpm dev` itself, so the nightly does not start it again.
- The timing spike counts `retries: 2` under `CI=true`.

**Neon key** (security High; the maintainer chooses)
- The repo is **public**.
- A project-wide `NEON_API_KEY` in a same-repo PR job can branch from prod `main`, because the PR author controls the workflow file.
- Options, strongest first:
  - (a) a separate Neon project for CI, with a project-scoped `NEON_CI_API_KEY`;
  - (b) the key in a GitHub Environment `ci-e2e` that needs the maintainer's approval on every run;
  - (c) a protected `main` branch in Neon, as well as (a) or (b).
- The collaborator `OMG-group-tech` is inside this trust boundary.

**Maintainer decisions (2026-10-18)**
- The repo **stays public**, so the masking and artifact limits above are mandatory.
- **Neon key: a separate Neon project for CI.**
  - The maintainer creates it, holding only synthetic data, together with a project-scoped `NEON_CI_API_KEY` and `vars.NEON_CI_PROJECT_ID`. That project's main branch is the parent for every `ci-e2e/*` branch.
  - The existing project-wide `NEON_API_KEY` is **not** used by the e2e workflows; a YAML test asserts this.
  - Migrations run on each fresh branch, so the CI project starts empty.
- **No `E2E_*` persona exists in prod** (maintainer confirmed).

**Maintainer setup before slice 2's PR runs:**
- The Neon CI project, `NEON_CI_API_KEY`, `NEON_CI_PROJECT_ID` and `NEON_CI_PARENT_BRANCH`.
- The CI Blob store: public and private tokens.
- The CI Upstash URL and token.

**Before slice 1 merges:** set the `PROD_BASE_URL` repo variable.

Claude never reads or prints any of these values.

## Constitution Check

| Principle | Result |
|---|---|
| I · Privacy | Pass. CI branches come from the CI branch, which has no real data; the PII-bearing preview branches are untouched; `/api/health` returns no data. |
| II · Test-first | Pass, per the test plans above. Re-checked against constitution 2.1.0 (2026-10-18): CI workflows, scripts and a route are outside the UI / copy / non-guard size-S allowance, so slice 2 keeps separate RED commits. |
| III · Clean Architecture | **Deviation:** `/api/health` imports `@/lib/db` directly, the same precedent as the cron routes. See Complexity Tracking. |
| IV · PCI | Pass. Stripe stays stubbed in the browser; no keys are needed. |
| V · i18n, VI · Inclusive UX | Not applicable. |
| VII · Perf & Observability | Improves: a health signal and a post-deploy check. |
| VIII · Reliability | Pass. The run's branch is deleted in an `always()` step, and a sweep catches leaks. |
| IX · Review | Applies as normal. |
| X · Simplicity | Zero new npm dependencies; two GitHub Actions; reuses the `ci-neon-env` action and `playwright.attach.config.ts`. |

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| `/api/health` calls `db` without a use case | A liveness probe has no domain logic | A `health` module with a port and a use case: ceremony with no behaviour behind it |
| Solo-maintainer review, **slice 2 only** (`NEON_CI_API_KEY` and CI secrets in a PR workflow). Slice 1's public `GET /api/health` returns no data and is not one of the six sensitive surfaces, so it gets the normal review with `security-engineer` as its surface reviewer (D-022) | No second human reviewer | — |

## Rollout and risks

**Rollout**
- **Slice 1** is safe on merge: the route is new, and the workflow reports only.
- The maintainer sets `PROD_BASE_URL` (the live domain) before the merge. Verify with `workflow_dispatch` straight after.
- **Slice 2** needs the CI Blob store, the CI Upstash database and `NEON_CI_PARENT_BRANCH` in place before its PR runs.

**Risks**
- **Flaky critical specs.** The check stays advisory; the flake rate is tracked for two weeks.
- **Neon branch limits.** One branch per PR run, about 25 min each; the sweep catches leaks.
- **US runners against a Singapore database are about 7× slower.** The spike sets the real budget.
- **The plan year rolls to 2027.** The seed fails loudly, and a follow-up is logged.

## Verification

- **Slice 1:**
  - Run the contract and unit tests, then `pnpm check`.
  - Run the app on :3400 and `curl` `/api/health`: 200 ok, and 503 within about 3 s with a bad `DATABASE_URL` in a scratch env.
  - Run `node scripts/post-deploy-smoke.ts http://localhost:3400` (passes), then against production (read-only).
  - After merge, run the workflow with `workflow_dispatch` and confirm a deliberate bad `base_url` opens a `prod-smoke` issue.
  - Post-merge checks:
    - (a) the `deployment_status` run of the merge deploy is green;
    - (b) `gh workflow run post-deploy-smoke.yml -f base_url=https://invalid.example` opens a `prod-smoke` issue, and a second such run comments on that issue instead of opening another;
    - (c) a preview deployment's run is skipped (the job `if:` is false).
- **Slice 2:**
  - The PR's `e2e-critical` run is green on both projects within 25 min, and its Neon branch is gone afterwards (Neon API list).
  - Run the nightly by `workflow_dispatch` once after merge.
  - Evidence goes in `plan.md` § Evidence.
- **Review per slice:** `/code-review high <pr#>`, the surface reviewers and `spec-compliance-auditor`. `whole-branch-reviewer` runs only in slice 2's staff review (solo-maintainer review), per D-022.

## Evidence

Filled in at Verify, one block per slice.

### Slice 1 (head `6d66f48ed`, verified 2026-10-18 on a cold `next dev` :3400 in worktree f49)

- **DW-3 ok:** `GET /api/health` → `200 {"status":"ok"}`, `Cache-Control: no-store`. Cold call 6.2 s (route compile); repeat within 10 s 0.03 s (cache).
- **DW-3 degraded:** with `DATABASE_URL` pointed at an unroutable host → `503 {"status":"degraded"}`. An uncached call took **3.04 s** (`application-code: 3.0s`). The log line is `WARN health.degraded route="api.health" err="HealthProbeTimeoutError"`, with no message text.
- **DW-3 tests:** `tests/contract/api-health.test.ts` 8/8, including single-flight N→1 and the exact 3 s timeout. Mutation-checked: M1 (no single-flight) and M2 (30 s timer) each turn one test red.
- **DW-2:**
  - `scripts/post-deploy-smoke.ts http://localhost:3400` → PASS admin-sign-in 200, PASS portal-sign-in 200, PASS health 200, EXIT 0.
  - Against `https://swecham.dxtspace.com`, before deploy, both sign-ins PASS and `FAIL health 404`, after 3 attempts 20 s apart. That is expected: the route isn't deployed yet.
  - Unit tests 14/14.
- **DW-1, DW-4:**
  - Workflow text guard 13/13. Mutation M3, `${{ inputs.base_url }}` in `run:`, turns two tests red.
  - The real `deployment_status` run and the `workflow_dispatch` issue check happen after merge (the file must be on `main`).
- **DW-5:** `docs/runbooks/post-deploy-smoke.md`.
- **Gates:** `pnpm typecheck` 0, `pnpm lint` 0, `api-route-exhaustiveness` 8/8, `check:api-route-guard` OK.
- **Repo setup:**
  - Variables `PROD_BASE_URL`, `NEON_CI_PROJECT_ID` and `NEON_CI_PARENT_BRANCH` are set.
  - Secrets `NEON_CI_API_KEY`, `CI_BLOB_READ_WRITE_TOKEN`, `CI_BLOB_PRIVATE_READ_WRITE_TOKEN`, `CI_UPSTASH_REDIS_REST_URL` and `CI_UPSTASH_REDIS_REST_TOKEN` are set; names were checked, values never read.

**Re-verified after review round 1** (head `04b766dd8`, cold `next dev` :3400):
- **OK path:** 200 `{"status":"ok"}`. The smoke run passed all 3 checks, with one retry because the first `/admin/sign-in` hit compiled for 15 s.
- **Unreachable DB:** 3 concurrent calls after the cache expired all returned 503 in 2.9-3.05 s, and the log has one `health.degraded` line for them, so they shared one probe.
- **Log redaction found and fixed:**
  - The live log showed `reason: "[REDACTED]"`, because `src/lib/logger.ts` redacts every `reason` key. The mocked-logger tests had hidden this.
  - Renamed to `probe`. The live log now reads `probe: "timeout"`, `route: "api.health"`, `err: "HealthProbeTimeoutError"`.
  - Guarded by a test against the real `REDACT_PATHS` (RED `49af5e060`).

**Post-merge (done 2026-10-18, merge commit `c4884db96`):**
- **(a)** The `deployment_status` run of the production deploy was green, with all three lines `PASS admin-sign-in 200`, `PASS portal-sign-in 200` and `PASS health 200` against `https://swecham.dxtspace.com`. The recovery step logged "No open prod-smoke issue". Run: https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39061553065
- **(b)** Two `workflow_dispatch` runs with `base_url=https://invalid.example`, then one plain run:
  - [run 39061639414](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39061639414) failed and opened issue #583. The body holds the base URL, the commit, "Deployment: none (manual run)", the run URL and the three `FAIL … network-error` lines only.
  - [run 39061718039](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39061718039) failed and **commented on #583**; no new issue was opened.
  - [run 39061797720](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39061797720), against `PROD_BASE_URL`, passed. It commented "Recovered…" and **closed #583**.
- **(c)** Preview deployments of this branch fired `deployment_status`, and the job was **skipped** each time (for example https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39057302987).
- **(d)** Not proven: DW-4's "names the deployment URL" holds only for a real failing `deployment_status` run. Manual runs print "none (manual run)". Accepted.
- **Process note:** D-020 says the slice's own PR sets its Slices row to `done` before merging. #582 missed that, so this follow-up sets it. Cause: step 8 (PR), the DoD and the PR template had no line for it, only step 9 assumed it was "already" set. Guard: a DoD line, a PR-template line and a `feature-flow` § 8 bullet; retro logged.

### Slice 2 — spike 1 ([run 39093568820](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39093568820), failed)

- **Create branch:** 3 s. **DW-9 guard:** ok.
- **Migrate from zero:** failed at 0021 on both attempts, about 291 s in total. `CREATE UNIQUE INDEX … audit_log_overdue_once_per_day … WHERE "event_type" = 'invoice_overdue_detected'` raised 55P04 (unsafe use of new enum value).
  - Cause: drizzle-orm 0.45.2 `PgDialect.migrate` applies every pending migration in one transaction, so on an empty database 0020 adds the value and 0021 uses it in the same transaction. The enum pre-pass only acts on types that already exist; here it logged "applied 0, skipped 372".
  - Nothing in this repo had ever migrated from zero: dev, CI and preview all branch from prod.
- **Delete branch:** ran at the end (`always()`).
- **Fix:** the fresh-DB mode above (plan change 2026-10-18).

### Slice 2 — spike 2 ([run 39095428106](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39095428106), head `65a644aef`, failed)

- **Create branch:** 2 s. **DW-9 guard:** ok.
- **Migrate from zero:** passed on the first attempt, with no retry, in **523 s**. The log reads `✓ Fresh-DB migrate: applied 308, skipped 0 (hash already recorded) in 520.2 s`, and the enum post-checks passed.
- **Seed:** failed after 13 s. `seed-system-actors` (3.3 s) and `seed-e2e-user` (6.8 s) were ok.
  - `seed-f4-invoice-settings` failed with `null value in column "currency_code" of relation "tenant_invoice_settings" violates not-null constraint`.
  - Cause: 0026 made the column NOT NULL with no DEFAULT. The Drizzle schema's `.default('THB')` exists only in TypeScript.
  - Fixed in `a14295c1f` (RED `beaf27a97`). A scan of every Drizzle NOT NULL column with a SQL default against the migrations found no other default that exists only in TypeScript.
- **Build, ready, e2e:** skipped. **Delete branch:** ran.
- 520 s is above the 3-minute line, so the CI parent is now pre-migrated (plan change above).

### Slice 2 — spike 3 ([run 39096465335](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39096465335), head `a14295c1f`, failed)

| Phase | Seconds |
|---|---|
| migrate (from zero, fresh-DB mode: `applied 308` in 694.4 s) | 698 |
| seed (all nine scripts ok; the plans seed alone took 60 s) | 183 |
| build | 141 |
| ready | 7 |
| e2e-chromium | 41 |
| e2e-mobile-chrome | 37 |

- **The seed step passed on the empty database.**
- **Both e2e projects ran 0 tests.** Playwright's collection threw `Environment validation failed (src/lib/env.ts): CLAMAV_TIMEOUT_MS: Expected number, received nan` at `tests/e2e/renewals/rolling-anchor.spec.ts:28`, which imports `@/lib/db`. Global setup's `seed-f4-e2e-admin-fixtures` top-up failed the same way.
  - Likely cause: CI's `.env.local` is a copy of `.env.example`, which carries inline comments (`CLAMAV_TIMEOUT_MS="300000"           # 5-minute …`). The minimal loader in `playwright.config.ts` strips quotes only when the value ends in a quote, so the comment stays in the value. Developers' `.env.local` comes from `vercel env pull` and has no inline comments.
- **Per-spec table:** empty, because no test ran. **Delete branch:** ran.

### Slice 2 — spike 4 ([run 39097994635](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39097994635), head `e121c57da`, cancelled)

- Superseded mid-run by the push of `32709716c` (concurrency `cancel-in-progress`). It carried no fix for spike 3's failure, so nothing was lost.

### Slice 2 — spike 5 ([run 39098373802](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39098373802), head `32709716c`, **success**)

- Fix since spike 3: `parseEnvLine` (RED `a1d1c4e99`, GREEN `32709716c`). `playwright.config.ts` now drops inline `# comments` and reads quoted values up to the matching quote.
- **Job wall time:** 20 min 59 s. The CI parent was still empty, so migrate ran from zero; that is the last PR run to do so once the parent refresh has run on `main`.

| Phase | Seconds |
|---|---|
| migrate (fresh-DB mode: `applied 308` in 515.9 s) | 519 |
| seed (all nine ok) | 152 |
| build | 144 |
| ready | 6 |
| e2e-chromium | 195 |
| e2e-mobile-chrome | 187 |

| Project | Spec | Seconds | Retries | Passed | Flaky | Failed | Skipped |
|---|---|---|---|---|---|---|---|
| chromium | payment-promptpay-happy-path.spec.ts | 37 | 0 | 2 | 0 | 0 | 0 |
| chromium | portal-invoices.spec.ts | 98 | 0 | 6 | 0 | 0 | 0 |
| chromium | staff-sign-in.spec.ts | 14 | 0 | 3 | 0 | 0 | 0 |
| mobile-chrome | payment-promptpay-happy-path.spec.ts | 36 | 0 | 2 | 0 | 0 | 0 |
| mobile-chrome | portal-invoices.spec.ts | 98 | 0 | 6 | 0 | 0 | 0 |
| mobile-chrome | staff-sign-in.spec.ts | 12 | 0 | 3 | 0 | 0 | 0 |

- **11 passed** on each project (3.2 min and 3.1 min), with no retries, no flakes and no skips. The artifact upload was skipped because nothing failed. **Delete branch:** ran.
- **Budget:** without the 519 s migrate, the run is about 12 min. That leaves about 13 min of the 25-minute budget for the rest of the `@critical` set, at roughly 1 min per spec file per project.

### Slice 2 — spike 6 ([run 39100353012](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39100353012), head `bf2aa3565`, failed): nine `@critical` specs

- **Phases:** migrate 537 s, seed 156 s, build 135 s, ready 6 s, e2e-chromium **724 s**, e2e-mobile-chrome **772 s**.
- **Results:** 31 passed and 2 failed on each project. Both failures were deterministic, failing all three attempts.
  - `member-nav.spec.ts:66`, "mobile Benefits tab stays active on /portal/broadcasts/**": the member tab bar was not found on `/portal/broadcasts/new`. In CI `FEATURE_F7_BROADCASTS=false` (`.github/ci/e2e.env`), so the broadcasts route is not live.
  - `renewal-pipeline-dashboard.spec.ts:107`, AS1: its 5 s wall-clock smoke read 5.7 s from a US runner to the Singapore database.
- **DW-10 evidence:** the failure uploaded the artifact `e2e-critical-39100353012-1` (64.4 MB, the HTML reports and traces of both projects). It is kept for 7 days and expires 2026-10-25T06:03:22Z.
- **Fixed after review round 1:**
  - `member-nav` now skips its broadcasts test when F7 is off, with a named reason.
  - The AS1 bound now comes from `E2E_RENEWALS_AS1_BUDGET_MS`, which CI sets to 15 s.
  - Both specs stay out of `@critical` for budget.
- **Budget:** without the from-zero migrate the job projects to about 30 min, over DW-7's 25. The two slowest additions were dropped, and they are the two failing specs: `member-nav` at 202 s per project and `renewal-pipeline-dashboard` at 118 s / 168 s (RED `df8eecda1`, GREEN `488d28f32`).
  - Both still run nightly, where the same two failures are expected until F7 has a CI inbox and the AS1 latency bound accounts for the runner region. **Open items.**

### Slice 2 — final ([run 39102932905](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39102932905), head `488d28f32`, **success**): the seven-spec `@critical` set

| Phase | Seconds |
|---|---|
| migrate (from zero; the CI parent is not migrated until the refresh runs on `main`) | 519 |
| seed | 153 |
| build | 138 |
| ready | 6 |
| e2e-chromium | 376 |
| e2e-mobile-chrome | 380 |

| Spec | chromium s | mobile-chrome s | Retries | Passed (each) | Flaky | Failed | Skipped |
|---|---|---|---|---|---|---|---|
| admin-journey.spec.ts | 65 | 66 | 0 | 1 | 0 | 0 | 0 |
| f9-dashboard.spec.ts | 42 | 52 | 0 | 3 | 0 | 0 | 0 |
| member-sign-in.spec.ts | 27 | 28 | 0 | 2 | 0 | 0 | 0 |
| members-directory-search.spec.ts | 48 | 48 | 0 | 4 | 0 | 0 | 0 |
| payment-promptpay-happy-path.spec.ts | 34 | 34 | 0 | 2 | 0 | 0 | 0 |
| portal-invoices.spec.ts | 99 | 99 | 0 | 6 | 0 | 0 | 0 |
| staff-sign-in.spec.ts | 13 | 12 | 0 | 3 | 0 | 0 | 0 |

- **21 passed** on each project (6.2 min and 6.3 min), with no retries, flakes or skips.
- **Job wall time:** 27 min 11 s. Without the 519 s from-zero migrate, which the parent refresh removes after merge, it projects to about **18.5 min**, within DW-7's 25 min.
- **The `@critical` set is pinned** by `tests/unit/architecture/e2e-critical-set.test.ts`, which holds the allow-list and the no-throwaway-tenant / no-`/test-fixtures` rule. It was mutation-checked: tagging `invoice-draft-issue` turns both rules red.
- **Nightly shard estimate:** about 694 `test(` calls. At this run's CI rate of about 18 s per test under `next start` (spike 6: about 22 s with retries), and slower under `next dev`'s first-hit compiles, one job lands at roughly 4-6 h against GitHub's 6 h limit. Two shards land at about 2-3 h each. This is not measured yet.
- **Shared steps:** e2e-critical and the nightly duplicate their branch, guard, seed and env steps rather than sharing a composite action. The YAML guards read each workflow's key-bearing steps directly, and a composite action would hide `NEON_CI_API_KEY` behind an input.
- **Not verifiable before merge:**
  - `ci-e2e-parent-refresh.yml` and `ci-e2e-branch-sweep.yml` need the file on `main` before `workflow_dispatch` works.
  - The nightly runs only on schedule or dispatch, on `main`. Its schema reset (`psql`) and its `jq` filters have not run yet.
  - The sweep's `jq` date filter has not been run (no `jq` on the workstation).

### Slice 2 — review round 1 (PR #586): fix runs

- **[run 39107806086](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39107806086)** (head `93174cb43`), failed at the new M3 scope check. `GET /api/v2/projects` answers **404** for `NEON_CI_API_KEY`, which is project-scoped, so "exactly one project in the listing" can never pass. Fixed in `95124020b` (RED `71a221bd6`): a 200 listing must hold exactly the CI project; a 404/403 means a scoped key, and `GET /projects/$PROJECT_ID` must then return the CI project. The later runs log "The CI key cannot list projects (HTTP 404): a project-scoped key" and "CI key scope: ok".
- **[run 39108085903](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39108085903)** (head `95124020b`), failed: 21 passed and 2 failed per project, both in the new specs.
  - The seeded member already holds a 2026 invoice, so the "second invoice" confirm dialog appeared.
  - The own contact row reads "E2E Echo (you)".
  - Fixed in `25c6bfdb7`.
- **[run 39110905078](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39110905078)** (head `25c6bfdb7`): chromium 23/23. On mobile-chrome, `getByText(number).first()` resolved to the hidden breadcrumb. Fixed in `ec90a7495`.
- **[run 39113744658](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39113744658)** (head `ec90a7495`): `getByText(/^draft$/i)` found nothing; the badge is an icon plus text. Fixed in `06d791f9e`: both states are read from the visible h1.
- **[run 39117062905](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39117062905)** (head `06d791f9e`), **success**: 23 passed on each project (9.3 min and 9.4 min), with no retries, flakes or skips.

| Phase | Seconds |
|---|---|
| migrate (from zero: `applied 308` in fresh-DB mode) | 607 |
| seed | 171 |
| build | 157 |
| ready | 7 |
| e2e-chromium | 559 |
| e2e-mobile-chrome | 562 |

| Spec | chromium s | mobile-chrome s | Retries | Passed (each) | Flaky | Failed | Skipped |
|---|---|---|---|---|---|---|---|
| admin-journey.spec.ts | 77 | 77 | 0 | 1 | 0 | 0 | 0 |
| critical-invoice-issue.spec.ts | 91 | 96 | 0 | 1 | 0 | 0 | 0 |
| critical-member-profile.spec.ts | 19 | 18 | 0 | 1 | 0 | 0 | 0 |
| f9-dashboard.spec.ts | 48 | 60 | 0 | 3 | 0 | 0 | 0 |
| member-sign-in.spec.ts | 33 | 33 | 0 | 2 | 0 | 0 | 0 |
| members-directory-search.spec.ts | 58 | 58 | 0 | 4 | 0 | 0 | 0 |
| payment-promptpay-happy-path.spec.ts | 40 | 39 | 0 | 2 | 0 | 0 | 0 |
| portal-invoices.spec.ts | 118 | 116 | 0 | 6 | 0 | 0 | 0 |
| staff-sign-in.spec.ts | 17 | 16 | 0 | 3 | 0 | 0 | 0 |

- **Budget:**
  - Job wall time was 35 min 18 s (09:52:46 → 10:28:04). Without the 607 s from-zero migrate, which the parent refresh removes after merge, that is **about 25.2 min**: DW-7's 25 min, missed by about 12 s.
  - Dropping `admin-journey` (77 s per project) would bring it to about 22.6 min. Not done here; it is the maintainer's call.
- **Integration smoke and the Vercel preview are red on Phase 4, the new journal assertion. This is a finding about production's state, not a CI flake.**
  - On the prod-derived branch they migrate, 4 journal entries are recorded neither by hash nor by `created_at = when`:
    - `0110_f8_wave_k24_renewal_lapsed_enum` (when 1792224000001)
    - `0111_f8_phase6_us4_audit_event_type_enum` (…002)
    - `0112_f8_phase6_review_cron_bearer_auth_rejected` (…003)
    - `0113_f8_t149_fix_plan_id_at_cycle_start_text` (…004)
  - Since #24 (2026-05-11) git has changed nothing in these files or their `when` except whitespace, so the prod rows were most likely written by pre-final versions of these files. Before 2026-06-23, `db:migrate` targeted prod.
  - 0110–0112 are idempotent enum adds, and the Phase 3 enum check passes. 0113 changes `renewal_cycles.plan_id_at_cycle_start` to `text` and backfills it; whether that landed on prod is **not verified**.
  - **Open, for the maintainer:** Phase 4 as specified fails integration smoke, which is a required check, and every preview, and it would fail the production `vercel-build` on merge. Merging as is blocks every deploy. The decision is the maintainer's; it has not been softened here.

### Slice 2 — maintainer decisions after review round 1 (2026-10-18)

- **Phase 4: an explicit allow-list.**
  - `LEGACY_UNRECORDED_TAGS` in `scripts/lib/migrate-fresh.ts` names exactly the four tags above, with no wildcard.
  - In normal mode, the unrecorded entries must be a subset of it; in fresh mode it does not apply.
  - Tests: RED `8c97e3d5f`, GREEN `96252832d`. A mutation that drops the fresh-mode branch turns the fresh-mode test red.
  - Follow-up, in a separate PR: the maintainer verifies `renewal_cycles.plan_id_at_cycle_start` on prod, then the four rows are backfilled on prod and the list is deleted. Claude does not touch prod.
- **DW-7 timing deferred to post-merge (projection 25.2 min).**
  - No change in this PR. The first real run after the parent refresh is the measurement.
  - If it is over 25 min, the remedy is to split chromium and mobile-chrome into parallel jobs. The `@critical` set is never trimmed for time.
- **M3: two-sided and fail-closed.**
  - The check is in `scripts/ci-neon-key-scope.ts`: (i) `GET /projects` answers non-200, or 200 with exactly the CI project; and (ii) `GET /projects/{NEON_CI_PROJECT_ID}` answers 200 with that id.
  - Each leg is unit-tested, including an org-wide key and a wrong key. RED `8ad7a97cf`, GREEN `0d82d347e`.
- **Head `ef64f5985`:** every check is green.
  - Integration smoke ([run 39121468147](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39121468147)) logged "✓ Migrations applied" with Phase 4 passing. The Vercel preview deployed.
  - e2e-critical ([run 39121468131](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39121468131)) logged "CI key scope: ok (cannot list projects (HTTP 404): a project-scoped key; opens the CI project)".
  - Phase times: migrate 564 s (from zero), seed 164, build 139, ready 6, e2e-chromium 572, e2e-mobile-chrome 519.
  - mobile-chrome 23 passed. chromium 22 passed and **1 flaky**, and the M1 warning fired: `critical-invoice-issue` did not find the member page's create-invoice link on two attempts and passed on the third. **Open: this flake has to be fixed before DW-12 starts counting.**

### Slice 2 — post-merge steps (owners)

- **DW-8, sweep arming (maintainer):** after the first scheduled `ci-e2e-branch-sweep.yml` run on `main`, read its dry-run summary and the "would delete" warning. If the list holds only stale `ci-e2e/` children of the CI parent, set the repo variable `CI_E2E_SWEEP_ENABLED=true`.
- **Operational-state date (maintainer):** the merge follow-up fills the "advisory from" date in `docs/operational-state.md`.
- **First parent refresh:** it runs on the merge push. The first PR run after it measures DW-7 without the from-zero migrate (see the maintainer decisions above).

### Slice 2 — the `critical-invoice-issue` flake (cause corrected 2026-10-18)

- **No trace at first.** Run 39121468131 was green, so the upload step (`failure() || cancelled()`) skipped and the traces of the two failed attempts were lost. The report is now also uploaded when the summary sees a flaky spec (RED `25e80fbdd`, GREEN `b17100640`).
- **The cause, from the traces of [run 39124301861](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39124301861)** (artifact `e2e-critical-39124301861-1`). It is **not** a hidden previous segment: each trace shows a single member link and a single "New invoice" link. The page was still rendering:
  - **chromium attempt 1:** on `/admin/members/<id>`, `<main>` held only the "Members" back link from 145.6 s to 160.6 s (the whole 15 s wait).
  - **mobile-chrome:** the URL changed to `/admin/invoices/<id>` at 182.7 s, and at 197.7 s the h1 was still the `loading.tsx` shimmer (`skeleton-shimmer h-8 w-64`). The URL updates when a client navigation starts, so `waitForURL` passed before the content streamed.
  - **Correction (run 39136426864):** this trace showed two things, and only the second is the flake. A real first render of about 12 s, slower than the 15 s waits allowed. And a page stuck on its `loading.tsx`, which the 60 s wait then exposed: the same page stayed stuck for the full 60 s, so it was not slow. The flake is a **cancelled client navigation**, described below.
- **First fix (`a75769d29`), kept:**
  - Every wait after a navigation gets `SERVER_RENDER_MS` = 60 s, which fits inside `test.slow()`.
  - Every post-navigation locator in both new specs is `.filter({ visible: true })` and strict; there is no `.first()` left.
  - The profile spec asserts the h1 company name and the visible "(you)" row.
- **Proof, on [run 39131190941](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39131190941)** (head `42e5ffd4b`, after merging `origin/main`):
  - **success**: 23 passed on chromium (9.0 min) and 23 on mobile-chrome (9.2 min). There was no flaky warning, so no artifact was uploaded.
  - `critical-invoice-issue`: 90 s on chromium and 95 s on mobile-chrome, 0 retries.
  - Phases: migrate 608 s, seed 169, build 95, ready 5, e2e 541 + 551. Job 33 min 36 s.
  - Integration smoke, Quality gates, Architecture guards, Coverage and the Vercel preview are all green.
- **It came back on [run 39136426864](https://github.com/Jirawatpyk/Swedish-chaplain_Membership/actions/runs/39136426864)** (head `de1d49a10`). mobile-chrome was flaky on its first attempt. The new warnings fired as designed: "passed only on a retry", and "took 186 s, over 1.5x its 95 s baseline" (item 5).
  - Trace (artifact `e2e-critical-39136426864-1`):
    - 52.348 s: the click on the directory row.
    - 52.395 s: the navigation's RSC fetch (`?_rsc`, no prefetch header) ends `ERR_ABORTED` after 6 ms. Nothing re-fetches it.
    - For the next 60 s, `<main>` holds only the member route's `loading.tsx` back link while the URL already shows the member page.
  - **Candidate ruled out:** AURA's FilterBar sends `onSearchChange` only from its typing debounce, never on mount (`aura-react` dist, `FilterBar` `send`/`type`). The directory's `router.replace` is therefore not the trigger. The trace does not show what aborted the fetch.
  - **Test fix:** the spec opens the member page by `page.goto(href)`, taking the href from the visible directory link, so it still proves the search found the member. This spec's subject is issuing an invoice; `members-directory-search` covers the list.
  - **Open (app-side, not fixed here):** an admin who clicks a directory row soon after the list loads may get a member page that never leaves its loading state.
    - Evidence: an aborted navigation RSC fetch, never retried.
    - Repro for a follow-up: load `/admin/members?q=…`, click a row at once, and assert that `<main>` renders the member page.
    - The maintainer decides whether this becomes a follow-up spec.

### Slice 2 — DW-7 split into parallel jobs

- DW-7: first post-refresh run 28.3 min > 25 → split per the pre-agreed remedy (PR #TBD)
