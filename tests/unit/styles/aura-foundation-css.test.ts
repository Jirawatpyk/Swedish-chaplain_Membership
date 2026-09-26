/**
 * Spec 122 FR-002 / FR-003 — the AURA foundation in `src/app/globals.css`
 * (contracts/css-layers.md): layer order, imports, fonts, the token bridge
 * that makes un-migrated pages take AURA's colours, and overlay stacking.
 *
 * These are source assertions on purpose: the failure modes are an import in
 * the wrong order (AURA components then beat Tailwind utilities), a bridged
 * variable left pinned in `.dark`, or a font origin sneaking back in — none of
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

/** contracts/css-layers.md § Token bridge. */
const BRIDGE: Record<string, string> = {
  '--background': 'bg-canvas',
  '--foreground': 'fg-primary',
  '--card': 'bg-surface',
  '--card-foreground': 'fg-primary',
  '--popover': 'bg-surface',
  '--popover-foreground': 'fg-primary',
  // Brand accent, not AURA's ink button: `text-primary` links must not read as body text.
  '--primary': 'fg-accent',
  '--primary-foreground': 'fg-inverted',
  // Not bg-surface-hover: in light it equals the canvas, so muted fills vanish on the page.
  '--secondary': 'status-neutral-bg',
  '--secondary-foreground': 'fg-primary',
  '--muted': 'status-neutral-bg',
  '--muted-foreground': 'fg-secondary',
  '--accent': 'bg-selected',
  '--accent-foreground': 'fg-primary',
  '--destructive': 'fg-danger',
  '--destructive-foreground': 'fg-inverted',
  '--destructive-surface': 'alert-danger-bg',
  '--success': 'fg-positive',
  '--success-foreground': 'fg-inverted',
  '--success-surface': 'alert-success-bg',
  '--warning': 'alert-warning-fg',
  '--warning-foreground': 'fg-inverted',
  '--warning-surface': 'alert-warning-bg',
  '--info': 'fg-accent',
  '--info-foreground': 'fg-inverted',
  '--info-surface': 'alert-info-bg',
  '--border': 'border-default',
  '--input': 'border-control',
  '--ring': 'focus-ring',
  '--chart-1': 'chart-1',
  '--chart-2': 'chart-2',
  '--chart-3': 'chart-3',
  '--chart-4': 'chart-4',
  '--chart-5': 'chart-5',
  '--radius': 'radius-md',
  '--sidebar': 'bg-surface',
  '--sidebar-foreground': 'fg-primary',
  '--sidebar-primary': 'button-primary-bg',
  '--sidebar-primary-foreground': 'button-primary-fg',
  '--sidebar-accent': 'bg-selected',
  '--sidebar-accent-foreground': 'fg-accent',
  '--sidebar-border': 'border-default',
  '--sidebar-ring': 'focus-ring',
  '--nav-indicator': 'fg-accent',
};

