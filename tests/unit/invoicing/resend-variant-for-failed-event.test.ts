/**
 * B7 / FR-026 — `resendVariantForFailedEvent` maps a failed auto-email's event
 * type to the resend variant that recovers the SAME document. invoice_paid +
 * receipt_pdf_resent are receipt copies → 'receipt'; everything else → 'invoice'.
 * (@/lib/db is stubbed so importing the adapter module doesn't boot the DB.)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));

const { resendVariantForFailedEvent } = await import(
  '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter'
);

describe('resendVariantForFailedEvent (B7)', () => {
  it.each([
    ['invoice_paid', 'receipt'],
    ['receipt_pdf_resent', 'receipt'],
    ['invoice_issued', 'invoice'],
    ['invoice_voided', 'invoice'],
    ['credit_note_issued', 'invoice'],
    ['invoice_pdf_resent', 'invoice'],
  ] as const)('%s → %s', (eventType, expected) => {
    expect(resendVariantForFailedEvent(eventType)).toBe(expected);
  });

  it('null event type → invoice (safe default)', () => {
    expect(resendVariantForFailedEvent(null)).toBe('invoice');
  });
});
