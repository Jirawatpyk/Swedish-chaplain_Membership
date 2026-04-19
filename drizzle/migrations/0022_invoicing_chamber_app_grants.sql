-- Migration 0022 — GRANT chamber_app role on F4 invoicing tables + enums
--
-- The F2/F3 convention: every tenant-scoped table runs under
-- `chamber_app` (NOBYPASSRLS) at request time. Missing GRANTs → every
-- query fails with "permission denied". Discovered during CP-2
-- integration-test run (tenant-isolation.test.ts failure).
--
-- Forward-only: GRANTs are idempotent (re-running re-grants).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invoices"                   TO chamber_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invoice_lines"              TO chamber_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "credit_notes"               TO chamber_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_invoice_settings"    TO chamber_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_document_sequences"  TO chamber_app;--> statement-breakpoint

-- Enum USAGE grants — chamber_app must USE the enum types to read/write
-- columns of those types under RLS. Postgres enforces USAGE on the
-- TYPE independently of the TABLE's SELECT/INSERT privilege.
GRANT USAGE ON TYPE "public"."invoice_status"          TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."invoice_line_kind"       TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."pro_rate_policy"         TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."numbering_reset_cadence" TO chamber_app;--> statement-breakpoint
GRANT USAGE ON TYPE "public"."document_type"           TO chamber_app;
