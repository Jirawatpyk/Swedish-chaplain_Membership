-- ---------------------------------------------------------------------------
-- F7 — seed default segment_definitions (T015 per specs/010-email-broadcast/tasks.md).
--
-- Seeds 9 default segment presets for the SweCham tenant. Idempotent via
-- WHERE NOT EXISTS check so re-runs don't double-insert. Composite PK
-- (tenant_id, definition_id) uses gen_random_uuid() — different definition_id
-- on re-run wouldn't conflict on PK, hence the explicit (tenant_id,
-- segment_type, params) uniqueness check below.
--
-- Single-tenant deployment (TENANT_SLUG=swecham per F1). F7.1+ multi-tenant
-- deployment will add a separate seed-per-tenant flow.
--
-- The display_label_i18n_key references next-intl translation keys that
-- exist (or will exist by Phase 5+) under
-- src/i18n/messages/{en,th,sv}.json `broadcasts.segment.*`.
-- ---------------------------------------------------------------------------

-- Seed runs under `swecham_super` role to bypass RLS for the bootstrap
-- INSERT. Wrap in DO block to allow conditional execution.
DO $$
BEGIN
  -- all_members
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'all_members', 'broadcasts.segment.allMembers', NULL::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'all_members' AND "params" IS NULL
  );

  -- tier:premium
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'tier', 'broadcasts.segment.tierPremium',
         '{"tierCodes":["premium"]}'::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
      AND "params" = '{"tierCodes":["premium"]}'::jsonb
  );

  -- tier:large
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'tier', 'broadcasts.segment.tierLarge',
         '{"tierCodes":["large"]}'::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
      AND "params" = '{"tierCodes":["large"]}'::jsonb
  );

  -- tier:regular
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'tier', 'broadcasts.segment.tierRegular',
         '{"tierCodes":["regular"]}'::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
      AND "params" = '{"tierCodes":["regular"]}'::jsonb
  );

  -- tier:diamond
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'tier', 'broadcasts.segment.tierDiamond',
         '{"tierCodes":["diamond"]}'::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
      AND "params" = '{"tierCodes":["diamond"]}'::jsonb
  );

  -- tier:platinum
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'tier', 'broadcasts.segment.tierPlatinum',
         '{"tierCodes":["platinum"]}'::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
      AND "params" = '{"tierCodes":["platinum"]}'::jsonb
  );

  -- tier:gold
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'tier', 'broadcasts.segment.tierGold',
         '{"tierCodes":["gold"]}'::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'tier'
      AND "params" = '{"tierCodes":["gold"]}'::jsonb
  );

  -- event_attendees_last_90d (F6 stub-port — returns [] until F6 ships)
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'event_attendees_last_90d',
         'broadcasts.segment.eventAttendeesLast90d', NULL::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'event_attendees_last_90d'
  );

  -- custom (member-supplied recipient list)
  INSERT INTO "broadcast_segment_definitions"
    ("tenant_id", "segment_type", "display_label_i18n_key", "params", "enabled")
  SELECT 'swecham', 'custom', 'broadcasts.segment.custom', NULL::jsonb, true
  WHERE NOT EXISTS (
    SELECT 1 FROM "broadcast_segment_definitions"
    WHERE "tenant_id" = 'swecham' AND "segment_type" = 'custom'
  );
END $$;--> statement-breakpoint
