/**
 * Spec 122 — the renewal pipeline's route-level loading skeleton draws the
 * work-queue table as the page does: AURA's DataTable in its loading state
 * with the pipeline's columns, edge to edge inside the card (`bleed`), so
 * nothing moves when the rows arrive.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));

const { default: Loading } = await import('@/app/(staff)/admin/renewals/loading');

describe('renewal pipeline loading', () => {
  it('draws the pipeline table edge to edge inside the work-queue card', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        {(await Loading()) as ReactElement}
      </NextIntlClientProvider>,
    );
    const table = host.querySelector('.aura-card .aura-bleed');
    expect(table).not.toBeNull();
    expect(table?.closest('[aria-hidden="true"]')).not.toBeNull();
    // the bulk bar and "Next 50" can follow the table, so it does not end the card
    expect(host.querySelector('.aura-card .aura-bleed-end')).toBeNull();
    const heads = [...host.querySelectorAll('.aura-card [role="columnheader"]')].map((h) => h.textContent?.trim());
    // after the checkbox column's own header
    expect(heads.filter((h) => h?.startsWith('columns.')).slice(0, 4)).toEqual(['columns.tier', 'columns.company', 'columns.expires', 'columns.urgency']);
  });

  it('draws the admin\'s checkbox column, AURA\'s own cards on a phone (5.29, #134), and announces the load once (UX review M2, L2)', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        {(await Loading()) as ReactElement}
      </NextIntlClientProvider>,
    );
    expect(host.querySelector('.aura-bleed .aura-table__sel')).not.toBeNull();
    expect(host.querySelector('.aura-bleed')?.closest('[aria-hidden="true"]')).not.toHaveClass('max-sm:hidden');
    expect(host.querySelector('[data-slot="phone-cards-skeleton"]')).toBeNull();
    // Send reminder and ⋯ fill the card's last row at touch height
    expect(host.querySelector('.aura-table__row--skeleton .aura-skel--action.is-footer.is-touch')).not.toBeNull();
    const announced = [...host.querySelectorAll('[role="status"]')].filter((el) => !el.closest('[aria-hidden="true"]'));
    expect(announced).toHaveLength(1);
    expect(host.querySelector('[data-slot="layout-container"]')).toHaveAttribute('aria-busy', 'true');
  });
});
