-- ---------------------------------------------------------------------------
-- F7 — marketing_unsubscribes table (T013 per specs/010-email-broadcast/tasks.md).
--
-- Tenant-scoped suppression list. Natural composite PK
-- (tenant_id, email_lower) — FR-018 + Q8 invariant. Idempotent upsert is
-- the primary write pattern (replaying an unsubscribe is safe; last-write
-- audit chain via `broadcast_unsubscribed` event).
--
-- Source of truth: specs/010-email-broadcast/data-model.md § 1.3.
--
-- Retention: indefinite per GDPR Art. 21 + PDPA §32. On member-erasure
-- (Art. 17), `member_id` SET NULL but the row is RETAINED — the regulatory
-- invariant "we will not contact this email again" outlives the underlying
-- member record. Suppression deletion is reserved for `swecham_super` ops
-- role only (compliance-officer-driven re-subscription edge case — out of
-- MVP UI; capability preserved for legal-counsel-mandated deletion under
-- Art. 17 if regulatory authority orders it).
-- ---------------------------------------------------------------------------

-- --- 1. Enum: marketing_unsubscribe_reason ----------------------------------

CREATE TYPE "marketing_unsubscribe_reason" AS ENUM (
  'recipient_initiated',
  'hard_bounce',
  'complaint',
  'admin_added'
);--> statement-breakpoint

-- --- 2. marketing_unsubscribes table ----------------------------------------

CREATE TABLE "marketing_unsubscribes" (
  "tenant_id"           text NOT NULL,
  "email_lower"         text NOT NULL,
  "member_id"           uuid,                                        -- SET NULL on Art. 17

  "reason"              "marketing_unsubscribe_reason" NOT NULL,
  "reason_text"         text,                                        -- ≤500 chars optional free-text
  "source_broadcast_id" uuid,                                        -- null for hard_bounce/complaint
  "source_token_hash"   text,                                        -- sha256(token); null for non-token sources

  "unsubscribed_at"     timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "marketing_unsubscribes_pkey" PRIMARY KEY ("tenant_id", "email_lower")
);--> statement-breakpoint

-- --- 3. Indexes -------------------------------------------------------------

-- Member-side lookup ("show me everyone who unsubscribed from my plan-tier broadcasts")
CREATE INDEX "marketing_unsubscribes_member_lookup_idx"
  ON "marketing_unsubscribes" ("tenant_id", "member_id")
  WHERE "member_id" IS NOT NULL;--> statement-breakpoint

-- Time-series query for ops dashboard
CREATE INDEX "marketing_unsubscribes_unsubscribed_at_idx"
  ON "marketing_unsubscribes" ("tenant_id", "unsubscribed_at" DESC);--> statement-breakpoint

-- --- 4. Row-Level Security --------------------------------------------------
-- The public unsubscribe page (/unsubscribe/[token]) and Resend webhook
-- (/api/webhooks/resend-broadcasts) write to this table after resolving
-- tenant_id from the signed token / resend_broadcast_id lookup. Both
-- handlers re-bind `app.current_tenant` via `runInTenant(ctx, ...)`
-- BEFORE the upsert — the bypass window is signature/token verification
-- only. RLS enforces tenant scope on the actual write.

ALTER TABLE "marketing_unsubscribes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "marketing_unsubscribes" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_marketing_unsubscribes"
  ON "marketing_unsubscribes"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 5. Grants --------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE "marketing_unsubscribes" TO chamber_app;--> statement-breakpoint
-- NOTE: NO DELETE grant. Suppression deletion is `swecham_super` ops role
-- only (out-of-MVP). The Art. 17 cascade hook updates `member_id` to NULL
-- via UPDATE — does NOT delete the row.
