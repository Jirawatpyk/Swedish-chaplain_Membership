# Runbook — `prod-smoke` (post-deploy smoke failed)

**Owner**: Solo-maintainer
**Severity**: page-equivalent (production may be down or cut off from its database right after a deploy)
**Source signal**: a GitHub issue labelled `prod-smoke`, opened or commented on by `.github/workflows/post-deploy-smoke.yml`
**Checks**: `scripts/post-deploy-smoke.ts` · probe `GET /api/health` (`src/app/api/health/route.ts`)
**Spec**: `specs/123-ci-e2e-smoke/` (US1, DW-1…DW-5)
**Last reviewed**: 2026-10-18 (spec 123 slice 1)

---

## Symptom

A `prod-smoke` issue appears (or gains a comment) a few minutes after a merge to `main`. It names the base URL, the commit, the deployment URL, the workflow run, and one line per failed check:

```
FAIL <check> <reason>
```

The workflow run is red in GitHub → Actions → *Post-deploy smoke*. The issue never holds a response body, by design (the repo is public).

## Why this matters

Every merge to `main` deploys to production, and SweCham is live with real members and money. Vercel reporting `READY` only means the build finished. This smoke is the first check that the live site answers and still reaches its database. There is **no automatic rollback**: the issue is the alarm and a human decides.

The workflow retries the whole set 3 times, 20 s apart, so a red run is not alias lag: the failure lasted at least ~40 s.

---

## What each failed check means

| Line | Meaning | Most likely cause |
|---|---|---|
| `FAIL health 503` | `/api/health` ran `select 1` and it threw or took longer than 3 s, or an earlier `select 1` on that instance is still unsettled | the connection pool is exhausted; the Neon compute is suspended, down or unreachable; `DATABASE_URL` wrong in the new deploy; a hung earlier probe (`probe: still-pending`). `select 1` takes no table locks, so a migration's locks do not cause it |
| `FAIL health 200-unexpected-body` | 200, but the body was not exactly `{"status":"ok"}` | something in front of the app (a Vercel challenge page, a domain pointed elsewhere) is answering |
| `FAIL admin-sign-in <status>` / `FAIL portal-sign-in <status>` | the sign-in page did not answer 200 | 5xx: the app or a server component crashes at render, often a missing or invalid env var (`src/lib/env.ts` refuses to boot). 3xx: a redirect, so the base URL is not the canonical domain or the proxy now redirects anonymous users. 401/403: deployment protection or the Vercel firewall |
| `FAIL admin-sign-in 200-no-password-input` (or portal) | the page answered 200 without a password field | an error boundary or a maintenance page rendered instead of the form; or the sign-in form changed shape (then fix the script, not prod) |
| `FAIL <check> network-error` | no HTTP answer within 15 s (DNS, TLS, timeout) | the domain or its certificate, or a Vercel incident |
| `FAIL config no-base-url` | the workflow had no URL to check | the `PROD_BASE_URL` repo variable is not set (see Triage step 1) |
| `FAIL base-url invalid` | the base URL is not an `http(s)` URL, or carries credentials | a wrong `PROD_BASE_URL` value or `base_url` input |
| `FAIL smoke internal-error` | the script itself threw outside a check | a bug in `scripts/post-deploy-smoke.ts` or the runner's Node; not a production signal until reproduced (Triage step 2) |
| `(no FAIL line captured; see the run log)` | the job failed before the smoke printed anything | a CI-side failure: checkout, `pnpm install`, the runner. Not a production incident; re-run the workflow |

---

## Triage steps (in order)

1. **Confirm the target.** GitHub → Settings → Secrets and variables → Actions → *Variables* → `PROD_BASE_URL` must be the FINAL origin the members land on: `https://<domain>` with no path (the script uses only the origin) and no redirect behind it. The script does not follow redirects, so an apex that 308s to `www`, or `http` that redirects to `https`, fails every check with a 3xx. A manual run's `base_url` input overrides it. If the value is wrong, fix it and re-run (step 6); it is not a production incident.

2. **Reproduce from your machine** (read-only, public URLs only):

   ```bash
   node scripts/post-deploy-smoke.ts https://<domain>   # Node 22.18+; or: pnpm exec tsx …
   curl -sS -i https://<domain>/api/health
   ```

   If both are green now, the failure was transient: note it on the issue, watch the next deploy, and close it.

