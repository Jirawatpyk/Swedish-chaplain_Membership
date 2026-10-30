/**
 * D-039 (the maintainer, 29 Oct 2026; AURA #185, 5.69) — below 640px every
 * viewport bar is AURA's edge strip (`edgeBelow="sm"`): AURA spans the screen,
 * sits on the bottom edge and pads the page's end by the bar's measured height.
 * The app's own edge rules (negative margins to reach the screen edges, the
 * page's bottom padding taken under the bar, `bottom: 0`) and its from-640px
 * static row are gone, so nothing fights AURA's strip or its floating card.
 * (Spec 122 US12c-1 follow-up, 20 Oct, had these in globals.css.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');
const BARS = /\.(?:member-form-actions|plan-form-actions|schedule-actions|template-form-actions|eblast-detail-actions)\b/;

/** Every rule whose selector names one of the form bars itself (not a child of it). */
function barRules(): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => BARS.test(m[1]!) && !/>\s*(?:div|:)/.test(m[1]!))
    .map((m) => `${m[1]!.trim()} { ${m[2]!.trim()} }`);
}

describe('pinned phone bars are AURA’s edge strip (D-039)', () => {
  it('finds the form bars’ rules (positive control)', () => {
    expect(css).toMatch(BARS);
  });

  it('no rule moves a form bar itself: no margins, bottom, position, width, border or shadow of the app’s own', () => {
    expect(barRules().filter((r) => /\b(?:margin|bottom|position|width|border|box-shadow)\s*:/.test(r))).toEqual([]);
  });

  it('the viewport bars’ fixed scroll allowance applies only from 640px, where the bar is the sticky card', () => {
    const at = css.indexOf('html:has(.chamber-viewport-actionbar) {');
    expect(at).toBeGreaterThan(-1);
    const media = css.lastIndexOf('@media', at);
    expect(css.slice(media, at)).toMatch(/@media \(min-width: 640px\) and \(min-height: 30\.01rem\)/);
  });
});
