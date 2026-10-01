/**
 * Spec 122 US7c (T747) — the renewal pages' loading skeletons on AURA.
 *
 * Each skeleton keeps the shape of its page so nothing jumps when the page
 * arrives (ux-standards § 2.1), keeps its one status announcement, and uses
 * the AURA card and the shared skeleton block, not the old kit:
 * - the renewal page: the board's two-column grid from `lg`, the plan and
 *   benefit cards on the left, the confirm card (stepper, select, price band,
 *   full-width CTA) on the right;
 * - the success page: the centred hero, the details card and the actions.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import RenewalPortalLoading from '@/app/(member)/portal/renewal/[memberId]/loading';
import RenewalSuccessLoading from '@/app/(member)/portal/renewal/[memberId]/success/loading';

afterEach(cleanup);

async function renderAsync(component: () => Promise<ReactElement>) {
  return render(await component());
}

describe('renewal page skeleton (US7c)', () => {
  it('announces loading once, and uses AURA cards and skeleton blocks, not the old kit', async () => {
    const { container } = await renderAsync(RenewalPortalLoading);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('announce');
    expect(container.querySelectorAll('.aura-card')).toHaveLength(3);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(10);
  });

  it('lays out the board grid: plan + benefits left, the confirm card right from lg', async () => {
    const { container } = await renderAsync(RenewalPortalLoading);
    const grid = container.querySelector('[class*="lg:grid-cols-[minmax(0,1fr)_420px]"]')!;
    expect(grid).not.toBeNull();
    const [left, confirm] = [...grid.children];
    expect(left!.querySelectorAll('.aura-card')).toHaveLength(2);
    expect(confirm!.className).toMatch(/aura-card/);
    // The confirm card holds the stepper, the select, the price band and the CTA.
    expect(within(confirm as HTMLElement).getByTestId('renewal-skeleton-steps')).toBeInTheDocument();
    expect(confirm!.querySelector('[class*="bg-[var(--aura-bg-surface-hover)]"]')).not.toBeNull();
    const cta = within(confirm as HTMLElement).getByTestId('renewal-skeleton-cta');
    expect(cta.className).toMatch(/w-full/);
    expect(cta.className).toMatch(/h-11/); // the real button is 44px
  });
});

describe('renewal success skeleton (US7c)', () => {
  it('announces loading once and shows the hero, the details card and the actions', async () => {
    const { container } = await renderAsync(RenewalSuccessLoading);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelector('[data-testid="renewal-skeleton-hero"] .rounded-full')).not.toBeNull();
    expect(container.querySelectorAll('.aura-card')).toHaveLength(1);
    expect(container.querySelector('[data-testid="renewal-skeleton-actions"]')!.children).toHaveLength(2);
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    // UX review: the title is not claimed before the page knows the state.
    expect(screen.queryByText('title')).toBeNull();
    for (const block of container.querySelectorAll('[data-testid="renewal-skeleton-actions"] > *')) {
      expect(block.className).toMatch(/h-11/);
    }
  });
});
