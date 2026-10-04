/**
 * Spec 122 US8b (T827) — the invoice detail, void and new-credit-note loading
 * states and the not-found page on AURA: AURA cards and skeleton blocks in
 * the new shape (the detail page's Details card, then Line items), one live
 * region announcing the load, and the same layout container as the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

import DetailLoading from '@/app/(staff)/admin/invoices/[invoiceId]/loading';
import VoidLoading from '@/app/(staff)/admin/invoices/[invoiceId]/void/loading';
import CreditNoteLoading from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/loading';
import NotFound from '@/app/(staff)/admin/invoices/[invoiceId]/not-found';

async function dom(el: () => Promise<ReactElement> | ReactElement): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(await el());
  return host;
}

function announced(host: HTMLElement) {
  return [...host.querySelectorAll('[role="status"]')].filter((el) => !el.closest('[aria-hidden="true"]'));
}

describe('invoice detail loading', () => {
  it('draws the Details and Line items cards on AURA, in the detail container, announced once', async () => {
    const host = await dom(DetailLoading);
    expect(host.querySelectorAll('.aura-card').length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'detail');
    expect(announced(host)).toHaveLength(1);
  });
});

describe.each([
  ['void', VoidLoading],
  ['new credit note', CreditNoteLoading],
])('%s loading', (_name, Loading) => {
  it('draws an AURA card with skeleton blocks in the form container, announced once', async () => {
    const host = await dom(Loading);
    expect(host.querySelector('.aura-card')).not.toBeNull();
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'form');
    expect(announced(host)).toHaveLength(1);
  });

  it('reserves the back link above the title, as the page draws it', async () => {
    const host = await dom(Loading);
    const container = host.querySelector('[data-slot="layout-container"]')!;
    expect(container.firstElementChild).toHaveAttribute('data-slot', 'skeleton-block');
  });
});

describe('invoice not found', () => {
  it('keeps its test id and draws the back link as an AURA button', async () => {
    const host = await dom(NotFound);
    expect(host.querySelector('[data-testid="invoice-not-found"]')).not.toBeNull();
    expect(host.querySelector('a[href="/admin/invoices"]')).toHaveClass('aura-btn');
  });
});
