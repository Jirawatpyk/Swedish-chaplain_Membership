-- Migration 0020 — F4 audit_event_type extension (16 new values)
--
-- Only the ALTER TYPE ADD VALUE statements live here — Postgres
-- requires new enum values to be committed BEFORE they can be
-- referenced in CHECK constraints, partial indexes (WHERE), etc.
-- The partial unique index guarding `invoice_overdue_detected`
-- idempotency lives in migration 0021.
--
-- Idempotent: DO $$ ... EXCEPTION duplicate_object $$ wrapping so
-- re-running is a no-op.
-- Forward-only: enum values cannot be dropped.

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_draft_created'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_draft_updated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_draft_deleted'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_issued'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_paid'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_voided'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_overdue_detected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'credit_note_issued'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'tenant_invoice_settings_updated'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_pdf_resent'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'receipt_pdf_resent'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'credit_note_pdf_resent'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'invoice_cross_tenant_probe'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'credit_note_cross_tenant_probe'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'pdf_render_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'auto_email_delivery_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
