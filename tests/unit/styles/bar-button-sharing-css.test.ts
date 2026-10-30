/**
 * PR #697 maintainer review (30 Oct 2026) — two bars the form-bar rules did
 * not cover:
 *   - the invoice settings save bar joins the form bars: on a phone Discard
 *     takes a third and Save two thirds of the strip, as Cancel and the
 *     primary do; from 640px the status, Discard and Save share one row
 *     (board `Admin-invoice-settings`);
 *   - the renewals bulk bar on a phone: "1 selected" and Clear selection on
 *     the first row, Send reminder and Mark paid side by side on the second,
 *     so Mark paid never drops onto a third row.
 * Only the app's class and the bar's element structure (inner row → status,
 * [start,] actions) are read, never AURA's own classes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

/** The declarations of the first rule with exactly this selector inside a block opening with `media`. */
function ruleIn(media: string, selector: string): string | null {
  const at = css.indexOf(media);
  if (at === -1) return null;
  const sel = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const m = new RegExp(`(?:^|[}\\s])${sel}\\s*\\{([^}]*)\\}`).exec(css.slice(at));
  return m ? m[1]!.trim() : null;
}

const PHONE = '@media (max-width: 639.98px) {\n  /* PR #697 review';

describe('invoice settings save bar', () => {
  it('on a phone, shares the strip by the form bars\u2019 rules (Discard a third, Save two thirds)', () => {
    for (const tail of ['> div {', '> div > :last-child {', '> div > :last-child > * {', '> div > :last-child > :first-child:not(:last-child) {']) {
      const rule = css.split('\n').find((l) => l.includes('.template-form-actions') && l.trimEnd().endsWith(tail));
      expect(rule, tail).toContain('.invoice-settings-actions');
    }
  });
});

describe('renewals bulk bar on a phone', () => {
  it('lays the count and Clear on one row, the two actions side by side on the next', () => {
    expect(ruleIn(PHONE, '.pipeline-bulk-actions > div')).toMatch(/grid-template-columns:\s*1fr 1fr/);
    expect(ruleIn(PHONE, '.pipeline-bulk-actions > div > :last-child')).toMatch(/display:\s*contents/);
    expect(ruleIn(PHONE, '.pipeline-bulk-actions > div > :last-child > :first-child')).toMatch(/justify-self:\s*end/);
  });
});
