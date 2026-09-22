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
 *   1. the skeleton renders three card regions, in the page's order;
 *   2. the middle one reserves a frame whose height is the SAME constant the
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
  it('renders three card regions, not two', async () => {
    const { default: Loading } = await import(
      '@/app/(member)/portal/broadcasts/[id]/loading'
    );
    render(await Loading());

    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(3);
  });

  it('the middle card reserves the frame height the page passes PreviewSurface', async () => {
    const { default: Loading } = await import(
      '@/app/(member)/portal/broadcasts/[id]/loading'
    );
    render(await Loading());

    const frame = screen.getByTestId('detail-content-frame-skeleton');
    // The reservation is the page's own constant — a change to one is a
    // change to both, or this fails.
    expect(frame.style.height).toBe(`${DETAIL_PREVIEW_FRAME_HEIGHT}px`);

    // …and it sits in the SECOND card, between fields and delivery.
    const cards = Array.from(document.querySelectorAll('[data-slot="card"]'));
    expect(cards[1]?.contains(frame)).toBe(true);
  });
});
