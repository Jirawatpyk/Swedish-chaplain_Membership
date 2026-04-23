/**
 * T033 unit test — CSP Stripe allowlist scoping.
 *
 * Verifies `buildCsp()` from `src/proxy.ts` adds `js.stripe.com` +
 * `api.stripe.com` + `hooks.stripe.com` ONLY on F5 invoice detail
 * routes (`/portal/invoices/*`, `/admin/invoices/*`) and NOT on
 * unrelated routes or the webhook endpoint (security.md § 6
 * "CSP allowlist scoped to F5-relevant routes only").
 */
import { describe, expect, it } from 'vitest';
import { buildCsp } from '@/proxy';

describe('F5 CSP Stripe allowlist (T033)', () => {
  describe('F5 invoice routes include Stripe origins', () => {
    it.each([
      '/portal/invoices/abc-123',
      '/admin/invoices/abc-123',
      '/portal/invoices/abc-123?pay=1',
      '/admin/invoices/abc/credit-notes/def',
    ])('includes Stripe origins on %s', (pathname) => {
      const csp = buildCsp(false, pathname);
      expect(csp).toContain('https://js.stripe.com');
      expect(csp).toContain('https://api.stripe.com');
      expect(csp).toContain('https://hooks.stripe.com');
      // script-src specifically — not just any directive
      expect(csp).toMatch(/script-src[^;]*https:\/\/js\.stripe\.com/);
      // frame-src — for the Stripe Elements iframe + hooks.stripe.com
      // (3DS / bank auth redirect iframe)
      expect(csp).toMatch(/frame-src[^;]*https:\/\/js\.stripe\.com/);
      expect(csp).toMatch(/frame-src[^;]*https:\/\/hooks\.stripe\.com/);
      // connect-src — for api.stripe.com XHR
      expect(csp).toMatch(/connect-src[^;]*https:\/\/api\.stripe\.com/);
    });
  });

  describe('non-F5 routes do NOT include Stripe origins', () => {
    it.each([
      '/',
      '/admin',
      '/portal',
      '/admin/members',
      '/admin/plans',
      '/portal/profile',
      '/api/webhooks/stripe', // webhook route: server-only, no client Stripe.js
      '/api/invoices/abc/pdf',
      '/api/payments/initiate',
    ])('excludes Stripe origins on %s', (pathname) => {
      const csp = buildCsp(false, pathname);
      expect(csp).not.toContain('js.stripe.com');
      expect(csp).not.toContain('hooks.stripe.com');
      expect(csp).not.toContain('api.stripe.com');
    });
  });

  describe('dev vs prod script-src', () => {
    it('adds unsafe-eval in dev', () => {
      const csp = buildCsp(true, '/');
      expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/);
    });
    it('omits unsafe-eval in prod', () => {
      const csp = buildCsp(false, '/');
      expect(csp).not.toContain("'unsafe-eval'");
    });
  });

  describe('defensive defaults', () => {
    it('always declares default-src self + frame-ancestors none + base-uri self', () => {
      const csp = buildCsp(false, '/admin/invoices/x');
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });
  });
});
