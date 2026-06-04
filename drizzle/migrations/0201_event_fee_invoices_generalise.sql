-- 054-event-fee-invoices (Task 3+4) — generalise the `invoices` table so it
-- can carry an EVENT-fee invoice alongside the classic MEMBERSHIP invoice.
--
-- Shape changes:
--   1. New enum `invoice_subject` ('membership' | 'event') — the
--      discriminator. Brand-new type → safe inside this transaction (only
--      `ADD VALUE` on a pre-existing enum is transaction-restricted; that
--      lives in the earlier 0200 migration).
--   2. Member/plan identity columns become NULLABLE: membership invoices
--      set them, event invoices leave them NULL. Every existing row already
--      has member_id/plan_id/plan_year non-null, so DROP NOT NULL is
--      backward-compatible.
--   3. Four new columns: invoice_subject (DEFAULT 'membership' backfills all
--      existing rows), event_id, event_registration_id, vat_inclusive
--      (DEFAULT false).
--   4. CHECK `invoices_subject_fields_ck` — enforces per-subject identity:
--      membership ⇒ member_id+plan_id+plan_year; event ⇒
--      event_registration_id+event_id. Existing rows pass (subject defaults
--      to 'membership' and all three membership columns are present).
--   5. Partial UNIQUE index `invoices_event_registration_uniq` — at most one
--      non-void event invoice per (tenant_id, event_registration_id). Uses
--      `status <> 'void'` (the invoice_status enum value is literally
--      'void'; there is NO 'voided' value), so a voided event invoice frees
--      the registration for re-issue.
--   6. Composite FK `invoices_event_registration_fk` (tenant-aware) →
--      event_registrations(tenant_id, registration_id) ON DELETE RESTRICT.
--      The composite (tenant_id, event_registration_id) can never reference
--      a cross-tenant registration → defence-in-depth on top of RLS.
--      Hand-authored (idempotent DO-block, mirroring migration 0125)
--      because the F6 event_registrations table lives in the events bounded
--      context and is NOT in drizzle.config.ts's schema list; a builder-level
--      FK in schema-invoices.ts would force a cross-context Infrastructure
--      import (Principle III smell). Validity-checked at apply time: the FK
--      only constrains rows where event_registration_id IS NOT NULL, so every
--      existing membership row (event_registration_id NULL) is exempt.
--
-- Immutability note: the `invoices_enforce_immutability` trigger (migration
-- 0019) locks member_id/plan_id/plan_year (+ snapshots) once status != draft.
-- It does NOT reference the four new columns — they are set once at draft and
-- never updated, so no trigger change is needed. For event invoices the three
-- membership columns are NULL at draft and stay NULL across the lifecycle, so
-- `NULL IS DISTINCT FROM NULL` (FALSE) never trips the trigger.

-- 1. Discriminator enum (brand-new type — transactional-safe).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_subject') THEN
    CREATE TYPE "invoice_subject" AS ENUM ('membership', 'event');
  END IF;
END $$;--> statement-breakpoint

-- 2. Member/plan identity → NULLABLE.
ALTER TABLE "invoices" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "plan_year" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "plan_id" DROP NOT NULL;--> statement-breakpoint

-- 3. New columns (DEFAULT 'membership' / false backfills existing rows).
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "invoice_subject" "invoice_subject" NOT NULL DEFAULT 'membership';--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "event_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "event_registration_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "vat_inclusive" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- 4. Per-subject identity CHECK (idempotent guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_subject_fields_ck'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_subject_fields_ck"
      CHECK (
        (invoice_subject = 'membership'
          AND member_id IS NOT NULL
          AND plan_id IS NOT NULL
          AND plan_year IS NOT NULL)
        OR
        (invoice_subject = 'event'
          AND event_registration_id IS NOT NULL
          AND event_id IS NOT NULL)
      );
  END IF;
END $$;--> statement-breakpoint

-- 5. One non-void event invoice per registration (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_event_registration_uniq"
  ON "invoices" ("tenant_id", "event_registration_id")
  WHERE invoice_subject = 'event' AND status <> 'void';--> statement-breakpoint

-- 6. Tenant-aware composite FK → event_registrations (idempotent guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_event_registration_fk'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_event_registration_fk"
      FOREIGN KEY ("tenant_id", "event_registration_id")
      REFERENCES "event_registrations" ("tenant_id", "registration_id")
      ON DELETE RESTRICT;
  END IF;
END $$;
