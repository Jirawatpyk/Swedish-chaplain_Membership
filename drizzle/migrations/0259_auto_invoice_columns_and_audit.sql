-- 107-auto-invoice (Task 1) — schema foundation for proactive renewal
-- billing: a cron pre-fills renewal-invoice DRAFTS ahead of the due date; a
-- treasurer reviews a queue and issues them. This migration adds:
--   (1) `invoice_origin` — a FRESH enum discriminating a manually-drafted
--       invoice from one the auto-invoice cron pre-filled;
--   (2) `members.auto_invoice_enrolled_at` — per-member opt-in timestamp;
--   (3) `renewal_cycles.auto_draft_invoice_id` — points a cycle at its
--       cron-created draft (if any);
--   (4) 4 cadence/toggle columns on `tenant_invoice_settings` gating the
--       cron globally + the rolling/calendar lead-day windows + the
--       per-run page size.
--
-- Foundation-only this round — nothing here changes runtime behaviour; the
-- cron + review-queue use-cases land in later tasks and read these columns.
--
-- `invoice_origin` is a FRESH enum type (not an ALTER TYPE … ADD VALUE), so
-- CREATE TYPE + the ADD COLUMN that uses it are safe in one migration
-- transaction (mirrors migration 0255's `billing_cycle` pattern).
--
-- NOTE: this file's name says "_and_audit" because Task 2 of this plan
-- APPENDS two `audit_event_type ADD VALUE` statements to this SAME file
-- (co-located so the audit lockstep lands atomically with the schema it
-- describes; enum ADD VALUE runs in run-migrations.ts's autocommit
-- pre-pass, so co-locating is safe). Task 1 (this commit) is DDL-only —
-- no audit_event_type change here.
--
-- Renumbered 0258 → 0259 at implementation time: migration 0258 was taken
-- by `0258_staff_invitation_lifecycle_audit.sql` (PR #224, merged into this
-- branch's base after the auto-invoice plan was written) — see
-- `.superpowers/sdd/task-1-report.md` for the collision note.

CREATE TYPE "invoice_origin" AS ENUM('manual', 'auto_renewal');--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "origin" "invoice_origin" NOT NULL DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "auto_invoice_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renewal_cycles" ADD COLUMN "auto_draft_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_lead_days_rolling" integer NOT NULL DEFAULT 30;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_lead_days_calendar" integer NOT NULL DEFAULT 31;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD COLUMN "auto_invoice_page_size" integer NOT NULL DEFAULT 200;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" DROP CONSTRAINT IF EXISTS "tenant_invoice_settings_auto_lead_days_ck";--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD CONSTRAINT "tenant_invoice_settings_auto_lead_days_ck" CHECK ("auto_invoice_lead_days_rolling" BETWEEN 1 AND 120 AND "auto_invoice_lead_days_calendar" BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings" ADD CONSTRAINT "tenant_invoice_settings_auto_page_size_ck" CHECK ("auto_invoice_page_size" BETWEEN 1 AND 5000);
