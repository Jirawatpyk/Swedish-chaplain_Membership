/**
 * `<PageHeader>` — the title and the room above a hero page come from AURA.
 *
 * AURA 5.47 (#152) ships the boards' sizes as options: `size="compact"` is
 * the 26 / 32px title every ordinary page uses, `hero` grows to 36px from
 * 1024px, and `--aura-page-header-hero-space` sets the room above a hero
 * title. So the wrapper picks AURA's size, the portal sets AURA's hero-space
 * property to land the boards' 24 / 40px, and globals.css neither re-sizes
 * AURA's title nor pads a hero page itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { PageHeader } from '@/components/layout/page-header';

afterEach(cleanup);

const css = readFileSync(join(__dirname, '../../../../src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('<PageHeader> sizes are AURA’s', () => {
  it('an ordinary page takes AURA’s compact title; hero sizes pass through', () => {
    const { container, rerender } = render(<PageHeader title="Members" />);
    const root = () => container.querySelector('[data-slot="page-header"]');
    expect(root()).toHaveClass('aura-page-header--compact');
    rerender(<PageHeader title="Hi Anna" size="hero" />);
    expect(root()).toHaveClass('aura-page-header--hero');
    rerender(<PageHeader title="Benefits" size="hero-lg" />);
    expect(root()).toHaveClass('aura-page-header--hero-lg');
  });

  it('the portal lands the boards’ room above a hero title through AURA’s property (24px, 40px from 1024px)', () => {
    // The portal pads its pages 20px, 2rem from 1024px; AURA adds the property.
    expect(css).toMatch(/\.chamber-portal\s*\{[^}]*--aura-page-header-hero-space:\s*4px/);
    expect(css).toMatch(/@media \(min-width: 1024px\)\s*\{[\s\S]*?\.chamber-portal\s*\{[^}]*--aura-page-header-hero-space:\s*8px/);
  });

  it('globals.css does not override AURA’s title size or pad a hero page itself', () => {
    expect(css).not.toMatch(/--aura-page-header-title-(size|line-height)/);
    // Any rule keyed on a hero header may space sections apart, but sets
    // neither the title size nor the page's top padding.
    for (const m of css.matchAll(/[^{}]*data-size='hero[^{}]*\{([^}]*)\}/g)) {
      expect(m[1]).not.toMatch(/--font-size-h1|--page-padding-y/);
    }
  });
});
