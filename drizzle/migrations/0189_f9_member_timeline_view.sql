-- ---------------------------------------------------------------------------
-- F9 (T010) — member_timeline_v multi-source timeline view + per-source
-- keyset indexes (US3).
--
-- Source of truth: specs/015-admin-dashboard/data-model.md § 5 + research R4.
--
-- A hand-authored SQL view (Drizzle cannot emit views, security_invoker, or
-- RLS — plan Complexity #3). UNION ALL over six sources normalised to a common
-- shape. WITH (security_invoker = on) so base-table RLS applies to the querying
-- `chamber_app` role → tenant isolation holds INSIDE the view (Principle I,
-- NON-NEGOTIABLE). The check-f9-schema CI guard asserts security_invoker (T018).
--
-- IMPLEMENTATION DISCOVERY vs data-model § 5 (which typed member_id/ref_id as
-- uuid): `payments.id` is a ULID stored as TEXT and `payments.member_id` +
-- audit `payload->>'member_id'` are TEXT. A UNION column must have ONE type, so
-- the view emits `member_id` and `ref_id` as TEXT (every uuid source is cast
-- `::text`). This also avoids a cast-failure on any malformed audit payload and
-- matches the existing F3 timeline repo's text comparison
-- (`payload->>'member_id' = $memberId`). (Mirrors the F7.1a "tenant_id is text
-- not uuid" data-model correction.)
--
-- occurred_at mapping (verified column names): audit.timestamp · invoice
-- issue_date · payment completed_at (terminal only) · event events.start_date ·
-- broadcast sent_at (status='sent') · renewal renewal_cycles.period_from.
--
-- audit member_id: COALESCE(payload member_id, related_member_id) so a row
-- referencing the member under either key surfaces on their timeline (matches
-- the existing F3 repo's OR-match). Covered by the member-timeline index below
-- for the common payload->>'member_id' path.
--
-- Keyset pagination: (occurred_at DESC, ref_id DESC) — see timeline-list repo.
--
-- Rollback (Critique E8):
--   DROP VIEW member_timeline_v;
--   DROP INDEX <each index created below>;
-- ---------------------------------------------------------------------------

CREATE VIEW "member_timeline_v" WITH (security_invoker = on) AS
  -- 1. audit_log (existing source)
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
    al."payload"                                                    AS "payload"
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
  --    member_id is `uuid` in the DB (Drizzle reads it as text); cast ::text
  --    for UNION type consistency. pay.id is already a TEXT ULID.
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
--> statement-breakpoint

GRANT SELECT ON "member_timeline_v" TO chamber_app;--> statement-breakpoint

-- --- Per-source keyset indexes (data-model § 9 item 5, Critique E6) ----------
-- Load-bearing for SC-005 + timeline pagination. IF NOT EXISTS keeps the
-- migration safe against any pre-existing equivalent index.

CREATE INDEX IF NOT EXISTS "invoices_tenant_member_issue_date_idx"
  ON "invoices" ("tenant_id", "member_id", "issue_date" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payments_tenant_member_completed_idx"
  ON "payments" ("tenant_id", "member_id", "completed_at" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "event_registrations_tenant_member_idx"
  ON "event_registrations" ("tenant_id", "matched_member_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "events_tenant_start_date_idx"
  ON "events" ("tenant_id", "start_date" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "broadcasts_tenant_member_sent_idx"
  ON "broadcasts" ("tenant_id", "requested_by_member_id", "sent_at" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "renewal_cycles_tenant_member_period_idx"
  ON "renewal_cycles" ("tenant_id", "member_id", "period_from" DESC);--> statement-breakpoint

-- Audit member-timeline index: (payload->>'member_id', timestamp DESC) for the
-- common timeline path (the existing audit_log_member_id_idx lacks timestamp).
CREATE INDEX IF NOT EXISTS "audit_log_member_timeline_idx"
  ON "audit_log" ((("payload"->>'member_id')), "timestamp" DESC)
  WHERE "payload" ? 'member_id';
