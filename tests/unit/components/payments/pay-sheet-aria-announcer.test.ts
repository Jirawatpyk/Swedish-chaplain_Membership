/**
 * T127 (Phase 7) — unit coverage for the FR-028(j) screen-reader
 * announcement derivation.
 *
 * Asserts that `derivePayStateAnnouncement` returns the correct
 * localized string for every PayState branch — including the
 * fall-through silence on transient pre-interactive kinds.
 *
 * The function is pure (state + translator → string) so we can test
 * it without mounting PaySheetInternal (which requires Stripe SDK +
 * initiate-fetch mocks).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  derivePayStateAnnouncement,
  type PayState,
} from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-sheet-internal';

const t = vi.fn((key: string) => `T:${key}`) as unknown as Parameters<
  typeof derivePayStateAnnouncement
>[1];

describe('derivePayStateAnnouncement', () => {
  it.each<[PayState['kind'], PayState]>([
    ['idle', { kind: 'idle' }],
    ['initiating', { kind: 'initiating' }],
    ['card-form', { kind: 'card-form', clientSecret: 'cs_test' }],
  ])('returns empty string for transient pre-interactive kind=%s', (_kind, state) => {
    expect(derivePayStateAnnouncement(state, t)).toBe('');
  });

  it('processing → translated processing.title', () => {
    expect(derivePayStateAnnouncement({ kind: 'processing' }, t)).toBe(
      'T:processing.title',
    );
  });

  it('requires-action → translated threeDSecure.title', () => {
    expect(
      derivePayStateAnnouncement(
        { kind: 'requires-action', clientSecret: 'cs_test' },
        t,
      ),
    ).toBe('T:threeDSecure.title');
  });

  it('success → translated success.title', () => {
    expect(
      derivePayStateAnnouncement(
        {
          kind: 'success',
          paymentIntentId: 'pi_test',
          method: 'card',
          receiptUrl: '/portal/invoices/inv_1/receipt',
        },
        t,
      ),
    ).toBe('T:success.title');
  });

  it('failure → translated retry.title concatenated with reason', () => {
    expect(
      derivePayStateAnnouncement(
        { kind: 'failure', reason: 'Card declined' },
        t,
      ),
    ).toBe('T:retry.title: Card declined');
  });
});
