-- 0317 — record the four legacy F8 journal entries 0110-0113 in
-- drizzle.__drizzle_migrations (spec 123 follow-up).
--
-- WHY: run-migrations' Phase 4 asserts that every journal entry is recorded,
-- by hash OR by `created_at = when`. Production (and every branch cut from it)
-- has no row for these four, so #586 allow-listed them in normal mode
-- (LEGACY_UNRECORDED_TAGS). Their effects are on prod, checked read-only with
-- `pnpm db:verify:prod` against prod's own host on 2026-10-19:
--   - 0110-0112: all eight audit_event_type values are present (canary);
--   - 0113: renewal_cycles.plan_id_at_cycle_start is `text` (canary), and its
--     orphan-repair UPDATE predicate matches ZERO rows on a non-empty
--     renewal_cycles, so there is nothing left for it to fix;
--   - no __drizzle_migrations row has created_at 1792224000001…0004, and the
--     window between 0109 and 0114 holds exactly 0109's row.
-- So recording them is bookkeeping only. This migration runs no DDL and
-- touches no application table.
--
-- HASH: sha256 of each file's bytes as a Linux checkout reads them (the git
-- blob), which is what drizzle computes on Vercel. Phase 4 matches on
-- created_at as well, so a hash computed on another OS is harmless.
--
-- IDEMPOTENT: WHERE NOT EXISTS on created_at. On a database migrated from zero
-- (fresh mode records every file it applies) all four rows already exist, so
-- this inserts nothing. It inserts at most once anywhere.
--
-- SAFE BEFORE THE CODE: yes. The code in the same PR only removes the
-- allow-list; Phase 4 runs after this migration in the same deploy, so the
-- four entries are recorded by the time it looks.
INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT v.hash, v.created_at
  FROM (VALUES
    ('0893ef792ea80fca49732ab5059f12e80961b7f5e6bf121dc55deb12666b4c20', 1792224000001::bigint),
    ('fe59ae1cdbf9b8fbfca04bd349b9b5809f3b0cfb1dd2b084eed4ab908d04ca7a', 1792224000002::bigint),
    ('5cc0ccf48b8ff0f0ce8b8fca6cd4ef6fd8233bb22dc379bb507d2a7921bdf9ac', 1792224000003::bigint),
    ('bc0c83b4773e9fd4ab9300abb087afe47e3640aa74e76b51ff0f1ed37b151e39', 1792224000004::bigint)
  ) AS v(hash, created_at)
 WHERE NOT EXISTS (
   SELECT 1 FROM "drizzle"."__drizzle_migrations" m WHERE m.created_at = v.created_at
 );
