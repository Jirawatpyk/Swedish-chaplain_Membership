/**
 * AURA 5.71 (#191) — the portal invoice's phone pay bar is PageHeader's
 * `actionsBar` strip, so AURA pads the page for it and the app's own
 * `.portal-pay-bar` scroll padding is gone. While PaySheet's optimistic-paid
 * signal hides the pay bar (it hides, never unmounts: R7), the strip that
 * holds it hides too, read by structure, never by AURA's class, so no empty
 * band waits for `router.refresh()`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('portal pay bar on AURA PageHeader (#191)', () => {
  it('keeps no scroll padding of its own', () => {
    expect(css).not.toContain('.portal-pay-bar');
  });

  it('hides the strip that holds a hidden pay bar, only when nothing else is in it', () => {
    const rule = /\[data-slot="page-header"\] :has\(> \[data-slot="pay-bar"\]\[hidden\]\):not\(:has\(> :not\(\[data-slot="pay-bar"\], \[role="status"\]\)\)\) \{\s*display: none;/;
    expect(css).toMatch(rule);
    // An AURA gap, labelled so it is removed when AURA hides such a strip.
    const at = css.search(rule);
    expect(css.slice(Math.max(0, at - 600), at)).toContain('stand-in until AURA #193');
  });
});
