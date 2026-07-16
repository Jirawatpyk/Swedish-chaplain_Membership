/**
 * 065 renewal-swecham-alignment (§5.5) — every POST-DUE reminder step carries the
 * termination warning ("Under its bylaws, SweCham is required to terminate the
 * membership of members whose fees remain unpaid more than 60 days after the
 * invoice due date") in all three locales.
 *
 * Wording is BYLAW-based + compliance-reviewed 2026-07-16 (see copy.ts docblock):
 * the earlier "statutory/ตามกฎหมาย/lagstadgad" phrasing was an overclaim (a
 * chamber's duty comes from its own bylaws, not a statute) and was removed. This
 * test pins the presence of the bylaw marker (not the exact wording), so a future
 * reword keeps the guarantee without churning the assertion.
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

// The bylaw marker, one per locale: EN "bylaws" · TH "ข้อบังคับ" · SV "stadgar".
// (2026-07-16 compliance fix: replaced the old "regulatory/ระเบียบ/föreskri"
// markers after the "statutory" overclaim was removed — the warning now anchors
// on the chamber's own bylaws, not a statute/external regulation.)
const WARNING_MARKER = /bylaws|ข้อบังคับ|stadgar/i;

describe('065 §5.5 — bylaw-based termination warning on post-due reminders', () => {
  it('every post-expiry reminder body carries the termination warning (all 3 locales)', () => {
    for (const locale of LOCALES) {
      for (const key of POST_EXPIRY) {
        const body = RENEWAL_COPY[locale][key]?.body;
        expect(body, `${locale} / ${key} must have a body`).toBeDefined();
        expect(body, `${locale} / ${key} body must carry the termination warning`).toMatch(
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
