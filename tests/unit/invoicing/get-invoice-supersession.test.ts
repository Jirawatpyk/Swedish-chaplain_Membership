/**
 * 121-void-supersede-links — `getInvoiceSupersession` branches.
 *
 * The live-Postgres proof (both directions, cross-tenant, member scope) is
 * `tests/integration/invoicing/invoice-supersession.test.ts`. This file pins
 * the use-case's own decisions against a fake port: which lookups run for
 * which status, the member-scope drop (and that it is logged, because a
 * supersede link across members is a data anomaly, not a normal miss), and
 * that a failed read is `read_failed`, never "no link".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warn, error } = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn, error, info: vi.fn(), debug: vi.fn() } }));

import { getInvoiceSupersession } from '@/modules/invoicing/application/use-cases/get-invoice-supersession';
import type {
  InvoiceSupersessionReadPort,
  SupersessionLinkRow,
} from '@/modules/invoicing/application/ports/invoice-supersession-port';

const TENANT = 'test-swecham';

function row(over: Partial<SupersessionLinkRow> = {}): SupersessionLinkRow {
  return {
    invoiceId: 'inv-new',
    displayNumber: 'SC-2026-000131',
    issueDate: '2026-09-24',
    memberId: 'member-1',
    status: 'issued',
    ...over,
  };
}

function fakePort(
  replacement: SupersessionLinkRow | null,
  replaced: readonly SupersessionLinkRow[] = [],
): InvoiceSupersessionReadPort & {
  findReplacement: ReturnType<typeof vi.fn>;
  findReplaced: ReturnType<typeof vi.fn>;
} {
  return {
    findReplacement: vi.fn(async () => replacement),
    findReplaced: vi.fn(async () => replaced),
  };
}

beforeEach(() => {
  warn.mockReset();
  error.mockReset();
});

describe('getInvoiceSupersession', () => {
  it('looks up the replacement only for a void invoice', async () => {
    const port = fakePort(row());
    const r = await getInvoiceSupersession(
      { supersession: port },
      { tenantId: TENANT, invoice: { invoiceId: 'inv-old', status: 'void', memberId: 'member-1' } },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        replacedBy: { invoiceId: 'inv-new', displayNumber: 'SC-2026-000131', issueDate: '2026-09-24' },
        replaces: [],
      },
    });
    expect(port.findReplacement).toHaveBeenCalledWith(TENANT, 'inv-old');

    const issued = fakePort(row());
    await getInvoiceSupersession(
      { supersession: issued },
      { tenantId: TENANT, invoice: { invoiceId: 'inv-x', status: 'issued', memberId: 'member-1' } },
    );
    expect(issued.findReplacement).not.toHaveBeenCalled();
    expect(issued.findReplaced).toHaveBeenCalledWith(TENANT, 'inv-x');
  });

  it('does not query anything for a draft', async () => {
    const port = fakePort(row(), [row()]);
    const r = await getInvoiceSupersession(
      { supersession: port },
      { tenantId: TENANT, invoice: { invoiceId: 'inv-d', status: 'draft', memberId: 'member-1' } },
    );
    expect(r).toEqual({ ok: true, value: { replacedBy: null, replaces: [] } });
    expect(port.findReplacement).not.toHaveBeenCalled();
    expect(port.findReplaced).not.toHaveBeenCalled();
  });

  it('never links to a draft, and falls back to the id when the other end has no number', async () => {
    const port = fakePort(null, [
      row({ invoiceId: 'inv-a', status: 'draft' }),
      row({ invoiceId: 'inv-b', displayNumber: null, status: 'void' }),
    ]);
    const r = await getInvoiceSupersession(
      { supersession: port },
      { tenantId: TENANT, invoice: { invoiceId: 'inv-new', status: 'paid', memberId: 'member-1' } },
    );
    expect(r.ok && r.value.replaces).toEqual([
      { invoiceId: 'inv-b', displayNumber: 'inv-b', issueDate: '2026-09-24' },
    ]);
  });

  it('member scope drops a link to another member’s invoice and logs the anomaly', async () => {
    const port = fakePort(row({ memberId: 'member-2' }), [
      row({ invoiceId: 'inv-mine' }),
      row({ invoiceId: 'inv-theirs', memberId: 'member-2' }),
    ]);
    const r = await getInvoiceSupersession(
      { supersession: port },
      {
        tenantId: TENANT,
        invoice: { invoiceId: 'inv-old', status: 'void', memberId: 'member-1' },
        restrictToMemberId: 'member-1',
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.replacedBy).toBeNull();
    expect(r.value.replaces.map((l) => l.invoiceId)).toEqual(['inv-mine']);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[1]).toMatch(/member mismatch/);
  });

  it('staff scope keeps a cross-member link', async () => {
    const port = fakePort(row({ memberId: 'member-2' }));
    const r = await getInvoiceSupersession(
      { supersession: port },
      { tenantId: TENANT, invoice: { invoiceId: 'inv-old', status: 'void', memberId: 'member-1' } },
    );
    expect(r.ok && r.value.replacedBy?.invoiceId).toBe('inv-new');
    expect(error).not.toHaveBeenCalled();
  });

  it('a failed read is read_failed, not "no link"', async () => {
    const port = fakePort(null);
    port.findReplacement.mockRejectedValueOnce(new Error('connection reset'));
    const r = await getInvoiceSupersession(
      { supersession: port },
      { tenantId: TENANT, invoice: { invoiceId: 'inv-old', status: 'void', memberId: 'member-1' } },
    );
    expect(r).toEqual({ ok: false, error: { code: 'read_failed' } });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
