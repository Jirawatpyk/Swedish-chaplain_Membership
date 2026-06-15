-- ---------------------------------------------------------------------------
-- Migration 0217 — F7.1a US1 DB-constraint closure for partially_sent /
-- partial_delivery_accepted (finding H-1).
--
-- Migration 0064 defined broadcasts_state_machine_fn() for the 8-state
-- F7-MVP machine + the broadcasts_quota_year_only_on_sent CHECK keyed to
-- status='sent'. Migration 0169 added the two F7.1a enum VALUES
-- (partially_sent, partial_delivery_accepted) but never updated EITHER the
-- trigger CASE or the quota CHECK — so every F7.1a UPDATE transition raised
-- at the DB layer once the flags flipped:
--   - sending -> partially_sent / sending -> cancelled (batch cancel) ->
--     RAISE broadcast_invalid_state_transition (the 'sending' arm allowed
--     only sent / failed_to_dispatch)
--   - partially_sent -> partial_delivery_accepted / partially_sent ->
--     sending (retry) -> CASE_NOT_FOUND 20000 (no 'partially_sent' WHEN arm)
--   - partial_delivery_accepted + quota_year_consumed -> CHECK violation
--     (the quota CHECK keyed quota to status='sent' only)
-- 0124 only ALTERed the function search_path, NOT the body.
--
-- Part 1 — CREATE OR REPLACE the trigger function with the F7.1a edges + an
-- explicit ELSE (defensive against any future enum value reaching the CASE).
-- `SET search_path = pg_catalog, public` is RE-DECLARED so this replacement
-- does not regress the 0124 hardening (CREATE OR REPLACE drops proconfig SET
-- clauses not re-stated here).
--
-- Part 2 — widen broadcasts_quota_year_only_on_sent so the quota columns may
-- also be set on partial_delivery_accepted (FR-008c: accepting a partial
-- delivery consumes the member's annual quota slot, exactly like a full send).
--
-- Idempotent + forward-only: CREATE OR REPLACE FUNCTION + DROP CONSTRAINT IF
-- EXISTS + ADD CONSTRAINT. main's code does not yet DRIVE these transitions
-- until the F7.1a roll-up (finding Ship-blocker A) lands; this migration
-- removes the DB-layer barrier so that roll-up + accept-partial + cancel can
-- commit instead of 500-ing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION broadcasts_state_machine_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed_targets text[];
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;  -- no transition; non-status updates allowed
  END IF;

  CASE OLD.status
    WHEN 'draft'                     THEN allowed_targets := ARRAY['submitted', 'cancelled'];
    WHEN 'submitted'                 THEN allowed_targets := ARRAY['approved', 'rejected', 'cancelled'];
    WHEN 'approved'                  THEN allowed_targets := ARRAY['sending', 'cancelled', 'failed_to_dispatch'];
    -- F7.1a US1: a batched send may progress to partially_sent (FR-008a) or
    -- be cancelled mid-dispatch (FR-004a hasBatches path) in addition to the
    -- F7-MVP sent / failed_to_dispatch edges.
    WHEN 'sending'                   THEN allowed_targets := ARRAY['sent', 'failed_to_dispatch', 'cancelled', 'partially_sent'];
    -- F7.1a US1: partially_sent is NON-terminal — admin retry (-> sending,
    -- FR-008b) or accept-partial (-> partial_delivery_accepted, FR-008c).
    WHEN 'partially_sent'            THEN allowed_targets := ARRAY['sending', 'partial_delivery_accepted'];
    WHEN 'sent'                      THEN allowed_targets := ARRAY[]::text[];
    WHEN 'rejected'                  THEN allowed_targets := ARRAY[]::text[];
    WHEN 'cancelled'                 THEN allowed_targets := ARRAY[]::text[];
    WHEN 'failed_to_dispatch'        THEN allowed_targets := ARRAY[]::text[];
    WHEN 'partial_delivery_accepted' THEN allowed_targets := ARRAY[]::text[];  -- TERMINAL
    ELSE
      -- Defensive: any future enum value reaching an UPDATE without a
      -- matching arm has no legal outbound transition (raises
      -- invalid_transition below) rather than aborting with the opaque
      -- CASE_NOT_FOUND (20000) the original arm-less body threw.
      allowed_targets := ARRAY[]::text[];
  END CASE;

  IF NOT (NEW.status::text = ANY (allowed_targets)) THEN
    RAISE EXCEPTION 'broadcast_invalid_state_transition'
      USING ERRCODE = 'check_violation',
            DETAIL  = format('cannot transition broadcast from %s to %s', OLD.status, NEW.status),
            HINT    = 'See FR-004 + FR-004a + FR-008 state machine.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

ALTER TABLE "broadcasts" DROP CONSTRAINT IF EXISTS "broadcasts_quota_year_only_on_sent";--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_quota_year_only_on_sent" CHECK (
  (status IN ('sent', 'partial_delivery_accepted') AND quota_year_consumed IS NOT NULL AND quota_consumed_at IS NOT NULL)
  OR (status NOT IN ('sent', 'partial_delivery_accepted') AND quota_year_consumed IS NULL AND quota_consumed_at IS NULL)
);
