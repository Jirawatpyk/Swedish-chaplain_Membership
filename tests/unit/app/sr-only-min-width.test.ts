/**
 * Stand-in until AURA #176. Below 640px AURA's full-width page-header actions
 * give every direct child `min-width: max-content`. That rule beat the 1px
 * `.sr-only` width of the credit note's hidden "Email a copy" description,
 * which then ran 636px wide and scrolled the page sideways. A visually hidden
 * element never needs a minimum width, so globals.css says so, in the
 * utilities layer that comes after AURA's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../../src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('globals.css: a visually hidden element has no minimum width', () => {
  it('sets .sr-only { min-width: 0 } in the utilities layer', () => {
    const layer = /@layer utilities\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(layer).toMatch(/\.sr-only\s*\{[^}]*min-width:\s*0\s*;?[^}]*\}/);
  });
});
