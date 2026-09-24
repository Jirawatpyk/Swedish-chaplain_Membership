/**
 * /admin/invoices — a failed invoice read must render an error state, never
 * the "No invoices yet" empty state (admin design review).
 *
 * `listInvoicesPaged` is typed `Result<…, never>`: a DB/RLS failure THROWS out
 * of the repo. The page's only failure handling was a `!ok` branch that logged
 * and then rendered `rows = []` — i.e. the benign empty state — and a thrown
 * read escaped to the generic route boundary with no tenant context. An admin
 * reconciling during an outage would read "no invoices" as the truth.
 *
 * Contract pinned here: a thrown repo error renders the shared load-error card
 * ("Couldn't load invoices…", Try again + Go back, a reference id), is logged
 * with an errorId carrying the same reference id, and the empty-state copy is
 * NOT rendered. A successful empty read still renders the empty state.
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

const { errorSpy, warnSpy, listInvoicesPagedMock } = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  warnSpy: vi.fn(),
  listInvoicesPagedMock: vi.fn(),
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

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue({ user: { id: 'u1', role: 'admin' } }),
  canPerform: () => true,
}));

vi.mock('@/lib/env', () => ({
  env: { features: { f088TaxAtPayment: false, autoInvoice: false } },
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/modules/invoicing', () => ({
  listInvoicesPaged: (...args: unknown[]) => listInvoicesPagedMock(...args),
  makeListInvoicesDeps: () => ({}),
  isTenantInvoiceSetupComplete: vi.fn().mockResolvedValue(true),
  computeIsOverdue: () => false,
  displayDocumentNumber: () => null,
  invoiceStatusHasReceipt: () => false,
  resolveTaxDocumentKind: () => 'none',
}));

vi.mock('@/modules/payments', () => ({
  listSucceededPaymentMethods: vi.fn(),
  makeListSucceededPaymentMethodsDeps: () => ({}),
}));
vi.mock('@/modules/members', () => ({ directorySearch: vi.fn() }));
vi.mock('@/modules/members/members-deps', () => ({ buildMembersDeps: () => ({}) }));
vi.mock('@/modules/renewals', () => ({
  loadAutoRenewalQueueContext: vi.fn(),
  makeAutoRenewalQueueContextDeps: () => ({}),
}));
vi.mock('@/lib/events-admin-deps', () => ({ runListEventNamesByIds: vi.fn() }));

// Client components (next-intl react-client hooks have no provider under
// renderToStaticMarkup) — irrelevant to what these tests assert.
vi.mock('@/app/(staff)/admin/invoices/_components/invoice-table', () => ({
  InvoicesTable: () => null,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/invoice-filters', () => ({
  InvoiceFilters: () => null,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/csv-export-dialog', () => ({
  CsvExportDialog: () => null,
}));

import AdminInvoicesPage from '@/app/(staff)/admin/invoices/page';

async function renderPage(searchParams: Record<string, string> = {}): Promise<string> {
  const tree = await AdminInvoicesPage({ searchParams: Promise.resolve(searchParams) });
  return decodeEntities(renderToStaticMarkup(tree as ReactElement));
}

const LOAD_FAILED = "Couldn't load invoices. Please try again.";

beforeEach(() => {
  errorSpy.mockClear();
  warnSpy.mockClear();
  listInvoicesPagedMock.mockReset();
  listInvoicesPagedMock.mockResolvedValue({ ok: true, value: { rows: [], total: 0 } });
});

describe('AdminInvoicesPage — invoice read failure renders the load-error state', () => {
  it('a thrown repo error renders the error card (retry + go back + reference id), NOT the empty state', async () => {
    listInvoicesPagedMock.mockRejectedValue(new Error('NeonDbError: connection terminated'));
    const html = await renderPage();

    expect(html).toContain(LOAD_FAILED);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
    expect(html).toContain('Go back');
    expect(html).toMatch(UUID_RE);
    expect(html).not.toContain(en.admin.invoices.list.empty);
    expect(html).not.toContain(en.admin.invoices.list.filteredEmpty);
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('a thrown repo error under an active filter still renders the error card, not "no matches"', async () => {
    listInvoicesPagedMock.mockRejectedValue(new Error('RLS drift'));
    const html = await renderPage({ status: 'paid' });

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain(en.admin.invoices.list.filteredEmpty);
  });

  it('logs the failure with an errorId and the SAME reference id the admin sees', async () => {
    listInvoicesPagedMock.mockRejectedValue(new TypeError('boom'));
    const html = await renderPage();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [ctx] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({
      errorId: 'F4.ADMIN.INVOICES_LIST_LOAD',
      tenantId: 'tenant-a',
      errKind: 'TypeError',
    });
    expect(ctx.correlationId).toMatch(UUID_RE);
    expect(html).toContain(ctx.correlationId as string);
  });

  it('control: a successful empty read still renders the empty state (no error card)', async () => {
    const html = await renderPage();

    expect(html).toContain(en.admin.invoices.list.empty);
    expect(html).not.toContain(LOAD_FAILED);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
