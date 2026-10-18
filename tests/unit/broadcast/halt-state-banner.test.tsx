/**
 * Spec 122 US12b UX review M3 — the halted member's name on the halt banner is
 * a link that looks like one (accent ink, board `Admin-broadcasts`) and is a
 * 44 px target on a phone; on a phone the row stacks so "Review + clear halt"
 * spans the row.
 *
 * `HaltStateBanner` is an async Server Component: resolve it first and render
 * the element (the `sla-banner.test.tsx` pattern, echo translator).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    return (key: string, params?: Record<string, unknown>): string =>
      params ? `${key}:${JSON.stringify(params)}` : key;
  }),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('@/components/broadcast/admin/clear-halt-dialog', () => ({
  HALT_BANNER_HEADING_ID: 'halt-banner-heading',
  ClearHaltDialog: () => <button type="button">clear</button>,
}));

import { HaltStateBanner } from '@/components/broadcast/admin/halt-state-banner';

afterEach(cleanup);

const halted = [{ memberId: 'm1', displayName: 'Andaman Marine Tech Co., Ltd.', haltedSinceAt: new Date('2026-09-12T02:00:00Z') }];

describe('<HaltStateBanner> (US12b UX review M3)', () => {
  it('the member link is accent ink and a 44 px target below sm', async () => {
    render(await HaltStateBanner({ halted }));
    const link = screen.getByRole('link', { name: 'Andaman Marine Tech Co., Ltd.' });
    expect(link).toHaveAttribute('href', '/admin/members/m1');
    expect(link).toHaveClass('text-[var(--aura-fg-accent)]', 'min-h-11', 'sm:min-h-0');
  });

  it('on a phone the row stacks so the clear-halt action spans it', async () => {
    render(await HaltStateBanner({ halted }));
    const row = screen.getByRole('link', { name: 'Andaman Marine Tech Co., Ltd.' }).closest('li');
    expect(row).toHaveClass('max-sm:flex-col', 'max-sm:items-stretch');
  });
});
