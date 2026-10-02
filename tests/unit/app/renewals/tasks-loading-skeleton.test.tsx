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

// AURA 5.29 (handoff #134): the loading rows match the queue's rows, so the
// phone uses AURA's own stacked cards instead of hand-drawn ones.
describe('escalation tasks loading on a phone', () => {
  it('uses AURA\'s stacked cards at every width: no own phone cards, the table not hidden below 640px', async () => {
    const host = await dom();
    expect(host.querySelector('[data-slot="phone-cards-skeleton"]')).toBeNull();
    expect(host.querySelector('.aura-bleed')?.closest('[aria-hidden="true"]')).not.toHaveClass('max-sm:hidden');
  });

  it('labels the card lines, draws the assignee and role as two lines, and Done and ⋯ at touch height', async () => {
    const host = await dom();
    const row = host.querySelector('.aura-table__row--skeleton') as HTMLElement;
    expect(row.querySelector('[data-label="columns.taskType"]')).not.toBeNull();
    expect(row.querySelector('[data-label="columns.dueAt"]')).not.toBeNull();
    // the Assigned to cell: the name over the role
    expect(row.querySelectorAll('.aura-skel-lines')).toHaveLength(1);
    expect(row.querySelector('.aura-skel-lines')?.children).toHaveLength(2);
    expect(row.querySelector('.aura-skel--action.is-footer.is-touch')).not.toBeNull();
  });
});
