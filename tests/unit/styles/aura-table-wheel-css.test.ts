/**
 * The mouse wheel over a table scrolls the page (maintainer, 19 Oct 2026).
 * AURA's `.aura-table__scroll` sets `overscroll-behavior: contain` on both
 * axes, so once the box scrolls sideways (even by a fraction of a pixel) a
 * vertical wheel stops at the box and the page never moves. The page keeps
 * the sideways containment (no trackpad back-swipe inside a wide table) and
 * lets the vertical axis chain (stand-in until AURA #163).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('the wheel over a DataTable scrolls the page', () => {
  it('lets the table box pass vertical scrolling on to the page, inside a layer after AURA', () => {
    const at = css.indexOf('.aura-table__scroll {');
    expect(at, '.aura-table__scroll rule').toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toMatch(/overscroll-behavior-y:\s*auto/);
    expect(rule).not.toMatch(/overscroll-behavior-x:\s*auto/);
    // Inside `@layer components`, which the layer order puts after `aura`.
    const layerStart = css.lastIndexOf('@layer components {', at);
    expect(layerStart).toBeGreaterThan(-1);
    expect(css.lastIndexOf('@layer base {', at)).toBeLessThan(layerStart);
  });
});
