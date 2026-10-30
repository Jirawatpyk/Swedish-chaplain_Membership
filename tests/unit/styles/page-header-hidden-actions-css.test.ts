/**
 * PR #697 maintainer review (30 Oct 2026) — a page's back link sits in the
 * header's actions and hides below 1024px (`max-lg:hidden`), but the empty
 * actions cell stayed: below 640px the header stacks, so it added a 16px gap
 * under the subtitle (member new / edit, invoice new, the registers, import
 * history, member timeline and benefits). The cell now hides with the last
 * of its children, read through the app's `data-slot`, never AURA's classes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

function block(media: string): string {
  const at = css.indexOf(`${media} {\n  /* PR #697 review — the page header`);
  return at === -1 ? '' : css.slice(at, css.indexOf('\n}\n', at));
}

describe('page header: an actions cell whose actions are all hidden takes no room', () => {
  it('below 1024px, when every action is `max-lg:hidden`', () => {
    expect(block('@media (max-width: 1023.98px)')).toContain(
      '[data-slot="page-header"] > :last-child:not(:first-child):not(:has(> :not(.max-lg\\:hidden)))',
    );
  });

  it('below 640px, also when they are `max-sm:hidden` or `max-md:hidden`', () => {
    expect(block('@media (max-width: 639.98px)')).toContain(
      ':not(:has(> :not(.max-lg\\:hidden, .max-md\\:hidden, .max-sm\\:hidden)))',
    );
  });
});
