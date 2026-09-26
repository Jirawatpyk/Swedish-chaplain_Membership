/**
 * Admin invoice detail — Payment activity: a FAILED auto-refund must not read
 * as a benign one.
 *
 * `confirm-payment` marks a stale-invoice payment `auto_refunded` even when the
 * refund failed at creation (and `process-refund-updated` leaves it there when
 * it fails later); the failure is only in the
 * `auto_refund_failed_needs_manual_reconcile` forensic, which the page reads
 * via `findStaleInvoiceAutoRefund`. With that verdict passed in, the timeline
 * shows a destructive "Auto-refund failed" row — matching the
 * AutoRefundFailedAlert above it — with no "Payment succeeded" row and no
 * processor charge-id chip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

function makeRealTranslator(ns: string) {
  return (key: string): string => {
    const val = getPath(getPath(en as unknown, ns), key);
    return typeof val === 'string' ? val : `MISSING_KEY:${ns}.${key}`;
  };
}

const { getActivityMock } = vi.hoisted(() => ({ getActivityMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/modules/payments', () => ({
  SYSTEM_ACTOR_STRIPE_WEBHOOK: '00000000-0000-0000-0000-000000000001',
  SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY: 'system:stripe-webhook',
}));
vi.mock('@/modules/auth/infrastructure/db/user-repo', () => ({
  userRepo: { findById: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/modules/auth', () => ({ asUserId: (id: string) => id }));
vi.mock('@/app/(staff)/admin/invoices/[invoiceId]/_lib/cached-payment-activity', () => ({
  getInvoicePaymentActivity: (...args: unknown[]) => getActivityMock(...args),
}));

import { PaymentTimeline } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline';

const timelineEn = en.admin.paymentReconciliation.timeline;

// The invoice was already paid by another method when the online payment
// landed (cause `invoice_already_paid`) — the online payment is a duplicate.
const PAID_INVOICE = {
  invoiceId: 'inv-1',
  status: 'paid',
  paidAt: '2026-04-26T09:00:00Z',
  paymentRecordedByUserId: 'user-admin-1',
} as const;

const AUTO_REFUNDED_PAYMENT = {
  id: 'pmt_dup',
  tenantId: 'tenant-a',
  invoiceId: 'inv-1',
  memberId: 'mem-1',
  method: 'card',
  status: 'auto_refunded',
  amountSatang: 1_000_000n,
  currency: 'THB',
  processorPaymentIntentId: 'pi_dup',
  processorChargeId: 'ch_dup',
  processorEnvironment: 'live',
  attemptSeq: 1,
  card: null,
  failureReasonCode: null,
  initiatedAt: new Date('2026-04-26T10:00:00Z'),
  completedAt: new Date('2026-04-26T10:00:30Z'),
  actorUserId: 'user-member-1',
  correlationId: 'corr-1',
};

async function renderTimeline(autoRefundFailed: boolean): Promise<string> {
  const tree = await PaymentTimeline({
    invoice: PAID_INVOICE,
    tenantId: 'tenant-a',
    isAdmin: true,
    autoRefundFailed,
  });
  return renderToStaticMarkup(tree as ReactElement);
}

function rowFor(html: string, type: string): string | undefined {
  return html.match(new RegExp(`<li[^>]*data-testid="timeline-event-${type}"[\\s\\S]*?</li>`))?.[0];
}

beforeEach(() => {
  getActivityMock.mockReset();
  getActivityMock.mockResolvedValue({
    ok: true,
    value: { payments: [AUTO_REFUNDED_PAYMENT], refunds: [] },
  });
});

describe('PaymentTimeline — failed auto-refund', () => {
  it('shows a destructive "Auto-refund failed" row, no success row and no charge-id chip', async () => {
    const html = await renderTimeline(true);

    const row = rowFor(html, 'auto_refund_failed');
    expect(row).toBeDefined();
    expect(row).toContain(timelineEn.events.auto_refund_failed);
    expect(row).toContain('text-destructive');

    expect(html).not.toContain('MISSING_KEY');
    expect(html).not.toContain('timeline-event-auto_refunded');
    expect(html).not.toContain(timelineEn.events.auto_refunded);
    expect(html).not.toContain(timelineEn.events.payment_succeeded);
    expect(html).not.toContain('data-testid="processor-charge-id"');
    expect(html).not.toContain('ch_dup');
  });

  it('control — without a failure verdict the row stays the neutral "Payment auto-refunded"', async () => {
    const html = await renderTimeline(false);

    expect(rowFor(html, 'auto_refunded')).toBeDefined();
    expect(html).not.toContain('timeline-event-auto_refund_failed');
  });
});
