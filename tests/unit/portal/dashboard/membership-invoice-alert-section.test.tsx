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
