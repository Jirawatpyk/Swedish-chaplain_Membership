# Runbook — e2e in CI (`e2e-critical`, `e2e-nightly`, parent refresh, branch sweep)

**Owner**: Solo-maintainer
**Severity**: `e2e-critical` red = the PR is not ready (advisory until DW-12 makes it required); `e2e-nightly` red = triage the next working day
**Source signal**: a red `e2e @critical (chromium)` or `e2e @critical (mobile-chrome)` check on a PR; a GitHub issue labelled `e2e-nightly`
**Workflows**: `.github/workflows/e2e-critical.yml` · `e2e-nightly.yml` · `ci-e2e-parent-refresh.yml` · `ci-e2e-branch-sweep.yml`
**Spec**: `specs/123-ci-e2e-smoke/` (slice 2, DW-6…DW-12)
**Last reviewed**: 2026-10-18 (spec 123 slice 2)

---

## How it works

- **The CI Neon project** (`vars.NEON_CI_PROJECT_ID`, key `NEON_CI_API_KEY`) holds synthetic data only; it is not the production project. Its parent branch `vars.NEON_CI_PARENT_BRANCH` is kept migrated to `main` by `ci-e2e-parent-refresh.yml` (push to `main` + manual dispatch).
- **Each run** creates its own branch `ci-e2e/<run>-<attempt>` from that parent (2 h expiry; 8 h for the nightly). The DW-9 guard (`scripts/seed-ci-e2e.ts --guard-only`) refuses any other target. The run migrates (only the PR's new migrations), seeds personas and fixtures (`scripts/seed-ci-e2e.ts`), and deletes the branch in an `always()` step.
- **`e2e-critical`** builds the app, runs `next start` on :3100, then runs the `@critical` specs (the list is in `tests/unit/architecture/e2e-critical-set.test.ts`) on chromium and mobile-chrome with `--workers=1`. Budget: 25 min (DW-7).
  - **Job layout:** `e2e` is a matrix over `project: [chromium, mobile-chrome]` with `fail-fast: false`, so a PR shows two checks that run in parallel. Each job runs the whole chain on its own: its own Neon branch `ci-e2e/<run>-<attempt>-<project>`, rate-limit prefix `swecham-ci-<run>-<attempt>-<project>`, one Playwright project, and its own artifact. The first post-refresh run took 28.3 min with both projects in series, which is why they were split.
- **`e2e-nightly`** (19:00 UTC) resets the schema on its own branch and migrates **from zero**, then runs the full suite on chromium under `next dev` with `E2E_X_TENANT_HEADER_ENABLED=1`, in two shards.

## A red `e2e-critical` check on a PR

1. Open the run. The job summary has a phase-time table and a per-spec table (seconds, retries, passed / flaky / failed / skipped).
2. **The first red step tells you which kind of failure it is:**
   - *Create / Mask / Refuse (DW-9)*: Neon or configuration. Check that `NEON_CI_API_KEY`, `NEON_CI_PROJECT_ID` and `NEON_CI_PARENT_BRANCH` are set and that the CI project is under its branch limit (see the sweep below).
   - *Migrate the branch*: the PR's migration fails against a copy of `main`'s schema. Fix the migration. The first failing statement is in the log.
   - *Seed personas and fixtures*: a seed broke on the CI data, often a NOT NULL column without a DB default (see `tests/unit/scripts/seed-insert-not-null-coverage.test.ts`).
   - *Build / Start the app*: the production build or the boot env failed. `next-start.log` is tailed in the step.
   - *e2e @critical on …*: a real test failure, or "0 tests" when a spec throws while being collected (an env var missing at import time). Read the list output, then the artifact.
3. **The report and traces** are uploaded as `e2e-critical-<run>-<attempt>-<project>` for 7 days, on a failure, a cancel, or a flaky pass. Open a trace with `pnpm exec playwright show-trace <zip>`.
   - **They contain the e2e persona passwords.** A trace records every action, including the passwords typed into the sign-in form, and the repo is public, so anyone can download them for 7 days.
   - This is accepted for three reasons. The personas are synthetic and seeded per run. They exist only on the run's own `ci-e2e/` branch of the CI Neon project, and that branch is deleted at the end of the run. No E2E persona exists in production.
   - Never point these workflows at a database with a real account.
4. **To re-run:** use GitHub → *Re-run failed jobs*. It creates a fresh branch, because the attempt number is in the branch name. Re-running to make a red go away is not a fix. If the same test passes on a re-run, log it as a flake (see DW-12 below).
5. **To reproduce locally:** follow the `run-chamber-os` skill, then run `E2E_BASE_URL=http://localhost:3400 pnpm exec playwright test --config=playwright.attach.config.ts <spec> --workers=1`.

## An `e2e-nightly` issue

- The issue lists failed spec **file names only** (the repo is public); the run link carries the report artifact (`e2e-nightly-report-…-s<shard>`, 7 days).
- A failure in *Reset the schema* or *Migrate the branch from zero* means migrating from zero is broken. That is also the disaster-recovery path, so treat it as a priority. The PR runs cannot catch it, because they apply only the delta.
- A red run comments on the open issue rather than opening a new one. A green run closes it.

## DW-12: making `e2e-critical` required

It stays advisory for two weeks from #586's merge. Record each red that was not the PR's fault (a flake) on the `e2e-nightly` issue or in a dedicated issue. After two weeks with a flake rate of 2% or less (DW-12), add both `e2e @critical (chromium)` and `e2e @critical (mobile-chrome)` to `main`'s required status checks, and update `docs/operational-state.md`.

## The CI parent refresh

- It runs on every push to `main` and is queued, never cancelled. Manual run: GitHub → Actions → *CI e2e parent refresh* → Run workflow.
- If it fails, PR runs keep working but migrate more. On an empty parent they take about 520 s, from zero. Fix the cause, then re-run the workflow.
- It refuses unless the branch Neon returns is exactly `NEON_CI_PARENT_BRANCH` in `NEON_CI_PROJECT_ID`.

## The `ci-e2e/*` sweep

- `ci-e2e-branch-sweep.yml` runs daily at 22:00 UTC. It considers only branches named `ci-e2e/…` that are children of the CI parent and older than 24 h, and it refuses the denylist (main / dev / ci / *backup*) and the parent itself.
- **It is a dry run** until the repo variable `CI_E2E_SWEEP_ENABLED` is `true`. Read one dry-run summary first, then set the variable. To disarm it, unset the variable; no code change is needed. A manual run also needs `dry_run: false` to delete.

## Rotating the CI Neon key

- Create the new key in the CI Neon project as a **project-scoped** key, then replace the repo secret `NEON_CI_API_KEY`, then revoke the old key.
- **Known gap:** the e2e-critical scope check proves the key opens the CI project and cannot list others. A *personal* key whose account can see only the CI project would pass it too, but could reach any project added to that account later. Always use a project-scoped key.
