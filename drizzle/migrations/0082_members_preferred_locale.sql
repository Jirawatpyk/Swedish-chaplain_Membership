-- Migration 0082 — F3 members.preferred_locale + F7 R4 (verify-fix Types-#6).
--
-- Adds a per-member preferred locale for transactional notifications.
-- F7 (Email Broadcast) uses this so SweCham members who prefer Swedish
-- get email notifications in `sv` instead of the tenant default `th`.
-- F3 admin UI for setting this lands post-F12 white-label phase; for
-- now NULL = "use tenant default locale" (resolved by routes via
-- `tenantDefaultLocaleFor(...)` chained after `getMemberPreferredLocale`).
--
-- Allowed values match the canonical `Locale` union in
-- `src/i18n/config.ts` (`en | th | sv`). Enforced via CHECK so a
-- future code path that bypasses the smart constructor (e.g., direct
-- INSERT in a seed) cannot land an invalid locale value.
--
-- Idempotent — re-runs are no-ops via `IF NOT EXISTS`.

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS preferred_locale text;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'members_preferred_locale_chk'
  ) THEN
    ALTER TABLE members
      ADD CONSTRAINT members_preferred_locale_chk
      CHECK (preferred_locale IS NULL OR preferred_locale IN ('en', 'th', 'sv'));
  END IF;
END$$;
