/**
 * T026 — Personal-email-domain deny list (F6 Domain).
 *
 * The 4-rule match cascade (FR-012 / research.md R4) SKIPS step 2
 * (member_domain match) for attendees whose email domain is on this
 * static list. Reason: matching jane@gmail.com to a member by domain
 * would false-positive every Gmail user against any member with a
 * Gmail email.
 *
 * Static for v1; tenant-extensible interface declared below so a future
 * `tenant_email_deny_list_overrides` table (if needed) can plug in
 * without changing the cascade implementation.
 *
 * Pure TypeScript — Constitution Principle III. No DB / network.
 */

/**
 * Canonical static deny list — the top consumer/personal email providers.
 * Lower-case + bare domain (no `@`). Matched against
 * `email.split('@')[1].toLowerCase()` at the call site.
 *
 * Sources:
 *   - research.md R4 — original 5 providers
 *   - Plus common Thai consumer providers (hotmail.co.th, line.me)
 *   - Plus common Swedish consumer providers (live.se)
 */
export const PERSONAL_EMAIL_DOMAINS = new Set<string>([
  // Global top-5 consumer
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  // Microsoft variants
  'live.com',
  'msn.com',
  // Yahoo variants
  'ymail.com',
  'rocketmail.com',
  // Apple variants
  'me.com',
  'mac.com',
  // Country-specific consumer
  'hotmail.co.th',
  'yahoo.co.th',
  'live.se',
  'spray.se',
  // Misc personal providers
  'protonmail.com',
  'proton.me',
  'tutanota.com',
  'aol.com',
  'mail.com',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'fastmail.com',
]);

/**
 * Tenant-extensible interface — v1 returns the static set; future
 * implementations can union the static set with tenant-specific extras
 * loaded from a settings table without changing the match-cascade code.
 */
export interface PersonalEmailDenyList {
  /** True iff the lower-cased bare domain is on the deny list. */
  has(domain: string): boolean;
}

/**
 * Default deny-list implementation backed by the static set above.
 */
export const defaultPersonalEmailDenyList: PersonalEmailDenyList = {
  has(domain: string): boolean {
    return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase());
  },
};

/**
 * Convenience helper — extracts the bare domain from a full email,
 * lower-cased, then checks the deny list. Returns FALSE for malformed
 * emails (no `@`) so the call site degrades to "not personal" and the
 * domain-match rule executes; the malformed-email case will be caught
 * by the contact-email rule (step 1) returning no match too.
 */
export function isPersonalEmail(
  email: string,
  denyList: PersonalEmailDenyList = defaultPersonalEmailDenyList,
): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return denyList.has(domain);
}
