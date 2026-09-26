/**
 * Bundle guard — no broadcast client component may reach `@js-joda/*`.
 *
 * `@js-joda/timezone` is imported for its side effect (it registers the full
 * IANA tz database), so a bundler cannot tree-shake it: ONE value import on a
 * client path ships ~900 KB of ZoneRules data to the browser. On 2026-09-26
 * that 902 KB chunk sat on `/admin/broadcasts`, `/admin/broadcasts/new`,
 * `/admin/broadcasts/[id]` and `/portal/broadcasts/new`, via two client-side
 * Bangkok wall-time helpers:
 *
 *   schedule-picker / schedule-confirm-dialog / bulk-approve-confirm-dialog
 *     → components/broadcast/bangkok-datetime.ts → '@js-joda/timezone'
 *   admin/approve-dialog.tsx (inline copies)     → '@js-joda/timezone'
 *
 * Both are now `Intl`-based. Server-side js-joda (use-cases, ports) is
 * untouched — only files reachable from a `'use client'` module ship to the
 * browser, so those are the scan roots.
 *
 * The walk follows static value imports and `export … from` re-exports
 * (`import type` / `export type` are erased at build and skipped), resolving
 * `@/` and relative specifiers to files under `src/`. Same matcher as
 * `member-form-no-js-joda.test.ts`.
 *
 * Positive controls, so the guard cannot pass vacuously:
 *   1. at least MIN_CLIENT_ROOTS `'use client'` roots are discovered;
 *   2. the walk reaches both helper files that used to leak;
 *   3. the SAME matcher must detect a js-joda import in fixture strings.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** Trees whose `'use client'` modules are scan roots. */
const ROOT_TREES = ['src/components/broadcast', 'src/app'] as const;

/** Under `src/app`, only broadcast routes are in scope. */
function inScope(rel: string): boolean {
  return rel.startsWith('src/components/broadcast/') || /\/broadcasts\//.test(rel);
}

/** Must be reached — proves the walk covers the files that leaked. */
const MUST_REACH = [
  'src/components/broadcast/bangkok-datetime.ts',
  'src/components/broadcast/admin/approve-dialog.tsx',
] as const;

/**
 * 61 broadcast `'use client'` modules on 2026-09-26. The floor sits under,
 * so a broken discovery fails loudly while ordinary refactors do not churn
 * the number.
 */
const MIN_CLIENT_ROOTS = 50;

const SOURCE_EXT = /\.(ts|tsx)$/;

function walkTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTree(full, out);
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

/** `'use client'` directive as the first statement (after comments). */
const USE_CLIENT = /^(?:\s|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)*(['"])use client\1/;

/** Strip block + line comments so prose mentioning an import is not a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\r\n]*/g, '$1');
}

/**
 * Value-import specifiers of a module: `import … from 'x'`, bare
 * `import 'x'` (side-effect) and `export … from 'x'`. Type-only forms are
 * skipped.
 */
function valueImportSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?[^'";]*?\sfrom\s*(['"])([^'"]+)\3/g;
  for (const m of code.matchAll(fromRe)) {
    if (m[2]) continue; // `import type` / `export type`
    out.push(m[4]!);
  }
  const bareRe = /(^|[;\r\n])\s*import\s*(['"])([^'"]+)\2/g;
  for (const m of code.matchAll(bareRe)) out.push(m[3]!);
  return out;
}

function isJsJoda(specifier: string): boolean {
  return specifier === '@js-joda' || specifier.startsWith('@js-joda/');
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSpecifier(specifier: string, fromRel: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join('src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = join(dirname(fromRel), specifier);
  else return null; // package import — only `@js-joda/*` matters, checked above
  for (const suffix of CANDIDATE_SUFFIXES) {
    const rel = (base + suffix).split('\\').join('/');
    const abs = resolve(ROOT, rel);
    if (existsSync(abs) && statSync(abs).isFile()) return rel;
  }
  return null;
}

type Hit = { file: string; specifier: string; chain: string[] };

function walkGraph(entries: readonly string[]): { visited: Set<string>; hits: Hit[] } {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const e of entries) {
    parent.set(e, null);
    queue.push(e);
  }
  const hits: Hit[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    for (const specifier of valueImportSpecifiers(source)) {
      if (isJsJoda(specifier)) {
        const chain: string[] = [];
        for (let k: string | null | undefined = file; k; k = parent.get(k)) chain.unshift(k);
        hits.push({ file, specifier, chain });
        continue;
      }
      const next = resolveSpecifier(specifier, file);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return { visited: new Set(parent.keys()), hits };
}

const clientRoots = [...new Set(ROOT_TREES.flatMap((tree) => walkTree(resolve(ROOT, tree))))]
  .map((abs) => relative(ROOT, abs).split('\\').join('/'))
  .filter((rel) => inScope(rel) && USE_CLIENT.test(readFileSync(resolve(ROOT, rel), 'utf8')))
  .sort();

const { visited, hits } = walkGraph(clientRoots);

describe('broadcast client graph carries no @js-joda (bundle budget)', () => {
  it(`positive control: at least ${MIN_CLIENT_ROOTS} broadcast 'use client' roots are discovered`, () => {
    expect(clientRoots.length, clientRoots.join('\n')).toBeGreaterThanOrEqual(MIN_CLIENT_ROOTS);
  });

  it.each(MUST_REACH)('positive control: the walk reaches %s', (file) => {
    expect(visited.has(file)).toBe(true);
  });

  it("positive control: the 'use client' matcher accepts leading comments and both quote styles", () => {
    expect(USE_CLIENT.test("'use client';\nexport {}")).toBe(true);
    expect(USE_CLIENT.test('/**\n * doc\n */\r\n"use client";\r\nexport {}')).toBe(true);
    expect(USE_CLIENT.test("import x from 'y';\n'use client';")).toBe(false);
  });

  it('positive control: the import matcher detects js-joda imports (side-effect, named, CRLF) and skips type-only / comments', () => {
    const detect = (src: string) => valueImportSpecifiers(src).some(isJsJoda);
    expect(detect("import '@js-joda/timezone';\n")).toBe(true);
    expect(
      detect("import { ZoneId } from '@js-joda/core';\r\nimport '@js-joda/timezone';\r\n"),
    ).toBe(true);
    expect(detect("export { LocalDate } from '@js-joda/core';")).toBe(true);
    expect(detect("import type { ZoneId } from '@js-joda/core';")).toBe(false);
    expect(detect("// import { ZoneId } from '@js-joda/core';\nexport const x = 1;")).toBe(false);
    expect(detect("/* import '@js-joda/timezone' */ export const x = 1;")).toBe(false);
  });

  it('no file reachable from a broadcast client component imports @js-joda', () => {
    const report = hits.map((h) => `${h.specifier}  ←  ${h.chain.join('  →  ')}`).join('\n');
    expect(hits, `@js-joda reached from a client graph:\n${report}`).toEqual([]);
  });
});
