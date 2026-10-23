/**
 * 124 slice 3 — the dashboard cards render what the loaders hand them:
 *   - aging rows are links named "{bucket}: {amount}, {count} invoices" to
 *     the bucket's own list query; empty buckets are not links; a non-zero
 *     share under 1% reads `<1%` (US1.3, US2.2);
 *   - Needs attention hides zero rows (D-n), has no draft rows without
 *     `invoicing.write` (US4), says "under these filters" when filtered;
 *   - Oldest overdue offers Record payment only when allowed, and focus
 *     after a payment goes to the next row's button or the footer link;
 *   - a failed card shows its reference id and Try again (US5.3); a filter
 *     that matches nothing shows the card's own "No invoices match" (US3.5);
 *   - the trend's sr-only table reads every month, "Not yet" for months to
 *     come, and the caption starts with the FY label (US3.3).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/finance',
  useSearchParams: () => new URLSearchParams(),
}));
// The dialog is its own tested component; here only its trigger matters.
vi.mock('@/app/(staff)/admin/invoices/_components/record-payment-dialog', () => ({
  RecordPaymentDialog: (p: { triggerId: string; triggerAriaLabel: string; finalFocusFallbackId: string }) => (
    <button type="button" id={p.triggerId} aria-label={p.triggerAriaLabel} data-fallback={p.finalFocusFallbackId}>
      pay
    </button>
  ),
}));

import { AgingCard } from '@/app/(staff)/admin/finance/_components/aging-card';
import { AttentionCard } from '@/app/(staff)/admin/finance/_components/attention-card';
import { OldestOverdueCard } from '@/app/(staff)/admin/finance/_components/oldest-overdue-card';
import { MethodsCard } from '@/app/(staff)/admin/finance/_components/methods-card';
import { TrendCard } from '@/app/(staff)/admin/finance/_components/trend-card';

const D = enMessages.admin.invoiceDashboard;

function mount(tree: unknown) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

const ok = <T,>(value: T) => ({ ok: true as const, value });
const failed = { ok: false as const, error: { code: 'query_failed' as const, referenceId: '7f3a-91c2' } };

function agingRow(
  bucket: 'not_yet_due' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'over_90',
  amountSatang: bigint,
  count: number,
  sharePercent: number,
) {
  return {
    bucket,
    amountSatang,
    count,
    sharePercent,
    listQuery:
      bucket === 'not_yet_due'
        ? { status: 'issued' as const, dueAfter: '2026-10-19', subject: 'membership' as const }
        : { status: 'overdue' as const, dueAfter: '2026-09-19', dueBefore: '2026-10-19', subject: 'membership' as const },
  };
}

describe('AgingCard', () => {
  const aging = {
    totalSatang: 100_000_000n + 50_000n,
    count: 4,
    buckets: [
      agingRow('not_yet_due', 100_000_000n, 3, 100),
      agingRow('days_1_30', 50_000n, 1, 0),
      agingRow('days_31_60', 0n, 0, 0),
      agingRow('days_61_90', 0n, 0, 0),
      agingRow('over_90', 0n, 0, 0),
    ],
  };

  it('each bucket with invoices is one link to its own list query, named for its amount and count', async () => {
    mount(await AgingCard({ result: ok(aging), filtered: true }));
    const link = screen.getByRole('link', { name: '1–30 days: 500.00 THB, 1 invoice' });
    expect(link).toHaveAttribute(
      'href',
      '/admin/invoices?status=overdue&dueAfter=2026-09-19&dueBefore=2026-10-19&subject=membership',
    );
    expect(screen.getByRole('link', { name: /^Not yet due: 1,000,000\.00 THB, 3 invoices$/ })).toHaveAttribute(
      'href',
      '/admin/invoices?status=issued&dueAfter=2026-10-19&subject=membership',
    );
  });

  it('an empty bucket is not a link; a real amount under 1% reads <1%', async () => {
    mount(await AgingCard({ result: ok(aging), filtered: false }));
    const rows = within(screen.getByTestId('aging-rows')).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[2]!).queryByRole('link')).toBeNull();
    expect(rows[1]).toHaveTextContent('1 · <1%');
  });

  it('filtered to nothing: the card’s own “No invoices match”', async () => {
    const none = { totalSatang: 0n, count: 0, buckets: aging.buckets.map((b) => ({ ...b, amountSatang: 0n, count: 0, sharePercent: 0 })) };
    mount(await AgingCard({ result: ok(none), filtered: true }));
    expect(screen.getByTestId('dashboard-no-match')).toHaveTextContent(D.states.noMatch);
  });

  it('a failed read shows the reference id and Try again', async () => {
    mount(await AgingCard({ result: failed, filtered: false }));
    const error = screen.getByTestId('dashboard-card-error');
    expect(error).toHaveTextContent('7f3a-91c2');
    expect(within(error).getByRole('button', { name: D.states.tryAgain })).toBeInTheDocument();
  });
});

describe('AttentionCard', () => {
  const listFilters = { subject: 'membership' as const };

  it('hides zero rows; the draft rows open the list’s draft views under the filters', async () => {
    mount(
      await AttentionCard({
        result: ok({
          receiptPdfFailed: 0,
          refundsFailedAtStripe: 1,
          refundsPendingOverThreshold: 0,
          drafts: { manual: 3, autoRenewal: 0 },
        }),
        filtered: true,
        listFilters,
        linkDrafts: true,
      }),
    );
    const rows = within(screen.getByTestId('attention-rows')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-attention'))).toEqual(['manualDrafts', 'refundsFailedAtStripe']);
    expect(screen.getByRole('link', { name: `${D.attention.manualDrafts}: 3` })).toHaveAttribute(
      'href',
      '/admin/invoices?status=draft&subject=membership&origin=manual',
    );
    // No list exists for a refund: a plain row.
    expect(within(rows[1]!).queryByRole('link')).toBeNull();
    expect(screen.getByText(D.attention.underFilters)).toBeInTheDocument();
  });

  it('with auto-invoice off the list ignores origin, so the draft rows are not links', async () => {
    mount(
      await AttentionCard({
        result: ok({
          receiptPdfFailed: 0,
          refundsFailedAtStripe: 0,
          refundsPendingOverThreshold: 0,
          drafts: { manual: 2, autoRenewal: 1 },
        }),
        filtered: false,
        listFilters: {},
        linkDrafts: false,
      }),
    );
    expect(screen.getByText(D.attention.manualDrafts)).toBeInTheDocument();
    expect(within(screen.getByTestId('attention-rows')).queryByRole('link')).toBeNull();
  });

  it('without write access the draft rows are absent from the HTML', async () => {
    const { container } = mount(
      await AttentionCard({
        result: ok({ receiptPdfFailed: 2, refundsFailedAtStripe: 0, refundsPendingOverThreshold: 1 }),
        filtered: false,
        listFilters: {},
        linkDrafts: true,
      }),
    );
    expect(container.innerHTML).not.toContain(D.attention.manualDrafts);
    expect(container.innerHTML).not.toContain(D.attention.autoRenewalDrafts);
    expect(screen.getByText(D.attention.refundsPendingOverThreshold)).toBeInTheDocument();
  });

  it('all zero: one line, filtered or not', async () => {
    const zeros = { receiptPdfFailed: 0, refundsFailedAtStripe: 0, refundsPendingOverThreshold: 0 };
    const { unmount } = mount(await AttentionCard({ result: ok(zeros), filtered: false, listFilters: {}, linkDrafts: true }));
    expect(screen.getByTestId('attention-nothing')).toHaveTextContent(D.attention.nothing);
    unmount();
    mount(await AttentionCard({ result: ok(zeros), filtered: true, listFilters, linkDrafts: true }));
    expect(screen.getByTestId('attention-nothing')).toHaveTextContent(D.attention.nothingFiltered);
  });
});

describe('OldestOverdueCard', () => {
  const rows = [
    { invoiceId: 'inv-a', documentNumber: 'SC-000071', buyerName: 'Nordic Freight', dueDate: '2026-06-12', daysPastDue: 129, amountSatang: 2_996_000n },
    { invoiceId: 'inv-b', documentNumber: 'SC-000088', buyerName: 'Siam Nordic', dueDate: '2026-07-01', daysPastDue: 110, amountSatang: 1_070_000n },
  ];
  const base = { overdueCount: 9, filtered: false, listFilters: {}, locale: 'en', today: '2026-10-19' };

  it('an admin gets Record payment per row; focus after a payment goes to the next row, from the last to the card title', async () => {
    mount(await OldestOverdueCard({ ...base, result: ok({ rows, canRecordPayment: true }) }));
    const first = screen.getByRole('button', { name: 'Record payment for SC-000071' });
    const second = screen.getByRole('button', { name: 'Record payment for SC-000088' });
    expect(first).toHaveAttribute('data-fallback', second.id);
    expect(second).toHaveAttribute('data-fallback', 'oldest-overdue-title');
    // The title is a focus target in every state of the card.
    expect(document.getElementById('oldest-overdue-title')).toHaveAttribute('tabindex', '-1');
    // the document number is a text link with AURA's touch rule (#172)
    expect(screen.getAllByRole('link', { name: 'SC-000071' })[0]).toHaveClass('aura-link', 'aura-link--touch');
    expect(screen.getByRole('link', { name: D.oldest.allOverdue.replace('{count}', '9') })).toHaveAttribute(
      'href',
      '/admin/invoices?status=overdue',
    );
  });

  it('the third row’s next row is hidden on a phone, so focus goes to the title; the title survives an emptied list', async () => {
    const four = [0, 1, 2, 3].map((i) => ({ ...rows[0]!, invoiceId: `inv-${i}`, documentNumber: `SC-00010${i}` }));
    const { unmount } = mount(await OldestOverdueCard({ ...base, result: ok({ rows: four, canRecordPayment: true }) }));
    expect(screen.getByRole('button', { name: 'Record payment for SC-000101' })).toHaveAttribute('data-fallback', 'oldest-overdue-pay-inv-2');
    expect(screen.getByRole('button', { name: 'Record payment for SC-000102' })).toHaveAttribute('data-fallback', 'oldest-overdue-title');
    unmount();
    mount(await OldestOverdueCard({ ...base, result: ok({ rows: [], canRecordPayment: true }) }));
    expect(document.getElementById('oldest-overdue-title')).toBeInTheDocument();
  });

  it('with the tiles failed the footer link carries no count (six rows are not the total)', async () => {
    mount(await OldestOverdueCard({ ...base, overdueCount: null, result: ok({ rows, canRecordPayment: false }) }));
    expect(screen.getByRole('link', { name: D.oldest.allOverdueNoCount })).toBeInTheDocument();
  });

  it('a manager sees the rows with no Record payment and no Actions column', async () => {
    const { container } = mount(await OldestOverdueCard({ ...base, result: ok({ rows, canRecordPayment: false }) }));
    expect(screen.getAllByTestId('oldest-overdue-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Record payment/ })).toBeNull();
    expect(container.innerHTML).not.toContain(D.oldest.actions);
  });
});

describe('MethodsCard', () => {
  it('six rows with shares of the positive total; the caption starts with the FY label', async () => {
    mount(
      await MethodsCard({
        result: ok({
          range: { from: '2026-01-01', to: '2026-10-19' },
          toDate: true,
          totalSatang: 100_000_00n,
          rows: [
            { method: 'bank_transfer', amountSatang: 99_950_00n, sharePercent: 100 },
            { method: 'promptpay', amountSatang: 50_00n, sharePercent: 0 },
            { method: 'card', amountSatang: 0n, sharePercent: 0 },
            { method: 'cheque', amountSatang: 0n, sharePercent: 0 },
            { method: 'cash', amountSatang: 0n, sharePercent: 0 },
            { method: 'other', amountSatang: 0n, sharePercent: 0 },
          ],
        }),
        filtered: false,
        fiscalYearShort: 'FY 2026',
      }),
    );
    const rows = within(screen.getByTestId('method-rows')).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(rows[1]).toHaveTextContent('PromptPay');
    expect(rows[1]).toHaveTextContent('<1%');
    expect(rows[2]).toHaveTextContent('0%');
    expect(screen.getByText('FY 2026 to date · by payment date')).toBeInTheDocument();
  });
});

describe('TrendCard', () => {
  it('reads every month in its sr-only table, months to come as Not yet, Billed and Collected named', async () => {
    const slot = (m: string, state: 'past' | 'current' | 'future', billed: bigint | null, collected: bigint | null) => ({
      monthKey: `2026-${m}`,
      from: `2026-${m}-01`,
      to: `2026-${m}-28`,
      state,
      billedSatang: billed,
      collectedSatang: collected,
    });
    mount(
      await TrendCard({
        result: ok({
          range: { from: '2026-01-01', to: '2026-12-31' },
          collectedRange: { from: '2026-01-01', to: '2026-10-19' },
          toDate: true,
          slots: [slot('09', 'past', 100_00n, 50_00n), slot('10', 'current', 20_00n, 10_00n), slot('11', 'future', null, null)],
        }),
        locale: 'en',
        fiscalYearShort: 'FY 2026',
        filtered: false,
      }),
    );
    expect(screen.getByRole('heading', { level: 2, name: D.trend.title })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: D.trend.tableCaption });
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows.map((r) => r.textContent)).toEqual([
      'September 2026100.00 THB50.00 THB',
      'October 202620.00 THB10.00 THB',
      `November 2026${D.trend.notYet}${D.trend.notYet}`,
    ]);
    expect(screen.getByTestId('trend-total-billed')).toHaveTextContent('120.00 THB');
    expect(screen.getByText(/^FY 2026 by month · billed by issue date, voided invoices left out/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/revenue|net of credit notes/i);
  });

  it('filtered to nothing: the card’s own “No invoices match”, no zero bars', async () => {
    mount(
      await TrendCard({
        result: ok({
          range: { from: '2026-01-01', to: '2026-12-31' },
          collectedRange: { from: '2026-01-01', to: '2026-10-19' },
          toDate: true,
          slots: [{ monthKey: '2026-10', from: '2026-10-01', to: '2026-10-31', state: 'current' as const, billedSatang: 0n, collectedSatang: 0n }],
        }),
        locale: 'en',
        fiscalYearShort: 'FY 2026',
        filtered: true,
      }),
    );
    expect(screen.getByTestId('dashboard-no-match')).toHaveTextContent(D.states.noMatch);
    expect(screen.queryByRole('table')).toBeNull();
  });
});
