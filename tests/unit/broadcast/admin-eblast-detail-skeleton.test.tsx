// @vitest-environment jsdom
/**
 * F119 T063 UX review M9 — `/admin/broadcasts/[id]`'s skeleton is announced as
 * busy like the other admin loading states, and fits a 320 px viewport: its
 * header bars are capped (`max-w-*`) rather than fixed widths that overflow.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import AdminBroadcastDetailLoading from '@/app/(staff)/admin/broadcasts/[id]/loading';

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
