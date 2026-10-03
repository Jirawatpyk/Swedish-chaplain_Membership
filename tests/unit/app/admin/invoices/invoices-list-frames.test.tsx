/**
 * Spec 122 US8 (T806) — the invoices list's loading skeleton and error
 * boundary on AURA: the skeleton keeps its status announcement and takes the
 * board's shape (seven columns, a frameless card on a phone); the boundary is
 * the shared `RouteErrorPanel` (Retry + the error id).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => (key: string) => {
    const v = `${ns}.${key}`.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], en);
    return typeof v === 'string' ? v : `MISSING_KEY:${ns}.${key}`;
  }),
}));

const { default: Loading } = await import('@/app/(staff)/admin/invoices/loading');
const { default: InvoicesError } = await import('@/app/(staff)/admin/invoices/error');

describe('/admin/invoices loading (T806)', () => {
  it('announces loading and draws the board shape on AURA', async () => {
    const html = renderToStaticMarkup((await Loading()) as ReactElement);
    const d = new DOMParser().parseFromString(html, 'text/html');
    const status = d.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-busy')).toBe('true');
    expect(status?.getAttribute('aria-label')).toBe(en.layout.loadingTable);
    expect(html).toContain(en.admin.invoices.list.title);
    const card = d.querySelector('.aura-card');
    expect(card?.className).toContain('max-sm:border-0');
    // AURA's own DataTable in its loading state with the real columns (keys,
    // widths, phone-card parts), so the grid lands in place (CLS 0) and turns
    // into cards below 640px like the real one.
    const skeleton = d.querySelector('[data-testid="invoices-table-skeleton"]');
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.querySelector('.aura-table')).not.toBeNull();
    const headers = [...(skeleton?.querySelectorAll('[role="columnheader"]') ?? [])].map((h) => h.textContent?.trim());
    const cols = en.admin.invoices.list.columns;
    expect(headers).toEqual([
      cols.documentNumber,
      cols.buyer,
      cols.status,
      cols.dueDate,
      cols.receiptNumber,
      cols.total,
      cols.actions,
    ]);
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('data-slot="table-skeleton"');
    // Only "New invoice" is reserved in the header: a manager, or a tenant
    // without the registers flag, gets fewer buttons, never more.
    expect(d.querySelector('[data-slot="page-header-actions"]')?.children).toHaveLength(1);
    // AURA's input height, not the legacy kit's token.
    expect(html).not.toContain('--input-height');
    expect(html).not.toContain('MISSING_KEY');
  });
});

describe('/admin/invoices error boundary (T806)', () => {
  it('renders the shared route error panel with Retry and the error id', () => {
    const reset = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <InvoicesError error={Object.assign(new Error('boom'), { digest: 'abc123' })} reset={reset} />
      </NextIntlClientProvider>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.aura-empty')).not.toBeNull();
    expect(alert).toHaveTextContent('abc123');
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

// The skeleton draws the list table as the page does: AURA's table, edge to
// edge inside the card (`bleed`), so nothing moves when the rows arrive.
describe('/admin/invoices loading in the list card', () => {
  it('the skeleton table bleeds to the card edges like the table', async () => {
    const d = new DOMParser().parseFromString(renderToStaticMarkup((await Loading()) as ReactElement), 'text/html');
    expect(d.querySelector('[data-testid="invoices-table-skeleton"] .aura-bleed')).not.toBeNull();
  });
});

// AURA 5.29 (handoff #134): the loading rows are as tall as the real rows —
// the number over "Issued {date}", the buyer over its subtitle, the receipt
// over its state — and the phone card ends in the row's touch-height actions.
describe('/admin/invoices loading rows match the rows', () => {
  it('draws two lines for the number, buyer and receipt cells, and a touch-height footer bar', async () => {
    const d = new DOMParser().parseFromString(renderToStaticMarkup((await Loading()) as ReactElement), 'text/html');
    const row = d.querySelector('[data-testid="invoices-table-skeleton"] .aura-table__row--skeleton');
    const lines = [...(row?.querySelectorAll('.aura-skel-lines') ?? [])];
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.children).toHaveLength(2);
    expect(row?.querySelector('.aura-skel--action.is-footer.is-touch')).not.toBeNull();
  });
});
