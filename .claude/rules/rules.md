# Rules — conventions, secrets, testing discipline, cross-cutting gotchas

Loaded every session (no `paths:`). Module-specific facts live in `.claude/rules/modules/`; layers, tenancy and migrations in `.claude/rules/architecture.md`.

## Conventions

- **Package manager**: pnpm (NOT npm). Lockfile `pnpm-lock.yaml`.
- **Commits**: Conventional Commits, enforced by the commit-msg hook; commitlint caps the header at 100 characters (count with `wc -m`). `[Spec Kit]` prefix on commits that move a Spec Kit feature through a gate (not used on `feature-flow` features).
- **Branches**: one feature per branch (`nnn-feature-name`), or for a size-L feature one slice per branch (`nnn-feature-name-s<k>`, D-020); the spec directory name matches the feature part exactly (e.g. `001-auth-rbac`).
- **Timestamps**: always store **ISO 8601 UTC (Gregorian)**. Thai Buddhist Era (BE = CE + 543) is **display-only** for `th-TH` surfaces. Storing BE anywhere is a ship blocker (off-by-543-years class).
- **Primary currency THB**; SEK/EUR/USD presentable where applicable. Thai tax invoices need VAT 7%, tax IDs on both parties, TH language, sequential tax-receipt numbering.
- **Never run `pnpm format` / `prettier --write`** even though the script exists — it reformats unrelated files. Hand-format to match the surrounding code.
- **Never `git stash`** on a shared checkout, and stage only your own hunks in a file someone else is editing — `git add -A` is unsafe even folder-scoped.

## Secrets & confidential data

- **NEVER commit** `docs/*.xlsm` / `docs/*.xlsx` — the Excel workbooks contain SweCham member PII. Blocked by `.gitignore`; a leak triggers rotation + postmortem.
- Secrets live in **Vercel env vars only** (never `.env` in git), validated at boot by `src/lib/env.ts` (zod schema) — the app refuses to start with a missing/invalid env var.
- **Setting an env var IS a production deploy**: `vercel.json` has no `ignoreCommand`, so every merge to `main` deploys, and a flag set early is armed for whoever merges next. Add a feature flag only when ready to redeploy immediately.
- **Forbidden in logs**: plaintext passwords, session IDs, reset tokens, invitation tokens, `Authorization` headers, raw email bodies. Log errors as `err: errKind(e)`. Hash user IDs where cross-request correlation is needed.

## Testing discipline (Principle II, NON-NEGOTIABLE)

- **TDD**: failing test → commit red → implement → commit green. Every user story in a spec MUST have ≥1 acceptance test authored before implementation starts. RED is the evidence that the test measures behaviour rather than the mock — a guard whose test never went red has never been exercised.
- **Test scope**: commit only the tests the task asks for or that this repo already keeps for that kind of change — roughly one focused test per stated behaviour, sized like the neighbouring test files. Scratch checks and quick scripts stay out of the repo (the unit+contract suite is ~4 min, integration ~40 min, and CI runs the live-Neon suites ~7× slower than a workstation).
- **Contract tests** at every external and inter-module boundary (`tests/contract/`).
- **Integration tests hit real Postgres** (local: the live Neon `dev` branch via `.env.local`; CI: disposable Neon branches), not mocks. Integration tests refuse to run against prod (`TEST_DB_HOST_BLOCKLIST` in `tests/integration-setup.ts`).
- **`pnpm test:integration -- <pattern>` runs the WHOLE suite (~40 min).** Pass the file PATH positionally: `pnpm test:integration tests/integration/renewals/foo.test.ts`. A whole 80-file folder dies around "Worker exited" — batch it.
- An explicit per-test timeout like `}, 30_000)` replaces CI's longer allowance with the local default — don't add one without a reason.
- Pinned per-file coverage is enforced ONLY under `--coverage`: a green `pnpm test` is not the CI coverage job.
- A red test suite on `main` is a stop-the-line event — no new work until green.
- Coverage thresholds (`vitest.config.ts`): Domain 100% line; Application 80% line + 80% branch; 100% branch on security-critical use cases.

## Cross-cutting gotchas

- **`pnpm typecheck` is not in pre-push** (CI runs it). Run it locally as the final step after the last edit, before committing — and run full `pnpm lint` too, it catches errors typecheck + vitest miss.
- **All cron triggers are native Vercel Cron** (`vercel.json` `crons`): **UTC-only** (Asia/Bangkok schedules are −7 h) and invoked with **GET**, so POST handlers need `export const GET = POST`. cron-job.org is a paused standby. See `docs/runbooks/cron-jobs.md`.
- **DB is Neon-branched**: `.env.local` → the `dev` branch; `pnpm db:migrate` never touches prod. Prod + preview migrate on Vercel deploy. Map: `docs/runbooks/db-environment-branching.md`.
- **`default: { return _exhaustive }` is FAIL-OPEN** — it returns the value at runtime, so an unknown variant is silently ACCEPTED. Write `void _exhaustive; return <safe>`. `rg -n "^\s*return _exhaustive" src` should print nothing.
- **A source-scanning gate whose regex anchors on `\n` is INERT on every Windows checkout** (`core.autocrlf=true` → `;\r\n`), and CI (Linux, LF) can never catch it. Match `;\r?\n`, and give every source-parsing gate a **positive control** that fails when its own parse yields zero members.
- **A cross-module semantics change leaves stale fixtures in the modules you didn't touch** — pre-push runs only the edited module's integration suite, so grep `tests/` for the changed SYMBOL (an arity or meaning change), not just the folder.
- **A type declaration is not runtime evidence** — verify a constraint, an index or a payload shape against the live schema or the real call before relying on it.
