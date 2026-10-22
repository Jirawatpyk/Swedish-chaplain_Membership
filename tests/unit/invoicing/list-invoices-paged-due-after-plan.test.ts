/**
 * Unit — 124 slice 1: `listInvoicesPagedSchema` gains `dueAfter` (inclusive
 * due-date lower bound) and `planId` (membership plan). The page validates
 * first; the schema is defence in depth for non-page callers.
 */
import { describe, it, expect, vi } from 'vitest';
import { listInvoicesPaged, listInvoicesPagedSchema } from '@/modules/invoicing';
import type { InvoiceRepo } from '@/modules/invoicing/application/ports/invoice-repo';

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

// The use case never parses the schema, so the use case itself must drop a
// non-calendar dueAfter (Postgres would raise 22008 on `due_date >= '2026-02-30'`).
describe('listInvoicesPaged — 124 dueAfter reaching the repo', () => {
  function run(dueAfter: string) {
    const listPaged = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const invoiceRepo = { listPaged } as unknown as InvoiceRepo;
    return listInvoicesPaged({ invoiceRepo }, {
      tenantId: 'acme',
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      dueAfter,
    }).then(() => listPaged.mock.calls[0]?.[1] as { dueAfter?: string });
  }

  it('passes a calendar date through', async () => {
    expect((await run('2026-01-01')).dueAfter).toBe('2026-01-01');
  });

  it('drops a non-calendar date instead of sending it to Postgres', async () => {
    expect((await run('2026-02-30')).dueAfter).toBeUndefined();
  });
});

