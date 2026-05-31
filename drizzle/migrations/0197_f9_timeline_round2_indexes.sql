-- ---------------------------------------------------------------------------
-- F9 (code-review Round 2, 2026-05-30) — two sargability gaps the 0196
-- remediation left/created on the member_timeline_v read path:
--
--   #4  payments member lookup. 0196's header wrongly assumed
--       `payments.member_id` was already text and SKIPPED its expression index.
--       It is `uuid` (migration 0033) — only the Drizzle schema declares text (a
--       pre-existing schema/DB drift). The view casts `pay.member_id::text`, so
--       the existing `payments_tenant_member_completed_idx` (raw uuid) cannot
--       serve the timeline's `(member_id)::text = $1` qual → per-tenant seq-scan
--       on the payment branch. Add the matching expression index (partial on the
--       branch's `completed_at IS NOT NULL` filter).
--
--   #5  actor-kind member classification. 0196 added an EXISTS subquery to the
--       audit branch — `... FROM contacts c WHERE c.tenant_id = al.tenant_id AND
--       c.linked_user_id::text = al.actor_user_id` — evaluated per audit row, but
--       `contacts` has no index on `linked_user_id` (its indexes are on member_id
--       / email). Add a tenant-leading, cast-matched partial expression index so
--       the per-row EXISTS is index-served instead of scanning contacts.
--
-- Both are additive `CREATE INDEX IF NOT EXISTS` (no view/table change); safe to
-- apply online (sub-second at first-tenant data volume). Rollback: DROP the two
-- indexes. (Dual-role staff-as-member misclassification — a separate Round-2
-- finding — is intentionally NOT addressed here: the safe fix needs a users-role
-- join in the security_invoker view whose chamber_app grant is unverified; it is
-- a rare, no-data-leak filter-attribution edge tracked for a dedicated change.)
-- ---------------------------------------------------------------------------

-- #4 — sargable payments member lookup matching the view's `member_id::text` cast.
CREATE INDEX IF NOT EXISTS "payments_tenant_member_text_completed_idx"
  ON "payments" ("tenant_id", (("member_id")::text), "completed_at" DESC)
  WHERE "completed_at" IS NOT NULL;--> statement-breakpoint

-- #5 — support 0196's audit-branch member-classification EXISTS subquery.
CREATE INDEX IF NOT EXISTS "contacts_tenant_linked_user_text_idx"
  ON "contacts" ("tenant_id", (("linked_user_id")::text))
  WHERE "linked_user_id" IS NOT NULL;
