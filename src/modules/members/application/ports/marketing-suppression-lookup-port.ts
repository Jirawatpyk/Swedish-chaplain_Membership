/**
 * Application port — read-only view of the tenant's marketing suppression
 * list (the person's OWN unsubscribe, GDPR Art. 21 / PDPA §32).
 *
 * 108 PR-D: `setContactMarketingOptOut` must refuse to switch marketing ON
 * for an address the person has unsubscribed (FR-025 — unsubscribe always
 * wins over anything staff do). The suppression list is OWNED by the
 * broadcasts module, which already imports the members barrel, so the
 * adapter for this port lives in the composition layer
 * (`src/lib/contact-marketing-deps.ts`), never in `members-deps.ts` — see
 * plan § Complexity Tracking #3 (barrel-cycle rule).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
export interface MarketingSuppressionLookupPort {
  /**
   * True when `email` (any case) is on the tenant's suppression list.
   * THROWS on a lookup failure — the caller decides what "cannot verify"
   * means for its operation (the toggle refuses "on"; display surfaces
   * render "status unavailable").
   */
  isSuppressed(email: string): Promise<boolean>;
}
