---
name: new-migration
description: Add a database migration to Chamber-OS — a hand-written SQL file, its _journal.json entry, applied to the Neon dev branch and verified in information_schema before any code that depends on it is committed. Use whenever a change adds or alters a table, column, enum value, index, trigger, function or RLS policy.
---

# New migration

Migrations from 0019 on are hand-written (D-002). `pnpm db:generate` is denied, because its snapshots stop at 0018. Every step below has failed silently here at least once, so do them in order.

## 1. Number it

- The next number is one past the last SQL file: `ls drizzle/migrations/*.sql | tail -1`.
- If another open branch or PR adds a migration, merge that one first and take the number after it. Two branches with the same number collide at merge.
- File name: `drizzle/migrations/NNNN_<snake_case_summary>.sql`.

## 2. Write the SQL

- **Idempotent where Postgres allows.** Use `IF NOT EXISTS` / `IF EXISTS`. For an enum value, use a `DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_enum …) THEN ALTER TYPE … ADD VALUE …` block, as in `0014_audit_event_portal_invite_queued.sql`.
- **A tenant-scoped table** gets a `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and policies keyed on `current_setting('app.current_tenant')`. Add indexes on FK columns.
- **A pre-check `DO` block that refuses the deploy** must pass on the shared `dev` branch and the persistent CI branch, both full of `test-*` tenants. Measure the whole branch before writing the predicate.
- **Redefining a function or trigger** (`CREATE OR REPLACE`): start from the newest existing definition (`rg -n "FUNCTION <name>" drizzle/migrations`), not from the first one.
- **A backfill that updates many rows** disables any `updated_at` trigger around it if a timer reads `updated_at`. In F119 the 30-day draft prune restarted its clock on deploy.
- Add a header comment: what the migration does, why, and whether it is safe before the code that uses it is deployed. Prod migrates inside the deploy, before the new code serves.

## 3. Register it

Append an entry to `drizzle/migrations/meta/_journal.json`:
- `idx` is the previous entry's `idx` + 1. It does not equal the file number.
- `tag` is the file name without `.sql`.
- `when` is a unique value larger than every existing `when`. A duplicate `when` makes the migrator print "✓ applied" while applying nothing. The usual step is the previous `when` + 100000.
- Keep the file's existing formatting; don't reformat it.

## 4. Apply it to `dev` and prove it landed

```bash
pnpm db:migrate        # .env.local → the Neon dev branch; never prod (db:migrate:prod is denied)
```

- Confirm the DDL in `information_schema` (or `pg_enum` / `pg_indexes` / `pg_policies`) with a read-only query. "✓ applied" alone is not evidence.
- Update the Drizzle schema (`src/modules/<m>/infrastructure/**/schema.ts`) to match, so the inferred types agree with the database.

## 5. Test against the real database before committing

- Run the integration suites that touch the changed tables, by path: `pnpm test:integration tests/integration/<module>/<file>.test.ts`. Unit mocks hide schema gaps.
- For a tenant-scoped table, add or extend a cross-tenant test (Principle I).
- If the migration adds an audit event value, also follow the `add-audit-event` skill.
- Run `pnpm db:verify` if the change touches what it asserts.

## 6. In the PR

- Say whether the migration is **unflagged on deploy** (it always is: the flag gates code, not DDL) and what it changes for live rows.
- Give the rollback: usually a forward-fix migration, because enum values cannot be dropped.
- `integration-smoke.yml` runs `pnpm db:migrate` against a fresh Neon branch. A migration that fails there blocks the merge.
