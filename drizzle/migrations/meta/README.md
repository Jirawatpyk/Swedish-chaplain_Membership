# Drizzle migration metadata — convention note

## Sparse-snapshot policy (staff-review R2 R022, 2026-04-28)

`_journal.json` is the **single source of truth** for the migration history Drizzle replays — it lists all 56 migrations 0000–0055.

The per-migration `<idx>_snapshot.json` files in this directory are **intentionally sparse**. They are kept only at archive-checkpoint boundaries (currently 0000, 0001, 0005, 0006, 0007, 0008, 0009, 0018) — not regenerated on every `pnpm drizzle-kit generate` run.

### Why

- `drizzle-kit generate` writes a fresh full-schema `<next>_snapshot.json` on every run. Committing all 56 would create high-churn diff noise that obscures the actual SQL change in a migration PR.
- The runtime migrator (`drizzle-kit migrate`) does **not** consult per-migration snapshots — it replays SQL files in the order listed in `_journal.json` and tracks `__drizzle_migrations` bookkeeping by `sha256(rawFileContent)`. Snapshots exist for offline schema-diff tooling, not runtime correctness.
- The custom `scripts/sync-drizzle-bookkeeping.ts` + `scripts/sync-drizzle-journal.ts` reconcile the bookkeeping table + journal against the SQL files when migrations are renamed / squashed / hand-edited (rare but possible during a refactor like the F5 R3 fix-it batch — commit `1bcc375`).

### When to add a new snapshot

Only when a release boundary or major schema epoch is reached and you want a static reference point for `drizzle-kit drop` rollback simulation or external schema-diff tooling. **Do not** add a snapshot per migration.

### When to backfill all snapshots

Only if a tooling change requires it (e.g. a future Drizzle Studio version that reads per-migration snapshots for visualization). At that point run `pnpm drizzle-kit generate` once to regenerate the missing `0010_snapshot.json` … `0055_snapshot.json` and commit them as a single bookkeeping PR — not bundled with feature changes.

### See also

- `scripts/sync-drizzle-bookkeeping.ts` — reconciles the `__drizzle_migrations` Postgres table after manual migration edits.
- `scripts/sync-drizzle-journal.ts` — reconciles `_journal.json` after migrations are renamed or reordered.
- F5 commit `1bcc375` (`db:sync-bookkeeping — restore drizzle-kit as canonical migrator`) — last full reconciliation pass.
