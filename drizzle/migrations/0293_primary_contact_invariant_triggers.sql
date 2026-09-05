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
-- refused as a typed error the app maps to 409 (`isPrimaryContactTriggerError`,
-- same contract as `last-admin-protection`).
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
-- COST. One indexed count per changed contact row at commit (the partial index
-- contacts_one_primary_per_member serves the live-primary predicate). The
-- trigger is not narrowed with UPDATE OF because it must also cover INSERT and
-- DELETE and a single named trigger is what the tests pin; a name-only edit
-- queues one cheap count.
--
-- REPLAYABLE: DROP TRIGGER IF EXISTS before CREATE (CREATE TRIGGER has no OR
-- REPLACE — cf. 0291's dev-branch incident), CREATE OR REPLACE on the function.

-- ── Pre-check (FR-010a): fail the deploy if the data already violates ────────
-- Counts only — no id, name or address is raised. On a violation the operator
-- fixes the member through the member page (promote a remaining contact); a
-- silent backfill was rejected in research R4 because auto-picking a contact
-- silently chooses who receives money emails.
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

-- ── The guard ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contacts_assert_one_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_tenant_id      text;
  v_member_id      uuid;
  v_status         text;
  v_erased_at      timestamptz;
  v_contact_rows   int;
  v_live_primaries int;
BEGIN
  -- Resolve the member this row belongs to. On DELETE there is no NEW.
  IF TG_TABLE_NAME = 'contacts' AND TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_member_id := OLD.member_id;
  ELSE
    v_tenant_id := NEW.tenant_id;
    v_member_id := NEW.member_id;
  END IF;

  -- Member row gone at commit → the bottom-up hard-delete chain (contacts,
  -- then members, one tx). Nothing left to guard.
  SELECT m.status::text, m.erased_at
    INTO v_status, v_erased_at
    FROM members m
   WHERE m.tenant_id = v_tenant_id
     AND m.member_id = v_member_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Archived keeps its final snapshot (FR-003 as written in 005); erased is the
  -- one sanctioned zero-primary state (FR-013).
  IF v_status = 'archived' OR v_erased_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE c.is_primary AND c.removed_at IS NULL)
    INTO v_contact_rows, v_live_primaries
    FROM contacts c
   WHERE c.tenant_id = v_tenant_id
     AND c.member_id = v_member_id;

  -- AMENDMENT scope: a member with no contact rows at all is not checked.
  IF v_contact_rows = 0 THEN
    RETURN NULL;
  END IF;

  IF v_live_primaries <> 1 THEN
    -- Ids only in the message (never an address). The count is machine-read by
    -- the app: 0 → no_primary_contact, otherwise primary_contact_race.
    RAISE EXCEPTION
      'primary-contact-invariant: member % in tenant % has % live primary contact(s)',
      v_member_id, v_tenant_id, v_live_primaries
      USING ERRCODE = '23514';  -- check_violation, like last-admin-protection
  END IF;

  RETURN NULL;  -- AFTER trigger: return value is ignored
END;
$$;--> statement-breakpoint

-- Without EXECUTE an app session (chamber_app) cannot fire the trigger at all.
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
