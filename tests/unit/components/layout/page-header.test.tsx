/**
 * `<PageHeader>` — the title and the room above a hero page are AURA's.
 *
 * Spec 122's parity rule: AURA's defaults win on sizes and spacing; a board
 * value that is better goes to the AURA handoff, never into an override. So
 * the wrapper hands `size` to AURA (its hero sizes and the 16px above), and
 * globals.css neither re-sizes AURA's title nor pads a hero page itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { PageHeader } from '@/components/layout/page-header';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '../../../../src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('<PageHeader> sizes are AURA’s', () => {
  it('hands size to AURA', () => {
    const { container, rerender } = render(<PageHeader title="Hi Anna" size="hero" />);
    const root = () => container.querySelector('[data-slot="page-header"]');
    expect(root()).toHaveClass('aura-page-header--hero');
    rerender(<PageHeader title="Benefits" size="hero-lg" />);
    expect(root()).toHaveClass('aura-page-header--hero-lg');
    rerender(<PageHeader title="Members" />);
    expect(root()?.className).not.toMatch(/aura-page-header--hero/);
  });

  it('globals.css does not override AURA’s title size or pad a hero page itself', () => {
    expect(css).not.toMatch(/--aura-page-header-title-(size|line-height)/);
    expect(css).not.toMatch(/\[data-slot='page-header'\]\[data-size=/);
    expect(css).not.toMatch(/\[data-slot='page-header'\]:is\(\[data-size=/);
  });
});
