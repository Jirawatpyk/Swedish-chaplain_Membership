/**
 * Spec 122 FR-002 / FR-003 — the AURA foundation in `src/app/globals.css`
 * (contracts/css-layers.md): layer order, imports, fonts, and overlay
 * stacking. The shadcn token bridge that made un-migrated pages take AURA's
 * colours was removed at US13b, and this file now pins that it stays gone.
 *
 * These are source assertions on purpose: the failure modes are an import in
 * the wrong order (AURA components then beat Tailwind utilities), a bridge
 * variable coming back, or a font origin sneaking back in — none of
 * which a jsdom render can see.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

/** The body of the first top-level rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const start = css.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`no ${selector} block`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`unterminated ${selector} block`);
}

function declared(body: string, name: string): string | undefined {
  return body.match(new RegExp(`(?:^|[\\s;{])${name}\\s*:\\s*([^;]+);`))?.[1]?.trim();
}

/** The shadcn names the bridge used to define (removed at spec 122 US13b). */
const BRIDGE_NAMES = [
  '--background', '--foreground', '--card', '--card-foreground', '--popover', '--popover-foreground',
  '--primary', '--primary-foreground', '--secondary', '--secondary-foreground', '--muted',
  '--muted-foreground', '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--destructive-surface', '--success', '--success-foreground', '--success-surface', '--warning',
  '--warning-foreground', '--warning-surface', '--info', '--info-foreground', '--info-surface',
  '--border', '--input', '--ring', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
  '--radius', '--sidebar', '--sidebar-foreground', '--sidebar-primary', '--sidebar-primary-foreground',
  '--sidebar-accent', '--sidebar-accent-foreground', '--sidebar-border', '--sidebar-ring', '--nav-indicator',
] as const;

