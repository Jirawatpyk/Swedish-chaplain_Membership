-- ---------------------------------------------------------------------------
-- COMP-1 US2b — GDPR Art.17 / PDPA §33 broadcast_deliveries tombstone.
--
-- The erasure path must tombstone every `broadcast_deliveries` row that
-- pointed at the erased member: `recipient_member_id` → NULL and
-- `recipient_email_lower` → `erased+<delivery_id>@erased.invalid`. The row
-- is RETAINED (never deleted) for record-of-processing per PDPA §39 +
-- GDPR Art.30.
--
-- The table is append-only via `broadcast_deliveries_append_only_fn`, fired
-- by BOTH `broadcast_deliveries_no_update` (UPDATE) and
-- `broadcast_deliveries_no_delete` (DELETE). The tombstone is an UPDATE, so
-- this migration adds a GUC-gated, UPDATE-only exemption arm to that
-- function — the same established append-only-bypass pattern as F4's
-- `app.allow_pii_redaction` on `invoices_enforce_immutability` (migrations
-- 0205/0207/0214) and US2b's own `app.allow_broadcast_redaction` arm on
-- `broadcasts_immutable_after_submit_fn` (migration 0224).
--
-- WHY a GUC arm + GRANT, NOT `ALTER TABLE … DISABLE TRIGGER`:
--   Under `runInTenant` the session role is `chamber_app`, which is NOT the
--   owner of `broadcast_deliveries` (owner = neondb_owner). `ALTER TABLE …
--   DISABLE/ENABLE TRIGGER` requires table ownership, so it would fail. The
--   0065 comment that referenced a `setMemberIdNull` DISABLE-TRIGGER dance
--   was aspirational — no such code ever existed. The GUC arm keeps the
--   tombstone a plain UPDATE inside `runInTenant`/`chamber_app`/RLS:
--   Principle I (two-layer tenant isolation) preserved, no owner role.
--
-- WHAT CHANGES UNDER THE GUC (UPDATE only):
--   When the erasure tx sets `SET LOCAL app.allow_broadcast_redaction = 'on'`
--   the UPDATE branch permits a change to ONLY the three recipient-PII columns
--   `recipient_member_id` + `recipient_email_lower` + `error_message`.
--   `error_message` is PII because it stores RAW Resend bounce diagnostics
--   (persisted UNSANITIZED from the webhook) and SMTP bounce strings routinely
--   embed the recipient email (e.g. `550 5.1.1 <addr@example.com> unknown`),
--   so the tombstone must be able to NULL it too — otherwise the erased
--   member's email survives as plaintext (incomplete Art.17 erasure).
--   A change to ANY of the 10 remaining (non-PII) columns still RAISEs
--   `broadcast_deliveries_redaction_only_pii_cols` (ERRCODE check_violation)
--   so the exemption cannot be abused to rewrite the delivery audit
--   (status / timestamps / Resend ids / broadcast_id / bounce_type).
--
-- DELETE STAYS PERMANENTLY BLOCKED: the GUC never relaxes DELETE. On DELETE
--   `TG_OP = 'DELETE'`, the GUC arm is skipped, and the original
--   unconditional RAISE fires (`NEW` is NULL on DELETE — referencing NEW.*
--   columns there would itself error, so the TG_OP guard is required).
--
-- The same GUC `app.allow_broadcast_redaction` is reused for both the
-- broadcasts content scrub (0224) and this deliveries tombstone — the
-- erasure tx sets it once and it covers both UPDATEs.
--
-- SEARCH-PATH HARDENING: `CREATE OR REPLACE FUNCTION` RESETS the per-function
--   config previously applied via `ALTER FUNCTION … SET search_path` in
--   migration 0124. We re-declare `SET search_path = pg_catalog, public`
--   INLINE on the function so the hardening survives this replace.
--
-- GRANT: migration 0065 deliberately granted chamber_app only SELECT, INSERT
--   (append-only intent). The tombstone needs UPDATE. RLS+FORCE
--   (`tenant_isolation_on_broadcast_deliveries`, 0065) still confines every
--   chamber_app UPDATE to the tenant in `app.current_tenant` — the GRANT
--   widens the verb, not the row scope. Idempotent.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION broadcast_deliveries_append_only_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
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

  -- Normal path (GUC unset, or any DELETE) — UNCHANGED from migration 0065.
  RAISE EXCEPTION 'broadcast_deliveries_append_only'
    USING ERRCODE = 'check_violation',
          HINT    = 'broadcast_deliveries rows are insert-only (audit trail).';
END;
$$;--> statement-breakpoint

GRANT UPDATE ON TABLE "broadcast_deliveries" TO chamber_app;--> statement-breakpoint
