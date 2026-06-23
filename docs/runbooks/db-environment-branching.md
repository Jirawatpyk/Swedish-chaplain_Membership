# Runbook — Database Environment Branching (Neon)

**Status:** dev/test + preview isolation LIVE (2026-06-23). UAT + CI-branch isolation pending go-live.

Chamber-OS runs on **Neon Postgres** (project `neon-almond-chair` / `broad-silence-28093929`, region `ap-southeast-1`). This runbook documents how database environments are separated using **Neon branches** (copy-on-write), so that local dev, CI, preview deployments, and UAT never read or write the production database.

## 1. Branch topology

| Neon branch | Used by | `DATABASE_URL` source |
|---|---|---|
| **`main`** (default) | **Production** deployment | Vercel **Production** env (Neon integration) |
| **`dev`** | Local dev + integration tests | `.env.local` |
| **`preview/<git-branch>`** | Each Vercel **Preview** deployment (per PR) — auto-created, auto-deleted | Vercel **Preview** env (Neon integration, injected per deploy) |
| **`uat`** *(pending)* | UAT sign-off | Vercel Custom Environment *(not yet wired)* |

All branches are copy-on-write from `main` at creation time and stay in `ap-southeast-1` (PDPA residency preserved). **CoW branches inherit production data — including member PII** — so non-prod branches should be PII-sanitised (see §6) unless access is restricted to the maintainer.

## 2. Local dev + tests → `dev` branch

`.env.local` points `DATABASE_URL` / `DATABASE_URL_UNPOOLED` (+ the `POSTGRES_*` / `PG*` mirrors) at the **`dev`** branch endpoint (`ep-gentle-king-…`). The production backup is kept at `.env.local.bak.prod` (gitignored) — restore it into `.env.local` only if you deliberately need to point local tooling at production.

> ⚠️ `pnpm db:migrate` and `pnpm test:integration` now hit **`dev`**, NOT production.

### Production-safety guard
`tests/integration-setup.ts` refuses to run the integration suite if `DATABASE_URL` matches `TEST_DB_HOST_BLOCKLIST` (comma-separated host substrings, set in `.env.local` to the prod endpoint id). This is a hard stop against tests ever creating/mutating data in production. **Set the same `TEST_DB_HOST_BLOCKLIST` in CI.**

## 3. Preview isolation (per-PR branches)

Enabled in the **Vercel ▸ Neon integration** — *"Create database branch for deployment → Preview"* (Preview only; **never** Production). Each push to a non-default branch triggers a Vercel preview deploy, and Neon auto-creates `preview/<git-branch>` (CoW from prod) + injects its connection string into the Preview env. The branch is auto-deleted when the deployment is removed (PR close / branch delete).

Verified 2026-06-23: a test push created `preview/chore/verify-preview-branch`, isolated from prod.

## 4. Migration workflow (best practice: migrate-on-deploy)

| Target | How migrations apply |
|---|---|
| **`dev`** | `pnpm db:migrate` (reads `.env.local` → dev) — apply + test locally first |
| **`preview/*`** | **Automatic** — Vercel `vercel-build` runs `run-migrations.ts` against the injected preview-branch URL before `next build`, so a PR's new migration is live on its preview |
| **`main` (prod)** | **Automatic** on production deploy — same `vercel-build` runs migrations against prod before the prod build |

`vercel-build` (`package.json`) = `node --import tsx scripts/run-migrations.ts && next build --turbopack`. It is safe to run on every deploy: Drizzle's migration journal skips already-applied migrations. `run-migrations.ts` reads `DATABASE_URL_UNPOOLED` from the **injected** Vercel env (no `.env.local`), so each environment migrates its own branch.

**Manual prod escape hatch:** `pnpm db:migrate:prod` (reads `.env.production`, gitignored). Populate it only when you need an out-of-band prod migration:
```bash
vercel env pull .env.production --environment=production
pnpm db:migrate:prod
```

### Standard flow for a schema change
```
1. pnpm db:generate          # author the migration
2. pnpm db:migrate           # apply to dev + test locally
3. open PR → preview deploy auto-migrates the preview branch
4. merge → production deploy auto-migrates prod
```

## 5. Creating / managing branches (neonctl)

```bash
ORG=org-late-feather-58666635
PROD=broad-silence-28093929   # the production Neon project

neonctl branches list   --project-id $PROD --org-id $ORG
neonctl branches create --project-id $PROD --org-id $ORG --name <dev|uat|ci>
neonctl branches delete <branch> --project-id $PROD --org-id $ORG
# connection string (use the prod role; CoW preserves the role password):
neonctl connection-string <branch> --project-id $PROD --org-id $ORG --role-name chamber_app --pooled
```
> Gotcha: `neonctl connection-string` may return a non-working password. The reliable method is to take the **production** connection string and swap only the endpoint id (`ep-bold-block-…` → the new branch endpoint) — CoW preserves the `chamber_app` role password.

## 6. Pending (before go-live)

- [ ] **CI** still uses a `DATABASE_URL` secret pointing at prod — create a `ci`/`test` branch and repoint the GitHub Actions secret (+ set `TEST_DB_HOST_BLOCKLIST`).
- [ ] **PII sanitise** the `dev` (and any long-lived) branch — `dev` is CoW from prod and contains real member PII. Truncate `members` / `contacts` / `users` and reseed synthetic data, or restrict access.
- [ ] **UAT** — create a `uat` branch + a Vercel Custom Environment pointing at it; refresh from prod (sanitised) per UAT cycle.
- [ ] Run the `vercel-build` migrate path through a real schema-changing PR once to confirm preview-branch migration end-to-end.
