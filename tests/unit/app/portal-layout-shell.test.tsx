/**
 * 057 — portal shell wiring. The portal layout is an async server component
 * (calls requireSession), so we don't render it in jsdom. Instead we pin the
 * two pure, statically-checkable contracts:
 *   1. the root layout exports a `viewport` with viewportFit: 'cover' so
 *      env(safe-area-inset-bottom) resolves on the iPhone home-bar (review a11y-1);
 *   2. the portal layout source imports + renders MemberBottomTabs and pads
 *      <main> so the fixed bar never obscures content (WCAG 2.4.11 / review a11y-2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { viewport } from '@/app/layout';

const portalLayoutSrc = readFileSync(
  resolve(__dirname, '../../../src/app/(member)/portal/layout.tsx'),
  'utf8',
);

describe('root layout viewport (057)', () => {
  it('sets viewportFit to cover', () => {
    expect(viewport.viewportFit).toBe('cover');
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
