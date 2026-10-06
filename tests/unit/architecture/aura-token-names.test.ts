/**
 * Spec 122 — every `var(--aura-…)` in `src/` names a token that exists.
 *
 * A misspelt or invented token is silent: `color: var(--aura-fg-link)` with no
 * such property computes to the inherited colour, so the link simply renders
 * in body text and no test or type check notices. US9a shipped two of these
 * (`--aura-fg-link`, `--aura-fg-success`); the parity screenshots caught them.
 *
 * Known tokens are the custom properties AURA ships (`aura-tokens` and
 * `aura-react` CSS) plus the ones the app defines itself (`src/styles`,
 * `globals.css`). The positive control fails if that set comes back empty,
 * so a broken parse cannot pass by checking nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, ext, out);
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

const cssSources = [
  ...files(join(ROOT, 'node_modules/@jirawatpyk/aura-tokens'), /\.css$/),
  ...files(join(ROOT, 'node_modules/@jirawatpyk/aura-react/dist'), /\.css$/),
  ...files(join(ROOT, 'src/styles'), /\.css$/),
  join(ROOT, 'src/app/globals.css'),
];

const known = new Set<string>();
for (const path of cssSources) {
  for (const m of readFileSync(path, 'utf8').matchAll(/(--aura-[a-z0-9-]+)\s*:/g)) known.add(m[1]!);
}

describe('AURA token names', () => {
  it('positive control: the known-token set is read', () => {
    expect(known.size).toBeGreaterThan(200);
    expect(known.has('--aura-fg-accent')).toBe(true);
  });

  it('every var(--aura-…) in src/ names a token that exists', () => {
    const unknown: string[] = [];
    for (const path of files(join(ROOT, 'src'), /\.(ts|tsx|css)$/)) {
      const source = readFileSync(path, 'utf8');
      for (const m of source.matchAll(/var\((--aura-[a-z0-9-]+)/g)) {
        if (!known.has(m[1]!)) unknown.push(`${relative(ROOT, path)}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
