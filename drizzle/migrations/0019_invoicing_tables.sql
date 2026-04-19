-- Migration 0019 — F4 Invoicing & Thai-Tax Receipts core tables
--
-- SPEC DEVIATIONS (documented here, reconciled in Phase 10 T115b/c docs pass):
--   1. Migration number 0019 (spec T010 said "0010" — that number was
--      already consumed by F3's audit-log extension). Plan 2026-04 docs
--      to update tasks.md / plan.md / data-model.md migration refs.
--   2. `tenant_id` is `text` NOT `uuid` (spec data-model.md § 1.2 said
--      `uuid REFERENCES tenants(id)`). F2/F3 established `tenant_id
--      text` + RLS on `text = text` because there is no physical
--      `tenants` table — tenant identity lives in env (`TENANT_SLUG`)
--      until F10. F4 matches the F2/F3 convention for consistency.
--   3. Composite FKs where parent uses composite PK:
--        `members` PK = (tenant_id, member_id) → FK on `invoices` uses
--        composite (tenant_id, member_id).
--        `membership_plans` PK = (tenant_id, plan_id, plan_year) → FK
--        on `invoices` uses composite (tenant_id, plan_id, plan_year).
--   4. RLS policy is `FOR ALL TO chamber_app` with matching
--      `USING` + `WITH CHECK` (F3 pattern).
--
-- Creates:
--   - 5 enums: invoice_status, invoice_line_kind, pro_rate_policy,
--              numbering_reset_cadence, document_type
--   - 5 tables: tenant_invoice_settings, tenant_document_sequences,
--              invoices, invoice_lines, credit_notes
--   - RLS + FORCE + FOR ALL TO chamber_app policy on every table
--   - Immutability trigger on invoices (BEFORE UPDATE)
--   - Indexes (inline — §87 UNIQUE + performance)
--
-- Money: all `_satang` columns BIGINT (1 THB = 100 satang). No NUMERIC.
--
-- Rollback: DROP TABLE CASCADE on 5 tables + DROP TYPE on 5 enums; or
-- Neon PITR to pre-0019 snapshot.

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

CREATE TYPE "invoice_status" AS ENUM (
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
  'partially_credited'
);--> statement-breakpoint

CREATE TYPE "invoice_line_kind" AS ENUM ('membership_fee', 'registration_fee');--> statement-breakpoint

CREATE TYPE "pro_rate_policy" AS ENUM ('none', 'monthly', 'daily');--> statement-breakpoint

CREATE TYPE "numbering_reset_cadence" AS ENUM ('yearly', 'perpetual');--> statement-breakpoint

CREATE TYPE "document_type" AS ENUM ('invoice', 'receipt', 'credit_note');--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: tenant_invoice_settings  (one row per tenant)
-- ----------------------------------------------------------------------------

CREATE TABLE "tenant_invoice_settings" (
  "tenant_id"                     text PRIMARY KEY,

  "vat_rate"                      numeric(5,4) NOT NULL,
  "registration_fee_satang"       bigint NOT NULL DEFAULT 0 CHECK ("registration_fee_satang" >= 0),

  "legal_name_th"                 text NOT NULL,
  "legal_name_en"                 text NOT NULL,
  "tax_id"                        text NOT NULL,
  "registered_address_th"         text NOT NULL,
  "registered_address_en"         text NOT NULL,

  "invoice_number_prefix"         text NOT NULL,
  "invoice_number_reset_cadence"  numbering_reset_cadence NOT NULL DEFAULT 'yearly',
  "receipt_numbering_mode"        text NOT NULL DEFAULT 'combined'
                                    CHECK ("receipt_numbering_mode" IN ('combined', 'separate')),
  "credit_note_number_prefix"     text NOT NULL,

  "fiscal_year_start_month"       smallint NOT NULL DEFAULT 1
                                    CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12),

  "default_net_days"              smallint NOT NULL DEFAULT 30
                                    CHECK ("default_net_days" BETWEEN 0 AND 365),
  "pro_rate_policy"               pro_rate_policy NOT NULL DEFAULT 'monthly',

  "logo_blob_key"                 text,
  "auto_email_enabled"            boolean NOT NULL DEFAULT true,
  "billing_reply_to_email"        text,
  "billing_from_name"             text,
  "tenant_logo_count"             integer NOT NULL DEFAULT 0
                                    CHECK ("tenant_logo_count" >= 0 AND "tenant_logo_count" <= 50),

  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "tenant_invoice_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_invoice_settings"
  ON "tenant_invoice_settings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: tenant_document_sequences  (allocator state)
-- ----------------------------------------------------------------------------

CREATE TABLE "tenant_document_sequences" (
  "tenant_id"                     text NOT NULL,
  "document_type"                 document_type NOT NULL,
  "fiscal_year"                   smallint NOT NULL,
  "next_sequence_number"          integer NOT NULL DEFAULT 1
                                    CHECK ("next_sequence_number" >= 1),
  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_document_sequences_pkey"
    PRIMARY KEY ("tenant_id", "document_type", "fiscal_year")
);--> statement-breakpoint

ALTER TABLE "tenant_document_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_document_sequences" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_document_sequences"
  ON "tenant_document_sequences"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: invoices  (aggregate root)
-- ----------------------------------------------------------------------------

CREATE TABLE "invoices" (
  "tenant_id"                     text NOT NULL,
  "invoice_id"                    uuid NOT NULL DEFAULT gen_random_uuid(),
  "member_id"                     uuid NOT NULL,
  "plan_year"                     smallint NOT NULL,
  "plan_id"                       text NOT NULL,

  "status"                        invoice_status NOT NULL DEFAULT 'draft',
  "draft_by_user_id"              uuid NOT NULL REFERENCES "users"("id"),

  "fiscal_year"                   smallint,
  "sequence_number"               integer,
  "document_number"               text,

  "issue_date"                    date,
  "due_date"                      date,
  "paid_at"                       timestamptz,
  "voided_at"                     timestamptz,

  "currency"                      char(3) NOT NULL DEFAULT 'THB',
  "subtotal_satang"               bigint,
  "vat_rate_snapshot"             numeric(5,4),
  "vat_satang"                    bigint,
  "total_satang"                  bigint,
  "credited_total_satang"         bigint NOT NULL DEFAULT 0,

  "pro_rate_policy_snapshot"      text,
  "net_days_snapshot"             smallint,

  "tenant_identity_snapshot"      jsonb,
  "member_identity_snapshot"      jsonb,

  "payment_method"                text,
  "payment_reference"             text,
  "payment_notes"                 text,
  "payment_recorded_by_user_id"   uuid REFERENCES "users"("id"),

  "void_reason"                   text,
  "voided_by_user_id"             uuid REFERENCES "users"("id"),

  "auto_email_on_issue"           boolean,

  "pdf_blob_key"                  text,
  "pdf_sha256"                    char(64),
  "pdf_template_version"          smallint,

  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "invoices_pkey" PRIMARY KEY ("tenant_id", "invoice_id"),

  CONSTRAINT "invoices_member_fk"
    FOREIGN KEY ("tenant_id", "member_id")
    REFERENCES "members" ("tenant_id", "member_id")
    ON DELETE RESTRICT,
  CONSTRAINT "invoices_plan_fk"
    FOREIGN KEY ("tenant_id", "plan_id", "plan_year")
    REFERENCES "membership_plans" ("tenant_id", "plan_id", "plan_year")
    ON DELETE RESTRICT,

  CONSTRAINT "invoices_draft_has_no_number"
    CHECK ("status" = 'draft' OR "sequence_number" IS NOT NULL),
  CONSTRAINT "invoices_non_draft_has_snapshots"
    CHECK (
      "status" = 'draft' OR (
        "subtotal_satang" IS NOT NULL AND "vat_rate_snapshot" IS NOT NULL
        AND "tenant_identity_snapshot" IS NOT NULL AND "member_identity_snapshot" IS NOT NULL
        AND "pdf_blob_key" IS NOT NULL AND "pdf_sha256" IS NOT NULL
      )
    ),
  CONSTRAINT "invoices_paid_has_payment"
    CHECK ("status" != 'paid' OR ("paid_at" IS NOT NULL AND "payment_method" IS NOT NULL)),
  CONSTRAINT "invoices_void_has_reason"
    CHECK ("status" != 'void' OR ("voided_at" IS NOT NULL AND "void_reason" IS NOT NULL AND "voided_by_user_id" IS NOT NULL)),
  CONSTRAINT "invoices_credited_total_in_range"
    CHECK ("credited_total_satang" >= 0 AND ("total_satang" IS NULL OR "credited_total_satang" <= "total_satang")),
  CONSTRAINT "invoices_credited_status_matches"
    CHECK (
      ("credited_total_satang" = 0 AND "status" NOT IN ('credited','partially_credited'))
      OR ("credited_total_satang" > 0 AND "total_satang" IS NOT NULL AND "credited_total_satang" < "total_satang" AND "status" = 'partially_credited')
      OR ("credited_total_satang" > 0 AND "total_satang" IS NOT NULL AND "credited_total_satang" = "total_satang" AND "status" = 'credited')
    )
);--> statement-breakpoint

CREATE UNIQUE INDEX "invoices_tenant_fiscal_seq_unique"
  ON "invoices" ("tenant_id", "fiscal_year", "sequence_number")
  WHERE "sequence_number" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "invoices_tenant_status_issued_idx"
  ON "invoices" ("tenant_id", "status", "issue_date" DESC);--> statement-breakpoint
CREATE INDEX "invoices_tenant_member_status_idx"
  ON "invoices" ("tenant_id", "member_id", "status");--> statement-breakpoint
CREATE INDEX "invoices_tenant_due_date_issued_idx"
  ON "invoices" ("tenant_id", "due_date")
  WHERE "status" = 'issued';--> statement-breakpoint

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_invoices"
  ON "invoices"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- Immutability trigger — reject changes to snapshot columns once non-draft.
-- Allows legitimate lifecycle mutations (status transitions, pay/void
-- recording, pdf_* on re-render) but locks pricing/identity snapshots.
CREATE OR REPLACE FUNCTION "invoices_enforce_immutability"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW."subtotal_satang"            IS DISTINCT FROM OLD."subtotal_satang"
     OR NEW."vat_rate_snapshot"       IS DISTINCT FROM OLD."vat_rate_snapshot"
     OR NEW."vat_satang"              IS DISTINCT FROM OLD."vat_satang"
     OR NEW."total_satang"            IS DISTINCT FROM OLD."total_satang"
     OR NEW."fiscal_year"             IS DISTINCT FROM OLD."fiscal_year"
     OR NEW."sequence_number"         IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_number"         IS DISTINCT FROM OLD."document_number"
     OR NEW."issue_date"              IS DISTINCT FROM OLD."issue_date"
     OR NEW."due_date"                IS DISTINCT FROM OLD."due_date"
     OR NEW."pro_rate_policy_snapshot" IS DISTINCT FROM OLD."pro_rate_policy_snapshot"
     OR NEW."net_days_snapshot"       IS DISTINCT FROM OLD."net_days_snapshot"
     OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
     OR NEW."member_identity_snapshot" IS DISTINCT FROM OLD."member_identity_snapshot"
     OR NEW."member_id"               IS DISTINCT FROM OLD."member_id"
     OR NEW."plan_id"                 IS DISTINCT FROM OLD."plan_id"
     OR NEW."plan_year"               IS DISTINCT FROM OLD."plan_year"
  THEN
    RAISE EXCEPTION 'invoices: snapshot columns are immutable once status != draft (row id=%)', OLD."invoice_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "invoices_enforce_immutability_trg"
  BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION "invoices_enforce_immutability"();--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: invoice_lines
-- ----------------------------------------------------------------------------

CREATE TABLE "invoice_lines" (
  "tenant_id"           text NOT NULL,
  "line_id"             uuid NOT NULL DEFAULT gen_random_uuid(),
  "invoice_id"          uuid NOT NULL,
  "kind"                invoice_line_kind NOT NULL,
  "description_th"      text NOT NULL,
  "description_en"      text NOT NULL,
  "unit_price_satang"   bigint NOT NULL CHECK ("unit_price_satang" >= 0),
  "quantity"            numeric(10,4) NOT NULL DEFAULT 1 CHECK ("quantity" > 0),
  "pro_rate_factor"     numeric(6,4),
  "total_satang"        bigint NOT NULL CHECK ("total_satang" >= 0),
  "position"            smallint NOT NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("tenant_id", "line_id"),
  CONSTRAINT "invoice_lines_invoice_fk"
    FOREIGN KEY ("tenant_id", "invoice_id")
    REFERENCES "invoices" ("tenant_id", "invoice_id")
    ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "invoice_lines_invoice_idx"
  ON "invoice_lines" ("tenant_id", "invoice_id", "position");--> statement-breakpoint

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_invoice_lines"
  ON "invoice_lines"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- Table: credit_notes
-- ----------------------------------------------------------------------------

CREATE TABLE "credit_notes" (
  "tenant_id"                   text NOT NULL,
  "credit_note_id"              uuid NOT NULL DEFAULT gen_random_uuid(),
  "original_invoice_id"         uuid NOT NULL,

  "fiscal_year"                 smallint NOT NULL,
  "sequence_number"             integer NOT NULL,
  "document_number"             text NOT NULL,

  "issue_date"                  date NOT NULL,
  "issued_by_user_id"           uuid NOT NULL REFERENCES "users"("id"),
  "reason"                      text NOT NULL,

  "credit_amount_satang"        bigint NOT NULL CHECK ("credit_amount_satang" > 0),
  "vat_satang"                  bigint NOT NULL CHECK ("vat_satang" >= 0),
  "total_satang"                bigint NOT NULL,

  "tenant_identity_snapshot"    jsonb NOT NULL,
  "member_identity_snapshot"    jsonb NOT NULL,

  "pdf_blob_key"                text NOT NULL,
  "pdf_sha256"                  char(64) NOT NULL,
  "pdf_template_version"        smallint NOT NULL,

  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("tenant_id", "credit_note_id"),
  CONSTRAINT "credit_notes_original_invoice_fk"
    FOREIGN KEY ("tenant_id", "original_invoice_id")
    REFERENCES "invoices" ("tenant_id", "invoice_id")
    ON DELETE RESTRICT
);--> statement-breakpoint

CREATE UNIQUE INDEX "credit_notes_tenant_fiscal_seq_unique"
  ON "credit_notes" ("tenant_id", "fiscal_year", "sequence_number");--> statement-breakpoint

CREATE INDEX "credit_notes_tenant_original_idx"
  ON "credit_notes" ("tenant_id", "original_invoice_id");--> statement-breakpoint

ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_credit_notes"
  ON "credit_notes"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));
