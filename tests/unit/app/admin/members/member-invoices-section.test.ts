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
vi.mock('@/modules/invoicing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/invoicing')>()),
  listInvoicesByMember: async () => ({ ok: true, value: { rows: [invoice], total: 1 } }),
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
});
