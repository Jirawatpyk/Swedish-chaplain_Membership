/**
 * Email-locale audit 2026-07-16 — recipient locale lookup for F4 auto-emails.
 *
 * The `EmailOutboxPort.recipientLocale` field existed since R7-S2 but no
 * production caller ever populated it, so every F4 email rendered English
 * regardless of the member's preference. This port closes that gap with a
 * LIVE read at enqueue time (deliberately NOT a `MemberIdentitySnapshot`
 * extension — the snapshot is frozen at issue per FR-038, and a preference
 * change after issuance must still affect later emails: paid, void, resend).
 *
 * Resolution chain (platform-wide precedence, mirrors F8 renewals + F7
 * notification emails): `members.preferred_locale` (nullable — only ever set
 * by an explicit member/admin choice) beats `contacts.preferred_language`
 * (NOT NULL DEFAULT 'en' — indistinguishable from "never chose"), then null.
 * A null return means "no stored preference"; the outbox adapter's existing
 * `?? 'en'` default applies.
 */
import type { F4OutboxLocale } from './email-outbox-port';

export interface RecipientLocalePort {
  /**
   * Resolve the member's preferred email locale at enqueue time.
   *
   * `tx` follows the `EmailOutboxPort.enqueue` convention: the caller's open
   * tenant tx, or `null` for standalone reads (resend-pdf runs outside a
   * mutating financial tx) — the adapter then self-scopes via `runInTenant`.
   * Returns `null` when the member row is missing or carries no usable
   * preference.
   */
  getMemberEmailLocale(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<F4OutboxLocale | null>;
}
