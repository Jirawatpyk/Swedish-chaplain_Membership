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
| 2 | e2e in CI: seed chain, `@critical` tags, the PR workflow, the nightly workflow, the sweep | DW-6…12 | security-engineer, senior-tester, reliability-guardian | `123-ci-e2e-smoke-s2` | — · open |

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
| II · Test-first | Pass, per the test plans above. |
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
- **Process note:** D-020 says the slice's own PR sets its Slices row to `done` before merging. #582 missed that, so this follow-up sets it. Cause: step 8 (PR), the DoD and the PR template had no line for it, only step 9 assumed it was "already" set. Guard: a DoD line and a PR-template line; retro logged.

