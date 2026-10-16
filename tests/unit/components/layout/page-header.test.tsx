/**
 * `<PageHeader>` — the title keeps the app's type scale.
 *
 * AURA's title defaults to 28 / 36px; the boards draw 26 / 32px (hero 30, and
 * 36 from 1024px), which globals.css keeps in `--font-size-h1` per
 * `data-size`. AURA reads `--aura-page-header-title-size` / `-line-height`
 * (#151), so the stylesheet points those at our scale for every header.
 * jsdom has no cascade from globals.css, so the rule itself is the contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../../../src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('<PageHeader> title size', () => {
  it('globals.css points AURA’s title size at the app’s h1 scale on every page header', () => {
    const rule = css.match(/\[data-slot='page-header'\]\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/--aura-page-header-title-size:\s*var\(--font-size-h1\)/);
    expect(rule?.[1]).toMatch(/--aura-page-header-title-line-height:\s*1\.2/);
  });
});
