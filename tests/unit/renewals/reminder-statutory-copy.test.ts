/**
 * 065 renewal-swecham-alignment (§5.5) — every POST-DUE reminder step carries the
 * statutory-termination warning (SweCham is regulatory-bound to terminate members
 * with unpaid fees within 60 days of the invoice due date) in all three locales.
 *
 * Copy is a DRAFT grounded in SweCham's own spec language ("statutory and
 * regulatory obligation to delete members with unpaid fees") — still pending
 * SweCham's final legal sign-off (design §9.4), but no longer a literal
 * "PLACEHOLDER:" that would ship to members verbatim. This test pins the
 * presence of the warning marker (not the exact wording), so a legal reword
 * keeps the guarantee without churning the assertion.
 *
 * Post-due steps only: the tier ladders each end with one post-expiry step
 * (thai_alumni/start_up/regular t+7, premium t+14, partnership t+30). The pre-due
 * steps (t-N / t+0) deliberately do NOT carry the warning.
 */
import { describe, it, expect } from 'vitest';
import {
  RENEWAL_COPY,
  type RenewalEmailLocale,
} from '@/modules/renewals/infrastructure/email/templates/copy';

const POST_EXPIRY = [
  'thai_alumni.t+7',
  'start_up.t+7',
  'regular.t+7',
  'premium.t+14',
  'partnership.t+30',
] as const;

const LOCALES: readonly RenewalEmailLocale[] = ['en', 'th', 'sv'];

// EN "regulatory" · TH "ระเบียบ" · SV "föreskrift/föreskriv…" — one marker per
// locale. The SV stem is `föreskri` (matches the approved noun "föreskrift" AND a
// future verb reword "föreskriv…"); the plan's suggested `föreskriv` did NOT
// match the approved SV sentence's "föreskrift" (…skri + ft, not …skri + v).
const WARNING_MARKER = /regulatory|ระเบียบ|föreskri/i;

describe('065 §5.5 — statutory termination warning on post-due reminders', () => {
  it('every post-expiry reminder body carries the statutory warning (all 3 locales)', () => {
    for (const locale of LOCALES) {
      for (const key of POST_EXPIRY) {
        const body = RENEWAL_COPY[locale][key]?.body;
        expect(body, `${locale} / ${key} must have a body`).toBeDefined();
        expect(body, `${locale} / ${key} body must carry the statutory warning`).toMatch(
          WARNING_MARKER,
        );
      }
    }
  });

  it('a pre-due reminder (regular.t-30) does NOT carry the warning (post-due only)', () => {
    for (const locale of LOCALES) {
      const body = RENEWAL_COPY[locale]['regular.t-30']?.body;
      expect(body, `${locale} / regular.t-30 must have a body`).toBeDefined();
      expect(body).not.toMatch(WARNING_MARKER);
    }
  });
});
