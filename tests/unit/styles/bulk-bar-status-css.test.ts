/**
 * Spec 122 follow-up (maintainer, 22 Oct) — the bulk bars keep the count and
 * the buttons on one line when they fit. AURA's status cell asks for at least
 * 8rem; "1 selected" is about half that, so at 1440 the members bar's count
 * (8rem + 917px of buttons > its 1041px row) dropped onto a line of its own.
 * The count cell takes its text's width instead; a narrower bar still wraps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('the bulk bars’ count cell', () => {
  it('takes the width of its text, at every width', () => {
    const selector = '.chamber-bulk-actionbar > div > :first-child {';
    const at = css.indexOf(selector);
    expect(at, `${selector} not found`).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf('}', at))).toMatch(/flex-basis:\s*auto;/);
  });
});
