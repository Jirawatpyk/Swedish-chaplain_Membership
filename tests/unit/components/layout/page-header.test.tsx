/**
 * `<PageHeader>` — the title column keeps a minimum width beside the actions.
 *
 * From 640px the header is one wrapping row. The title column is `flex-1
 * min-w-0` (a zero basis), so without a minimum the actions never wrap: they
 * squeeze the title instead. At 700px the member detail page's four actions
 * left its h1 a few characters wide, cut mid-word ("Sia / m / Nor / dic").
 * A minimum width on the title column makes the actions drop under it when
 * the row is too narrow for both (jsdom has no layout, so the class is the
 * contract).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PageHeader } from '@/components/layout/page-header';

describe('<PageHeader>', () => {
  it('gives the title column a minimum width, so the actions wrap under it instead of squeezing it', () => {
    const { container } = render(<PageHeader title="Siam Nordic Trading Co., Ltd." actions={<button type="button">Edit</button>} />);
    const titleColumn = container.querySelector('[data-slot="page-header-title"]')?.closest('[data-slot="page-header"] > div');
    expect(titleColumn?.className).toContain('sm:min-w-[min(100%,18rem)]');
  });
});
