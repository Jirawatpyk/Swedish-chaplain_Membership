/**
 * AURA 5.71 (#191) — the portal invoice's phone pay bar is PageHeader's
 * `actionsBar` strip, so AURA pads the page for it and the app's own
 * `.portal-pay-bar` scroll padding is gone. AURA 5.74 (#193) hides a strip
 * whose content is all hidden (the pay bar on PaySheet's optimistic-paid
 * signal) and drops its page padding, so the app keeps no rule of its own
 * for it either.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

describe('portal pay bar on AURA PageHeader (#191, #193)', () => {
  it('keeps no scroll padding of its own', () => {
    expect(css).not.toContain('.portal-pay-bar');
  });

  it('keeps no rule hiding the strip: AURA 5.74 does it', () => {
    expect(css).not.toContain('[data-slot="pay-bar"]');
    expect(css).not.toContain('stand-in until AURA #193');
  });
});
