// @vitest-environment jsdom
/**
 * F119 T063 UX review M9 — `/admin/broadcasts/[id]`'s skeleton is announced as
 * busy like the other admin loading states, and fits a 320 px viewport: its
 * header bars are capped (`max-w-*`) rather than fixed widths that overflow.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import AdminBroadcastDetailLoading from '@/app/(staff)/admin/broadcasts/[id]/loading';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

describe('admin E-Blast detail skeleton (M9)', () => {
  it('the container is aria-busy', () => {
    const { container } = render(<AdminBroadcastDetailLoading />);
    expect(container.querySelector('[data-slot="layout-container"]')).toHaveAttribute('aria-busy', 'true');
  });

  it('no skeleton bar has a fixed width wider than a 320 px viewport can hold', () => {
    const { container } = render(<AdminBroadcastDetailLoading />);
    const fixedWide = Array.from(container.querySelectorAll('[data-slot="skeleton"]')).filter((el) =>
      /(?:^|\s)w-(?:7[2-9]|[89]\d)(?:\s|$)/.test(el.className),
    );
    expect(fixedWide).toEqual([]);
  });
});

/**
 * T086a V7 — the skeleton reserved only the round-0 page (one body card). Once
 * a version exists — `in_design`, and every stage after a version was sent —
 * the page renders its content as a two-column grid from `lg`: the version
 * (or the writing tool) first, the member's original beside it. The skeleton
 * cannot know the stage, so it reserves that shape, as the member's sign-off
 * skeleton does: the first card at every width, the second from `lg` only.
 */
describe('admin E-Blast detail skeleton reserves the two-column content grid (T086a V7)', () => {
  it('the content slot is an lg two-column grid: the first card always, the second from lg', () => {
    const { container } = render(<AdminBroadcastDetailLoading />);
    const grid = container.querySelector('[data-skeleton="content-grid"]');
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain('lg:grid-cols-2');

    const cards = Array.from(grid!.children).filter((el) => el.getAttribute('data-slot') === 'card');
    expect(cards).toHaveLength(2);
    // Word-bounded: the Card's own `overflow-hidden` is not a `hidden`.
    expect(cards[0]!.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
    expect(cards[1]!.className).toContain('hidden lg:flex');
  });

  it("each column reserves the page's own preview frame height", () => {
    const { container } = render(<AdminBroadcastDetailLoading />);
    const frames = container.querySelectorAll<HTMLElement>('[data-skeleton="content-grid"] [data-skeleton="preview-frame"]');
    expect(frames).toHaveLength(2);
    for (const frame of frames) expect(frame.style.height).toBe(`${DETAIL_PREVIEW_FRAME_HEIGHT}px`);
  });
});
