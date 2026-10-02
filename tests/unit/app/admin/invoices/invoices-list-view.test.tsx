/**
 * Spec 122 US8 (T806) — the invoices list page's view on AURA, shared by the
 * page and the no-DB preview (`Admin-invoices`, `Admin-state-invoices-setup`):
 * the header actions, the table card (frameless on a phone), the count line,
 * the empty states and the setup state.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

/** The shipped copy, with ICU plurals resolved for "other" / "one". */
function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const val = getPath(getPath(en as unknown, ns), key);
    if (typeof val !== 'string') return `MISSING_KEY:${ns}.${key}`;
    const count = params?.count;
    const plural = val.replace(/\{count, plural,((?:[^{}]|\{[^{}]*\})*)\}/, (_m, body: string) => {
      const pick = (sel: string) => new RegExp(`${sel} \\{([^}]*)\\}`).exec(body)?.[1];
      const chosen = (count === 1 ? pick('one') : undefined) ?? pick('other') ?? '';
      return chosen.replace(/#/g, String(count));
    });
    return plural.replace(/\{(\w+)\}/g, (_, k: string) => (params?.[k] !== undefined ? String(params[k]) : `{${k}}`));
  };
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
}));
vi.mock('@/app/(staff)/admin/invoices/_components/invoice-table', () => ({
  InvoicesTable: () => <div data-marker="invoices-table" />,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/invoice-filters', () => ({
  InvoiceFilters: () => <div data-marker="invoice-filters" />,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/invoices-export-actions', () => ({
  InvoicesExportActions: () => <button type="button" data-marker="csv-export">Export CSV…</button>,
}));
vi.mock('@/components/layout/table-pagination', () => ({
  TablePagination: () => <nav data-marker="pagination" />,
}));

const { renderInvoicesListView, renderInvoicesSetupView } = await import(
  '@/app/(staff)/admin/invoices/_components/invoices-list-view'
);

const list = en.admin.invoices.list;

function doc(el: ReactElement): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(el), 'text/html');
}

const base = {
  isAdmin: true,
  isQueueView: false,
  showRegisters: true,
  show088Filters: true,
  showAutoInvoiceFilter: false,
  rows: [{ invoiceId: 'a' }, { invoiceId: 'b' }] as never[],
  total: 8,
  page: 1,
  pageSize: 50,
  hasFilters: false,
  draftsHidden: true,
  payIntent: false,
  showMethodColumn: false,
  todayIso: '2026-10-02',
};

