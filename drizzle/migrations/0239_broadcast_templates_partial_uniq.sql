-- 0239 — bug #14: partial-index the broadcast_templates name uniqueness so a
-- soft-deleted template no longer occupies its (tenant, name, locale) key.
--
-- Before: the unique index covered ALL rows, so once a template was
-- soft-deleted (deleted_at set, row retained) its (tenant, name, locale)
-- triple stayed in the index. create() then 409'd forever for that exact
-- name — even though the soft-deleted template is filtered out of every list
-- surface (no undelete/hard-delete exists), leaving the admin staring at
-- "name already exists" for a name that appears nowhere.
--
-- Fix: make the index PARTIAL (WHERE deleted_at IS NULL), matching the
-- sibling MRU index (broadcast_templates_tenant_locale_updated_idx) which is
-- already scoped to live rows. A soft-deleted row no longer participates, so
-- the name is freed for reuse; live-row uniqueness is unchanged.
DROP INDEX IF EXISTS "broadcast_templates_tenant_name_locale_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_templates_tenant_name_locale_uniq" ON "broadcast_templates" USING btree ("tenant_id","name","locale") WHERE "deleted_at" IS NULL;
