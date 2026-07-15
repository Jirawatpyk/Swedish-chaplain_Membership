/**
 * 059-membership-suspension Task 3 — two-policy route spec.
 *
 * `isTerminatedAllowedRoute` (deny-by-default allowlist) and
 * `isSuspendedDeniedRoute` (allow-by-default denylist) are pure route
 * predicates consumed by `checkPortalAccess`. Exercised standalone here
 * (no cyclesRepo/audit deps needed) so the routing rules themselves are
 * pinned independent of the DB-lookup + derive-access plumbing, which
 * `tests/unit/lib/lapsed-portal-scope.test.ts` covers.
 */
import { describe, expect, it } from 'vitest';
import { isSuspendedDeniedRoute, isTerminatedAllowedRoute } from '@/lib/lapsed-portal-scope';

describe('suspended denylist (allow-by-default)', () => {
  it('blocks /portal/broadcasts/new', () => expect(isSuspendedDeniedRoute('/portal/broadcasts/new')).toBe(true));
  it('allows /portal/invoices/[id] (must reach to pay)', () => expect(isSuspendedDeniedRoute('/portal/invoices/abc')).toBe(false));
  it('allows /api/portal/invoices/[id]/pdf', () => expect(isSuspendedDeniedRoute('/api/portal/invoices/abc/pdf')).toBe(false));
  it('allows /portal/account/data-export (GDPR Art.20)', () => expect(isSuspendedDeniedRoute('/portal/account/data-export')).toBe(false));
  it('allows /portal/credit-notes/[id]', () => expect(isSuspendedDeniedRoute('/portal/credit-notes/abc')).toBe(false));
  it('does NOT block a confusable /portal/broadcasts/new-thing? via bare substring', () =>
    expect(isSuspendedDeniedRoute('/portal/broadcasts/newsletter')).toBe(false));
  it('allows reading an existing broadcast /portal/broadcasts/[id]', () =>
    expect(isSuspendedDeniedRoute('/portal/broadcasts/abc123')).toBe(false));
  it('allows POST /api/portal/broadcasts/acknowledge (GDPR Art.7 consent ack, not benefit consumption)', () =>
    expect(isSuspendedDeniedRoute('/api/portal/broadcasts/acknowledge')).toBe(false));
});

describe('terminated allowlist (deny-by-default)', () => {
  it('allows /portal (dashboard — renders the mailto contact CTA)', () => expect(isTerminatedAllowedRoute('/portal')).toBe(true));
  it('allows /portal/account', () => expect(isTerminatedAllowedRoute('/portal/account')).toBe(true));
  it('blocks /portal/timeline', () => expect(isTerminatedAllowedRoute('/portal/timeline')).toBe(false));
  it('does NOT allow /portal/renewal-evil via bare prefix', () => expect(isTerminatedAllowedRoute('/portal/renewal-evil')).toBe(false));

  // 2026-07-14 maintainer decision (task-15c): a terminated member's own
  // invoices + credit-notes are Thai tax records (§86/4 receipts), not a
  // membership benefit — they MUST remain reachable read-only even after
  // grace expires. This reverses the Task 15 (commit 48878099) spec
  // amendment that said the opposite; see the corrected FR-005 note in
  // specs/011-renewal-reminders/spec.md.
  describe('own tax-document read access (2026-07-14 maintainer decision)', () => {
    it('allows /portal/invoices (list page)', () =>
      expect(isTerminatedAllowedRoute('/portal/invoices')).toBe(true));
    it('allows /portal/invoices/<uuid> (detail page)', () =>
      expect(isTerminatedAllowedRoute('/portal/invoices/550e8400-e29b-41d4-a716-446655440000')).toBe(true));
    it('allows /portal/credit-notes/<uuid> (detail page)', () =>
      expect(isTerminatedAllowedRoute('/portal/credit-notes/550e8400-e29b-41d4-a716-446655440000')).toBe(true));
    it('allows the invoice PDF read API', () =>
      expect(isTerminatedAllowedRoute('/api/portal/invoices/550e8400-e29b-41d4-a716-446655440000/pdf')).toBe(true));
    it('allows the receipt PDF read API', () =>
      expect(isTerminatedAllowedRoute('/api/portal/invoices/550e8400-e29b-41d4-a716-446655440000/receipt/pdf')).toBe(true));
    it('allows the receipt status read API', () =>
      expect(isTerminatedAllowedRoute('/api/portal/invoices/550e8400-e29b-41d4-a716-446655440000/receipt/status')).toBe(true));
    it('allows the own-invoice search API (cmdk "Pay invoice" backend, read-only)', () =>
      expect(isTerminatedAllowedRoute('/api/portal/invoices/search')).toBe(true));
    it('allows the credit-note PDF read API', () =>
      expect(isTerminatedAllowedRoute('/api/portal/credit-notes/550e8400-e29b-41d4-a716-446655440000/pdf')).toBe(true));
    // Scope decision: `resend` (POST, emails a copy of the invoice PDF to
    // the member) is a mutation, not a read — but it shares the dynamic
    // `/api/portal/invoices/{id}/...` prefix with the PDF/receipt read
    // routes above, so `matchesScopePrefix` cannot exclude it without a
    // suffix-matching mechanism this allowlist doesn't have. Deliberately
    // ALLOWED via the broad prefix: a terminated member re-sending their
    // OWN invoice email to themselves is low-risk (no cross-member/PII
    // exposure, no financial mutation, no benefit consumption).
    it('allows resend (accepted broad-prefix trade-off — low-risk self-mutation)', () =>
      expect(isTerminatedAllowedRoute('/api/portal/invoices/550e8400-e29b-41d4-a716-446655440000/resend')).toBe(true));
    // Boundary precision: a confusable substring must not match either.
    it('does NOT allow /portal/invoices-other via bare prefix', () =>
      expect(isTerminatedAllowedRoute('/portal/invoices-other')).toBe(false));
    it('does NOT allow /api/portal/invoicesx via bare prefix', () =>
      expect(isTerminatedAllowedRoute('/api/portal/invoicesx')).toBe(false));
  });

  // Everything else stays blocked — this widening is scoped to
  // invoices/credit-notes ONLY, not a general re-opening of the portal.
  it('still blocks /portal/broadcasts/new (benefit consumption, unrelated surface)', () =>
    expect(isTerminatedAllowedRoute('/portal/broadcasts/new')).toBe(false));
  it('still blocks /api/payments/initiate (payment, not a read — separate gate, out of this scope)', () =>
    expect(isTerminatedAllowedRoute('/api/payments/initiate')).toBe(false));
});
