/**
 * Spec 122 US8c-2 — AURA 5.31 (#139) emits `--aura-control-checked-bg/-fg`
 * from the brand in `aura-theme`, so checked controls (checkbox, radio, switch,
 * tab underline, current page, selected day, completed step) follow SweCham
 * blue from the generated theme file. The US8c-1 hand-written stand-in
 * (`src/styles/aura-overrides.css`) is gone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '');

const THEME = 'src/styles/aura-theme.css';

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

describe('checked controls take the brand from the generated theme (AURA #139)', () => {
  it('the generated theme declares the checked tokens in light, dark and system-dark', () => {
    const css = read(THEME);
    expect(decls(css, ':root')['--aura-control-checked-bg']).toBeDefined();
    expect(decls(css, ':root')['--aura-control-checked-fg']).toBeDefined();
    expect(decls(css, '.dark')['--aura-control-checked-bg']).toBeDefined();
    expect(decls(css, '.dark')['--aura-control-checked-fg']).toBeDefined();
    const system = css.match(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(system).toMatch(/--aura-control-checked-bg:/);
    expect(system).toMatch(/--aura-control-checked-fg:/);
  });

  it('no hand-written override file remains or is imported', () => {
    expect(existsSync(join(ROOT, 'src/styles/aura-overrides.css'))).toBe(false);
    expect(read('src/app/globals.css')).not.toMatch(/aura-overrides/);
  });

  it('keeps the check mark legible on the brand fill (WCAG AA 4.5:1), light and dark', () => {
    const aura = read('node_modules/@jirawatpyk/aura-tokens/aura.css');
    const brand = read(THEME);
    const light = { ...decls(aura, ':root'), ...decls(brand, ':root') };
    const dark = { ...light, ...decls(aura, '.dark'), ...decls(brand, '.dark') };
    for (const vars of [light, dark]) {
      const bg = resolve(vars, '--aura-control-checked-bg');
      expect(bg).not.toBe(resolve(vars, '--aura-violet-700'));
      expect(contrast(bg, resolve(vars, '--aura-control-checked-fg'))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
