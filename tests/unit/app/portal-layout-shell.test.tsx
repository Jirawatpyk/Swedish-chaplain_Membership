/**
 * 057 — portal shell wiring. The portal layout is an async server component
 * (calls requireSession), so we don't render it in jsdom. Instead we pin the
 * pure, statically-checkable contracts:
 *   1. the PORTAL layout (NOT the root) exports a `viewport` with
 *      viewportFit: 'cover' so env(safe-area-inset-bottom) resolves on the
 *      iPhone home-bar ONLY where the member bottom-tab bar needs it (057
 *      review F3 — exporting it at the root leaked `cover` app-wide and broke
 *      admin/auth fixed-bottom UI safe-area);
 *   2. the root layout does NOT export a `viewport` (the leak guard);
 *   3. the portal layout source imports + renders MemberBottomTabs and pads
 *      <main> so the fixed bar never obscures content (WCAG 2.4.11 / review a11y-2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { viewport } from '@/app/(member)/portal/layout';
import * as rootLayout from '@/app/layout';

const portalLayoutSrc = readFileSync(
  resolve(__dirname, '../../../src/app/(member)/portal/layout.tsx'),
  'utf8',
);

describe('portal segment viewport (057 F3)', () => {
  it('the portal layout sets viewportFit to cover', () => {
    expect(viewport.viewportFit).toBe('cover');
  });

  it('the root layout does NOT export a viewport (no app-wide cover leak)', () => {
    expect('viewport' in rootLayout).toBe(false);
  });
});

describe('portal layout shell wiring (057)', () => {
  it('imports and renders MemberBottomTabs', () => {
    expect(portalLayoutSrc).toContain('member-bottom-tabs');
    expect(portalLayoutSrc).toContain('<MemberBottomTabs');
  });

  it('pads <main> bottom on mobile so the fixed tab bar never obscures content', () => {
    // Mobile-only bottom padding (>= bottom-tab height) cleared at lg where
    // the bar is hidden.
    expect(portalLayoutSrc).toMatch(/pb-\[calc\(var\(--bottom-tab-height\)/);
    expect(portalLayoutSrc).toContain('lg:pb-0');
  });
});
