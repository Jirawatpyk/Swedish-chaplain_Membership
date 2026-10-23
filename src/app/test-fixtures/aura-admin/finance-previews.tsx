/**
 * 124 — the invoice dashboard in the no-DB preview route, drawn through the
 * page's own `renderInvoiceDashboardView` from fixtures shaped like the
 * `Admin-finance*` boards (amounts incl. VAT, satang). States:
 *   default | events | manager | card-error | empty
 * (`?view=finance&state=…`; the loading board is `?view=loading&state=finance`).
 * The figures are invented; no real member is named.
 */
import { getLocale } from 'next-intl/server';
import {
  fiscalYearDateRange,
  type AgingBucket,
  type InvoiceDashboardAging,
  type InvoiceDashboardAttention,
  type InvoiceDashboardLoadInput,
  type InvoiceDashboardMethods,
  type InvoiceDashboardOldestOverdue,
  type InvoiceDashboardResult,
  type InvoiceDashboardTiles,
  type InvoiceDashboardTrend,
} from '@/modules/insights';
import { renderInvoiceDashboardView } from '@/app/(staff)/admin/finance/_components/invoice-dashboard-view';

const TODAY = '2026-10-19';
const NOW = new Date('2026-10-19T02:30:00Z');

const ok = <T,>(value: T): InvoiceDashboardResult<T> => ({ ok: true, value });

function aging(events: boolean): InvoiceDashboardAging {
  const rows: readonly [AgingBucket, bigint, number, number][] = events
    ? [
        ['not_yet_due', 7_490_000n, 2, 78],
        ['days_1_30', 2_140_000n, 2, 22],
        ['days_31_60', 0n, 0, 0],
        ['days_61_90', 0n, 0, 0],
        ['over_90', 0n, 0, 0],
      ]
    : [
        ['not_yet_due', 82_650_000n, 22, 75],
        ['days_1_30', 12_840_000n, 4, 12],
        ['days_31_60', 8_560_000n, 3, 8],
        ['days_61_90', 2_996_000n, 1, 3],
        ['over_90', 3_210_000n, 1, 2],
      ];
  const subject = events ? { subject: 'event' as const } : {};
  return {
    totalSatang: rows.reduce((s, r) => s + r[1], 0n),
    count: rows.reduce((s, r) => s + r[2], 0),
    buckets: rows.map(([bucket, amountSatang, count, sharePercent]) => ({
      bucket,
      amountSatang,
      count,
      sharePercent,
      listQuery: { status: bucket === 'not_yet_due' ? ('issued' as const) : ('overdue' as const), ...subject },
    })),
  };
}

function tiles(events: boolean, a: InvoiceDashboardAging, any = true): InvoiceDashboardTiles {
  const overdue = a.buckets.filter((b) => b.bucket !== 'not_yet_due');
  return {
    outstanding: { amountSatang: a.totalSatang, count: a.count },
    overdue: {
      amountSatang: overdue.reduce((s, b) => s + b.amountSatang, 0n),
      count: overdue.reduce((s, b) => s + b.count, 0),
    },
    collectedThisMonth: {
      amountSatang: events ? 6_420_000n : 21_400_000n,
      invoiceCount: events ? 3 : 12,
      range: { from: '2026-10-01', to: TODAY },
      toDate: true,
    },
    collectedInFiscalYear: {
      amountSatang: events ? 45_420_000n : 311_000_000n,
      invoiceCount: events ? 21 : 140,
      range: { from: '2026-01-01', to: TODAY },
      toDate: true,
    },
    anyNonDraftInvoice: any,
  };
}

function attention(events: boolean, canWrite: boolean): InvoiceDashboardAttention {
  const readOnly = {
    receiptPdfFailed: events ? 0 : 1,
    refundsFailedAtStripe: 1,
    refundsPendingOverThreshold: events ? 0 : 1,
  };
  return canWrite ? { ...readOnly, drafts: { manual: events ? 1 : 3, autoRenewal: events ? 0 : 14 } } : readOnly;
}

const BUYERS = [
  'Nordic Freight Solutions Co., Ltd.',
  'Siam Lakeside Hospitality Co., Ltd.',
  'Gothenburg Design Studio (Thailand) Ltd.',
  'Baltic Engineering Asia Co., Ltd.',
  'Andaman Timber Trading Co., Ltd.',
  'Stockholm Coffee Roasters Thailand',
];

