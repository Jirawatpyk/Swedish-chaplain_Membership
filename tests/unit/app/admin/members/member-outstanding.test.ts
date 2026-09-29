/**
 * 122 US5b-1 (T552) — the figures strip's Outstanding comes from the existing
 * member invoice read (Clarifications, Session 2026-09-29): issued invoices
 * only (the one unpaid state — a credit note follows payment), up to 100,
 * summed. More than 100 is reported as partial; a failed read is
 * "unavailable", never zero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listInvoicesByMember = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  listInvoicesByMember: (...args: unknown[]) => listInvoicesByMember(...args),
  makeListInvoicesByMemberDeps: () => ({}),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { loadMemberOutstanding } = await import(
  '@/app/(staff)/admin/members/[memberId]/_lib/member-outstanding'
);

const inv = (total: bigint, dueDate: string | null) => ({ total: { satang: total }, dueDate });

beforeEach(() => listInvoicesByMember.mockReset());

describe('loadMemberOutstanding (T552)', () => {
  it('asks for issued invoices only, up to 100', async () => {
    listInvoicesByMember.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
    await loadMemberOutstanding('t1', 'm-1');
    expect(listInvoicesByMember).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 't1',
      memberId: 'm-1',
      status: 'issued',
      pageSize: 100,
      offset: 0,
    });
  });

  it('sums the totals, counts them and finds the earliest due date', async () => {
    listInvoicesByMember.mockResolvedValue({
      ok: true,
      value: { rows: [inv(3852000n, '2026-10-15'), inv(214000n, '2026-09-30'), inv(100n, null)], total: 3 },
    });
    await expect(loadMemberOutstanding('t1', 'm-2')).resolves.toEqual({
      state: 'ok',
      sumSatang: 4066100n,
      count: 3,
      earliestDueIso: '2026-09-30',
      partial: false,
    });
  });

  it('reports partial when more unpaid invoices exist than it read', async () => {
    listInvoicesByMember.mockResolvedValue({ ok: true, value: { rows: [inv(100n, '2026-10-01')], total: 101 } });
    const r = await loadMemberOutstanding('t1', 'm-3');
    expect(r).toMatchObject({ state: 'ok', count: 101, partial: true });
  });

  it('a failed or thrown read is unavailable', async () => {
    listInvoicesByMember.mockResolvedValueOnce({ ok: false, error: { type: 'repo_error' } });
    await expect(loadMemberOutstanding('t1', 'm-4')).resolves.toEqual({ state: 'unavailable' });
    listInvoicesByMember.mockRejectedValueOnce(new Error('boom'));
    await expect(loadMemberOutstanding('t1', 'm-5')).resolves.toEqual({ state: 'unavailable' });
  });
});
