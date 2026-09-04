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

  /**
   * 108 FR-001 — resolve the member's money-email DELIVERY address, live, at
   * enqueue time: the one contact with `is_primary = true AND removed_at IS
   * NULL`, plus the same locale precedence `getMemberEmailLocale` applies.
   *
   * Deliberately NOT the frozen `MemberIdentitySnapshot.primary_contact_email`:
   * the snapshot fixes the tax document's BUYER (F4 FR-038, §86/4) and must
   * never move, but a receipt, void notice, credit note or resend enqueued
   * AFTER a contact promotion has to reach whoever is primary NOW. Two
   * different questions, two different reads.
   *
   * `tx` follows the same convention as `getMemberEmailLocale`: the caller's
   * open tenant tx, or `null` for standalone reads (resend-pdf runs outside a
   * mutating financial tx) — the adapter then self-scopes via `runInTenant`.
   *
   * `null` means "this member has no live primary contact" — an FR-003
   * violation upstream. There is NO fallback address: the caller skips the
   * email and audits the skip (see `lib/resolve-money-recipient.ts`).
   */
  getMemberEmailRecipient(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly email: string; readonly locale: F4OutboxLocale | null } | null>;
}
