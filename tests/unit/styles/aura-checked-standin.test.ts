/**
 * Spec 122 US8c — AURA 5.30 colours checked controls (checkbox, radio, switch,
 * tab underline, current page, selected day, completed step) with
 * `--aura-control-checked-bg/-fg`, wired to AURA's own violet rather than the
 * brand accent, and `aura-theme` does not emit them. Until AURA #139 ships, a
 * hand-written override (outside the generated theme file) points them at the
 * brand accent, light and dark (maintainer, 3 Oct 2026).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '');

const OVERRIDES = 'src/styles/aura-overrides.css';

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

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('checked controls follow the brand accent (stand-in until AURA #139)', () => {
  it('globals.css imports the hand-written overrides into the token layer, after the generated theme', () => {
    const globals = read('src/app/globals.css');
    const theme = globals.indexOf("@import '../styles/aura-theme.css' layer(aura-tokens);");
    const overrides = globals.indexOf("@import '../styles/aura-overrides.css' layer(aura-tokens);");
    expect(theme).toBeGreaterThan(-1);
    expect(overrides).toBeGreaterThan(theme);
  });

  it('points the checked tokens at the accent in light, dark and system-dark, and says why', () => {
    const css = read(OVERRIDES);
    expect(css).toMatch(/stand-in until AURA #139/);
    expect(decls(css, ':root')['--aura-control-checked-bg']).toBe('var(--aura-accent-violet)');
    expect(decls(css, '.dark')['--aura-control-checked-bg']).toBe('var(--aura-accent-violet)');
    const system = css.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(system).toMatch(/--aura-control-checked-bg:\s*var\(--aura-accent-violet\);/);
    expect(system).toMatch(/--aura-control-checked-fg:\s*var\(--aura-zinc-900\);/);
  });

  it('keeps the check mark legible on the brand fill (WCAG AA 4.5:1), light and dark', () => {
    const aura = read('node_modules/@jirawatpyk/aura-tokens/aura.css');
    const brand = read('src/styles/aura-theme.css');
    const ours = read(OVERRIDES);
    const light = { ...decls(aura, ':root'), ...decls(brand, ':root'), ...decls(ours, ':root') };
    const dark = { ...light, ...decls(aura, '.dark'), ...decls(brand, '.dark'), ...decls(ours, '.dark') };
    for (const vars of [light, dark]) {
      const bg = resolve(vars, '--aura-control-checked-bg');
      expect(bg).not.toBe(resolve(vars, '--aura-violet-700'));
      expect(contrast(bg, resolve(vars, '--aura-control-checked-fg'))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
