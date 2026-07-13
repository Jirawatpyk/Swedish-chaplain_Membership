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
});

describe('terminated allowlist (deny-by-default)', () => {
  it('allows /portal (dashboard — renders the mailto contact CTA)', () => expect(isTerminatedAllowedRoute('/portal')).toBe(true));
  it('allows /portal/account', () => expect(isTerminatedAllowedRoute('/portal/account')).toBe(true));
  it('blocks /portal/timeline', () => expect(isTerminatedAllowedRoute('/portal/timeline')).toBe(false));
  it('does NOT allow /portal/renewal-evil via bare prefix', () => expect(isTerminatedAllowedRoute('/portal/renewal-evil')).toBe(false));
});
