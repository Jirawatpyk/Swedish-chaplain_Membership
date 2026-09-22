-- ---------------------------------------------------------------------------
-- Migration 0304 — F119 E-Blast writing-tool upgrade (PR-1 foundation).
-- specs/119-eblast-approval-workflow/data-model.md §§ 4, 5, 6, 7.2;
-- research R12, R13, R22, R24.
--
-- Creates:
--   - broadcast_images                       (the image lifecycle record — one
--                                             row per upload, owner = the
--                                             E-Blast or the template, so
--                                             ownership is enforceable and
--                                             erasure / the last-reference
--                                             sweep are reachable)
--   - tenant_broadcast_settings.brand_*      (FR-041b/c — ONE primary colour +
--                                             the chamber postal address; the
--                                             LOGO is never written here, it
--                                             stays tenant_invoice_settings.
--                                             logo_blob_key, super-admin only)
--   - audit_event_type += 4                  (broadcast_test_copy_sent,
--                                             broadcast_brand_settings_changed,
--                                             broadcast_image_uploaded,
--                                             broadcast_image_removed)
--
-- The four ADD VALUE lines sit at the top, one per line, each ending in `;`:
-- scripts/run-migrations.ts extracts every `ALTER TYPE … ADD VALUE` across
-- the migration files and replays it in AUTOCOMMIT BEFORE the transactional
-- pass (scripts/lib/enum-migration-guard.ts, the 0230 incident), so the
-- transactional copy below is an `IF NOT EXISTS` no-op. Mixed enum + DDL
-- files have precedent (0255, 0268, 0274); PR-2's 0305 carries the ten
-- workflow audit values, the five broadcast_status values and the five
-- notification_type values — the split is exactly the PR boundary.
--
-- RLS on broadcast_images: ENABLE + FORCE + the canonical 0064 policy (two
-- spaces in `FORCE  ROW LEVEL SECURITY`, as every broadcasts table is
-- written). tenant_broadcast_settings already carries RLS + FORCE (0166) —
-- 0304 turns it into a tenant-authored WRITE surface, so it is registered in
-- scripts/check-multi-tenant-ready.ts SCOPED_TABLES alongside the new table.
--
-- No FK from broadcast_images.owner_id: it points at a broadcast OR a
-- template. Reachability is therefore APPLICATION-enforced, by TWO mechanisms
-- (corrected by review finding F2-1 — this header previously claimed the
-- sweep alone reaped orphans, which it did not: it read ONLY rows with
-- deleted_at IS NOT NULL):
--   (1) every path that removes an owner stamps deleted_at in the owner's own
--       transaction — draft discard, the daily draft prune, member
--       withdrawal, staff rejection, member erasure;
--   (2) the sweep ALSO carries an orphan arm (live rows anti-joined against
--       broadcasts / broadcast_templates), so a future hard-delete path that
--       forgets (1) cannot strand a member's bytes at a public blob URL.
-- A blob is then deleted under the last-reference rule: only when no live row
-- of either owner_kind shares its content_hash AND no live body_html still
-- embeds the URL.
-- NOT backfilled — images uploaded before 0304 have no row. They are never
-- swept, and that body_html reference check is what stops a later dedup row
-- from deleting them out from under a live E-Blast (recorded, not guessed).
--
-- Rollback (quickstart § 3.5): DROP TABLE broadcast_images; ALTER TABLE
-- tenant_broadcast_settings DROP COLUMN brand_primary_color,
-- brand_postal_address, brand_updated_at, brand_updated_by_user_id. The
-- enum values are irreversible.
-- ---------------------------------------------------------------------------

-- --- 0. audit_event_type += 4 (hoisted to AUTOCOMMIT by the runner) ---------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_test_copy_sent';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_brand_settings_changed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_image_uploaded';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'broadcast_image_removed';--> statement-breakpoint

-- --- 1. broadcast_images ---------------------------------------------------

CREATE TABLE "broadcast_images" (
  "tenant_id"            text        NOT NULL,
  "id"                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  "owner_kind"           text        NOT NULL
                           CONSTRAINT "broadcast_images_owner_kind_check"
                           CHECK ("owner_kind" IN ('broadcast', 'template')),
  "owner_id"             uuid        NOT NULL,
  "content_hash"         text        NOT NULL,
  "blob_url"             text        NOT NULL,
  "blob_key"             text        NOT NULL,
  "mime_type"            text        NOT NULL
                           CONSTRAINT "broadcast_images_mime_type_check"
                           CHECK ("mime_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  "byte_size"            integer     NOT NULL
                           CONSTRAINT "broadcast_images_byte_size_check"
                           CHECK ("byte_size" BETWEEN 1 AND 5 * 1024 * 1024),
  "uploaded_by_user_id"  uuid        NOT NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "deleted_at"           timestamptz NULL,
  CONSTRAINT "broadcast_images_pkey" PRIMARY KEY ("tenant_id", "id")
);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "broadcast_images" TO chamber_app;--> statement-breakpoint

-- Ownership lookups (route ownership check, per-E-Blast / per-template listing).
CREATE INDEX "broadcast_images_tenant_owner_idx"
  ON "broadcast_images" ("tenant_id", "owner_kind", "owner_id");--> statement-breakpoint
-- The last-reference rule: "does any live row still share this hash?".
CREATE INDEX "broadcast_images_tenant_content_hash_idx"
  ON "broadcast_images" ("tenant_id", "content_hash");--> statement-breakpoint
-- The daily sweep scans only rows already marked.
CREATE INDEX "broadcast_images_tenant_deleted_idx"
  ON "broadcast_images" ("tenant_id", "deleted_at")
  WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "broadcast_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_images" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_broadcast_images"
  ON "broadcast_images"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint

-- --- 2. tenant_broadcast_settings +4 brand columns (FR-041b/c) -------------
-- Format is a CHECK; the 4.5:1 contrast rule is Application + Domain
-- (`domain/brand/contrast.ts`) because it needs the WCAG formula and a
-- human-readable refusal carrying the computed ratio. The address CHECK
-- bounds LENGTH only — free text, line breaks allowed.

ALTER TABLE "tenant_broadcast_settings"
  ADD COLUMN "brand_primary_color" text NULL
    CONSTRAINT "tenant_broadcast_settings_brand_primary_color_check"
    CHECK ("brand_primary_color" ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN "brand_postal_address" text NULL
    CONSTRAINT "tenant_broadcast_settings_brand_postal_address_check"
    CHECK (char_length("brand_postal_address") BETWEEN 1 AND 300),
  ADD COLUMN "brand_updated_at" timestamptz NULL,
  ADD COLUMN "brand_updated_by_user_id" uuid NULL;--> statement-breakpoint
