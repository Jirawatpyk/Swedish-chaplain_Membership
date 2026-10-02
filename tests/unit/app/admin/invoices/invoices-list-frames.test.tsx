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
    // Invoice No. · Buyer · Status · Due · Receipt No. · Total · Actions
    expect(d.querySelector('[data-slot="table-skeleton"]')?.firstElementChild?.children).toHaveLength(7);
    expect(html).not.toContain('data-slot="skeleton"');
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
