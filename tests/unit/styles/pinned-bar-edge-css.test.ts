/**
 * Spec 122 US12c-1 follow-up (maintainer, 20 Oct) — every pinned phone bar
 * meets the screen edge at the end of the scroll. The bar is each form's last
 * element, so it takes the page's bottom padding (and, for a bar inside its
 * card, the card's padding and border too) instead of leaving it as a strip
 * under the bar: measured at 390, member and plan forms 32px, template and
 * clone forms 49px.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

function ruleAfter(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('pinned phone bars reach the screen edge', () => {
  it('every pinned bar takes the page bottom padding', () => {
    const rule = ruleAfter(
      ':is(.member-form-actions, .plan-form-actions, .schedule-actions, .template-form-actions, .eblast-detail-actions) {\n    margin-bottom: calc(-1 * var(--page-padding-bottom));',
    );
    expect(rule).toMatch(/margin-bottom:\s*calc\(-1 \* var\(--page-padding-bottom\)\);/);
  });

  it('a bar inside its card also takes the card padding and border', () => {
    const rule = ruleAfter('.plan-form-actions--in-card,\n  .template-form-actions {\n    margin-inline');
    expect(rule).toMatch(/margin-bottom:\s*calc\(-1 \* \(var\(--page-padding-bottom\) \+ var\(--aura-space-4\) \+ 1px\)\);/);
  });
});
