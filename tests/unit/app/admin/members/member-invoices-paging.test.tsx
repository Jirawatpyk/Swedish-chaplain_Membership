/**
 * #765 — the member invoices card pages 20 at a time (`?invPage=`). Before,
 * it read the first 100 and showed no pager, so a member with more invoices
 * lost the rest silently while the header count said otherwise.
 *
 * - the section reads `pageSize: 20` at `offset: (page - 1) × 20`;
 * - a page past the end shows the last page, not an empty card;
 * - the pager shows only past 20 invoices, its links keep the card's filters,
 *   set `invPage` (dropped for page 1) and land on the card's heading;
 * - a filter change starts again at page 1 (covered in the filters test).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createFormatter, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Bangkok' }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members/m-1',
  useSearchParams: () => new URLSearchParams('invStatus=issued&invPage=2'),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const TOTAL = 67;
const calls: { pageSize: number; offset: number }[] = [];
function invoice(i: number) {
  return {
    invoiceId: `i-${i}`,
    status: 'issued',
    documentNumber: null,
    billDocumentNumberRaw: `SC-2026-${String(i).padStart(6, '0')}`,
    issueDate: '2026-09-15',
    dueDate: '2026-10-15',
    paidAt: null,
    total: { satang: 100000n },
    creditedTotal: null,
  };
}
vi.mock('@/modules/invoicing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/invoicing')>()),
  listInvoicesByMember: async (_deps: unknown, input: { pageSize: number; offset: number }) => {
    calls.push({ pageSize: input.pageSize, offset: input.offset });
    const rows = Array.from({ length: Math.max(0, Math.min(input.pageSize, TOTAL - input.offset)) }, (_, k) =>
      invoice(input.offset + k + 1),
    );
    return { ok: true, value: { rows, total: TOTAL } };
  },
  makeListInvoicesByMemberDeps: () => ({}),
}));

const { MemberInvoicesSection, MemberInvoicesCard, MEMBER_INVOICES_PAGE_SIZE } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-section'
);

const base = { tenant: { slug: 't1' } as never, memberId: 'm-1', role: 'admin' as const };
type CardEl = ReactElement<{ rows: unknown[]; page: number; total: number }>;

beforeEach(() => {
  calls.length = 0;
});

describe('member invoices card paging (#765)', () => {
  it('reads one page of 20 at the requested offset', async () => {
    expect(MEMBER_INVOICES_PAGE_SIZE).toBe(20);
    const el = (await MemberInvoicesSection({ ...base, page: 3 })) as CardEl;
    // The first call is the unfiltered count read (pageSize 1); the page read follows.
    expect(calls.at(-1)).toEqual({ pageSize: 20, offset: 40 });
    expect(el.props.rows).toHaveLength(20);
    expect(el.props.page).toBe(3);
    expect(el.props.total).toBe(67);
  });

  it('shows the last page for a page past the end', async () => {
    const el = (await MemberInvoicesSection({ ...base, page: 9 })) as CardEl;
    expect(calls.at(-1)).toEqual({ pageSize: 20, offset: 60 });
    expect(el.props.page).toBe(4);
    expect(el.props.rows).toHaveLength(7);
  });

  it('renders the pager past 20 invoices; links keep the filters, set invPage and land on the card', async () => {
    const el = (await MemberInvoicesSection({ ...base, page: 2 })) as CardEl;
    const card = (await MemberInvoicesCard({
      ...(el.props as unknown as Parameters<typeof MemberInvoicesCard>[0]),
    })) as ReactElement;
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {card}
      </NextIntlClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: enMessages.admin.members.invoices.pagination.label });
    const next = within(nav).getByRole('link', { name: /3/ });
    expect(next.getAttribute('href')).toBe('/admin/members/m-1?invStatus=issued&invPage=3#member-invoices-heading');
    const first = within(nav).getByRole('link', { name: /^1$|page 1/i });
    expect(first.getAttribute('href')).toBe('/admin/members/m-1?invStatus=issued#member-invoices-heading');
  });

  it('shows no pager at 20 invoices or fewer', async () => {
    const card = (await MemberInvoicesCard({
      memberId: 'm-1',
      total: 20,
      rows: [],
      canMutate: true,
      hasFilter: false,
      showFilters: false,
    })) as ReactElement;
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {card}
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('navigation', { name: enMessages.admin.members.invoices.pagination.label })).toBeNull();
  });
});
