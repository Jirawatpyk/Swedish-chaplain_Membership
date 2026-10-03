/**
 * Spec 122 US8c (T845) — the credit-note detail on AURA, board
 * `Admin-credit-note-detail`, in one view the page and the no-DB preview both
 * render: "Credit note {CN-…}" (the Refund chip when a refund issued it, no
 * "Issued" badge), Resend email and Download PDF as header buttons, a Details
 * card with the amounts at its end, then Reason and Parties cards. Amounts
 * keep the `en-US` grouping and " THB" suffix used on main.
 *
 * The resend button keeps the request, toasts and 5-minute re-enable the ⋯
 * menu had.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('@/components/members/no-primary-contact-banner', () => ({
  NoPrimaryContactBanner: () => <div role="alert">no-primary-contact</div>,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));

const { renderCreditNoteDetailView } = await import(
  '@/app/(staff)/admin/credit-notes/_components/credit-note-detail-view'
);
const { CreditNoteActions } = await import('@/app/(staff)/admin/credit-notes/_components/credit-note-actions');
type ViewProps = Parameters<typeof renderCreditNoteDetailView>[0];

const detail = en.admin.creditNotes.detail;

function props(over: Partial<ViewProps> = {}): ViewProps {
  return {
    creditNoteId: 'cn-14',
    documentNumber: 'CN-2026-000014',
    isRefund: false,
    issueDate: '2026-09-23',
    issuerLabel: 'malin.berg@swecham.example',
    memberId: 'm-1',
    memberName: 'Siam Nordic Trading Co., Ltd.',
    originalDocuments: { receiptNumberRaw: 'RC-2026-000038', related: { kind: 'bill', numberRaw: 'SC-2026-000102' } },
    invoiceHref: '/admin/invoices/inv-1',
    creditAmountSatang: 1_000_000n,
    vatSatang: 70_000n,
    totalSatang: 1_070_000n,
    reason: 'Charged the Premium rate; difference credited.',
    siblings: [],
    noPrimaryContact: false,
    issuer: {
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thai-Swedish Chamber of Commerce',
      taxId: '0993000555121',
      addressTh: 'ชั้น 14 ถนนวิทยุ',
      addressEn: '14th floor, Wireless Road',
    },
    customer: {
      legalName: 'Siam Nordic Trading Co., Ltd.',
      taxId: '0105557004563',
      address: '98 Sathorn Road',
      contactEmail: 'erik@siamnordic.example',
    },
    ...over,
  };
}

async function renderView(over: Partial<ViewProps> = {}) {
  const el = (await renderCreditNoteDetailView(props(over))) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      {el}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  toast.warning.mockClear();
});

describe('renderCreditNoteDetailView', () => {
  it('heads the page "Credit note {number}" with no Issued badge', async () => {
    await renderView();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('Credit note CN-2026-000014');
    expect(screen.queryByText(detail.status.issued)).toBeNull();
  });

  it('shows the Refund chip when a refund issued it', async () => {
    await renderView({ isRefund: true });
    expect(screen.getByText(en.shared.creditNoteOriginal.refund)).toBeInTheDocument();
  });

  it('offers Resend email and Download PDF as header buttons, the PDF from the same URL', async () => {
    await renderView();
    expect(screen.getByRole('button', { name: detail.actions.resendAria.replace('{number}', 'CN-2026-000014') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: detail.actions.download })).toHaveAttribute('href', '/api/credit-notes/cn-14/pdf');
    expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull();
  });

  it('puts the fields and the amounts in a Details card, formatted as on main', async () => {
    await renderView();
    const details = screen.getByRole('region', { name: detail.sections.details });
    expect(within(details).getByRole('link', { name: 'Siam Nordic Trading Co., Ltd.' })).toHaveAttribute('href', '/admin/members/m-1');
    expect(within(details).getByText('malin.berg@swecham.example')).toBeInTheDocument();
    expect(within(details).getByText('RC-2026-000038')).toBeInTheDocument();
    expect(within(details).getByText('10,000.00 THB')).toBeInTheDocument();
    expect(within(details).getByText('700.00 THB')).toBeInTheDocument();
    expect(within(details).getByText('10,700.00 THB')).toBeInTheDocument();
  });

  it('names a non-member buyer as plain text', async () => {
    await renderView({ memberId: null, memberName: 'Walk-in Buyer' });
    const details = screen.getByRole('region', { name: detail.sections.details });
    expect(within(details).queryByRole('link', { name: 'Walk-in Buyer' })).toBeNull();
    expect(within(details).getByText('Walk-in Buyer')).toBeInTheDocument();
  });

  it('gives the reason and the parties their own cards, and says where a resend goes', async () => {
    await renderView();
    expect(within(screen.getByRole('region', { name: detail.reason.heading })).getByText(/difference credited/)).toBeInTheDocument();
    const parties = screen.getByRole('region', { name: detail.sections.parties });
    expect(within(parties).getByText('0105557004563')).toBeInTheDocument();
    expect(within(parties).getByText(detail.parties.resendNote)).toBeInTheDocument();
  });

  it('keeps the sibling credit notes and the no-primary-contact banner', async () => {
    await renderView({ siblings: [{ creditNoteId: 'cn-15', documentNumber: 'CN-2026-000015' }], noPrimaryContact: true });
    expect(screen.getByRole('link', { name: detail.siblings.viewLabel.replace('{number}', 'CN-2026-000015') })).toHaveAttribute(
      'href',
      '/admin/credit-notes/cn-15',
    );
    expect(screen.getByText('no-primary-contact')).toBeInTheDocument();
  });
});

describe('<CreditNoteActions> resend', () => {
  function renderActions() {
    return render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
        <CreditNoteActions creditNoteId="cn-14" documentNumber="CN-2026-000014" />
      </NextIntlClientProvider>,
    );
  }
  const resend = () => screen.getByRole('button', { name: detail.actions.resendAria.replace('{number}', 'CN-2026-000014') });

  it('POSTs the same request as before and re-enables after 5 minutes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipientEmail: 'a@b.example' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    renderActions();
    fireEvent.click(resend());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/credit-notes/cn-14/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resend()).toBeDisabled();
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(resend()).not.toBeDisabled();
    vi.unstubAllGlobals();
  });

  it('routes a 409 no_recipient to its own toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'no_recipient' } }), { status: 409 })),
    );
    renderActions();
    fireEvent.click(resend());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(detail.toast.resendNoRecipient));
    vi.unstubAllGlobals();
  });

  it('warns on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    renderActions();
    fireEvent.click(resend());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(detail.toast.resendRateLimited));
    vi.unstubAllGlobals();
  });
});
