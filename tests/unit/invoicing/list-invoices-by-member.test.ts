/**
 * Unit tests for `listInvoicesByMember` — US7.
 *
 * Thin wrapper over `invoiceRepo.listPaged`; the tests cover the
 * default-status branch + repo-error wrapping so the 80% branch
 * threshold is met without depending on the DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { listInvoicesByMember } from '@/modules/invoicing';
import type { InvoiceRepo } from '@/modules/invoicing/application/ports/invoice-repo';

function mockRepo(
  override: Partial<InvoiceRepo> = {},
): InvoiceRepo {
  const base: Partial<InvoiceRepo> = {
    listPaged: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
  };
  return { ...base, ...override } as InvoiceRepo;
}

const TENANT = 'test-swecham-abcd1234';
const MEMBER = '00000000-0000-4000-8000-000000000001';

describe('listInvoicesByMember', () => {
  it('omitting status passes "all" + includeDrafts: true to the repo', async () => {
    const listPaged = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const repo = mockRepo({ listPaged });
    const result = await listInvoicesByMember(
      { invoiceRepo: repo },
      {
        tenantId: TENANT,
        memberId: MEMBER,
        pageSize: 100,
        offset: 0,
      },
    );
    expect(result.ok).toBe(true);
    expect(listPaged).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({
        memberId: MEMBER,
        status: 'all',
        includeDrafts: true,
        offset: 0,
        pageSize: 100,
      }),
    );
  });

  it('passes status through when caller supplies one', async () => {
    const listPaged = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const repo = mockRepo({ listPaged });
    await listInvoicesByMember(
      { invoiceRepo: repo },
      {
        tenantId: TENANT,
        memberId: MEMBER,
        pageSize: 50,
        offset: 10,
        status: 'paid',
      },
    );
    expect(listPaged).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ status: 'paid', offset: 10, pageSize: 50 }),
    );
  });

  it('wraps a thrown repo error into Result.err with repo_error type', async () => {
    const boom = new Error('connection lost');
    const repo = mockRepo({
      listPaged: vi.fn().mockRejectedValue(boom),
    });
    const result = await listInvoicesByMember(
      { invoiceRepo: repo },
      { tenantId: TENANT, memberId: MEMBER, pageSize: 100, offset: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('repo_error');
      expect(result.error.cause).toBe(boom);
    }
  });
});
