/**
 * Spec 122 US12c-1 (UX review) — the staff E-Blast detail's action row on a
 * phone. With four actions it wraps onto two lines (~104px plus the safe
 * area), so the lines follow the DOM order (Cancel / Reject first, the next
 * step after, WCAG 2.4.3). A focused control scrolls clear of it (WCAG 2.4.11)
 * by AURA's measured edge-strip padding below 640px and the bar's own measured
 * clearance from 640px (D-039; `use-action-bar-clearance.test.ts`).
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

  it('keeps no fixed 8rem allowance of its own: AURA measures the two-line strip (D-039)', () => {
    expect(css).not.toContain('html:has(.eblast-detail-actions)');
  });

  it('keeps Reject · next step · ⋯ on one line: the next step shrinks and wraps its label (parity, 20 Oct)', () => {
    const group = ruleAfter('.eblast-detail-actions > div > :last-child {');
    expect(group).toMatch(/flex:\s*1 1 0;/);
    expect(group).toMatch(/flex-wrap:\s*nowrap;/);
    expect(group).toMatch(/min-width:\s*0;/);
    const next = ruleAfter('.eblast-detail-actions > div > :last-child > button {');
    expect(next).toMatch(/min-width:\s*0;/);
    expect(next).toMatch(/white-space:\s*normal;/);
    // 44px comes from AURA 5.54's ActionBar rule (#166), as on every other bar.
    expect(next).toMatch(/height:\s*auto;/);
    expect(next).not.toMatch(/min-height/);
  });

  it('leaves the 44px minimum to AURA: no min-height of its own on any bar button (AURA 5.54, #166)', () => {
    const block = css.slice(css.indexOf('.eblast-detail-actions > div {'), css.indexOf("/* The plan wizard's Back / Next share"));
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/min-height/);
  });

  it('shows the status line on a phone only; from 640px the row is buttons alone, as the desktop board', () => {
    const at = css.indexOf('@media (min-width: 640px)', css.indexOf('.eblast-detail-actions > div > :last-child > button {'));
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(css.indexOf('.eblast-detail-actions > div > :first-child {', at));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/display:\s*none;/);
  });

  it('stretches the next step across the free space even when it sits in a wrapper (Approve inside ReviewActions)', () => {
    const wrapper = ruleAfter('.eblast-detail-actions > div > :last-child > div {');
    expect(wrapper).toMatch(/flex:\s*1 1 auto;/);
    expect(wrapper).toMatch(/min-width:\s*0;/);
    const inner = ruleAfter('.eblast-detail-actions > div > :last-child > div > button,');
    expect(inner).toMatch(/flex:\s*1 1 auto;/);
  });

  it('gives Reject the free space when ⋯ is the only control at the end (design state, board `Admin-eblast-design-mobile`)', () => {
    const only = '.eblast-detail-actions > div:has(> :last-child > [data-more-actions]:only-child)';
    expect(ruleAfter(`${only} > :last-child {`)).toMatch(/flex:\s*0 0 auto;/);
    const start = ruleAfter(`${only} > :nth-child(2) {`);
    expect(start).toMatch(/flex:\s*1 1 0;/);
    expect(start).toMatch(/min-width:\s*0;/);
    expect(ruleAfter(`${only} > :nth-child(2) > div {`)).toMatch(/flex:\s*1 1 auto;/);
    expect(ruleAfter(`${only} > :nth-child(2) > div > button {`)).toMatch(/flex:\s*1 1 auto;/);
  });

  it('reaches the bottom edge as AURA's strip: no negative margin of its own (D-039)', () => {
    // AURA pads the page's end by the strip's height (pinned-bar-edge-css.test.ts).
    expect(css).not.toMatch(/\.eblast-detail-actions\)\s*\{\s*margin-bottom/);
  });
});
