/**
 * Spec 122 US11 (T1107) — the staff dashboard's loading state on AURA, in
 * both F9 flag branches: AURA cards with skeleton blocks (no legacy card or
 * skeleton), one live region announcing the load, and the same detail
 * container as the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({ features: { f9Dashboard: true } }));

vi.mock('@/lib/env', () => ({ env: { features: h.features } }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

import Loading from '@/app/(staff)/admin/(home)/loading';

async function dom(): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup((await Loading()) as ReactElement);
  return host;
}

function announced(host: HTMLElement) {
  return [...host.querySelectorAll('[role="status"]')].filter((el) => !el.closest('[aria-hidden="true"]'));
}

beforeEach(() => {
  h.features.f9Dashboard = true;
});

describe('staff dashboard loading', () => {
  it('F9 on: AURA cards with skeleton blocks in the detail container, announced once', async () => {
    const host = await dom();
    // 4 KPI stat tiles, then attention + insights + 2 trends + 2 breakdowns + activity
    expect(host.querySelectorAll('.aura-stat')).toHaveLength(4);
    expect(host.querySelectorAll('.aura-card')).toHaveLength(7);
    expect(host.querySelector('[data-slot="card"]')).toBeNull();
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'detail');
    expect(announced(host)).toHaveLength(1);
  });

  it('F9 on: blocks sized like the real cards, so the swap does not shift the page (UX review M1)', async () => {
    const host = await dom();
    const block = (cls: string) => host.querySelectorAll(`[data-slot="skeleton-block"].${cls}`);
    // attention + insights rows at the real 36px row height
    expect(block('h-9').length).toBeGreaterThanOrEqual(6);
    // the donut reserves the canvas's square, capped at 256px
    expect(block('max-h-64')).toHaveLength(1);
    // each trend card reserves its first/last month row under the canvas
    expect(host.querySelectorAll('[data-slot="trend-months"]')).toHaveLength(2);
  });

  it('F9 off: the roadmap card on AURA, announced once', async () => {
    h.features.f9Dashboard = false;
    const host = await dom();
    expect(host.querySelectorAll('.aura-card')).toHaveLength(1);
    expect(host.querySelector('[data-slot="card"]')).toBeNull();
    expect(host.querySelector('.aura-card__title')).toHaveTextContent('cardTitle');
    expect(announced(host)).toHaveLength(1);
  });
});
