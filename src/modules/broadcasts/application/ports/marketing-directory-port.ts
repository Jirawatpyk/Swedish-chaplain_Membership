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
 * of `listRecipients` as `broadcasts_no_marketing_recipient_total` — a
 * hand-off that notified nobody pages — so its caller never counts it again.
 * `readRoster` counts nothing: its caller reports an empty roster itself,
 * after its commit (T166 R-L3).
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
  /**
   * T166 R-L3 — the same roster with NO side effect, for a caller that reads
   * it BEFORE its transaction opens (the read is pool-global — `users` has no
   * tenant — and must not hold a second connection while the tx holds row or
   * advisory locks). A caller that uses it owes the count: `reportEmptyRoster()`
   * once the hand-off it read the roster for has COMMITTED, so the counter
   * still means "a hand-off that notified nobody", never "a refused attempt".
   */
  readRoster(): Promise<readonly MarketingRecipient[]>;
  /** Count one hand-off that reached nobody (`broadcasts_no_marketing_recipient_total`). */
  reportEmptyRoster(): void;
}
