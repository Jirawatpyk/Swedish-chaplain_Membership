/**
 * Shared HTML-entity escaper for plain-string email/HTML builders.
 *
 * Extracted (065 review follow-up) from five identical local `escape()`
 * copies across the auth / members / broadcasts email-template modules:
 *   - src/modules/auth/infrastructure/email/reset-password-email.ts
 *   - src/modules/auth/infrastructure/email/invitation-email.ts
 *   - src/modules/members/infrastructure/email/email-verification-email.ts
 *   - src/modules/members/infrastructure/email/email-change-revert-email.ts
 *   - src/modules/broadcasts/infrastructure/email/broadcast-notification-emails.ts
 *
 * Behaviour is byte-for-byte identical to those copies: it replaces the
 * five HTML-significant characters (`&`, `<`, `>`, `"`, `'`) with their
 * entity equivalents. `&` MUST be replaced first so the inserted `&` of
 * the other entities is not double-escaped.
 *
 * NOTE: this is intentionally distinct from the broadcasts domain
 * `escapeHtml` (`src/modules/broadcasts/domain/value-objects/template-snapshot.ts`),
 * which is a Domain-layer value-object helper with its own regex form.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
