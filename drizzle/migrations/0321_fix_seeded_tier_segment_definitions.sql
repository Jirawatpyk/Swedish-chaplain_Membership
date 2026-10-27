-- ---------------------------------------------------------------------------
-- F7 / spec 122 follow-up PR F — replace the tier segment presets 0068 seeded.
--
-- 0068 seeded six `swecham` tier presets with the codes premium, large,
-- regular, diamond, platinum and gold. The recipient query matches only the
-- two `plan_category` values (corporate, partnership), so each preset would
-- reach nobody — the PR D (#678) bug, in data. Their label keys
-- (`broadcasts.segment.tier*`) do not exist either.
--
-- 1. Delete every tier preset, in every tenant, whose `params.tierCodes` is
--    not a non-empty array of the two categories (null / malformed included).
-- 2. Seed one `swecham` preset per category, labelled with the keys the
--    member E-Blast history already uses (exist in EN / TH / SV).
--
-- Idempotent: the DELETE keeps valid rows; the INSERTs use 0068's own
-- WHERE NOT EXISTS check on (tenant_id, segment_type, params).
--
-- Safe before the code deploys: nothing reads this table yet (the
-- BroadcastSegmentDefinitionsRepo port has no caller) and no FK points at
-- it. Runs as the migration owner; `chamber_app`'s grants (no DELETE) are
-- unchanged. Rollback is a forward fix.
-- ---------------------------------------------------------------------------

DELETE FROM "broadcast_segment_definitions"
 WHERE "segment_type" = 'tier'
   AND NOT (
     "params" IS NOT NULL
     AND jsonb_typeof("params"->'tierCodes') = 'array'
     AND jsonb_array_length("params"->'tierCodes') > 0
     AND ("params"->'tierCodes') <@ '["corporate","partnership"]'::jsonb
   );--> statement-breakpoint

INSERT INTO "broadcast_segment_definitions"
  ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
SELECT 'swecham', 'tier', 'portal.broadcasts.list.tierCode.corporate',
       '{"tierCodes":["corporate"]}'::jsonb, true
WHERE NOT EXISTS (
  SELECT 1 FROM "broadcast_segment_definitions"
  WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
    AND "params" = '{"tierCodes":["corporate"]}'::jsonb
);--> statement-breakpoint

INSERT INTO "broadcast_segment_definitions"
  ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
SELECT 'swecham', 'tier', 'portal.broadcasts.list.tierCode.partnership',
       '{"tierCodes":["partnership"]}'::jsonb, true
WHERE NOT EXISTS (
  SELECT 1 FROM "broadcast_segment_definitions"
  WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
    AND "params" = '{"tierCodes":["partnership"]}'::jsonb
);
