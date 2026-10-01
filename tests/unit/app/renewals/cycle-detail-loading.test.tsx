/**
 * The cycle detail loading skeleton on AURA (spec 122 US7b-1, T724): the
 * page's shape — header with its actions, then the four cards in the same
 * grid, Linked invoice first on a phone — so the swap to content holds CLS 0.
 * One live region announces the load.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

import Loading from '@/app/(staff)/admin/renewals/[cycleId]/loading';

async function dom(): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup((await Loading()) as ReactElement);
  return host;
}

describe('cycle detail loading skeleton', () => {
  it('uses AURA skeleton blocks, not the legacy kit', async () => {
    const host = await dom();
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
  });

  it('draws the four cards as AURA cards in the page grid, Linked invoice first on a phone', async () => {
    const host = await dom();
    const cards = host.querySelectorAll('.aura-card');
    expect(cards).toHaveLength(4);
    expect(cards[0]?.parentElement).toHaveClass('lg:grid-cols-2');
    expect(cards[1]).toHaveClass('max-sm:order-first');
  });

  it('holds the header with its title, subtitle and actions', async () => {
    const host = await dom();
    const header = host.querySelector('[data-slot="page-header"]');
    expect(header).not.toBeNull();
    expect(header?.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThanOrEqual(3);
  });

  it('announces the load through one live region', async () => {
    const host = await dom();
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});
