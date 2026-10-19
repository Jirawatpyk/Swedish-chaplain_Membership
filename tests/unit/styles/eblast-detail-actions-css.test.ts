/**
 * Spec 122 US12c-1 (UX review) — the staff E-Blast detail's action row on a
 * phone. With four actions it wraps onto two lines (~104px plus the safe
 * area), so: the lines follow the DOM order (Cancel / Reject first, the next
 * step after, WCAG 2.4.3), and a focused control scrolls clear of the pinned
 * bar (WCAG 2.4.11), which the shared 5.5rem pad is too short for.
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

describe('the E-Blast detail action row on a phone', () => {
  it('wraps in DOM order, never reversed', () => {
    const rule = ruleAfter('.eblast-detail-actions > div {');
    expect(rule).toMatch(/flex-wrap:\s*wrap;/);
    expect(rule).not.toMatch(/wrap-reverse/);
  });

  it('keeps a focused control clear of its two-line bar', () => {
    const rule = ruleAfter('html:has(.eblast-detail-actions) {');
    expect(rule).toMatch(/scroll-padding-bottom:\s*calc\(var\(--aura-bottomnav-offset, 0px\) \+ 8rem/);
  });
});
