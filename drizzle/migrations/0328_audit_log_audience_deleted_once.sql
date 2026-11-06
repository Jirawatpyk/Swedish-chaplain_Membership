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
-- already exists (`->>` is NULL for a missing key, so no `?` test is
-- needed). The one dev duplicate (a spec 139 s2 test fixture) was removed by
-- hand on 6 Nov 2026 (spec 142 § Premises). The migration deletes
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
      AND (payload->>'resend_audience_id') IS NOT NULL
    GROUP BY tenant_id, payload->>'resend_audience_id'
    HAVING count(*) > 1
  ) dup;
  IF v IS NOT NULL THEN
    RAISE EXCEPTION '0328: duplicate keys: %', v;
  END IF;
END $$;--> statement-breakpoint

-- IF NOT EXISTS keeps a re-run a no-op (the new-migration skill's rule). An
-- index of another definition under this name would pass it with a NOTICE, so
-- the block after it fails the migration unless the index under the name is
-- this one (review round 2, code-review #1 and #3).
CREATE UNIQUE INDEX IF NOT EXISTS "audit_log_audience_deleted_once"
  ON "audit_log" ("tenant_id", ("payload"->>'resend_audience_id'))
  WHERE "event_type" = 'broadcast_audience_deleted';--> statement-breakpoint

-- The index under the name must be this one, read structurally from pg_index
-- (review round 3, code-review #2 and #6), not as indexdef text: it is on
-- public.audit_log, unique, VALID (an invalid index enforces nothing and is
-- not used for ON CONFLICT inference), with two key columns, tenant_id and
-- payload->>'resend_audience_id', and the predicate. The expression and the
-- predicate are compared with whitespace and parentheses stripped, and the
-- predicate with any schema qualifier on the enum type dropped, so a
-- rendering difference is not a definition difference. The values are what
-- dev's pg_index row answers after the apply. A missing index raises too; the
-- message names every field that differed. One SELECT INTO reads the catalog.
DO $$
DECLARE
  v_idx oid;
  v_tbl text;
  v_is_unique boolean;
  v_is_valid boolean;
  v_key_count integer;
  v_key1 text;
  v_key2 text;
  v_pred text;
  differs text[] := ARRAY[]::text[];
BEGIN
  SELECT i.indexrelid, tn.nspname || '.' || t.relname, i.indisunique, i.indisvalid, i.indnkeyatts,
         pg_get_indexdef(i.indexrelid, 1, true), pg_get_indexdef(i.indexrelid, 2, true),
         pg_get_expr(i.indpred, i.indrelid, true)
    INTO v_idx, v_tbl, v_is_unique, v_is_valid, v_key_count, v_key1, v_key2, v_pred
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'audit_log_audience_deleted_once';
  IF v_idx IS NULL THEN
    differs := differs || 'no such index'::text;
  ELSE
    IF v_tbl IS DISTINCT FROM 'public.audit_log' THEN
      differs := differs || ('table ' || coalesce(v_tbl, '(none)'));
    END IF;
    IF v_is_unique IS NOT TRUE THEN
      differs := differs || 'indisunique false'::text;
    END IF;
    IF v_is_valid IS NOT TRUE THEN
      differs := differs || 'indisvalid false'::text;
    END IF;
    IF v_key_count IS DISTINCT FROM 2 THEN
      differs := differs || ('indnkeyatts ' || coalesce(v_key_count::text, '(none)'));
    END IF;
    IF v_key1 IS DISTINCT FROM 'tenant_id' THEN
      differs := differs || ('key 1 ' || coalesce(v_key1, '(none)'));
    END IF;
    IF regexp_replace(v_key2, '[[:space:]()]', '', 'g')
       IS DISTINCT FROM 'payload->>''resend_audience_id''::text' THEN
      differs := differs || ('key 2 ' || coalesce(v_key2, '(none)'));
    END IF;
    IF regexp_replace(replace(v_pred, 'public.audit_event_type', 'audit_event_type'), '[[:space:]()]', '', 'g')
       IS DISTINCT FROM 'event_type=''broadcast_audience_deleted''::audit_event_type' THEN
      differs := differs || ('predicate ' || coalesce(v_pred, '(none)'));
    END IF;
  END IF;
  IF cardinality(differs) > 0 THEN
    RAISE EXCEPTION '0328: index audit_log_audience_deleted_once has another definition: %',
      array_to_string(differs, '; ');
  END IF;
END $$;--> statement-breakpoint

-- Hand the default back (see the lock_timeout block above).
SET LOCAL lock_timeout = DEFAULT;
