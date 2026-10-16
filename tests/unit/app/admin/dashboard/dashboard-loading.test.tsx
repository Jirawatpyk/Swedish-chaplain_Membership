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

  it('F9 off: the roadmap card on AURA, announced once', async () => {
    h.features.f9Dashboard = false;
    const host = await dom();
    expect(host.querySelectorAll('.aura-card')).toHaveLength(1);
    expect(host.querySelector('[data-slot="card"]')).toBeNull();
    expect(host.querySelector('.aura-card__title')).toHaveTextContent('cardTitle');
    expect(announced(host)).toHaveLength(1);
  });
});
