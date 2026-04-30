-- 0075 — Loosen `broadcasts_immutable_after_submit_fn` to permit
-- `scheduled_for` mutation during submitted → approved transition.
--
-- Bug: the original trigger (migration 0064) blocked ALL scheduled_for
-- changes after status leaves 'draft'. But FR-011 says admin approval
-- chooses between "send now" (sets scheduled_for = NOW()) and
-- "schedule" (sets scheduled_for = <future>). Both paths need to
-- update scheduled_for during the submitted → approved transition.
--
-- Fix: skip the scheduled_for arm of the immutability check when
-- OLD.status = 'submitted' AND NEW.status = 'approved'. All other
-- content fields (subject/body/segment/custom_recipient_emails) stay
-- locked per FR-004 + Q3. Other transitions (approved → cancelled,
-- approved → sending, etc.) keep scheduled_for locked because by
-- then the cron has picked it up.

CREATE OR REPLACE FUNCTION broadcasts_immutable_after_submit_fn()
RETURNS TRIGGER AS $$
DECLARE
  scheduled_for_changed boolean;
BEGIN
  IF OLD.status != 'draft' THEN
    scheduled_for_changed := NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for;
    -- During submit → approve, admin sets scheduled_for. Allowed.
    IF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      scheduled_for_changed := FALSE;
    END IF;

    IF NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body_html IS DISTINCT FROM OLD.body_html
       OR NEW.body_source IS DISTINCT FROM OLD.body_source
       OR NEW.segment_type IS DISTINCT FROM OLD.segment_type
       OR NEW.segment_params IS DISTINCT FROM OLD.segment_params
       OR NEW.custom_recipient_emails IS DISTINCT FROM OLD.custom_recipient_emails
       OR scheduled_for_changed THEN
      RAISE EXCEPTION 'broadcast_immutable_after_submit'
        USING ERRCODE = 'check_violation',
              HINT    = 'Cancel and create a new draft to change content (FR-004 + Clarifications Q3).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
