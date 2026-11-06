-- Migration 0328 — one `broadcast_audience_deleted` row per (tenant, Resend
-- segment), enforced by a partial unique index (spec 142, AO1).
--
-- Spec 139 s2 deduped this row in application code: an advisory lock in the
-- `broadcasts-audience-audit:` namespace plus an EXISTS read on audit_log. The
-- index makes the database the single arbiter. The writer
-- (`f7AuditAdapter.emitOnce`) runs `INSERT … ON CONFLICT (tenant_id,
-- (payload->>'resend_audience_id')) WHERE event_type =
-- 'broadcast_audience_deleted' DO NOTHING RETURNING 1`. Without this index
-- that statement fails with 42P10, so the migration must land before the
-- code serves; `vercel-build` migrates first.
--
-- A NULL tenant_id or a NULL segment key never conflicts (standard unique
-- index semantics). The product always writes both; NULL-tenant rows are
-- test fixtures only.
--
-- The pre-check refuses the deploy, naming the keys, if any duplicate key
-- already exists. The one dev duplicate (a spec 139 s2 test fixture) was
-- removed by hand on 6 Nov 2026 (spec 142 § Premises). The migration deletes
-- nothing: audit_log is append-only, and this file also runs on prod.
--
-- Build: non-CONCURRENTLY, inside the migrate transaction (the 0021 shape;
-- `scripts/run-migrations.ts` cannot run a statement outside it). The build
-- holds a SHARE lock on audit_log, which blocks every audit INSERT (sign-in
-- included) for its length, not the ACCESS EXCLUSIVE 0021's header names.
-- Dev (about 912k rows) builds it in about a second; 0021's rule (go
-- CONCURRENTLY outside the pipeline above 1M rows) is checked against the
-- prod row count before merge. The enum value has existed since 0327, and
-- the migrator's enum pre-pass commits enum values before the batch, so the
-- literal below is safe (0021's 55P04 note).
--
-- Rollback: a forward migration that drops the index. Reverting the code is
-- safe with the index in place: no other writer emits this event.

-- --- fail fast on the lock (0310 / 0322 / 0325 precedent) -----------------
-- Handed back as the file's LAST statement.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

DO $$
DECLARE
  v text;
BEGIN
  SELECT string_agg(k, ', ' ORDER BY k) INTO v
  FROM (
    SELECT tenant_id || '/' || (payload->>'resend_audience_id') AS k
    FROM audit_log
    WHERE event_type = 'broadcast_audience_deleted'
      AND tenant_id IS NOT NULL
      AND payload ? 'resend_audience_id'
      AND (payload->>'resend_audience_id') IS NOT NULL
    GROUP BY tenant_id, payload->>'resend_audience_id'
    HAVING count(*) > 1
  ) dup;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION '0328: duplicate keys: %', v;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "audit_log_audience_deleted_once"
  ON "audit_log" ("tenant_id", ("payload"->>'resend_audience_id'))
  WHERE "event_type" = 'broadcast_audience_deleted';--> statement-breakpoint

-- Hand the default back (see the lock_timeout block above).
SET LOCAL lock_timeout = DEFAULT;
