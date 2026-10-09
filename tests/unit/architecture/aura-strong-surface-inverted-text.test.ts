/**
 * Spec 122 — `--aura-bg-surface-strong` is AURA's INVERTED surface, so text on
 * it must be inverted too.
 *
 * In the light theme the token is zinc-900 (it was in AURA 5.22, when the
 * renewals bulk mark-paid dialog adopted it, and still is), and AURA's README
 * pairs it with `text-fg-inverted`. Used as a quiet panel with ordinary text,
 * it paints near-black text on a near-black box: the bulk mark-paid preview's
 * "Total to record" and its amount computed to rgb(24,24,27) on rgb(24,24,27),
 * and the grey captions to 2.29:1. axe does not report the 1:1 case, so only
 * the captions ever surfaced (relay R39).
 *
 * The rule here: an element whose class uses the strong surface must also set
 * an inverted foreground on itself. A quiet inset panel wants
 * `--aura-bg-canvas` instead. The positive control fails if the scan reads no
 * class attributes, so a broken parse cannot pass by checking nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const STRONG = /(?:^|[\s:'"`])bg-(?:\[var\(--aura-bg-surface-strong\)\]|bg-surface-strong)(?=[\s'"`]|$)/;
const INVERTED = /(?:^|[\s:'"`])text-(?:\[var\(--aura-fg-inverted\)\]|fg-inverted)(?=[\s'"`]|$)/;
// A className given as a string, a template literal or a cn()/clsx() argument
// list on one attribute. Multi-line attributes are joined first (CRLF-safe).
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{[a-zA-Z]*\(([\s\S]*?)\)\})/g;

const offenders: string[] = [];
let attrsScanned = 0;
for (const path of files(join(ROOT, 'src'))) {
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  for (const m of src.matchAll(CLASS_ATTR)) {
    attrsScanned++;
    const cls = m[1] ?? m[2] ?? m[3] ?? '';
    if (STRONG.test(cls) && !INVERTED.test(cls)) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(ROOT, path).replace(/\\/g, '/')}:${line}`);
    }
  }
}

describe('AURA strong surface needs inverted text', () => {
  it('positive control: the scan reads class attributes', () => {
    expect(attrsScanned).toBeGreaterThan(1000);
  });

  it('every use of --aura-bg-surface-strong sets an inverted foreground', () => {
    expect(offenders).toEqual([]);
  });
});
