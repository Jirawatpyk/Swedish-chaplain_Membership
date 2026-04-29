-- ---------------------------------------------------------------------------
-- F7 — ALTER members ADD broadcasts_acknowledged_at
-- (T018 per specs/010-email-broadcast/tasks.md).
--
-- Clarifications Q15: GDPR Art. 7 demonstrable-consent timestamp.
-- Populated when member dismisses the one-time portal acknowledgement
-- banner ("Your tier includes marketing broadcasts from chamber members.
-- You may unsubscribe at any time."). Emits
-- `member_acknowledged_broadcasts_terms` audit on first set.
--
-- Source of truth: specs/010-email-broadcast/data-model.md § 1.3a.
--
-- The column is NOT a precondition for receiving broadcasts — lawful
-- basis remains contract performance per PDPA §24 + GDPR Art. 6(1)(b).
-- It is evidence-strengthening for GDPR Art. 7 "demonstrable consent"
-- defence. Banner appears on first member-portal sign-in post-F7-launch
-- + on F7 benefits-page first-visit until acknowledged. Manager + admin
-- roles do NOT see the banner (member-role only).
--
-- Retention: indefinite while member row exists. Deleted alongside member
-- on Art. 17 erasure. If a tenant materially changes its marketing terms
-- (F12 white-label customisation), an admin SHOULD reset to NULL via a
-- migration or admin tool to force re-acknowledgement (preserves the GDPR
-- Art. 7 invariant that consent must reflect current terms). The audit-log
-- row `member_acknowledged_broadcasts_terms` carries the original
-- timestamp + banner_locale and is retained per the standard 5-year
-- audit retention regardless of column reset.
--
-- Idempotent via `IF NOT EXISTS` to support re-runs.
-- ---------------------------------------------------------------------------

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "broadcasts_acknowledged_at" timestamp with time zone;--> statement-breakpoint

-- Q15: banner-eligible members lookup (members who haven't acknowledged yet)
CREATE INDEX IF NOT EXISTS "members_tenant_broadcasts_unack_idx"
  ON "members" ("tenant_id", "member_id")
  WHERE "broadcasts_acknowledged_at" IS NULL;--> statement-breakpoint
