/**
 * R2 HIGH-5 (2026-04-27) — SC-006 decline-code catalogue coverage.
 *
 * Asserts the top-20 Stripe decline codes resolve to a non-empty,
 * non-`undefined` translation in EN, TH, and SV. The runtime mapping
 * lives in `src/lib/payments-errors-i18n.ts` (and is consumed by
 * `card-form.tsx`); this test pins the underlying JSON catalogues so
 * a missing key can never reach a member's screen as `undefined` or
 * an empty string. Spec authority: F5 spec.md SC-006 + FR-009 user-
 * facing decline-reason copy in 3 locales.
 */
import { describe, expect, it } from 'vitest';

import enCodes from '../../../../src/i18n/messages/en/payment-decline-reasons.json';
import thCodes from '../../../../src/i18n/messages/th/payment-decline-reasons.json';
import svCodes from '../../../../src/i18n/messages/sv/payment-decline-reasons.json';

const TOP_20_DECLINE_CODES = [
  'card_declined',
  'insufficient_funds',
  'expired_card',
  'incorrect_cvc',
  'processing_error',
  'incorrect_number',
  'lost_card',
  'stolen_card',
  'pickup_card',
  'restricted_card',
  'security_violation',
  'service_not_allowed',
  'transaction_not_allowed',
  'try_again_later',
  'withdrawal_count_limit_exceeded',
  'currency_not_supported',
  'do_not_honor',
  'fraudulent',
  'generic_decline',
  'invalid_account',
] as const;

type CatalogueRow = Record<string, string>;
const catalogues: ReadonlyArray<readonly [string, CatalogueRow]> = [
  ['en', enCodes as CatalogueRow],
  ['th', thCodes as CatalogueRow],
  ['sv', svCodes as CatalogueRow],
];

describe('SC-006 — decline-code catalogue (top-20 × 3 locales)', () => {
  for (const [locale, catalogue] of catalogues) {
    describe(`locale: ${locale}`, () => {
      for (const code of TOP_20_DECLINE_CODES) {
        it(`resolves '${code}' to a non-empty string`, () => {
          const value = catalogue[code];
          expect(value, `${locale} missing or undefined: ${code}`).toBeTruthy();
          expect(typeof value).toBe('string');
          expect((value ?? '').trim().length).toBeGreaterThan(0);
        });
      }

      it('exposes a _fallback entry for unknown codes', () => {
        const fallback = catalogue._fallback;
        expect(fallback).toBeTruthy();
        expect(typeof fallback).toBe('string');
        expect((fallback ?? '').trim().length).toBeGreaterThan(0);
      });
    });
  }
});