describe('renderInvoicesListView (T806)', () => {
  it('an admin gets Registers and Export CSV (secondary) and New invoice (primary)', async () => {
    const d = doc(await renderInvoicesListView(base));
    const newLink = [...d.querySelectorAll('a')].find((a) => a.textContent === list.actions.new);
    expect(newLink?.getAttribute('href')).toBe('/admin/invoices/new');
    expect(newLink?.className).toContain('aura-btn--primary');
    const registers = d.querySelector('a[href="/admin/invoices/registers"]');
    expect(registers?.className).toContain('aura-btn--secondary');
    expect(d.querySelector('[data-marker="csv-export"]')).not.toBeNull();
  });

  it('on a phone "New invoice" leads the row and Tax registers moves into the ⋯ menu', async () => {
    const d = doc(await renderInvoicesListView(base));
    const newLink = [...d.querySelectorAll('a')].find((a) => a.textContent === list.actions.new);
    expect(newLink?.className).toContain('max-sm:order-first');
    expect(d.querySelector('a[href="/admin/invoices/registers"]')?.className).toContain('max-sm:hidden');
  });

  it('a manager gets no header actions', async () => {
    const d = doc(await renderInvoicesListView({ ...base, isAdmin: false }));
    expect(d.querySelector('a[href="/admin/invoices/new"]')).toBeNull();
    expect(d.querySelector('[data-marker="csv-export"]')).toBeNull();
  });

  it('the table sits in an AURA card that drops its frame on a phone', async () => {
    const d = doc(await renderInvoicesListView(base));
    const card = d.querySelector('[data-marker="invoices-table"]')?.closest('.aura-card');
    expect(card).not.toBeNull();
    expect(card?.className).toContain('max-sm:border-0');
  });

  it('the visible count line names the drafts filter in the default view', async () => {
    const d = doc(await renderInvoicesListView(base));
    const status = d.querySelector('[role="status"]');
    // No arrow: a screen reader reads "→" aloud as "right arrow".
    expect(status?.textContent).toBe('8 invoices · to see drafts, choose Draft in the Status filter');
    expect(status?.className).not.toContain('sr-only');
  });

  it('with a status filter the count line is the count alone', async () => {
    const d = doc(await renderInvoicesListView({ ...base, draftsHidden: false, total: 1 }));
    expect(d.querySelector('[role="status"]')?.textContent).toBe('1 invoice');
  });

  it('no invoices yet: an AURA empty state with New invoice for an admin', async () => {
    const d = doc(await renderInvoicesListView({ ...base, rows: [], total: 0 }));
    const empty = d.querySelector('.aura-empty');
    expect(empty?.textContent).toContain(list.empty);
    expect(empty?.querySelector('a[href="/admin/invoices/new"]')).not.toBeNull();
    // The plus the header's New invoice carries (button icon rule).
    expect(empty?.querySelector('a[href="/admin/invoices/new"] svg')).not.toBeNull();
    expect(d.querySelector('[data-marker="invoices-table"]')).toBeNull();
  });

  it('no invoices yet: the screen-reader count says so, not "no matches"', async () => {
    const d = doc(await renderInvoicesListView({ ...base, rows: [], total: 0 }));
    expect(d.querySelector('[role="status"]')?.textContent).toBe(list.empty);
  });

  it('nothing matches: the screen-reader count names the filters', async () => {
    const d = doc(await renderInvoicesListView({ ...base, rows: [], total: 0, hasFilters: true }));
    // (This stub translator has no ICU `=0` branch; the shipped copy says "No invoices match the filters".)
    expect(d.querySelector('[role="status"]')?.textContent).toMatch(/match the filters$/);
  });

  it('nothing matches the filters: the filtered empty state with Clear filters', async () => {
    const d = doc(await renderInvoicesListView({ ...base, rows: [], total: 0, hasFilters: true }));
    const empty = d.querySelector('.aura-empty');
    expect(empty?.textContent).toContain(list.filteredEmpty);
    const clear = empty?.querySelector('a[href="/admin/invoices"]');
    expect(clear?.textContent).toBe(list.actions.clearFilters);
  });

  it('the palette ?pay=1 hint is an AURA info alert', async () => {
    const d = doc(await renderInvoicesListView({ ...base, payIntent: true }));
    const hint = d.querySelector('[data-testid="record-payment-intent-hint"]');
    expect(hint?.className).toContain('aura-alert--info');
    expect(hint?.textContent).toContain(list.recordPaymentIntentHint);
  });
});

describe('renderInvoicesSetupView (T806)', () => {
  it('the setup sentence, and "Configure Invoicing" for an admin', async () => {
    const d = doc(await renderInvoicesSetupView({ isAdmin: true }));
    expect(d.body.textContent).toContain(list.setupRequired);
    const configure = d.querySelector('a[href="/admin/settings/invoicing"]');
    expect(configure?.textContent).toBe(list.actions.configureInvoicing);
    expect(configure?.className).toContain('aura-btn--primary');
  });

  it('a manager sees the sentence only', async () => {
    const d = doc(await renderInvoicesSetupView({ isAdmin: false }));
    expect(d.body.textContent).toContain(list.setupRequired);
    expect(d.querySelector('a[href="/admin/settings/invoicing"]')).toBeNull();
  });
});
