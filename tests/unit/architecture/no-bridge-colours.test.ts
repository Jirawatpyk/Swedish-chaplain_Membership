/**
 * Spec 122 US13b — the shadcn token bridge is gone from `globals.css`, so a
 * class or `var()` that only resolved through it now resolves to nothing:
 * `text-muted-foreground` silently loses its colour, `rounded-md` silently
 * falls back to Tailwind's default radius, and a tw-animate utility silently
 * stops animating. Nothing fails at build time, so this scan is the guard.
 *
 * Scope: every `.ts`, `.tsx` and `.css` under `src/` (US11 began it on the
 * dashboard alone). The variants and `no-scrollbar` that `shadcn/tailwind.css`
 * defined are banned too: Tailwind's built-in `data-*:` variants match
 * differently (`[data-active]` also matches `="false"`). Comments are stripped first: naming the old class in a comment
 * is harmless. Use AURA tokens instead: `text-[var(--aura-fg-secondary)]`,
 * `rounded-[var(--aura-radius-sm)]`, `motion-safe:animate-chamber-fade-in`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:tsx?|css)$/.test(name) ? [path] : [];
  });
}

const BRIDGE_NAMES =
  'foreground|muted-foreground|muted|background|card|card-foreground|popover|popover-foreground|border|input|ring|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|destructive|destructive-foreground|destructive-surface|success|success-foreground|success-surface|warning|warning-foreground|warning-surface|info|info-foreground|info-surface|sidebar[\\w-]*|chart-\\d';

const RULES: readonly { name: string; re: RegExp }[] = [
  { name: 'bridge var', re: new RegExp(`var\\(--(?:${BRIDGE_NAMES}|radius(?:-[\\w]+)?|color-[\\w-]+)\\)`, 'g') },
  {
    name: 'bridge class',
    re: new RegExp(
      `(?<![\\w-])(?:text|bg|border|fill|stroke|ring|ring-offset|outline|divide|placeholder|from|via|to|caret|accent|decoration|shadow)-(?:${BRIDGE_NAMES})(?![\\w-])`,
      'g',
    ),
  },
  // A JS read or write of a bridge name (`getPropertyValue('--primary')`): how the pay sheet's
  // Stripe theme kept reading the removed names while the class rules stayed green.
  { name: 'bridge name string', re: new RegExp(`['"\`]--(?:${BRIDGE_NAMES}|radius(?:-[\\w]+)?)['"\`]`, 'g') },
  { name: 'bridge var shorthand', re: new RegExp(`-\\(--(?:${BRIDGE_NAMES}|radius(?:-[\\w]+)?)\\)`, 'g') },
  { name: 'theme radius', re: /(?<![\w-])rounded(?:-[trblse]{1,2})?-(?:sm|md|lg|xl|2xl|3xl|4xl)(?![\w-])/g },
  {
    name: 'tw-animate',
    re: /(?<![\w-])(?:animate-in|animate-out|animate-(?:accordion|collapsible)-[\w-]+|(?:fade|zoom|spin)-(?:in|out)(?:-[\w]+)?|slide-in-from-[\w-]+|slide-out-to-[\w-]+|fill-mode-[\w]+)(?![\w-])/g,
  },
  {
    name: 'shadcn variant',
    // Also the prefixed forms (`group-data-open:`, `peer-data-checked:`, `group-data-horizontal/tabs:`).
    re: /(?<![\w])(?:data-(?:open|closed|checked|unchecked|selected|disabled|active|horizontal|vertical)(?:\/[\w-]+)?:|no-scrollbar(?![\w-]))/g,
  },
  { name: 'old skeleton class', re: /skeleton-shimmer/g },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const all = files('src');

describe('no class or var reaches the removed shadcn bridge (spec 122 US13b)', () => {
  it('scans all of src (positive control)', () => {
    expect(all.length).toBeGreaterThan(1000);
    expect(all.some((p) => p.endsWith('globals.css'))).toBe(true);
    // Split with `+` so Tailwind's source scan does not compile these into CSS.
    const control = stripComments(
      "const c = 'text-" + "muted-foreground rounded-" + "md motion-safe:animate-" + "in bg-" + "(--muted) group-data-" + "active/tabs:" + "font-bold'; s.getPropertyValue('--" + "primary'); // text-destructive",
    );
    expect(RULES.flatMap((r) => control.match(r.re) ?? [])).toHaveLength(6);
  });

  it('finds no reach in any file', () => {
    const hits = all.flatMap((path) => {
      const src = stripComments(readFileSync(path, 'utf8'));
      return RULES.flatMap((r) => (src.match(r.re) ?? []).map((m) => `${path}: ${r.name} ${m}`));
    });
    expect(hits).toEqual([]);
  });
});