describe('globals.css — AURA foundation (spec 122)', () => {
  it('declares the cascade-layer order before anything else', () => {
    const firstStatement = css.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(';')[0];
    expect(firstStatement).toBe('@layer aura-tokens, theme, base, aura, components, utilities');
  });

  it('imports Tailwind and AURA in the contract order, with no legacy kit CSS (US13b)', () => {
    const imports = [...css.matchAll(/^@import\s+['"]([^'"]+)['"]([^;]*);/gm)].map((m) =>
      `${m[1]}${m[2]?.trim() ? ` ${m[2].trim()}` : ''}`,
    );
    expect(imports).toEqual([
      'tailwindcss',
      '@jirawatpyk/aura-tokens/aura.css layer(aura-tokens)',
      '@jirawatpyk/aura-tokens/aura-fonts.local.css',
      '@jirawatpyk/aura-tokens/tailwind.prefixed.css',
      '../styles/aura-theme.css layer(aura-tokens)',
      '@jirawatpyk/aura-react/styles.layer.css',
    ]);
  });

  it('defines no shadcn bridge variable anywhere (US13b: colours come from --aura-* directly)', () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const defined = BRIDGE_NAMES.filter((name) => new RegExp(`(?:^|[\\s;{])${name}\\s*:`).test(body));
    expect(defined).toEqual([]);
  });

  it('positive control: the bridge check finds a definition when one exists', () => {
    expect(new RegExp('(?:^|[\\s;{])--muted-foreground\\s*:').test(':root { --muted-foreground: red; }')).toBe(true);
  });

  it('defines no theme radius override, so `rounded-sm|md|lg` are never used for AURA radii', () => {
    expect(declared(block('@theme inline'), '--radius-md')).toBeUndefined();
  });

  it.each([
    ['--font-sans', '"Inter", "Noto Sans Thai", sans-serif'],
    // Card, dialog and sheet titles are h2/h3-level: AURA sets those in sans; Fraunces is display-only.
    ['--font-heading', '"Inter", "Noto Sans Thai", sans-serif'],
    // Thai in a mono label takes Noto Sans Thai, not whatever monospace the OS has (US6 parity).
    ['--font-mono', '"JetBrains Mono", "Noto Sans Thai", monospace'],
  ])('%s names the AURA families', (name, stack) => {
    expect(declared(block('@theme inline'), name)).toBe(stack);
  });

  it('keeps the TSCC gold as a literal — decorative, never AURA\'s accent blue', () => {
    expect(declared(block(':root'), '--brand-accent')).toMatch(/^oklch\(0\.728/);
    expect(declared(block(':root'), '--brand-accent-foreground')).toMatch(/^oklch\(0\.205/);
  });

  it('draws skeletons in AURA\'s skeleton tone, visible on the page background', () => {
    const rule = css.match(/\.skeleton-pulse\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--aura-bg-skeleton)');
  });

  it('pulses skeletons with AURA\'s own animation, and only without reduced motion (FR-009, spec 122 US1)', () => {
    // The shimmer sweep and its class name are gone: the pulse is AURA's keyframes and duration.
    expect(css).not.toMatch(/--animate-shimmer|@keyframes shimmer|\.skeleton-shimmer/);
    const motion = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.skeleton-pulse\s*\{[^}]*\}/)?.[0] ?? '';
    expect(motion).toMatch(/animation:\s*aura-pulse var\(--aura-duration-pulse\)/);
  });

  it('sets page titles in AURA\'s display face, as the canvas boards do (Fraunces, Thai falls back to Noto Sans Thai)', () => {
    expect(declared(block('.text-h1'), 'font-family')).toBe('var(--font-display)');
    // Section headings stay in the text face (the boards use Inter for h2/h3).
    expect(declared(block('.text-h2'), 'font-family')).toBeUndefined();
  });

  it('lets the page containers own the padding inside the AURA shell, on AURA\'s 16 / 24 / 32 steps (spec 122 US1)', () => {
    const layer = css.match(/@layer components\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    // AppShell pads <main> unless told not to; the containers pad, so AppShell
    // takes `contentPadding={false}` (AURA #97) and no rule reaches its content.
    expect(css).not.toMatch(/aura-shell__content/);
    expect(readFileSync('src/components/layout/staff-shell.tsx', 'utf8')).toContain('contentPadding={false}');
    // The gutter reads AURA's spacing tokens, not numbers of its own (2 Oct 2026).
    expect(layer).toMatch(/\.chamber-shell\s*\{[^}]*--page-padding-x:\s*var\(--aura-space-4\);/);
    // Sticky page parts stop below the sticky bar (whole-branch review M2).
    // AppShell's measured bar height, 56px before it is written (PR #530).
    expect(layer).toMatch(/\.chamber-shell\s*\{[^}]*--shell-bar-height:\s*var\(--aura-shell-bar-height,\s*56px\);/);
    // The gutter takes AURA Container's steps (maintainer, 2 Oct 2026): 24px
    // from 640, not 768, so the two never disagree.
    expect(layer).toMatch(/min-width:\s*640px\)\s*\{\s*\.chamber-shell\s*\{\s*--page-padding-x:\s*var\(--aura-space-6\);/);
    expect(layer).not.toMatch(/min-width:\s*768px\)\s*\{\s*\.chamber-shell\s*\{[^}]*--page-padding-x/);
    expect(layer).toMatch(/min-width:\s*1024px\)\s*\{\s*\.chamber-shell\s*\{\s*--page-padding-x:\s*var\(--aura-space-8\);/);
    expect(css).not.toMatch(/--page-padding-x:\s*[\d.]+(rem|px)/);
  });

  it('takes the 44px touch rows for shell nav from AURA 5.7, with no local override (FR-013; handoff #62)', () => {
    const aura = readFileSync(join(ROOT, 'node_modules/@jirawatpyk/aura-react/dist/styles.layer.css'), 'utf8');
    expect(aura).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.aura-nav__item\s*\{[^}]*min-height:\s*var\(--aura-touch-target\)/);
    // Only a mouse may get shorter rows (the collapsed rail's 40px board rows).
    const outsideFine = css.replace(/@media \(pointer: fine\)\s*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
    expect(outsideFine).not.toMatch(/\.aura-nav__item[^{]*\{[^}]*min-height/);
  });

  it('lets long nav labels wrap to two lines and hyphenate (AURA 5.7.1 / 5.7.2), not cut with an ellipsis (handoff #63, #64)', () => {
    const aura = readFileSync(join(ROOT, 'node_modules/@jirawatpyk/aura-react/dist/styles.layer.css'), 'utf8');
    const label = aura.match(/\.aura-nav__label\s*\{[^}]*\}/)?.[0] ?? '';
    expect(label).toMatch(/line-clamp:\s*2/);
    expect(label).not.toMatch(/white-space:\s*nowrap/);
    // 5.7.2 (handoff #64): a long compound breaks at a syllable, not mid-word.
    expect(label).toMatch(/(?<!-webkit-)hyphens:\s*auto/);
    expect(css).not.toMatch(/\.aura-nav__label/);
  });

  it('tints the auth brand panel\'s mesh from the boards\' light blue to their soft yellow (spec 122 US2)', () => {
    const layer = css.match(/@layer components\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    const mesh = layer.match(/\.auth-mesh\s*\{[^}]*\}/)?.[0] ?? '';
    expect(mesh).toMatch(/--aura-mesh-from:\s*#5b9bd5;/);
    expect(mesh).toMatch(/--aura-mesh-to:\s*#ffe27a;/);
  });

  it('carries no local toaster override — AURA 5.6 centres and offsets it (handoff #54, #56)', () => {
    expect(css).not.toMatch(/\.aura-toaster|\.aura-toast__action/);
  });

  it('loads no font from a third-party origin anywhere in src/', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(css|tsx?)$/.test(entry)) {
          const text = readFileSync(path, 'utf8');
          if (/fonts\.(googleapis|gstatic)\.com|next\/font\/google/.test(text)) offenders.push(path);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
