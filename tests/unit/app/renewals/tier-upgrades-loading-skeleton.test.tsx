/**
 * WP8 (BP5 item 2) — tier-upgrade loading skeleton CLS parity.
 *
 * 122 US7b-1 (T726): the live page renders the section tabs and the queue in
 * one AURA card (frameless on a phone), so the skeleton draws the same card
 * with a static tab strip ahead of the rows, on AURA skeleton blocks. Async
 * RSC body is invoked directly (mirrors the portal dashboard-loading test).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi
    .fn()
    .mockImplementation(async () => (key: string) => key),
}));

import Loading from '@/app/(staff)/admin/renewals/tier-upgrades/loading';

async function dom(): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup((await Loading()) as ReactElement);
  return host;
}

describe('tier-upgrades loading skeleton', () => {
  it('draws the page card, frameless on a phone, on AURA skeleton blocks', async () => {
    const host = await dom();
    const card = host.querySelector('.aura-card');
    expect(card).toHaveClass('aura-card--flush-below-sm', 'max-sm:border-0', 'max-sm:p-0');
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
  });

  it('renders a static tab-strip skeleton ahead of the rows, inside the card', async () => {
    const host = await dom();
    const card = host.querySelector('.aura-card') as HTMLElement;
    const tabs = card.querySelector('[data-slot="tab-strip-skeleton"]');
    const firstRow = card.querySelector('.aura-table');
    expect(tabs).not.toBeNull();
    expect(firstRow).not.toBeNull();
    expect(tabs!.compareDocumentPosition(firstRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('announces loading via one role=status live region', async () => {
    const host = await dom();
    // AURA's DataTable keeps its own loading status inside the hidden placeholder.
    const announced = [...host.querySelectorAll('[role="status"]')].filter((el) => !el.closest('[aria-hidden="true"]'));
    expect(announced).toHaveLength(1);
  });

  it('keeps the table layout container (structural parity with the page)', async () => {
    const host = await dom();
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'table');
  });
});

// The skeleton draws the list table as the page does: AURA's table, edge to
// edge inside the card (`bleed`), so nothing moves when the rows arrive.
describe('tier-upgrades loading in the list card', () => {
  it('draws AURA\'s DataTable in its loading state with the queue\'s columns, ending the card like the queue', async () => {
    const host = await dom();
    const table = host.querySelector('.aura-card .aura-bleed.aura-bleed-end');
    expect(table).not.toBeNull();
    expect(table?.closest('[aria-hidden="true"]')).not.toBeNull();
    const heads = [...host.querySelectorAll('.aura-card [role="columnheader"]')].map((h) => h.textContent?.trim());
    expect(heads.slice(0, 5)).toEqual(['columns.member', 'columns.from_plan', 'columns.to_plan', 'columns.reason', 'columns.status']);
  });
});

// AURA 5.29 (handoff #134): the loading rows match the queue's rows, so the
// phone uses AURA's own stacked cards instead of hand-drawn ones.
describe('tier-upgrades loading on a phone', () => {
  it('uses AURA\'s stacked cards at every width: no own phone cards, the table not hidden below 640px', async () => {
    const host = await dom();
    expect(host.querySelector('[data-slot="phone-cards-skeleton"]')).toBeNull();
    expect(host.querySelector('.aura-bleed')?.closest('[aria-hidden="true"]')).not.toHaveClass('max-sm:hidden');
  });

  it('draws two lines for the plans and the reason, labels the card fields, and a touch-height footer bar', async () => {
    const host = await dom();
    const row = host.querySelector('.aura-table__row--skeleton') as HTMLElement;
    for (const key of ['columns.from_plan', 'columns.to_plan', 'columns.reason']) {
      const cell = row.querySelector(`[data-label="${key}"]`);
      expect(cell, key).not.toBeNull();
      expect(cell?.querySelectorAll('.aura-skel-lines > .aura-skel'), key).toHaveLength(2);
    }
    expect(row.querySelector('.aura-skel--action.is-footer.is-touch')).not.toBeNull();
  });
});
