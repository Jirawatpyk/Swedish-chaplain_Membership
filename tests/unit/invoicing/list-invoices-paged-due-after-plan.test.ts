/**
 * Unit — 124 slice 1: `listInvoicesPagedSchema` gains `dueAfter` (inclusive
 * due-date lower bound) and `planId` (membership plan). The page validates
 * first; the schema is defence in depth for non-page callers.
 */
import { describe, it, expect } from 'vitest';
import { listInvoicesPagedSchema } from '@/modules/invoicing';

describe('listInvoicesPagedSchema — 124 dueAfter + planId', () => {
  const base = { tenantId: 'acme' } as const;

  it('parses dueAfter as YYYY-MM-DD and planId as a plan id', () => {
    const parsed = listInvoicesPagedSchema.parse({
      ...base,
      dueAfter: '2026-01-01',
      planId: 'corporate-gold',
    });
    expect(parsed.dueAfter).toBe('2026-01-01');
    expect(parsed.planId).toBe('corporate-gold');
  });

  it('rejects a malformed dueAfter', () => {
    expect(listInvoicesPagedSchema.safeParse({ ...base, dueAfter: '1/1/2026' }).success).toBe(false);
    expect(listInvoicesPagedSchema.safeParse({ ...base, dueAfter: '2026-02-30' }).success).toBe(false);
  });

  it('rejects an empty or over-long planId', () => {
    expect(listInvoicesPagedSchema.safeParse({ ...base, planId: '' }).success).toBe(false);
    expect(listInvoicesPagedSchema.safeParse({ ...base, planId: 'x'.repeat(65) }).success).toBe(false);
  });

  it('keeps both optional (absent ⇒ undefined)', () => {
    const parsed = listInvoicesPagedSchema.parse(base);
    expect(parsed.dueAfter).toBeUndefined();
    expect(parsed.planId).toBeUndefined();
  });
});
