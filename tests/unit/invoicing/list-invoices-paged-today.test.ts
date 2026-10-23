/**
 * Unit — spec 124 follow-up: `listInvoicesPaged` takes `today`, the request's
 * Bangkok date, so the Overdue filter and the row badges read one clock. The
 * use case never parses the schema, so it drops a non-calendar value itself
 * (the repo then keeps its database-clock cut-off).
 */
import { describe, it, expect, vi } from 'vitest';
import { listInvoicesPaged, listInvoicesPagedSchema } from '@/modules/invoicing';
import type { InvoiceRepo } from '@/modules/invoicing/application/ports/invoice-repo';

describe('listInvoicesPagedSchema — today', () => {
  const base = { tenantId: 'acme' } as const;

  it('parses a calendar date and stays optional', () => {
    expect(listInvoicesPagedSchema.parse({ ...base, today: '2026-06-30' }).today).toBe('2026-06-30');
    expect(listInvoicesPagedSchema.parse(base).today).toBeUndefined();
  });

  it('rejects a malformed or impossible date', () => {
    expect(listInvoicesPagedSchema.safeParse({ ...base, today: '30/06/2026' }).success).toBe(false);
    expect(listInvoicesPagedSchema.safeParse({ ...base, today: '2026-02-30' }).success).toBe(false);
  });
});

describe('listInvoicesPaged — today reaching the repo', () => {
  async function run(today: string) {
    const listPaged = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const invoiceRepo = { listPaged } as unknown as InvoiceRepo;
    await listInvoicesPaged({ invoiceRepo }, {
      tenantId: 'acme',
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      status: 'overdue',
      today,
    });
    return listPaged.mock.calls[0]?.[1] as { today?: string };
  }

  it('passes a calendar date through', async () => {
    expect((await run('2026-06-30')).today).toBe('2026-06-30');
  });

  it('drops a non-calendar date instead of sending it to Postgres', async () => {
    expect((await run('2026-02-30')).today).toBeUndefined();
  });
});
