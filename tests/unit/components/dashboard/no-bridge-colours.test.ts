/**
 * Spec 122 US11 — the staff dashboard takes its colours from AURA's tokens,
 * not from the US0 token bridge (`--primary`, `--chart-N`, `text-muted-
 * foreground`, …). The bridge keeps those names working today, so a half
 * migration would look right in the preview and break when US13 removes it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/components/dashboard', 'src/app/(staff)/admin/(home)'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const BRIDGE_VAR = /var\(--(?:primary|chart-\d|success|warning|destructive|border|card|foreground|muted-foreground|background|muted|color-[\w-]+)\)/g;
const BRIDGE_CLASS =
  /(?<![\w-])(?:text|bg|border|fill|stroke|ring)-(?:foreground|muted-foreground|muted|background|card|border|primary|destructive|success|warning|chart-\d)(?![\w-])/g;

describe('the dashboard uses no bridge colour names', () => {
  const all = ROOTS.flatMap(files);

  it('scans the dashboard files (positive control)', () => {
    expect(all.length).toBeGreaterThan(15);
  });

  it.each(all)('%s', (path) => {
    const src = readFileSync(path, 'utf8');
    expect([...(src.match(BRIDGE_VAR) ?? []), ...(src.match(BRIDGE_CLASS) ?? [])]).toEqual([]);
  });
});
