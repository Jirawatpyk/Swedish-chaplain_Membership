/**
 * `default: { return _exhaustive }` is fail-open (`.claude/rules/rules.md`):
 * the `never` type only convinces the compiler; at runtime the arm returns
 * the unknown variant itself, which is truthy, so it is silently accepted.
 * Write `void _exhaustive; return <safe>` instead. No such arm is left in
 * `src/`; this gate keeps it that way. Comments that quote the rule are fine.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const RETURN_EXHAUSTIVE = /^\s*return\s+_exhaustive\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

export function findReturnExhaustive(text: string): number[] {
  return text.split(/\r?\n/).flatMap((line, i) => (RETURN_EXHAUSTIVE.test(line) ? [i + 1] : []));
}

describe('no fail-open `return _exhaustive` arm in src/', () => {
  it('the scanner sees the shape it guards against (positive control)', () => {
    const sample = ['switch (x) {', '  default:', '    return _exhaustive;', '}', '// return _exhaustive is fail-open'].join('\r\n');
    expect(findReturnExhaustive(sample)).toEqual([3]);
  });

  it('scans a non-empty source tree', () => {
    expect(sourceFiles(join(ROOT, 'src')).length).toBeGreaterThan(100);
  });

  it('src/ has none', () => {
    const hits = sourceFiles(join(ROOT, 'src')).flatMap((file) =>
      findReturnExhaustive(readFileSync(file, 'utf8')).map((line) => `${relative(ROOT, file)}:${line}`),
    );
    expect(hits, 'write `void _exhaustive; return <safe>` instead').toEqual([]);
  });
});
