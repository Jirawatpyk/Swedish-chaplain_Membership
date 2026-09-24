/**
 * Admin invoice detail — Payment activity panel: a failed activity read must
 * render an inline error with retry, never the empty timeline (admin design
 * review).
 *
 * `loadInvoicePaymentActivity` returns `err({ kind: 'repo_unavailable' })` when
 * the F5 repo throws (DB outage, RLS drift, schema drift). The panel logged a
 * warn and then substituted `{ payments: [], refunds: [] }`, so an outage
 * rendered "No online payment activity yet" — indistinguishable from a
 * genuinely unpaid invoice to a bookkeeper reconciling a transfer.
 *
 * Contract pinned here: `repo_unavailable` (and a loader that throws outright)
 * renders the shared inline load-error ("Couldn't load payment activity…",
 * Try again + Go back, a reference id) inside the panel, logs an errorId with
 * the same reference id, and renders NEITHER empty-state copy. A successful
 * empty read still renders the empty state.
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
  return (key: string, params?: Record<string, unknown>): string => {
    const val = getPath(getPath(en as unknown, ns), key);
    if (typeof val !== 'string') return `MISSING_KEY:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * renderToStaticMarkup escapes `'` / `"` / `&` — decode them so copy like
 * "Couldn't load…" is matched literally (otherwise every `not.toContain` on
 * such copy would pass vacuously).
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// --- mocks ----------------------------------------------------------------

const { errorSpy, warnSpy, getActivityMock } = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  warnSpy: vi.fn(),
  getActivityMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => errorSpy(...args),
    warn: (...args: unknown[]) => warnSpy(...args),
    info: vi.fn(),
  },
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

const ISSUED_INVOICE = {
  invoiceId: 'inv-1',
  status: 'issued',
  paidAt: null,
  paymentRecordedByUserId: null,
} as const;

async function renderTimeline(
  invoice: {
    invoiceId: string;
    status: string;
    paidAt: string | null;
    paymentRecordedByUserId: string | null;
  } = ISSUED_INVOICE,
): Promise<string> {
  const tree = await PaymentTimeline({ invoice, tenantId: 'tenant-a', isAdmin: true });
  return decodeEntities(renderToStaticMarkup(tree as ReactElement));
}

const LOAD_FAILED = "Couldn't load payment activity. Please try again.";
const timelineEn = en.admin.paymentReconciliation.timeline;

beforeEach(() => {
  errorSpy.mockClear();
  warnSpy.mockClear();
  getActivityMock.mockReset();
  getActivityMock.mockResolvedValue({ ok: true, value: { payments: [], refunds: [] } });
});

describe('PaymentTimeline — activity read failure renders an inline error with retry', () => {
  it('repo_unavailable (repo threw) renders the error (retry + go back + reference id), NOT the empty timeline', async () => {
    getActivityMock.mockResolvedValue({
      ok: false,
      error: { kind: 'repo_unavailable', cause: new Error('NeonDbError') },
    });
    const html = await renderTimeline();

    expect(html).toContain(LOAD_FAILED);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).toContain('Go back');
    expect(html).toMatch(UUID_RE);
    // Still inside the Payment activity panel (inline, not a page takeover).
    expect(html).toContain('data-testid="payment-timeline"');
    expect(html).toContain(timelineEn.title);
    expect(html).not.toContain(timelineEn.empty.title);
    expect(html).not.toContain(timelineEn.emptyPaidManual.title);
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('a paid invoice whose activity read fails does NOT claim "paid manually"', async () => {
    getActivityMock.mockResolvedValue({
      ok: false,
      error: { kind: 'repo_unavailable', cause: new Error('RLS drift') },
    });
    const html = await renderTimeline({
      ...ISSUED_INVOICE,
      status: 'paid',
      paidAt: '2026-05-01T03:00:00.000Z',
    });

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain(timelineEn.emptyPaidManual.title);
  });

  it('a loader that throws outright also renders the inline error', async () => {
    getActivityMock.mockRejectedValue(new Error('pool exhausted'));
    const html = await renderTimeline();

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain(timelineEn.empty.title);
  });

  it('logs the failure with an errorId and the SAME reference id the admin sees', async () => {
    getActivityMock.mockResolvedValue({
      ok: false,
      error: { kind: 'repo_unavailable', cause: new TypeError('boom') },
    });
    const html = await renderTimeline();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [ctx] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({
      errorId: 'F5.ADMIN.PAYMENT_TIMELINE_LOAD',
      tenantId: 'tenant-a',
      invoiceId: 'inv-1',
      errKind: 'TypeError',
    });
    expect(ctx.correlationId).toMatch(UUID_RE);
    expect(html).toContain(ctx.correlationId as string);
  });

  it('control: a successful empty read still renders the empty timeline (no error)', async () => {
    const html = await renderTimeline();

    expect(html).toContain(timelineEn.empty.title);
    expect(html).not.toContain(LOAD_FAILED);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
