/**
 * F119 T007 — byte-identical wrapper baseline (PR-1 merge blocker).
 *
 * PR-1 ships UNFLAGGED into live outgoing email: `renderBroadcastHtml` gains
 * a logo header, a footer postal address and the post-sanitise design-block
 * pass. Spec § Feature flag: "the email produced with no brand data and no
 * design block MUST be byte-identical to today's output; that snapshot test
 * is a merge blocker for the unflagged tool upgrade" (plan Amendment 2).
 *
 * The fixtures under `__fixtures__/render-broadcast-html-baseline/` were
 * written by the wrapper as it stood on `main` at 2026-09-18 (5f602fd30),
 * BEFORE any F119 edit — they are the definition of "today", so they are
 * never regenerated. A wrapper change that alters this case must be a
 * deliberate, reviewed decision that rewrites the fixture by hand.
 *
 * Deliberate rewrite, 2026-09-26 (E-Blast PDPA/GDPR follow-up, after #418):
 * the footer's "why you receive this" line no longer claims every recipient
 * is a member's contact (the attendee segment is not), and a new line states
 * the opt-out covers every E-Blast from the chamber and links the privacy
 * inbox. The diff was checked to be exactly those two footer paragraphs;
 * header, body cell and every other byte are unchanged.
 *
 * The positive control proves the comparison bites: a one-character change
 * to the rendered output must fail the byte comparison.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBroadcastHtml } from '@/modules/broadcasts/infrastructure/resend/email-template';
import { BASELINE_CASES, FIXTURE_DIR } from './render-broadcast-html-baseline.cases';

function baseline(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.html`), 'utf8');
}

describe('renderBroadcastHtml — no brand, no blocks → byte-identical to the 2026-09-18 baseline', () => {
  for (const c of BASELINE_CASES) {
    it(`${c.input.locale}: the rendered HTML equals the committed baseline byte for byte`, () => {
      const html = renderBroadcastHtml(c.input);
      const expected = baseline(c.name);
      // Length first so a mismatch reports the size delta, not a 1.8 KB diff.
      expect(html.length).toBe(expected.length);
      expect(html).toBe(expected);
    });
  }

  it('positive control: a one-character change to the input is NOT byte-identical', () => {
    const c = BASELINE_CASES[0]!;
    const html = renderBroadcastHtml({ ...c.input, subject: `${c.input.subject}!` });
    expect(html).not.toBe(baseline(c.name));
  });

  it('positive control: the fixture set covers every locale the wrapper renders', () => {
    // A fixture that goes missing would otherwise turn a locale's guard into
    // "nothing to compare" — a check that cannot tell "nothing to find" from
    // "not looking" is not a check.
    const locales = BASELINE_CASES.map((c) => c.input.locale).sort();
    expect(locales).toEqual(['en', 'sv', 'th']);
    for (const c of BASELINE_CASES) expect(baseline(c.name).length).toBeGreaterThan(1000);
  });
});
