/**
 * AURA 5.61 (#176): the full-width page-header actions no longer give a
 * visually hidden child `min-width: max-content`, so the credit note's hidden
 * "Email a copy" description keeps its 1px box on a phone. The app needs no
 * `.sr-only { min-width: 0 }` of its own; this guards that the stand-in is gone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../../../src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('globals.css: AURA sizes visually hidden children itself', () => {
  it('sets no min-width on .sr-only (AURA 5.61 skips hidden children, #176)', () => {
    expect(css).not.toMatch(/\.sr-only\s*\{[^}]*min-width/);
  });
});
