-- ---------------------------------------------------------------------------
-- F6 Phase 2 Foundational · T007 — event_registrations table.
--
-- One row per attendee registration. Identified per tenant by
-- (event_id, external_id) — UNIQUE INDEX in migration 0131. FR-011
-- replay-idempotency: ON CONFLICT (tenant_id, event_id, external_id) DO
-- NOTHING is the second of two webhook idempotency layers (the first is
-- the eventcreate_idempotency_receipts X-Request-ID dedup in migration
-- 0134).
--
-- Source of truth: specs/012-eventcreate-integration/data-model.md § 1.2.
--
-- Differentiated retention (FR-032):
--   - member-linked rows (match_type IN 'member_*'): retained 5 years
--   - non-member rows (match_type IN 'non_member','unmatched'): PII
--     pseudonymised at 2 years by the daily retention sweep (Phase 10
--     T113); the row is preserved (for quota aggregates + audit
--     forensics) but attendee_email / name / company become salted
--     SHA-256 hashes. The pii_pseudonymised_at timestamp marks the
--     transition; partial index in 0131 keeps the sweep scan fast.
--
-- Generated column `attendee_email_lower` keeps lowercase email
-- searches O(index-scan) regardless of casing in the source payload.
-- STORED (not virtual) so the partial index on lower-cased email
-- search remains queryable.
--
-- RLS+FORCE for this table lives in migration 0133.
-- ---------------------------------------------------------------------------

CREATE TABLE "event_registrations" (
  "tenant_id"             text NOT NULL,
  "registration_id"       uuid NOT NULL DEFAULT gen_random_uuid(),

  "event_id"              uuid NOT NULL,
  "external_id"           text NOT NULL,           -- EventCreate attendee ID

  -- Attendee identity (FR-032 differentiated retention applies here).
  "attendee_email"        text NOT NULL,
  "attendee_email_lower"  text GENERATED ALWAYS AS (lower("attendee_email")) STORED,
  "attendee_name"         text NOT NULL,
  "attendee_company"      text,

  -- Match resolution (FR-012 — 4-rule cascade + non_member + unmatched).
  "match_type"            text NOT NULL,
  "matched_member_id"     uuid,
  "matched_contact_id"    uuid,

  -- Ticket info (record-only from EventCreate; F6 has zero payment surface).
  -- THB stored as plain integer (no satang sub-unit — F4/F5 use satang
  -- for invoices/payments because those money flows need 0.01 THB
  -- precision; F6 only mirrors the EventCreate ticket price for
  -- display + audit).
  "ticket_type"           text,
  "ticket_price_thb"      integer,
  "payment_status"        text NOT NULL DEFAULT 'paid',

  -- Quota accounting flags (FR-015 / FR-016 / FR-017 / FR-018).
  "counted_against_partnership"    boolean NOT NULL DEFAULT false,
  "counted_against_cultural_quota" boolean NOT NULL DEFAULT false,

  -- Forward-compat (FR-011a).
  "metadata"              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Retention + lifecycle (FR-032).
  "registered_at"         timestamptz NOT NULL,
  "imported_at"           timestamptz NOT NULL DEFAULT now(),
  "pii_pseudonymised_at"  timestamptz,             -- NULL until retention sweep at 2y

  CONSTRAINT "event_registrations_pk"
    PRIMARY KEY ("tenant_id", "registration_id"),

  CONSTRAINT "event_registrations_match_type_check"
    CHECK ("match_type" IN ('member_contact','member_domain','member_fuzzy','non_member','unmatched')),

  CONSTRAINT "event_registrations_payment_status_check"
    CHECK ("payment_status" IN ('paid','pending','refunded','free')),

  -- Composite FK to events (per data-model.md § 1.2 — tenant-scoped FK).
  CONSTRAINT "event_registrations_event_fk"
    FOREIGN KEY ("tenant_id", "event_id")
    REFERENCES "events" ("tenant_id", "event_id")
    ON DELETE RESTRICT,

  -- Domain invariant FR-013: non-member / unmatched rows MUST NOT carry
  -- quota flags set, AND matched_member_id MUST be NULL for those types.
  -- Application layer enforces this on insert/update, but DB-level CHECK
  -- is defense-in-depth.
  CONSTRAINT "event_registrations_non_member_no_quota"
    CHECK (
      "match_type" NOT IN ('non_member','unmatched')
      OR (
        "matched_member_id" IS NULL
        AND "counted_against_partnership" = false
        AND "counted_against_cultural_quota" = false
      )
    )
);--> statement-breakpoint

-- --- Grants for chamber_app role --------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "event_registrations"
  TO chamber_app;--> statement-breakpoint
