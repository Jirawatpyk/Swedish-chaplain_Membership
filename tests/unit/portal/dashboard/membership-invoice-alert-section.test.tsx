/**
 * R9 (local verify of PR #435) — a lapsed member was offered "Pay now" on the
 * home alert and the pay sheet then refused them ("Your membership has been
 * terminated"). The alert now asks the same scope rule the portal gate uses
 * (`isPortalPathAllowed`, via the request-cached `loadMembershipAccess`, which
 * writes no audit row): a terminated member can still open the invoice but
 * cannot start an online payment, so the alert links to the invoice and does
 * not promise one. A suspended member (unpaid) keeps Pay now.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { FIXED_NOW } from '../../../helpers/fixed-now';

const access = vi.fn();
vi.mock('@/lib/load-membership-access', () => ({ loadMembershipAccess: (...a: unknown[]) => access(...a) }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en' }));
vi.mock('@/app/(member)/portal/_components/dashboard-reads', () => ({
  loadDashboardOutstanding: async () => ({
    error: false,
    total: 1,
    partial: false,
    inputs: [{ status: 'issued', totalSatang: 535_000n, dueDate: '2026-05-15', id: 'inv-9', invoiceSubject: 'membership', documentNumber: 'SC-2026-900003' }],
  }),
  loadDashboardOnlineMethods: async () => 'both',
}));

import { MembershipInvoiceAlertSection } from '@/app/(member)/portal/_components/membership-invoice-alert-section';

async function show() {
  const el = await MembershipInvoiceAlertSection({ tenantId: 't', memberId: 'm' });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {el}
    </NextIntlClientProvider>,
  );
}

describe('<MembershipInvoiceAlertSection> membership access', () => {
  afterEach(cleanup);

  it('a terminated member gets View invoice, never Pay now', async () => {
    access.mockResolvedValue({ access: 'terminated', reason: 'lapsed' });
    await show();
    expect(screen.queryByRole('link', { name: /Pay now/ })).toBeNull();
    expect(screen.getByRole('link', { name: /View invoice/ })).toHaveAttribute('href', '/portal/invoices/inv-9');
    expect(screen.queryByText(/Pay online/)).toBeNull();
  });

  it('a suspended (unpaid) member keeps Pay now', async () => {
    access.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    await show();
    expect(screen.getByRole('link', { name: /Pay now/ })).toHaveAttribute('href', '/portal/invoices/inv-9?pay=1');
  });

  it('a member in good standing keeps Pay now', async () => {
    access.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    await show();
    expect(screen.getByRole('link', { name: /Pay now/ })).toBeInTheDocument();
  });
});

// Spec 124 follow-up — on /portal/invoices the alert reads the page's own
// Bangkok date (the one the list's Overdue filter and row badges use), so
// across midnight it never calls a bill overdue above a list that does not.
describe('<MembershipInvoiceAlertSection> today', () => {
  // tests/setup.ts pins the clock at 2026-04-09, before the bill's due date.
  afterEach(() => {
    cleanup();
    vi.setSystemTime(FIXED_NOW);
  });

  async function showOn(today: string) {
    access.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    const el = await MembershipInvoiceAlertSection({ tenantId: 't', memberId: 'm', today });
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {el}
      </NextIntlClientProvider>,
    );
  }

  it('the day after the due date is overdue, though the server clock is earlier', async () => {
    await showOn('2026-05-16');
    expect(screen.getByText(/was due/)).toBeInTheDocument();
  });

  it('on the due date it is not, whatever the server clock says', async () => {
    vi.setSystemTime(new Date('2026-06-30T05:00:00Z'));
    await showOn('2026-05-15');
    expect(screen.queryByText(/was due/)).toBeNull();
    expect(screen.getByText(/ due /)).toBeInTheDocument();
  });
});
