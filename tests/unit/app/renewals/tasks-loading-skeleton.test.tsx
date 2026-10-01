/**
 * Escalation tasks loading skeleton — 122 US7b-2 (T735). The live page puts
 * the section tabs, the filters and the queue in one AURA card (frameless on a
 * phone), so the skeleton draws the same card on AURA skeleton blocks, with
 * each row ending in Done and the ⋯ button.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

import Loading from '@/app/(staff)/admin/renewals/tasks/loading';

async function dom(): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup((await Loading()) as ReactElement);
  return host;
}

describe('escalation tasks loading skeleton', () => {
  it('draws the page card, frameless on a phone, on AURA skeleton blocks only', async () => {
    const host = await dom();
    expect(host.querySelector('.aura-card')).toHaveClass('aura-card--flush-below-sm', 'max-sm:border-0', 'max-sm:p-0');
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
  });

  it('puts the tab strip, then the filters, then the rows in the card', async () => {
    const host = await dom();
    const card = host.querySelector('.aura-card') as HTMLElement;
    const tabs = card.querySelector('[data-slot="tab-strip-skeleton"]');
    const filters = card.querySelector('[data-slot="filters-skeleton"]');
    const row = card.querySelector('[data-slot="row-actions-skeleton"]');
    expect(tabs).not.toBeNull();
    expect(filters).not.toBeNull();
    expect(row).not.toBeNull();
    expect(tabs!.compareDocumentPosition(filters!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filters!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('ends each row with two actions (Done and ⋯), not three', async () => {
    const host = await dom();
    const actions = host.querySelector('[data-slot="row-actions-skeleton"]') as HTMLElement;
    expect(actions.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(2);
  });

  it('announces loading once and keeps the table container', async () => {
    const host = await dom();
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'table');
  });
});
