/**
 * 059-membership-suspension Task 9 item 4 — renewal payability gate.
 *
 * The SINGLE source of truth for "may this member pay their renewal now?".
 * Consumed by BOTH:
 *   - the renewal page (`portal/renewal/[memberId]/page.tsx`) — gates the
 *     Confirm flow vs the "renewal window not yet open" card;
 *   - the portal dashboard membership stat (`_lib/dashboard-stats.ts`
 *     `shouldOfferRenewNow`) — gates the actionable "Renew now" CTA.
 * Sharing ONE predicate is load-bearing: a `due` stat card whose CTA links
 * here must never offer a "Renew now" button that dead-ends on the page's
 * not-yet-open gate (plan-change-ux seam 2). Moved up from the renewal
 * route's `_lib` to `portal/_lib` so the dashboard can import it without
 * reaching into a nested route segment.
 *
 * Extracted from `page.tsx` (mirrors the `resolve-plan-name.ts` extraction
 * pattern) so the predicate is unit-testable in isolation.
 *
 * BLOCKER fix: the gate previously keyed ONLY on `summary.status ===
 * 'awaiting_payment'`, so the `upcoming`/`reminded`-but-expired cohort the
 * 059 suspension override rule creates (see `deriveMembershipAccess` — a
 * non-terminal cycle past its `expiresAt` is `suspended`/`unpaid`) landed on
 * the read-only "renewal window not yet open" card — a dead end that
 * directly contradicts the suspended banner telling the same member to pay.
 * This now keys on the SAME predicate `deriveMembershipAccess` uses for that
 * override, so the Confirm flow renders exactly when the member is actually
 * suspended-for-non-payment. `confirmRenewal` already accepts this via its
 * lazy `upcoming|reminded → awaiting_payment` self-transition — only the
 * presentation gate was blocking it.
 *
 * Deliberately takes `status: string` (not `RenewalCycle['status']`) to stay
 * decoupled from a Domain import in this presentation-only helper, mirroring
 * `OutstandingInvoiceInput.status` in `_lib/dashboard-stats.ts`.
 */
export function isRenewalPayable(status: string, expiresAtIso: string, now: Date): boolean {
  if (status === 'awaiting_payment') return true;
  if (status === 'upcoming' || status === 'reminded') {
    // Instant-vs-instant, strict `<` — same semantics as
    // `deriveMembershipAccess` (exactly-now is NOT YET expired). A
    // malformed/unparseable `expiresAt` is treated as EXPIRED (→ payable),
    // mirroring `deriveMembershipAccess`'s `!Number.isFinite(expiresMs)`
    // guard so the two predicates never disagree on a corrupt row — a
    // disagreement would dead-end the suspended card's "pay to restore"
    // CTA, which links to this page (the exact regression Task 9 item 4
    // fixed for the well-formed case).
    const expiresMs = Date.parse(expiresAtIso);
    return !Number.isFinite(expiresMs) || expiresMs < now.getTime();
  }
  return false;
}
