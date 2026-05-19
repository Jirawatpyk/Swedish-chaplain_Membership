-- ---------------------------------------------------------------------------
-- F7.1a US7 (T011 + T016) — broadcast_templates table.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 2.4
-- + plan.md § Discoveries (tenant_id is TEXT, not uuid as data-model.md
-- mistyped — matches F7 MVP convention).
--
-- Admin-authored template library. Migration 0134 seeds 5 starter
-- templates × 3 locales = 15 rows per tenant at ship — depends on this
-- table existing first (file-order ordering by name handles it; pnpm
-- db:migrate applies in lexicographic order).
--
-- Single-column PK `id` (not composite). Tenant isolation enforced by:
--   - RLS+FORCE policy (migration 0132).
--   - The (tenant_id, name, locale) unique index keeps tenant scopes
--     disjoint at the namespace level too.
--
-- Soft-delete (deleted_at): preserves audit trail per FR-023 (the
-- template-deletion audit row records the count of drafts that
-- originated from the now-deleted template).
-- ---------------------------------------------------------------------------

CREATE TABLE "broadcast_templates" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"             text NOT NULL,
  "name"                  text NOT NULL,
  "subject"               text NOT NULL,
  "body_html"             text NOT NULL,
  "locale"                text NOT NULL DEFAULT 'en',
  "started_from_count"    integer NOT NULL DEFAULT 0,
  "is_seeded"             boolean NOT NULL DEFAULT false,
  "created_by_user_id"    uuid,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  "deleted_at"            timestamptz,

  CONSTRAINT "broadcast_templates_locale_check"
    CHECK ("locale" IN ('en', 'th', 'sv')),

  CONSTRAINT "broadcast_templates_name_length_check"
    CHECK (length("name") > 0 AND length("name") <= 100),

  CONSTRAINT "broadcast_templates_subject_length_check"
    CHECK (length("subject") > 0 AND length("subject") <= 200),

  CONSTRAINT "broadcast_templates_body_length_check"
    CHECK (length("body_html") <= 204800)
);--> statement-breakpoint

-- (tenant_id, name, locale) — tenant-scoped name+locale uniqueness.
-- The seed migration 0134 uses ON CONFLICT against this constraint to
-- skip same-name rows on re-application (idempotency).
CREATE UNIQUE INDEX "broadcast_templates_tenant_name_locale_uniq"
  ON "broadcast_templates" ("tenant_id", "name", "locale");--> statement-breakpoint

-- Member picker (Phase 5 T103) — MRU ordering filtered to live rows.
CREATE INDEX "broadcast_templates_tenant_locale_updated_idx"
  ON "broadcast_templates" ("tenant_id", "locale", "updated_at" DESC)
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
