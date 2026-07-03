-- 0230 — F6 → F3/F8: deterministic event attendance bumps members.last_activity_at.
--
-- The F3 audit_log trigger (migration 0009) bumps last_activity_at only on
-- audit rows carrying a snake `member_id`. F6 attendance was never counted as
-- member activity (a matched ingest never refreshed recency), so an event-only-
-- active member could look dormant in the directory + accrue the F8
-- `days_since_contact_update_gt_365` risk factor despite attending events.
--
-- Fix: bump last_activity_at directly from the attendance table on INSERT.
-- Gated to DETERMINISTIC matches (member_contact / member_domain). A
-- low-confidence `member_fuzzy` company-name guess must NOT bump, because a
-- false positive is UN-correctable: `registration_relinked` (the admin fix)
-- carries no scalar member_id to undo a prior bump, so a wrongly-matched member
-- would look "recently active" forever, masking a genuinely at-risk member.
--
-- DECOUPLED FROM THE TIMELINE ON PURPOSE: the `member_timeline_v` `event`
-- source (migration 0192) already lists EVERY matched registration
-- (WHERE matched_member_id IS NOT NULL), so this trigger adds ONLY the recency
-- bump — it must NOT route through an audit `member_id` (which would create a
-- duplicate timeline row).
--
-- SECURITY DEFINER + locked search_path mirror the 0009 audit trigger
-- (members is RLS+FORCE; the event_registrations INSERT runs in a tenant
-- context). FORWARD-ONLY: never lowers an existing last_activity_at, so a
-- historical/backdated import cannot rewind a member's recency.

CREATE OR REPLACE FUNCTION public.members_event_registration_bump_last_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ts timestamptz;
BEGIN
  -- Activity time = when the member registered (bounded by now). registered_at
  -- is NOT NULL today; the COALESCE chain (imported_at NOT NULL DEFAULT now(),
  -- then now()) is defensive against a future relaxation so v_ts is never NULL.
  v_ts := COALESCE(NEW.registered_at, NEW.imported_at, now());

  -- Scope to the registration row's tenant_id so a forged matched_member_id
  -- can never bump a member in another tenant. Forward-only guard keeps a
  -- backdated import from rewinding recency.
  UPDATE members
     SET last_activity_at = v_ts
   WHERE member_id = NEW.matched_member_id
     AND tenant_id = NEW.tenant_id
     AND (last_activity_at IS NULL OR last_activity_at < v_ts);

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Grant EXECUTE to chamber_app; without it an INSERT from an app session
-- cannot fire the AFTER trigger (mirrors the 0009 audit trigger grant).
GRANT EXECUTE ON FUNCTION public.members_event_registration_bump_last_activity() TO chamber_app;--> statement-breakpoint

-- WHEN clause filters at the trigger layer so the function body only runs for
-- deterministic matched rows (member_fuzzy / non_member / unmatched skip it).
CREATE TRIGGER "event_registration_bump_member_last_activity"
  AFTER INSERT ON "event_registrations"
  FOR EACH ROW
  WHEN (
    NEW."matched_member_id" IS NOT NULL
    AND NEW."match_type"::text IN ('member_contact', 'member_domain')
  )
  EXECUTE FUNCTION public.members_event_registration_bump_last_activity();
