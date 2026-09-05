-- 0293 — 108 PR-B (US2, FR-010a): "exactly one live primary contact" guaranteed
-- BELOW the application, evaluated at COMMIT.
--
-- WHY A DB GUARANTEE. Since 108 PR-A every money email (receipt, void notice,
-- credit note, resends) and the PromptPay billing address resolve the member's
-- LIVE primary contact at enqueue time. A member with zero live primaries
-- therefore silently stops receiving receipts. The application already refused
-- to remove a primary — but it decided that from a read taken OUTSIDE the write
-- transaction, and a promote(Y) racing a remove(Y) left 50 of 50 members at zero
-- primaries in the T030 rehearsal (both calls reported success). An app-layer
-- fix ships in the same PR; this migration is the backstop for every path that
-- is not the app (bare SQL, scripts, a future import).
--
-- WHY DEFERRED. `promotePrimary` is demote-then-promote (two statements, zero
-- primaries in between) and erasure is scrub-every-contact + `erased_at` in one
-- tx. A row-level check would refuse both. A DEFERRABLE INITIALLY DEFERRED
-- constraint trigger runs once per changed row at COMMIT and sees the final
-- state, so those pass while a sequence that ENDS at zero or two primaries is
-- refused as a typed error the app maps to 409 (`primaryContactTriggerViolation`
-- in src/lib/db-errors.ts, same contract as `last-admin-protection`).
--
-- SCOPE — one predicate at all three points (spec AMENDMENT 2026-09-05):
--   a non-archived, non-erased member that has AT LEAST ONE contact row at
--   commit time must have exactly one live (removed_at IS NULL) primary.
-- The "at least one contact row" clause is a deliberate NARROWING of FR-010's
-- "at all times". Measured on the shared dev branch before this file was
-- written: 72 test-* tenants held 150 violating members and EVERY one had zero
-- contact rows (a fixture that seeds a bare member row; unreachable through the
-- app, which writes member + primary in one tx). The required CI check runs
-- against a persistent Neon branch with the same shape that cannot be cleaned
-- from a PR, so the unnarrowed pre-check could never pass there. Production and
-- every preview/* branch (copy-on-write from prod) hold zero violations under
-- either reading. Consequences worth knowing:
--   - INSERT/UPDATE on contacts always leaves a row, so those keep the full
--     rule: soft-removing the last primary of a live member raises;
--   - hard-deleting EVERY contact row of a live member is exempt (the
--     test-suite tenant cleanup does exactly that as its own statement, before
--     `members`); hard-deleting the primary while a secondary remains raises;
--   - a status change on a contact-less member is exempt.
-- Compensating control: scripts/inventory-primary-contact-invariant.ts lists
-- contact-less members on their own line — the population PR-A skips mail for.
--
-- ROLES. Migrations run as neondb_owner (BYPASSRLS), so the pre-check below
-- genuinely scans every tenant's rows even though members/contacts are RLS
-- ENABLE + FORCE — it is not a vacuous "0 violations". The function is SECURITY
-- DEFINER (owned by the migration role) so its count is complete whoever fires
-- it — an app session runs as chamber_app with the tenant GUC set, a script
-- may not — and it filters by the ROW'S tenant_id explicitly so that reach never
-- becomes a cross-tenant count (mirrors the 0009 audit trigger + 0291).
--
-- COST. One count per changed contact row at commit, served by the plain
-- (tenant_id, member_id) index added below — the existing indexes on contacts
-- are all PARTIAL (`removed_at IS NULL` / the one-primary predicate) and the
-- count must see removed rows too, so none of them applied (T041 migration
-- review, L2). The trigger is not narrowed with UPDATE OF because it must also
-- cover INSERT and DELETE and a single named trigger is what the tests pin; a
-- name-only edit queues one cheap count. Postgres does not de-duplicate queued
-- constraint-trigger events: a row touched k times is checked k times.
--
-- REPLAYABLE: DROP TRIGGER IF EXISTS before CREATE (CREATE TRIGGER has no OR
-- REPLACE — cf. 0291's dev-branch incident), CREATE OR REPLACE on the functions.
--
-- T041 review round 1 (security + migration reviewers) folded in:
--   - search_path is `pg_catalog, public, pg_temp` — pg_catalog FIRST (the
--     CVE-2018-1058 class; 0124 already moved the other trigger functions to
--     that order), pg_temp LAST and explicit so a session's TEMP TABLE named
--     `members` can never shadow the real one and turn the guard fail-open;
--   - EXECUTE is revoked from PUBLIC on both functions; only the trigger
--     function is granted to chamber_app — the SECURITY DEFINER helper is
--     callable by nobody but its owner (round 2 removed that grant);
--   - an UPDATE that moves a contact between members checks the member it LEFT
--     as well as the one it joined (a script does exactly this move);
--   - the whole batch takes SHARE ROW EXCLUSIVE on both tables first, so no
--     writer can commit a violation between the pre-check and CREATE TRIGGER.

-- ── Close the pre-check → CREATE TRIGGER window ──────────────────────────────
-- The migrator runs this whole file in ONE transaction. This is the same lock
-- CREATE CONSTRAINT TRIGGER takes anyway, so it adds no new contention class;
-- new writers queue for the few ms the batch needs, reads are unaffected.
-- Prod migrates on deploy while the app is live: a transaction that has
-- already written members/contacts (any audit insert carrying member_id bumps
-- members via the 0009 trigger) holds ROW EXCLUSIVE and blocks this lock. Fail
-- fast rather than sit on the migrator's 30 s statement timeout — the batch
-- rolls back whole and the deploy is simply retried (T041 round 2, N3).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE "members", "contacts" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- ── Pre-check (FR-010a): fail the deploy if the data already violates ────────
-- Counts only — no id, name or address is raised. A failed pre-check leaves
-- prod on the PREVIOUS deployment, whose promote refuses a member with no
-- current primary and whose add-contact inserts a secondary — so the repair
-- is a human-chosen, per-member, tenant-scoped `UPDATE contacts SET
-- is_primary = true` (one row), then redeploy. Once THIS deployment is live,
-- promote designates when there is no current primary (T041 round 3). Never
-- a script that auto-picks: research R4 rejected a silent backfill because
-- choosing a contact chooses who receives money emails.
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM members m
   WHERE m.status <> 'archived'
     AND m.erased_at IS NULL
     AND EXISTS (SELECT 1
                   FROM contacts c
                  WHERE c.tenant_id = m.tenant_id
                    AND c.member_id = m.member_id)
     AND (SELECT count(*)
            FROM contacts c
           WHERE c.tenant_id = m.tenant_id
             AND c.member_id = m.member_id
             AND c.is_primary
             AND c.removed_at IS NULL) <> 1;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'primary-contact invariant violated for % member(s); fix before migrating', bad;
  END IF;
END $$;--> statement-breakpoint

-- ── The index the count runs on ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "contacts_tenant_member_all_idx"
  ON "contacts" ("tenant_id", "member_id");--> statement-breakpoint

-- ── The check, for ONE member ────────────────────────────────────────────────
-- Split out so the trigger can run it for the member a row LEFT as well as the
-- one it joined. Raises with ids only (member uuid + tenant slug + the count —
-- never an address); the count is machine-read by the app (0 → no primary).
CREATE OR REPLACE FUNCTION public.contacts_check_member_primary(p_tenant text, p_member uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status         text;
  v_erased_at      timestamptz;
  v_contact_rows   int;
  v_live_primaries int;
BEGIN
  -- Member row gone at commit → the bottom-up hard-delete chain (contacts,
  -- then members, one tx). Nothing left to guard.
  SELECT m.status::text, m.erased_at
    INTO v_status, v_erased_at
    FROM public.members m
   WHERE m.tenant_id = p_tenant
     AND m.member_id = p_member;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Archived keeps its final snapshot (FR-003 as written in 005); erased is the
  -- one sanctioned zero-primary state (FR-013).
  IF v_status = 'archived' OR v_erased_at IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE c.is_primary AND c.removed_at IS NULL)
    INTO v_contact_rows, v_live_primaries
    FROM public.contacts c
   WHERE c.tenant_id = p_tenant
     AND c.member_id = p_member;

  -- AMENDMENT scope: a member with no contact rows at all is not checked.
  IF v_contact_rows = 0 THEN
    RETURN;
  END IF;

  IF v_live_primaries <> 1 THEN
    RAISE EXCEPTION
      'primary-contact-invariant: member % in tenant % has % live primary contact(s)',
      p_member, p_tenant, v_live_primaries
      USING ERRCODE = '23514';  -- check_violation, like last-admin-protection
  END IF;
END;
$$;--> statement-breakpoint

-- ── The trigger body ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contacts_assert_one_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'contacts' THEN
    -- On DELETE there is no NEW; on an UPDATE that re-parents the row the
    -- member it LEFT may be the one that ends at zero.
    IF TG_OP = 'DELETE' THEN
      PERFORM public.contacts_check_member_primary(OLD.tenant_id, OLD.member_id);
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
       AND (OLD.tenant_id, OLD.member_id) IS DISTINCT FROM (NEW.tenant_id, NEW.member_id) THEN
      PERFORM public.contacts_check_member_primary(OLD.tenant_id, OLD.member_id);
    END IF;
    PERFORM public.contacts_check_member_primary(NEW.tenant_id, NEW.member_id);
    RETURN NULL;
  END IF;

  -- members: UPDATE OF status, erased_at
  PERFORM public.contacts_check_member_primary(NEW.tenant_id, NEW.member_id);
  RETURN NULL;  -- AFTER trigger: return value is ignored
END;
$$;--> statement-breakpoint

-- The helper is callable by NOBODY but its owner. It runs as SECURITY DEFINER
-- and takes a caller-supplied tenant, so an EXECUTE grant to chamber_app would
-- let an app session probe another tenant's member for existence + live-primary
-- count from the raise text — a cross-tenant oracle (T041 round 2, migration
-- N2 / security #7). The trigger body PERFORMs it as the owner, whose EXECUTE
-- survives the REVOKE, so the app role needs no grant for the triggers to fire.
-- (Trigger-function EXECUTE is checked at CREATE TRIGGER time, not per fire;
-- the grant on the trigger function is kept for parity with 0009/0291.)
REVOKE ALL ON FUNCTION public.contacts_check_member_primary(text, uuid) FROM PUBLIC;--> statement-breakpoint
-- Also from the app role by name: an earlier revision of this file granted it
-- (and a branch that applied that revision — the shared dev branch did — keeps
-- the grant, because CREATE OR REPLACE FUNCTION preserves an existing ACL). A
-- no-op on a fresh database; self-correcting on one that ran the old version.
REVOKE ALL ON FUNCTION public.contacts_check_member_primary(text, uuid) FROM chamber_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.contacts_assert_one_primary() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.contacts_assert_one_primary() TO chamber_app;--> statement-breakpoint

DROP TRIGGER IF EXISTS "contacts_one_primary_ct" ON "contacts";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "contacts_one_primary_ct"
  AFTER INSERT OR UPDATE OR DELETE ON "contacts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_assert_one_primary();--> statement-breakpoint

-- A member row never gains or loses a contact by itself, but a status flip
-- (unarchive) or an erasure changes whether the rule applies — so re-check when
-- exactly those two columns change.
DROP TRIGGER IF EXISTS "members_one_primary_ct" ON "members";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "members_one_primary_ct"
  AFTER UPDATE OF "status", "erased_at" ON "members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.contacts_assert_one_primary();
