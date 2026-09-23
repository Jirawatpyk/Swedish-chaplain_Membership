/**
 * F119 T066 — `MarketingDirectoryPort` Application port (FR-021a;
 * contracts/dashboard-and-notifications.md § 3.1, research R15).
 *
 * Who is emailed when an E-Blast hand-off is marketing's turn: every ACTIVE
 * user the permission evaluator makes "marketing" (holds `broadcasts.write`,
 * outside the admin tiers), or — when none is active — the admin tiers.
 * Other staff are never emailed for hand-offs; they see the in-app count.
 *
 * The adapter (`src/lib/broadcast-marketing-deps.ts`) counts an EMPTY result
 * as `broadcasts_no_marketing_recipient_total` — a hand-off that notified
 * nobody pages — so a caller never counts it again.
 *
 * `users` is cross-tenant (F1's carve-out, no `tenant_id`, no RLS), so the
 * read takes no tx. `locale` is on the shape so a future per-user locale
 * needs no port change; today it is the platform default.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface MarketingRecipient {
  readonly userId: string;
  readonly email: string;
  readonly locale: 'en' | 'th' | 'sv';
}

export interface MarketingDirectoryPort {
  /** The hand-off roster, ordered by address. Empty ⇒ nobody to notify (already counted). */
  listRecipients(): Promise<readonly MarketingRecipient[]>;
}
