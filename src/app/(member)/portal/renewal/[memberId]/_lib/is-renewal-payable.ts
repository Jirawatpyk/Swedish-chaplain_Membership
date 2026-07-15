/**
 * 059-membership-suspension Task 9 item 4 — renewal-page payability gate.
 *
 * Extracted from `page.tsx` (mirrors the `resolve-plan-name.ts` extraction
 * pattern colocated in this same `_lib` directory) so the predicate is
 * unit-testable in isolation.
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