3. **`health` failed** → the database path.
   - Vercel → Logs for the deployment → search `health.degraded` and read its `probe` field (search by `probe`, not by the `err` class name, which a build can minify; the field is not called `reason` because the logger redacts that key):
     - `timeout`: `select 1` did not answer within 3 s — a saturated pool or an unreachable compute.
     - `query-error`: the driver threw — bad credentials, the compute refused or dropped the connection. `err` is the error class only.
     - `still-pending`: an earlier `select 1` on that instance has not settled yet, so no new query was started. It is sticky for up to 60 s per instance: a query still unsettled after 60 s is abandoned (not cancelled) and ONE fresh probe runs, so at most two hung connections per instance. A run of these means the database is hanging, not just slow. Recovery shows with a lag: after a hang clears, health can keep answering 503 for up to about 70 s (the 60 s abandon age plus the 10 s cache), so re-run the smoke before acting on a lone `still-pending` failure.
   - The log fires only when the outcome CHANGES per instance (no repeat every 10 s), and `health.recovered` (info) marks the instance answering ok again — so read the first `health.degraded` and the `health.recovered` after it, not a count of lines.
   - Neon console → the production branch: is the compute running, are connections near the limit?
   - `vercel env ls production`: is `DATABASE_URL` present and unchanged?

4. **A sign-in check failed** → the render path.
   - Vercel → the deployment → *Runtime Logs* (or Observability → Errors) for the two pages.
   - A boot-time env refusal shows as every route failing; a single page failing points at that page's server component.

5. **Decide: roll back or fix forward.** If members are affected and the cause is not a one-line fix, roll back first (Recovery) and debug on the previous build's time.

6. **Re-run the check** after any fix: GitHub → Actions → *Post-deploy smoke* → *Run workflow* (leave `base_url` empty to use `PROD_BASE_URL`).

---

## Escalation

- **Neon unreachable or degraded** with nothing changed on our side → Neon status page, then Neon support.
- **Vercel edge / DNS / TLS** (`network-error` on every check, app logs quiet) → Vercel status page, then Vercel support.
- **A failure that persists after a rollback** → not caused by the deploy: treat it as an infrastructure incident (Neon, Vercel, the domain) and consider `READ_ONLY_MODE=true` if writes are at risk (`specs/001-auth-rbac/quickstart.md` § 7.3).

---

## Recovery

1. **Roll back** to the last good production deployment:

   ```bash
   vercel ls --prod                         # find the previous READY production deployment
   vercel promote <previous-deployment-url> # point the production domain back at it
   ```

   A promote does not re-run migrations. If the bad deploy applied a migration, check the previous build still works against the new schema before relying on the rollback: read that migration and confirm the previous code does not depend on what it changed.

2. **Re-run the smoke** (Triage step 6) and confirm it is green.
3. **Add the cause and the action taken to the `prod-smoke` issue.** A passing run against `PROD_BASE_URL` (the next deploy, or a manual run with `base_url` empty) comments "Recovered: smoke passed at <commit> (<run url>)" on every open `prod-smoke` issue and closes it. A manual run against any other `base_url` leaves the issue open. The failure step comments on the newest OPEN issue, so once it is closed the next failure opens a fresh one.

---

## Prevention

- **The workflow file must be on `main`.** GitHub fires `deployment_status` only for workflows on the default branch, so a change to `.github/workflows/post-deploy-smoke.yml` takes effect only once merged. Test an edit with *Run workflow* (`workflow_dispatch`) on the branch.
- **Only successful Production deployments trigger it** (`deployment_status.state == 'success'` and `deployment.environment == 'Production'`); a preview deployment never does. `tests/unit/architecture/post-deploy-smoke-workflow.test.ts` pins the filter, the permissions and the no-injection rule.
- **`PROD_BASE_URL` is a repo variable, not hardcoded**, because the docs name more than one domain. Update it when the canonical domain changes.
- `/api/health` caches its result for 10 s per instance (from settle), never holds more than two hung connections, and answers only one of two fixed bodies; keep it that way (no version, environment, tenant, hostname or error text). Its contract is `tests/contract/api-health.test.ts`.

## Drills

A manual run against a bad URL (`gh workflow run post-deploy-smoke.yml -f base_url=https://invalid.example`) opens a real `prod-smoke` issue. Comment on it that it was a drill, and say what it checked, before a plain run closes it. The first drill was #583 (spec 123 post-merge check (b)).
