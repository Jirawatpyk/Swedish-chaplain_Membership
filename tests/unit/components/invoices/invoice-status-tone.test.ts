/**
 * Spec 122 US8 (T801) — one invoice status tone map for every invoice list:
 * the portal list, the member invoices table and the admin list and detail
 * (spec Clarifications, Session 2026-10-02).
 */
import { describe, expect, it } from 'vitest';
import { invoiceStatusTone } from '@/components/invoices/invoice-status-tone';

describe('invoiceStatusTone', () => {
  it.each([
    ['paid', 'ready'],
    ['issued', 'progress'],
    ['overdue', 'blocked'],
    ['draft', 'neutral'],
    ['void', 'neutral'],
    ['credited', 'neutral'],
    ['partially_credited', 'neutral'],
  ] as const)('%s → %s', (status, tone) => {
    expect(invoiceStatusTone(status)).toBe(tone);
  });

  it('renders a status outside the union neutral, never the raw value', () => {
    expect(invoiceStatusTone('refunded' as never)).toBe('neutral');
  });
});
