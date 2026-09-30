/**
 * 122 US5b-1 (T556) — the member invoices section hands the table its money
 * in the board's form ("38,520.00 THB", `formatSatangThb`), the same form as
 * the figures strip above it, so one page never shows one amount two ways
 * (financial-integrity review L1). Remaining is still total − credited.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { createFormatter, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Bangkok' }),
}));

const invoice = {
  invoiceId: 'i-1',
  status: 'partially_credited',
  documentNumber: 'SC-2026-000123',
  billDocumentNumberRaw: null,
  issueDate: '2026-09-15',
  dueDate: '2026-10-15',
  paidAt: '2026-09-20T03:00:00.000Z',
  total: { satang: 3852000n },
  creditedTotal: { satang: 100000n },
};
let rows: Record<string, unknown>[] = [invoice];
vi.mock('@/modules/invoicing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/invoicing')>()),
  listInvoicesByMember: async () => ({ ok: true, value: { rows, total: rows.length } }),
  makeListInvoicesByMemberDeps: () => ({}),
}));

const { MemberInvoicesSection } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-section'
);

describe('MemberInvoicesSection money form (T556)', () => {
  it('Total and Remaining read as "<amount> THB", Remaining net of credits', async () => {
    const el = (await MemberInvoicesSection({
      tenant: { slug: 't1' } as never,
      memberId: 'm-1',
      role: 'admin',
    })) as ReactElement<{ rows: { total: string; remaining: string }[] }>;
    expect(el.props.rows[0]).toMatchObject({ total: '38,520.00 THB', remaining: '37,520.00 THB' });
  });

  // UX review (board): the h2 is "Invoices"; the count sits beside it, not
  // inside it (it read "Invoices 1 invoice").
  it('the card heading is the title alone; New invoice is the primary action', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { MemberInvoicesCard } = await import(
      '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-section'
    );
    render((await MemberInvoicesCard({ memberId: 'm-1', total: 3, rows: [], canMutate: true, hasFilter: false, showFilters: false })) as ReactElement);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Invoices$/);
    expect(screen.getByRole('link', { name: /New invoice/ })).toHaveClass('aura-btn--primary');
  });
});

// Financial-integrity review M1 — `issued` is the only unpaid state
// (`canTransition`: issued → paid | void; credit notes need paid), so only an
// issued row is owed, matching the figures strip's Outstanding.
describe('MemberInvoicesSection owing flag', () => {
  const owingFor = async (row: Record<string, unknown>): Promise<boolean> => {
    rows = [row];
    try {
      const el = (await MemberInvoicesSection({
        tenant: { slug: 't1' } as never,
        memberId: 'm-1',
        role: 'admin',
      })) as ReactElement<{ rows: { owing: boolean }[] }>;
      return el.props.rows[0]!.owing;
    } finally {
      rows = [invoice];
    }
  };
  const unpaid = { paidAt: null, creditedTotal: { satang: 0n } };

  it('a void bill is not owed', async () => {
    expect(await owingFor({ ...invoice, ...unpaid, status: 'void', total: { satang: 535000n } })).toBe(false);
  });

  it('a partially credited (paid) invoice is not owed', async () => {
    expect(await owingFor(invoice)).toBe(false);
  });

  it('a paid invoice is not owed', async () => {
    expect(await owingFor({ ...invoice, status: 'paid', creditedTotal: { satang: 0n } })).toBe(false);
  });

  it('an issued invoice is owed', async () => {
    expect(await owingFor({ ...invoice, ...unpaid, status: 'issued' })).toBe(true);
  });
});
