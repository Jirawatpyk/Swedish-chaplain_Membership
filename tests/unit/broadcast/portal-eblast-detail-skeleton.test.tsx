// @vitest-environment jsdom
/**
 * F119 T155 finding U1 — `/portal/broadcasts/[id]`'s skeleton must reserve
 * what the page renders.
 *
 * `loading.tsx` drew TWO cards (fields, delivery). Since T141 the page renders
 * THREE: the content card — a 560 px preview frame plus its heading — is
 * inserted BETWEEN them, so the delivery card jumped ~640 px down the moment
 * the page settled. That is the largest layout shift in the feature and it is
 * invisible to the axe suite.
 *
 * Pinned here, on structure rather than on pixels jsdom cannot measure:
 *   1. the skeleton renders the page's regions in the page's order — since
 *      F119 T086 the sign-off shape: the stage banner, the fields card, the
 *      compare grid (formatted first; the original beside it at ≥ lg only) —
 *      and, since T086a V5, NOT the delivery card, which the page renders only
 *      once sending has begun;
 *   2. the formatted frame reserves a height that is the SAME constant the
 *      page passes `PreviewSurface` — imported, not retyped, so the two can
 *      never drift by a number again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue(
    Object.assign((key: string) => key, { has: () => true }),
  ),
}));

beforeEach(() => {
  cleanup();
});

describe('portal E-Blast detail skeleton reserves the page it precedes (U1)', () => {
  it('renders the stage banner, then the fields card and the content grid — no delivery card', async () => {
    const { default: Loading } = await import(
      '@/app/(member)/portal/broadcasts/[id]/loading'
    );
    render(await Loading());

    // F119 T086 — fields · formatted · original (≥ lg). T086a V5: the
    // delivery card is NOT reserved — the page renders it only once sending
    // has begun, and on the sign-off stages this view exists for, the
    // decision controls and the history sit in that slot instead.
    const cards = Array.from(document.querySelectorAll('[data-slot="card"]'));
    expect(cards).toHaveLength(3);
    // The banner is reserved ABOVE the fields card, as the page renders it.
    const banner = screen.getByTestId('detail-stage-banner-skeleton');
    expect(banner.compareDocumentPosition(cards[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('T086a V5: the fields card has a header (the overline + the subject heading), as the page does', async () => {
    const { default: Loading } = await import(
      '@/app/(member)/portal/broadcasts/[id]/loading'
    );
    render(await Loading());

    const fields = document.querySelectorAll('[data-slot="card"]')[0]!;
    const header = Array.from(fields.children).find((el) => el.getAttribute('data-slot') === 'card-header');
    expect(header).toBeDefined();
    // The overline label and the subject heading — two bars, as `page.tsx`.
    expect(header!.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(2);
  });

  it('the formatted frame reserves the height the page passes PreviewSurface, first in the grid', async () => {
    const { default: Loading } = await import(
      '@/app/(member)/portal/broadcasts/[id]/loading'
    );
    render(await Loading());

    const frame = screen.getByTestId('detail-content-frame-skeleton');
    // The reservation is the page's own constant — a change to one is a
    // change to both, or this fails.
    expect(frame.style.height).toBe(`${DETAIL_PREVIEW_FRAME_HEIGHT}px`);

    // …and it sits in the SECOND card (the grid's first), after the fields
    // card; the original's frame beside it is reserved at ≥ lg only.
    const cards = Array.from(document.querySelectorAll('[data-slot="card"]'));
    expect(cards[1]?.contains(frame)).toBe(true);
    const original = screen.getByTestId('detail-original-frame-skeleton');
    expect(cards[2]?.contains(original)).toBe(true);
    expect(cards[2]?.className).toContain('hidden lg:flex');
  });
});