describe('globals.css — AURA foundation (spec 122)', () => {
  it('declares the cascade-layer order before anything else', () => {
    const firstStatement = css.replace(/\/\*[\s\S]*?\*\//g, '').trim().split(';')[0];
    expect(firstStatement).toBe('@layer aura-tokens, theme, base, aura, components, utilities');
  });

  it('imports Tailwind, the legacy kit CSS and AURA in the contract order', () => {
    const imports = [...css.matchAll(/^@import\s+['"]([^'"]+)['"]([^;]*);/gm)].map((m) =>
      `${m[1]}${m[2]?.trim() ? ` ${m[2].trim()}` : ''}`,
    );
    expect(imports).toEqual([
      'tailwindcss',
      'tw-animate-css',
      'shadcn/tailwind.css',
      '@jirawatpyk/aura-tokens/aura.css layer(aura-tokens)',
      '@jirawatpyk/aura-tokens/aura-fonts.local.css',
      '@jirawatpyk/aura-tokens/tailwind.prefixed.css',
      '../styles/aura-theme.css layer(aura-tokens)',
      '@jirawatpyk/aura-react/styles.layer.css',
    ]);
  });

  it.each(Object.entries(BRIDGE))('bridges %s to --aura-%s on :root', (name, token) => {
    expect(declared(block(':root'), name)).toBe(`var(--aura-${token})`);
  });

  it('leaves no bridged variable pinned in .dark (AURA flips the --aura-* values itself)', () => {
    const dark = block('.dark');
    const pinned = Object.keys(BRIDGE).filter((name) => declared(dark, name) !== undefined);
    expect(pinned).toEqual([]);
  });

  it.each([
    ['--font-sans', '"Inter", "Noto Sans Thai", sans-serif'],
    // Kit titles (card, dialog, sheet) are h2/h3-level: AURA sets those in sans; Fraunces is display-only.
    ['--font-heading', '"Inter", "Noto Sans Thai", sans-serif'],
    ['--font-mono', '"JetBrains Mono", monospace'],
  ])('%s names the AURA families', (name, stack) => {
    expect(declared(block('@theme inline'), name)).toBe(stack);
  });

  it('keeps the TSCC gold as a literal — decorative, never AURA\'s accent blue', () => {
    expect(declared(block(':root'), '--brand-accent')).toMatch(/^oklch\(0\.728/);
    expect(declared(block(':root'), '--brand-accent-foreground')).toMatch(/^oklch\(0\.205/);
  });

  it('draws skeletons in AURA\'s skeleton tone, visible on the page background', () => {
    const rule = css.match(/\.skeleton-shimmer\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('var(--aura-bg-skeleton)');
  });

  it('pulses skeletons with AURA\'s own animation, and only without reduced motion (FR-009, spec 122 US1)', () => {
    // The shimmer sweep is gone: the pulse is AURA's keyframes and duration.
    expect(css).not.toMatch(/--animate-shimmer|@keyframes shimmer/);
    const motion = css.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.skeleton-shimmer\s*\{[^}]*\}/)?.[0] ?? '';
    expect(motion).toMatch(/animation:\s*aura-pulse var\(--aura-duration-pulse\)/);
  });

  it('sets page titles in AURA\'s display face, as the canvas boards do (Fraunces, Thai falls back to Noto Sans Thai)', () => {
    expect(declared(block('.text-h1'), 'font-family')).toBe('var(--font-display)');
    // Section headings stay in the text face (the boards use Inter for h2/h3).
    expect(declared(block('.text-h2'), 'font-family')).toBeUndefined();
  });

  it('lets the page containers own the padding inside the AURA shell, on AURA\'s 16 / 24 / 32 steps (spec 122 US1)', () => {
    const layer = css.match(/@layer components\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    // AppShell pads <main> itself; the containers already pad, so one of the two must go.
    expect(layer).toMatch(/\.chamber-shell \.aura-shell__content\s*\{\s*padding:\s*0;/);
    expect(layer).toMatch(/\.chamber-shell\s*\{[^}]*--page-padding-x:\s*1rem;/);
    // Sticky page parts stop below the sticky bar (whole-branch review M2).
    expect(layer).toMatch(/\.chamber-shell\s*\{[^}]*--shell-bar-height:\s*56px;/);
    expect(layer).toMatch(/min-width:\s*768px\)\s*\{\s*\.chamber-shell\s*\{\s*--page-padding-x:\s*1\.5rem;/);
    expect(layer).toMatch(/min-width:\s*1024px\)\s*\{\s*\.chamber-shell\s*\{\s*--page-padding-x:\s*2rem;/);
  });

  it('takes the 44px touch rows for shell nav from AURA 5.7, with no local override (FR-013; handoff #62)', () => {
    const aura = readFileSync(join(ROOT, 'node_modules/@jirawatpyk/aura-react/dist/styles.layer.css'), 'utf8');
    expect(aura).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.aura-nav__item\s*\{[^}]*min-height:\s*var\(--aura-touch-target\)/);
    expect(css).not.toMatch(/\.aura-nav__item/);
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

  it('tints the auth brand panel\'s mesh from the brand blue to the boards\' soft yellow (spec 122 US2)', () => {
    const layer = css.match(/@layer components\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(layer).toMatch(/\.auth-mesh\s*\{\s*--aura-mesh-to:\s*#ffe27a;/);
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

describe('legacy kit inputs in dark mode (spec 122 review)', () => {
  it.each(['input', 'textarea', 'select', 'button', 'checkbox', 'radio-group', 'input-group', 'tabs'])(
    'ui/%s.tsx fills dark controls with --aura-bg-input, not a tint of the border colour',
    (file) => {
      // `--input` is AURA's control BORDER (zinc-400 in dark); 30 % of it under a
      // zinc-400 placeholder measured 3.95:1 on a dark card.
      const src = readFileSync(join(ROOT, `src/components/ui/${file}.tsx`), 'utf8');
      expect(src).not.toMatch(/dark:(?:[a-z-]+:)*bg-input\/(?:30|50)\b/);
    },
  );
});

describe('legacy kit overlays stack on the AURA z-index scale (spec 122 T013)', () => {
  it.each([
    ['popover', 'menu'],
    ['select', 'menu'],
    ['dropdown-menu', 'menu'],
    ['tooltip', 'tooltip'],
    ['dialog', 'dialog'],
    ['alert-dialog', 'dialog'],
    ['sheet', 'dialog'],
  ])('ui/%s.tsx uses --aura-z-%s and no fixed z-50', (file, layer) => {
    // Combobox and the other pickers open through ui/popover, so they inherit it.
    const src = readFileSync(join(ROOT, `src/components/ui/${file}.tsx`), 'utf8');
    expect(src).toContain(`z-[var(--aura-z-${layer})]`);
    // A bare `z-50` class; a variant-scoped one (`**:data-[slot=kbd]:z-50`)
    // stacks inside the popup and stays.
    expect(src).not.toMatch(/(^|[\s"'`])z-50\b/);
  });
});
