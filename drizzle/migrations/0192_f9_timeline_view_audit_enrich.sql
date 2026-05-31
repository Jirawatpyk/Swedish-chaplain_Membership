-- ---------------------------------------------------------------------------
-- F9 (T054 prerequisite) — enrich the audit branch of member_timeline_v so the
-- unified timeline repo can render audit rows AS richly as the F3 audit-only
-- repo did (US3).
--
-- Source of truth: specs/015-admin-dashboard/data-model.md § 5 + research R4.
--
-- WHY (vs 0189): the original view emitted the raw `audit_log.payload` for the
-- audit source, which does NOT carry `event_type`, `summary`, or `actor_user_id`
-- (those are first-class audit_log columns, not payload keys). The F3 timeline
-- (and its shipped tests + e2e) depend on all three:
--   - `event_type` → the audit eventKind drives the localised label
--     (`audit.eventType.<type>`) AND the payload-formatting switch
--     (member_created / member_plan_changed / …). Existing integration test
--     asserts `eventType === 'member_plan_changed'`.
--   - `actor_user_id` → resolved to a human display name (e2e T129 asserts the
--     UUID is NOT shown raw).
--   - `summary` → FR-014 fallback display value for audit rows whose event_type
--     has no i18n key.
-- The other five sources already emit a purpose-built `jsonb_build_object`
-- payload and are unchanged.
--
-- The synthetic keys are placed FIRST in the `||` merge so any real payload key
-- of the same name wins (defensive — audit payloads never carry these today).
--
-- CREATE OR REPLACE VIEW is column-shape-preserving (same names/types/order;
-- only the audit `payload` expression changes), so security_invoker + the
-- GRANT + downstream indexes from 0189 are untouched. We re-state
-- WITH (security_invoker = on) so the option survives the replace
-- (Principle I — tenant isolation inside the view; check-f9-schema asserts it).
--
-- Rollback (Critique E8): re-run 0189's CREATE VIEW body (the pre-enrich audit
-- branch emitted `al."payload"` directly). The view is a derived read object —
-- no data migration, safe to swap back.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW "member_timeline_v" WITH (security_invoker = on) AS
  -- 1. audit_log (enriched: event_type + summary + actor_user_id surfaced into
  --    the payload so the unified repo keeps F3 audit-row fidelity)
  SELECT
    al."tenant_id"                                                  AS "tenant_id",
    COALESCE(al."payload"->>'member_id', al."payload"->>'related_member_id') AS "member_id",
    al."timestamp"                                                  AS "occurred_at",
    'audit'                                                         AS "source",
    al."id"::text                                                   AS "ref_id",
    CASE
      WHEN al."actor_user_id" LIKE 'system:%' OR al."actor_user_id" = 'anonymous'
        THEN 'system'
      ELSE 'staff'
    END                                                             AS "actor_kind",
    jsonb_build_object(
      'event_type', al."event_type"::text,
      'summary', al."summary",
      'actor_user_id', al."actor_user_id"
    ) || COALESCE(al."payload", '{}'::jsonb)                        AS "payload"
  FROM "audit_log" al
  WHERE al."payload" ? 'member_id' OR al."payload" ? 'related_member_id'

  UNION ALL

  -- 2. invoices
  SELECT
    inv."tenant_id",
    inv."member_id"::text,
    inv."issue_date"::timestamptz,
    'invoice',
    inv."invoice_id"::text,
    'staff',
    jsonb_build_object('status', inv."status", 'invoice_id', inv."invoice_id"::text)
  FROM "invoices" inv
  WHERE inv."issue_date" IS NOT NULL

  UNION ALL

  -- 3. payments (terminal/succeeded only — completed_at IS NOT NULL).
  SELECT
    pay."tenant_id",
    pay."member_id"::text,
    pay."completed_at",
    'payment',
    pay."id",
    'system',
    jsonb_build_object('status', pay."status", 'amount_satang', pay."amount_satang"::text)
  FROM "payments" pay
  WHERE pay."completed_at" IS NOT NULL

  UNION ALL

  -- 4. event_registrations ⋈ events (occurred_at = event start_date)
  SELECT
    er."tenant_id",
    er."matched_member_id"::text,
    ev."start_date",
    'event',
    er."registration_id"::text,
    'member',
    jsonb_build_object(
      'event_id', er."event_id"::text,
      'counted_against_cultural_quota', er."counted_against_cultural_quota"
    )
  FROM "event_registrations" er
  JOIN "events" ev
    ON ev."tenant_id" = er."tenant_id" AND ev."event_id" = er."event_id"
  WHERE er."matched_member_id" IS NOT NULL

  UNION ALL

  -- 5. broadcasts (sent only)
  SELECT
    b."tenant_id",
    b."requested_by_member_id"::text,
    b."sent_at",
    'broadcast',
    b."broadcast_id"::text,
    'member',
    jsonb_build_object('broadcast_id', b."broadcast_id"::text, 'status', b."status")
  FROM "broadcasts" b
  WHERE b."status" = 'sent' AND b."sent_at" IS NOT NULL

  UNION ALL

  -- 6. renewal_cycles (occurred_at = period_from)
  SELECT
    rc."tenant_id",
    rc."member_id"::text,
    rc."period_from",
    'renewal',
    rc."cycle_id"::text,
    'system',
    jsonb_build_object('cycle_id', rc."cycle_id"::text, 'status', rc."status", 'period_to', rc."period_to")
  FROM "renewal_cycles" rc;
