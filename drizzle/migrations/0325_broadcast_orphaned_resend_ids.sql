-- ---------------------------------------------------------------------------
-- Migration 0325 — spec 140 s2c: `broadcast_orphaned_resend_ids`, the record
-- of a Resend broadcast or audience our side created whose id no live
-- `broadcasts` row will carry to a cleanup path (DL5b, DL6, DL10; plan.md
-- § Slice 2c — build plan, item 1).
--
-- Numbered 0325, journal idx 326, `when` 1798545800000: after #728's 0323 /
-- 0324 (`when` 1798545600000 / 1798545700000, merged) and before #733's 0326
-- (`when` 1798545900000), which must merge AFTER this file — drizzle's
-- migrator skips an entry older than the newest applied one, so 0325 landing
-- after 0326 would never run (and run-migrations' phase 4 would fail the
-- deploy on the unrecorded entry).
--
-- RE-RUNNABLE: every statement is idempotent (CREATE TABLE / INDEX IF NOT
-- EXISTS, ADD COLUMN IF NOT EXISTS, GRANT / REVOKE, ENABLE / FORCE, DROP
-- POLICY IF EXISTS + CREATE POLICY, CREATE OR REPLACE FUNCTION). CREATE TABLE
-- IF NOT EXISTS skips the whole table, so the two attempt columns are added
-- by their own ADD COLUMN IF NOT EXISTS (review round 1): the dev branch, which
-- had this table before they existed, gets them the same way.
--
-- Who writes a row (each at its CALLER, never inside a shared gateway
-- helper, plan item 3): a minted broadcast whose reclaim leaked
-- (`attach_lost` / `row_vanished` / `persist_failed`), a persist whose
-- read-back failed and kept the id (`read_back_failed_kept`), a dead inherited
-- id the import leg replaced or kept (`dead_broadcast_replaced` /
-- `dead_broadcast_kept`), a terminal write that could not delete the row's
-- draft (`terminal_reclaim_undecided`, `refused_draft_undeleted`), an audience
-- whose reclaim leaked (`audience_leaked`), and a `createBroadcast` that ended
-- in a network failure, a timeout or a 5xx (`create_unconfirmed`, no id).
-- Who settles it: the `cleanup-audiences` cron's drain, and the erasure
-- cascade for the requester's own rows (DL10). Neither deletes a row.
--
-- Columns — ids and closed tokens only, no content:
--   tenant_id, orphan_id (PK with tenant_id), broadcast_id and
--   requested_by_member_id (SNAPSHOTS: no FK, by decision — the row must
--   outlive both the broadcast row, which the retention sweep deletes, and
--   any member change; it carries no content), resource_type, resource_id
--   (NULL only for `create_unconfirmed`), reason, created_at, settled_at and
--   outcome (set together, once, by the settle CAS — and, since review round 2,
--   enforced once by a BEFORE UPDATE trigger), and since review round 1
--   attempts / last_attempted_at (an undecided settle increments both, so the
--   drain lists `ORDER BY attempts, created_at` and a permanently undecided row
--   cannot hold the head of the queue).
--
-- Deviation from the slice-2 design (plan item 1, [A8]): the design's single
-- `resend_broadcast_id` column is `resource_type` + `resource_id`, so a leaked
-- AUDIENCE (which holds recipients' contacts) fits the same table.
--
-- The value lists in the CHECKs mirror `ORPHAN_REASONS`, `ORPHAN_OUTCOMES`
-- and `ORPHAN_RESOURCE_TYPES` (src/modules/broadcasts/domain/value-objects/
-- orphaned-resend-id.ts); `orphaned-resend-ids.test.ts` pins every value.
--
-- Access: RLS ENABLE + FORCE with the 0064 / 0308 policy on
-- `app.current_tenant`. chamber_app gets SELECT and INSERT on the table, and
-- UPDATE on four columns only (`settled_at`, `outcome`, `attempts`,
-- `last_attempted_at`; review round 1, migration M2): no writer may rewrite an
-- id, a reason or a requester. No DELETE: rows leave only through
-- `prune_orphaned_resend_ids` below.
--
-- Retention [P M-1]: `prune_orphaned_resend_ids(tenant, cutoff)` deletes the
-- rows that no longer name a copy we could reach — settled rows other than
-- `handed` (`superseded` included), and `create_unconfirmed` rows (no id to
-- call) — older than the cutoff. An UNSETTLED row with an id is never pruned.
-- A `handed` row is the durable record of a disclosure (RoPA 8c; review round
-- 1, pdpa M-A), kept until `ORPHAN_HANDED_RETENTION_YEARS` = 5 after it was
-- settled, the 8c evidence horizon (review round 2, pdpa L-3). SECURITY DEFINER (it runs as the
-- owner, which has BYPASSRLS and the DELETE chamber_app lacks), so it fences
-- itself: the tenant must be the caller's `app.current_tenant`, every DELETE
-- carries `tenant_id = p_tenant`, and a cutoff younger than 90 days
-- (`ORPHAN_ROW_RETENTION_DAYS`) is refused, so no caller can shorten the
-- retention. `search_path` is pinned to `pg_catalog, public, pg_temp` (the
-- 0293 pattern; review round 1, migration M1): with `pg_temp` LAST, a caller's
-- temporary table cannot shadow the table this owner-run function deletes from. The F7 retention sweep calls it once per tenant per daily run.
--
-- Outcomes (review round 2, code-review #2): `superseded` is added — the id is
-- held by a row whose send went out normally; settled with no Resend call.
--
-- Indexes: the partial UNIQUE (tenant_id, resource_type, resource_id) WHERE
-- resource_id IS NOT NULL is what the writers' `ON CONFLICT DO NOTHING` lands
-- on (one row per Resend id); the partial (tenant_id, created_at) WHERE
-- settled_at IS NULL narrows the drain's and the erasure's reads to the
-- unsettled rows (they then sort past-grace first, by attempts and age, in
-- memory: at most a tenant's unsettled rows, review round 2). The drain's
-- NOT EXISTS against `broadcasts.resend_audience_id` has no index on that
-- column; it reads at most 20 orphans per tick against one tenant's rows, so
-- none is added here (an index on `broadcasts` would lock it on deploy).
--
-- Safe before the code that uses it is deployed: a new table nothing reads.
--
-- Rollback: `DROP FUNCTION prune_orphaned_resend_ids(text, timestamptz);
-- DROP TABLE broadcast_orphaned_resend_ids;` — after which an orphan is again
-- only a critical log line (the pre-0325 state, RoPA 8d).
-- ---------------------------------------------------------------------------

-- --- fail fast on the lock (0310 / 0322 precedent) -------------------------
-- Nothing here locks an existing table, so the wait is not expected; kept so
-- a future edit that does cannot hang a live deploy. Handed back as the
-- file's LAST statement.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "broadcast_orphaned_resend_ids" (
  "tenant_id"              text        NOT NULL,
  "orphan_id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
  "broadcast_id"           uuid        NOT NULL,
  "requested_by_member_id" uuid        NOT NULL,
  "resource_type"          text        NOT NULL
                             CONSTRAINT "broadcast_orphaned_resend_ids_resource_type_check"
                             CHECK ("resource_type" IN ('broadcast', 'audience')),
  "resource_id"            text        NULL
                             CONSTRAINT "broadcast_orphaned_resend_ids_resource_id_nonblank"
                             CHECK (btrim("resource_id") <> ''),
  "reason"                 text        NOT NULL
                             CONSTRAINT "broadcast_orphaned_resend_ids_reason_check"
                             CHECK ("reason" IN (
                               'attach_lost', 'row_vanished', 'persist_failed',
                               'read_back_failed_kept', 'dead_broadcast_replaced',
                               'dead_broadcast_kept', 'terminal_reclaim_undecided',
                               'refused_draft_undeleted', 'audience_leaked',
                               'create_unconfirmed'
                             )),
  "created_at"             timestamptz NOT NULL DEFAULT now(),
  "settled_at"             timestamptz NULL,
  "outcome"                text        NULL
                             CONSTRAINT "broadcast_orphaned_resend_ids_outcome_check"
                             CHECK ("outcome" IN ('deleted', 'absent', 'retained', 'handed', 'superseded')),
  CONSTRAINT "broadcast_orphaned_resend_ids_pkey" PRIMARY KEY ("tenant_id", "orphan_id"),
  -- An id is known for every reason but `create_unconfirmed`, which never has one.
  CONSTRAINT "broadcast_orphaned_resend_ids_id_iff_known"
    CHECK (("resource_id" IS NULL) = ("reason" = 'create_unconfirmed')),
  -- Only `createBroadcast` can end unconfirmed.
  CONSTRAINT "broadcast_orphaned_resend_ids_unconfirmed_is_broadcast"
    CHECK ("reason" <> 'create_unconfirmed' OR "resource_type" = 'broadcast'),
  -- The settle CAS writes both, once.
  CONSTRAINT "broadcast_orphaned_resend_ids_settled_pair"
    CHECK (("settled_at" IS NULL) = ("outcome" IS NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_orphaned_resend_ids_resource_uq"
  ON "broadcast_orphaned_resend_ids" ("tenant_id", "resource_type", "resource_id")
  WHERE "resource_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "broadcast_orphaned_resend_ids_unsettled_idx"
  ON "broadcast_orphaned_resend_ids" ("tenant_id", "created_at")
  WHERE "settled_at" IS NULL;--> statement-breakpoint

-- Review round 2 (code-review #2) — the outcome set gains `superseded`. CREATE
-- TABLE IF NOT EXISTS skipped an existing table, so the CHECK is replaced here.
ALTER TABLE "broadcast_orphaned_resend_ids"
  DROP CONSTRAINT IF EXISTS "broadcast_orphaned_resend_ids_outcome_check";--> statement-breakpoint
ALTER TABLE "broadcast_orphaned_resend_ids"
  ADD CONSTRAINT "broadcast_orphaned_resend_ids_outcome_check"
  CHECK ("outcome" IN ('deleted', 'absent', 'retained', 'handed', 'superseded'));--> statement-breakpoint

-- Review round 1 — the attempt counter (a separate ADD COLUMN, see the header).
ALTER TABLE "broadcast_orphaned_resend_ids"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0
    CONSTRAINT "broadcast_orphaned_resend_ids_attempts_nonneg" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "broadcast_orphaned_resend_ids"
  ADD COLUMN IF NOT EXISTS "last_attempted_at" timestamptz NULL;--> statement-breakpoint

-- Review round 1 (migration M2) — UPDATE on the settle and attempt columns
-- only. The REVOKE also removes any column-level UPDATE, so the GRANT below
-- is the whole of what chamber_app may change.
GRANT SELECT, INSERT ON TABLE "broadcast_orphaned_resend_ids" TO chamber_app;--> statement-breakpoint
REVOKE UPDATE ON TABLE "broadcast_orphaned_resend_ids" FROM chamber_app;--> statement-breakpoint
GRANT UPDATE ("settled_at", "outcome", "attempts", "last_attempted_at")
  ON TABLE "broadcast_orphaned_resend_ids" TO chamber_app;--> statement-breakpoint

ALTER TABLE "broadcast_orphaned_resend_ids" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_orphaned_resend_ids" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation_on_broadcast_orphaned_resend_ids" ON "broadcast_orphaned_resend_ids";--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_orphaned_resend_ids"
  ON "broadcast_orphaned_resend_ids"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- Review round 2 (migration LOW) — settled once, in the DB ---------------
-- The settle CAS (`settled_at IS NULL`) already writes a row once; this trigger
-- makes it a property of the table: once `settled_at` is set, neither it nor
-- `outcome` changes. `attempts` / `last_attempted_at` stay writable.
CREATE OR REPLACE FUNCTION public.broadcast_orphaned_resend_ids_settled_once_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.settled_at IS NOT NULL
     AND (NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'broadcast_orphaned_resend_ids_settled_once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "broadcast_orphaned_resend_ids_settled_once" ON "broadcast_orphaned_resend_ids";--> statement-breakpoint
CREATE TRIGGER "broadcast_orphaned_resend_ids_settled_once"
  BEFORE UPDATE ON "broadcast_orphaned_resend_ids"
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_orphaned_resend_ids_settled_once_fn();--> statement-breakpoint

-- --- [P M-1] the retention prune --------------------------------------------

CREATE OR REPLACE FUNCTION public.prune_orphaned_resend_ids(p_tenant text, p_cutoff timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  -- The owner bypasses RLS, so the function is its own tenant fence: only the
  -- tenant the caller's runInTenant scope is bound to.
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM current_setting('app.current_tenant', TRUE) THEN
    RAISE EXCEPTION 'prune_orphaned_resend_ids_tenant_mismatch'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 90 days = ORPHAN_ROW_RETENTION_DAYS (orphaned-resend-id.ts). A younger
  -- cutoff would shorten the retention, so it is refused.
  IF p_cutoff IS NULL OR p_cutoff > now() - interval '90 days' THEN
    RAISE EXCEPTION 'prune_orphaned_resend_ids_cutoff_too_recent'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM broadcast_orphaned_resend_ids
   WHERE tenant_id = p_tenant
     AND (
       -- A `handed` row is the durable disclosure record: kept (pdpa M-A) ...
       (settled_at IS NOT NULL AND settled_at < p_cutoff AND outcome <> 'handed')
       -- ... for ORPHAN_HANDED_RETENTION_YEARS = 5, the 8c horizon (pdpa L-3).
       OR (outcome = 'handed' AND settled_at < now() - interval '5 years')
       OR (reason = 'create_unconfirmed' AND created_at < p_cutoff)
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.prune_orphaned_resend_ids(text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.prune_orphaned_resend_ids(text, timestamptz) TO chamber_app;--> statement-breakpoint

-- Hand the default back (see the lock_timeout block above).
SET LOCAL lock_timeout = DEFAULT;
