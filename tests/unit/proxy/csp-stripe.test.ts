/**
 * T033 unit test — CSP Stripe allowlist (global).
 *
 * Original spec scoped Stripe origins to F5 invoice routes only, but
 * route-scoped CSP breaks under Next.js SPA navigation: CSP applies
 * at initial document load and is NOT re-evaluated on client-side
 * route changes. A user landing on `/portal/dashboard` first and then
 * SPA-navigating to an invoice detail keeps the dashboard's CSP →
 * Stripe.js blocked. Refactored 2026-04-25 to global allowlist.
 *
 * `buildCsp()` from `src/proxy.ts` now adds `js.stripe.com` +
 * `api.stripe.com` + `hooks.stripe.com` on EVERY route. The
 * "scoping" benefit was minimal anyway (Stripe.js is iframe-sandboxed,
 * not an XSS vector), and this matches Stripe's official integration
 * docs + how every Stripe-using app on the web is configured.
 */
import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/proxy';

describe('F5 CSP Stripe allowlist (T033 — global, post-SPA-fix)', () => {
  describe('Stripe origins are present on every route (SPA-safe)', () => {
    it.each([
      // F5 invoice routes (original scoped allow-list)
      '/portal/invoices/abc-123',
      '/admin/invoices/abc-123',
      '/portal/invoices/abc-123?pay=1',
      '/admin/invoices/abc/credit-notes/def',
      // Non-F5 routes — must ALSO include Stripe so SPA navigation
      // from these pages to an invoice detail does not get blocked.
      '/',
      '/admin',
      '/portal',
      '/admin/members',
      '/admin/plans',
      '/portal/profile',
      '/api/invoices/abc/pdf',
      '/api/payments/initiate',
      '/api/webhooks/stripe', // server-only but CSP harmless here
    ])('includes Stripe origins on %s', () => {
      const csp = buildCsp(false, 'r023-test-nonce');
      expect(csp).toContain('https://js.stripe.com');
      expect(csp).toContain('https://api.stripe.com');
      expect(csp).toContain('https://hooks.stripe.com');
      expect(csp).toMatch(/script-src[^;]*https:\/\/js\.stripe\.com/);
      expect(csp).toMatch(/frame-src[^;]*https:\/\/js\.stripe\.com/);
      expect(csp).toMatch(/frame-src[^;]*https:\/\/hooks\.stripe\.com/);
      expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.stripe\.com/);
    });
  });

  describe('dev vs prod script-src', () => {
    it('adds unsafe-eval in dev', () => {
      const csp = buildCsp(true, 'r023-test-nonce');
      expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/);
    });
    it('omits unsafe-eval in prod', () => {
      const csp = buildCsp(false, 'r023-test-nonce');
      expect(csp).not.toContain("'unsafe-eval'");
    });
  });

  describe('defensive defaults', () => {
    it('always declares default-src self + frame-ancestors none + base-uri self', () => {
      const csp = buildCsp(false, 'r023-test-nonce');
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });
  });

  // Staff-review R2 R023 (2026-04-28): nonce-based CSP for production.
  // Locks in the contract that prod ships `'nonce-${nonce}'` +
  // `'strict-dynamic'` while dev keeps `'unsafe-inline'` + `'unsafe-eval'`
  // for HMR + DevTools.
  describe('R023 nonce-based CSP (production)', () => {
    it('production includes the per-request nonce in script-src', () => {
      const csp = buildCsp(false, 'r023-prod-nonce-abc');
      expect(csp).toMatch(/script-src[^;]*'nonce-r023-prod-nonce-abc'/);
      expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
    });

    it('production drops unsafe-eval (CSP3-aware browsers ignore unsafe-inline when nonce present)', () => {
      const csp = buildCsp(false, 'r023-prod-nonce');
      expect(csp).not.toContain("'unsafe-eval'");
      // 'unsafe-inline' is retained as a legacy fallback only — CSP3-aware
      // browsers ignore it when a nonce-source is present.
      expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
    });

    it('development OMITS the nonce in script-src (HMR + DevTools require unsafe-inline directly)', () => {
      const csp = buildCsp(true, 'r023-dev-nonce');
      expect(csp).not.toContain("'nonce-r023-dev-nonce'");
      expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/);
    });
  });
});
