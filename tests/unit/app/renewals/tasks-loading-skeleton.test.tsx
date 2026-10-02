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
    const row = card.querySelector('.aura-table');
    expect(tabs).not.toBeNull();
    expect(filters).not.toBeNull();
    expect(row).not.toBeNull();
    expect(tabs!.compareDocumentPosition(filters!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(filters!.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('announces loading once and keeps the table container', async () => {
    const host = await dom();
    // AURA's DataTable keeps its own loading status inside the hidden placeholder.
    const announced = [...host.querySelectorAll('[role="status"]')].filter((el) => !el.closest('[aria-hidden="true"]'));
    expect(announced).toHaveLength(1);
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'table');
  });
});

// The skeleton draws the list table as the page does: AURA's table, edge to
// edge inside the card (`bleed`), so nothing moves when the rows arrive.
describe('escalation tasks loading in the list card', () => {
  it('draws AURA\'s DataTable in its loading state with the queue\'s columns, edge to edge', async () => {
    const host = await dom();
    const table = host.querySelector('.aura-card .aura-bleed');
    expect(table).not.toBeNull();
    expect(host.querySelector('.aura-card .aura-bleed-end')).toBeNull();
    const heads = [...host.querySelectorAll('.aura-card [role="columnheader"]')].map((h) => h.textContent?.trim());
    expect(heads.slice(0, 7)).toEqual([
      'columns.member', 'columns.tier', 'columns.expiresAt', 'columns.taskType', 'columns.dueAt', 'columns.assignedTo', 'columns.status',
    ]);
  });
});

// UX review H1: AURA's loading rows are one 48px line (handoff #134), far
// shorter than the queue's phone cards, so the phone keeps its own cards.
describe('escalation tasks loading on a phone', () => {
  it('draws the queue\'s own cards below 640px, ending in Done and ⋯ at touch height, and hides AURA\'s table there', async () => {
    const host = await dom();
    const cards = host.querySelector('[data-slot="phone-cards-skeleton"]');
    expect(cards).toHaveClass('sm:hidden');
    const actions = cards?.querySelector('[data-slot="row-actions-skeleton"]');
    expect(actions?.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(2);
    expect(host.querySelector('.aura-bleed')?.closest('[aria-hidden="true"]')).toHaveClass('max-sm:hidden');
  });
});
