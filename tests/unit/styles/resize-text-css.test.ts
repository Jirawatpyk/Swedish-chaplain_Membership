/**
 * PR #530 (relay R34b, WCAG 1.4.4): offsets that must follow the text size.
 * At 200% text a fixed px offset no longer matches the box it offsets.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('offsets that follow the text size (WCAG 1.4.4)', () => {
  it('hides the skip link by its own height, not a fixed -40px (half of it showed at 200%)', () => {
    const hidden = rule('.skip-to-content');
    expect(hidden).not.toMatch(/top:\s*-40px/);
    expect(hidden).toMatch(/transform:\s*translateY\(-100%\)/);
    expect(rule('.skip-to-content:focus')).toMatch(/transform:\s*none/);
  });

  it("stops the sticky E-Blast panes below the bar's measured height (AppShell writes it), not a fixed 56px", () => {
    expect(rule('  .chamber-shell')).toMatch(/--shell-bar-height:\s*var\(--aura-shell-bar-height,\s*56px\)/);
  });
});
