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

-- The index under the name must be this one. Past the review cap, the
-- maintainer chose to compare the full definition: review round 3 had read
-- the definition structurally from pg_index instead of as indexdef text, and
-- that read missed NULLS NOT DISTINCT and passed bpchar_ops (the default
-- operator class of another type). pg_get_indexdef prints the access method,
-- UNIQUE, the table, every key with any non-default operator class or
-- COLLATE, INCLUDE, NULLS NOT DISTINCT and the predicate, so the live text,
-- normalised (the `public.` schema qualifier dropped, whitespace collapsed),
-- must equal v_expected normalised the same way, and the index must be VALID
-- (an invalid index enforces nothing and is not used for ON CONFLICT
-- inference). v_expected is dev's text after the apply, read on 7 Nov 2026;
-- scripts/verify-schema.ts's canary holds the same literal and normalisation
-- (an integration test compares the two files). DEFERRABLE is never printed,
-- but only a constraint's index can be deferrable, and a constraint carries
-- neither an expression key nor a WHERE, so this text cannot be one. No
-- pg_index row for the name (none, or a relation that is not an index)
-- leaves both variables NULL and raises.
DO $$
DECLARE
  v_def text;
  v_valid boolean;
  v_expected constant text := 'CREATE UNIQUE INDEX audit_log_audience_deleted_once ON public.audit_log USING btree (tenant_id, ((payload ->> ''resend_audience_id''::text))) WHERE (event_type = ''broadcast_audience_deleted''::audit_event_type)';
  v_live text;
  v_want text;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid INTO v_def, v_valid
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('public.audit_log_audience_deleted_once');
  IF v_def IS NULL THEN
    RAISE EXCEPTION '0328: index audit_log_audience_deleted_once has another definition: no such index';
  END IF;
  v_live := btrim(regexp_replace(replace(v_def, 'public.', ''), '[[:space:]]+', ' ', 'g'));
  v_want := btrim(regexp_replace(replace(v_expected, 'public.', ''), '[[:space:]]+', ' ', 'g'));
  IF v_live IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION '0328: index audit_log_audience_deleted_once has another definition: live [%], expected [%]',
      v_live, v_want;
  END IF;
  IF v_valid IS NOT TRUE THEN
    RAISE EXCEPTION '0328: index audit_log_audience_deleted_once has another definition: indisvalid false';
  END IF;
END $$;--> statement-breakpoint

-- Hand the default back (see the lock_timeout block above).
SET LOCAL lock_timeout = DEFAULT;
