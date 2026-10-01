/**
 * Reminder schedules loading skeleton — 122 US7b-2 (T738): the editor's shape
 * on AURA skeleton blocks (tier tabs, the tier heading, the chart, step cards,
 * the save bar) inside the page's FormContainer.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

import Loading from '@/app/(staff)/admin/settings/renewals/schedules/loading';

async function dom(): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup((await Loading()) as ReactElement);
  return host;
}

describe('reminder schedules loading skeleton', () => {
  it('uses AURA skeleton blocks only, announced once', async () => {
    const host = await dom();
    expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(host.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('draws the tabs, the chart, the step cards and the save bar in that order', async () => {
    const host = await dom();
    const order = ['tabs-skeleton', 'chart-skeleton', 'step-skeleton', 'save-bar-skeleton'].map((slot) =>
      host.querySelector(`[data-slot="${slot}"]`),
    );
    order.forEach((n) => expect(n).not.toBeNull());
    // The chart is a fixed 80px tall at every width, so its placeholder is too
    // (an aspect ratio shrank it to ~41px on a phone and the page jumped).
    expect(order[1]!.querySelector('.h-20')).not.toBeNull();
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('keeps the form layout container (structural parity with the page)', async () => {
    const host = await dom();
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'form');
  });
});
