-- ---------------------------------------------------------------------------
-- Migration 0310 — F7 retention sweep: let a closed E-Blast past its
-- `retention_years` be deleted, together with everything that hangs off it.
--
-- The RoPA declares 5 years for `broadcasts` and `broadcast_deliveries`
-- (docs/compliance/processing-records.md, F7 retention table). Until now
-- nothing deleted a `broadcasts` row on age, so the 5 years was a
-- classification, not an enforced retention. The daily cron
-- `/api/cron/broadcasts/retention-sweep` (sweepExpiredBroadcasts) deletes the
-- PARENT row; this migration makes the one child that could not follow it
-- able to.
--
-- Numbered 0310, journal idx 311, `when` 1798544300000 — strictly after
-- 0309's 1798544200000 (a duplicate `when` makes db:migrate a silent no-op).
--
-- Carries:
--   0. audit_event_type += 'broadcast_retention_swept' (one counts-only row
--      per tenant per daily run). Hoisted to AUTOCOMMIT by the runner
--      (scripts/lib/enum-migration-guard.ts); the transactional copy below is
--      an `IF NOT EXISTS` no-op.
--   1. broadcast_deliveries (tenant_id, broadcast_id) → broadcasts
--      (tenant_id, broadcast_id) ON DELETE CASCADE, NOT VALID. The target is
--      `broadcasts_pkey` (0064) and the columns are exactly those of
--      `broadcast_versions_broadcast_fk` (0308). Until now the column was a
--      logical FK only (0065), so deleting a broadcast left its deliveries
--      behind for ever.
--   2. broadcast_deliveries_append_only_fn gains ONE arm: a DELETE is allowed
--      when `pg_trigger_depth() > 1`, i.e. when it arrives through the parent's
--      RI cascade — the rule 0308 gave broadcast_member_decisions. Everything
--      else is 0225's body VERBATIM (the UPDATE-only redaction-GUC arm and the
--      unconditional RAISE); a DELETE issued directly against the table
--      (depth 1) still raises `broadcast_deliveries_append_only`.
--
-- NOT VALID — and why the sweep does not need VALIDATE. NOT VALID skips the
-- check of EXISTING rows only; every new INSERT is checked from this commit
-- on (the webhook resolves the parent before it inserts, so it always has
-- one). A cascade fires whether or not the constraint is validated, so the
-- sweep works as soon as this lands. `VALIDATE CONSTRAINT` is a SEPARATE,
-- MANUAL step, run only after a read-only orphan count on the target branch
-- is 0 (docs/runbooks/cron-jobs.md § F7 retention-sweep). It is deliberately
-- NOT in this file: an orphaned delivery row (a dev-branch test leftover, a
-- pre-FK hand fix) would make VALIDATE fail and abort the deploy.
--
-- The RI cascade runs as the CHILD table's owner, not as chamber_app, which
-- is why NO DELETE grant is added here (0065 granted chamber_app SELECT,
-- INSERT; 0225 added UPDATE). chamber_app still cannot DELETE a delivery row
-- directly: no grant, and the trigger raises at depth 1.
--
-- The FK's lookup side is served by `broadcast_deliveries_broadcast_status_idx`
-- (tenant_id, broadcast_id, status) from 0065 — its leading columns are the
-- FK columns, so no new index is needed for the cascade.
--
-- Residual (same as 0308): a DELETE issued from inside some OTHER trigger
-- would also pass the depth test; none exists.
--
-- SEARCH-PATH HARDENING: CREATE OR REPLACE resets per-function config, so
-- `SET search_path = pg_catalog, public` is re-declared inline (as 0225 did).
--
-- Rollback: the enum value is irreversible (and harmless). `ALTER TABLE
-- broadcast_deliveries DROP CONSTRAINT broadcast_deliveries_broadcast_fk;`
-- and re-apply the 0225 function body. Rows the sweep already deleted are
-- gone; the `broadcast_retention_swept` audit rows record how many.
-- ---------------------------------------------------------------------------

-- --- 0. enum value (hoisted to AUTOCOMMIT by the runner) --------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_retention_swept';--> statement-breakpoint

-- --- 1. the FK the cascade needs --------------------------------------------

ALTER TABLE "broadcast_deliveries"
  ADD CONSTRAINT "broadcast_deliveries_broadcast_fk"
  FOREIGN KEY ("tenant_id", "broadcast_id")
  REFERENCES "broadcasts" ("tenant_id", "broadcast_id") ON DELETE CASCADE
  NOT VALID;--> statement-breakpoint

-- --- 2. the append-only trigger lets the parent cascade through -------------

CREATE OR REPLACE FUNCTION broadcast_deliveries_append_only_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- 0310 — Depth 1 = a DELETE issued directly against this table → refused
  -- below. Depth > 1 = issued from inside another trigger, here the RI
  -- cascade of `broadcasts` (the retention sweep deleting the parent) → the
  -- delivery row leaves with its E-Blast. Mirrors
  -- broadcast_member_decisions_append_only_fn (0308).
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  -- GDPR Art.17 tombstone exemption: UPDATE only, opted-in via
  -- `SET LOCAL app.allow_broadcast_redaction = 'on'`. The `, true` arg to
  -- current_setting returns NULL (not an error) when the GUC was never set
  -- in this session, so the normal append-only path is unaffected. DELETE
  -- (TG_OP = 'DELETE', NEW IS NULL) never reaches this branch.
  IF TG_OP = 'UPDATE'
     AND current_setting('app.allow_broadcast_redaction', true) = 'on' THEN
    IF NEW."tenant_id"                            IS DISTINCT FROM OLD."tenant_id"
       OR NEW."delivery_id"                       IS DISTINCT FROM OLD."delivery_id"
       OR NEW."broadcast_id"                      IS DISTINCT FROM OLD."broadcast_id"
       OR NEW."resend_event_id"                   IS DISTINCT FROM OLD."resend_event_id"
       OR NEW."resend_message_id"                 IS DISTINCT FROM OLD."resend_message_id"
       OR NEW."recipient_member_lookup_attempted_at" IS DISTINCT FROM OLD."recipient_member_lookup_attempted_at"
       OR NEW."status"                            IS DISTINCT FROM OLD."status"
       OR NEW."event_timestamp"                   IS DISTINCT FROM OLD."event_timestamp"
       -- error_message MAY change under the GUC: it stores raw Resend bounce
       -- diagnostics that can embed the recipient email (PII). The tombstone
       -- NULLs it; blocking it here would leave the email as plaintext.
       OR NEW."bounce_type"                       IS DISTINCT FROM OLD."bounce_type"
       OR NEW."created_at"                        IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'broadcast_deliveries_redaction_only_pii_cols'
        USING ERRCODE = 'check_violation',
              HINT    = 'Under app.allow_broadcast_redaction only recipient_member_id/recipient_email_lower/error_message may change.';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset, or a DIRECT DELETE) — UNCHANGED from migration 0065.
  RAISE EXCEPTION 'broadcast_deliveries_append_only'
    USING ERRCODE = 'check_violation',
          HINT    = 'broadcast_deliveries rows are insert-only (audit trail).';
END;
$$;--> statement-breakpoint
