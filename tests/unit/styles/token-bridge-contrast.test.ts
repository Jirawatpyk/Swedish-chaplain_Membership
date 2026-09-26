/**
 * Spec 122 — WCAG 2.1 AA contrast of the token bridge (ux-standards § 1.2).
 *
 * Every legacy page takes its colours from the bridge on `:root` in
 * `src/app/globals.css`, so a bad mapping recolours the whole app at once.
 * This resolves each bridged variable through AURA's real token values
 * (aura.css, then our brand theme, light and then dark) and checks the pairs
 * the legacy kit actually renders.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '');

/** Declarations of every top-level block whose selector list starts with `selector`. */
function decls(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{([^}]*)\\}`, 'gm');
  for (const block of css.matchAll(re)) {
    for (const [, name, value] of (block[1] ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out[name!] = value!.trim();
    }
  }
  return out;
}

const aura = read('node_modules/@jirawatpyk/aura-tokens/aura.css');
const brand = read('src/styles/aura-theme.css');
const globals = read('src/app/globals.css');

const light = { ...decls(aura, ':root'), ...decls(brand, ':root'), ...decls(globals, ':root') };
const dark = { ...light, ...decls(aura, '.dark'), ...decls(brand, '.dark'), ...decls(globals, '.dark') };

function resolve(vars: Record<string, string>, name: string, depth = 0): string {
  const value = vars[name];
  if (value === undefined || depth > 20) throw new Error(`unresolved ${name}`);
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/);
  return ref ? resolve(vars, ref[1]!, depth + 1) : value;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

function contrast(vars: Record<string, string>, fg: string, bg: string): number {
  const [a, b] = [resolve(vars, fg), resolve(vars, bg)];
  if (!/^#[0-9a-f]{3,6}$/i.test(a) || !/^#[0-9a-f]{3,6}$/i.test(b)) {
    throw new Error(`${fg}=${a} / ${bg}=${b} is not a hex colour`);
  }
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** [foreground, background, minimum] — text 4.5:1, non-text (borders, rings) 3:1. */
const PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ['--foreground', '--background', 4.5],
  ['--card-foreground', '--card', 4.5],
  ['--muted-foreground', '--background', 4.5],
  ['--muted-foreground', '--muted', 4.5],
  ['--primary-foreground', '--primary', 4.5],
  ['--primary', '--background', 4.5],
  ['--primary', '--card', 4.5],
  ['--destructive-foreground', '--destructive', 4.5],
  ['--destructive', '--destructive-surface', 4.5],
  ['--success-foreground', '--success', 4.5],
  ['--success', '--success-surface', 4.5],
  ['--warning-foreground', '--warning', 4.5],
  ['--warning', '--warning-surface', 4.5],
  ['--info-foreground', '--info', 4.5],
  ['--info', '--info-surface', 4.5],
  ['--sidebar-foreground', '--sidebar', 4.5],
  ['--sidebar-accent-foreground', '--sidebar-accent', 4.5],
  ['--input', '--card', 3],
  ['--ring', '--background', 3],
  ['--ring', '--sidebar', 3],
  ['--nav-indicator', '--background', 3],
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('token bridge contrast — %s', (_theme, vars) => {
  it.each(PAIRS)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(contrast(vars, fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it('links (`text-primary`) do not read as body text', () => {
    expect(resolve(vars, '--primary')).not.toBe(resolve(vars, '--foreground'));
  });

  it('muted fills (tabs, skeletons, secondary buttons) are distinguishable from the page', () => {
    expect(resolve(vars, '--muted')).not.toBe(resolve(vars, '--background'));
  });
});