function oldest(events: boolean, canWrite: boolean): InvoiceDashboardOldestOverdue {
  const days = [129, 98, 74, 52, 41, 33];
  const amounts = [2_996_000n, 3_210_000n, 2_140_000n, 4_280_000n, 2_996_000n, 1_284_000n];
  const n = events ? 2 : 6;
  return {
    canRecordPayment: canWrite,
    rows: Array.from({ length: n }, (_, i) => ({
      invoiceId: `00000000-0000-4000-9124-00000000000${i + 1}`,
      documentNumber: `SC-0000${71 + i * 3}`,
      buyerName: BUYERS[i] ?? null,
      dueDate: new Date(Date.UTC(2026, 9, 19 - (days[i] ?? 30))).toISOString().slice(0, 10),
      daysPastDue: days[i] ?? 30,
      amountSatang: events ? 1_070_000n : (amounts[i] ?? 1_070_000n),
    })),
  };
}

function trend(events: boolean): InvoiceDashboardTrend {
  const scale = events ? 1n : 10n;
  const billed = [42, 38, 45, 31, 36, 40, 29, 33, 41, 18];
  const collected = [35, 33, 39, 30, 31, 34, 27, 30, 33, 14];
  return {
    range: { from: '2026-01-01', to: '2026-12-31' },
    collectedRange: { from: '2026-01-01', to: TODAY },
    toDate: true,
    slots: Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      const state = i < 9 ? ('past' as const) : i === 9 ? ('current' as const) : ('future' as const);
      return {
        monthKey: `2026-${m}`,
        from: `2026-${m}-01`,
        to: `2026-${m}-28`,
        state,
        billedSatang: state === 'future' ? null : BigInt(billed[i] ?? 0) * 100_000_00n * scale / 10n,
        collectedSatang: state === 'future' ? null : BigInt(collected[i] ?? 0) * 100_000_00n * scale / 10n,
      };
    }),
  };
}

function methods(events: boolean): InvoiceDashboardMethods {
  const rows = events
    ? ([['bank_transfer', 41_730_000n, 92], ['promptpay', 3_210_000n, 7], ['card', 480_000n, 1], ['cheque', 0n, 0], ['cash', 0n, 0], ['other', 0n, 0]] as const)
    : ([['bank_transfer', 186_600_000n, 60], ['promptpay', 62_200_000n, 20], ['card', 37_320_000n, 12], ['cheque', 18_660_000n, 6], ['cash', 3_110_000n, 1], ['other', 3_110_000n, 1]] as const);
  return {
    range: { from: '2026-01-01', to: TODAY },
    toDate: true,
    totalSatang: rows.reduce((s, r) => s + r[1], 0n),
    rows: rows.map(([method, amountSatang, sharePercent]) => ({ method, amountSatang, sharePercent })),
  };
}

const PLANS = [
  { id: 'regular', label: 'Regular' },
  { id: 'premium', label: 'Premium' },
  { id: 'large', label: 'Large' },
  { id: 'start-up', label: 'Start-up' },
  { id: 'partnership', label: 'Partnership' },
  { id: 'thai-alumni', label: 'Thai alumni' },
];

export async function renderFinancePreview(state: string | undefined) {
  const events = state === 'events';
  const canWrite = state !== 'manager';
  const input: InvoiceDashboardLoadInput = {
    filters: { type: events ? 'event' : 'all', fiscalYear: 2026, planId: null, origin: 'all' },
    today: TODAY,
    now: NOW,
    fiscalYearRange: fiscalYearDateRange(2026, 1),
    canWrite,
  };
  const a = aging(events);
  return renderInvoiceDashboardView({
    locale: await getLocale(),
    now: NOW,
    input,
    currentFiscalYear: 2026,
    startMonth: 1,
    autoInvoiceEnabled: true,
    plans: PLANS,
    tiles: ok(tiles(events, a, state !== 'empty')),
    aging: ok(a),
    attention: ok(attention(events, canWrite)),
    oldestOverdue: ok(oldest(events, canWrite)),
    trend: ok(trend(events)),
    methods:
      state === 'card-error'
        ? { ok: false, error: { code: 'query_failed', referenceId: '7f3a-91c2' } }
        : ok(methods(events)),
  });
}
