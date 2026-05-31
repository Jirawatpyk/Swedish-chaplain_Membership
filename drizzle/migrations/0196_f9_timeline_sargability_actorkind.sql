-- ---------------------------------------------------------------------------
-- F9 (code-review max, 2026-05-30) — three timeline-view fixes:
--   #1  Make the member_timeline_v per-source member lookup index-SARGABLE.
--       The view casts every uuid source `member_id::text` (the UNION column
--       must be one type), and the repo filters `member_id = $1` (text). A
--       btree on the RAW uuid column cannot serve `(member_id)::text = $1`
--       (uuid→text is CoerceViaIO), so the invoice / renewal / broadcast /
--       event branches seq-scan per tenant. Expression indexes that MATCH the
--       view's cast restore sargability. (payments is already text → unchanged.)
--       Tenant-leading so they also serve the explicit `tenant_id = $1` second
--       wall added in drizzle-timeline-repo.ts (finding #12).
--   #15 Drop the redundant full index `event_registrations_tenant_member_idx`
--       (0189) — the 0131 partial `event_regs_tenant_matched_member_idx` covers
--       the same (tenant_id, matched_member_id) raw-uuid NOT-NULL path.
--   #8  Classify a MEMBER-linked audit actor as `'member'` (was always
--       `'staff'`): the bare `audit_log.actor_user_id` carries no role, so the
--       FR-015 `actorKind=member` filter previously hid member self-service
--       audit rows. `contacts.linked_user_id` is uuid, `actor_user_id` is text
--       → compare with a `::text` cast.
--
-- CREATE OR REPLACE VIEW is column-shape-preserving (only the audit `actor_kind`
-- CASE changes vs 0192), so security_invoker + the GRANT + downstream indexes
-- survive. Rollback: re-run 0192 (restores the system|staff-only CASE) and
-- DROP the four *_text_* expression indexes (the dropped 0189 index can be
-- re-created from 0189 if ever needed).
-- ---------------------------------------------------------------------------

-- #15 — drop the redundant full index.
DROP INDEX IF EXISTS "event_registrations_tenant_member_idx";--> statement-breakpoint

-- #1 — expression indexes matching the view's `::text` member cast.
CREATE INDEX IF NOT EXISTS "invoices_tenant_member_text_issue_idx"
  ON "invoices" ("tenant_id", (("member_id")::text), "issue_date" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "renewal_cycles_tenant_member_text_period_idx"
  ON "renewal_cycles" ("tenant_id", (("member_id")::text), "period_from" DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "broadcasts_tenant_member_text_sent_idx"
  ON "broadcasts" ("tenant_id", (("requested_by_member_id")::text), "sent_at" DESC)
  WHERE "status" = 'sent' AND "sent_at" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "event_registrations_tenant_member_text_idx"
  ON "event_registrations" ("tenant_id", (("matched_member_id")::text))
  WHERE "matched_member_id" IS NOT NULL;--> statement-breakpoint

-- #8 — member-actor classification (only the audit-branch CASE changes vs 0192).
CREATE OR REPLACE VIEW "member_timeline_v" WITH (security_invoker = on) AS
  SELECT
    al."tenant_id"                                                  AS "tenant_id",
    COALESCE(al."payload"->>'member_id', al."payload"->>'related_member_id') AS "member_id",
    al."timestamp"                                                  AS "occurred_at",
    'audit'                                                         AS "source",
    al."id"::text                                                   AS "ref_id",
    CASE
      WHEN al."actor_user_id" LIKE 'system:%' OR al."actor_user_id" = 'anonymous'
        THEN 'system'
      WHEN EXISTS (
        SELECT 1 FROM "contacts" c
        WHERE c."tenant_id" = al."tenant_id"
          AND c."linked_user_id"::text = al."actor_user_id"
      ) THEN 'member'
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

  SELECT
    rc."tenant_id",
    rc."member_id"::text,
    rc."period_from",
    'renewal',
    rc."cycle_id"::text,
    'system',
    jsonb_build_object('cycle_id', rc."cycle_id"::text, 'status', rc."status", 'period_to', rc."period_to")
  FROM "renewal_cycles" rc;
