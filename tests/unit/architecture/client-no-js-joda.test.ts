/**
 * Bundle guard — no `'use client'` module anywhere in `src/` may reach
 * `@js-joda/*`.
 *
 * `@js-joda/timezone` is imported for its side effect (it registers the full
 * IANA tz database), so a bundler cannot tree-shake it: ONE value import on a
 * client path ships about 1.1 MB (core + timezone) to the browser. It has
 * leaked three times, each fixed with a guard scoped to that area only:
 *
 *   2026-07-09 PR #173  — `bangkokDateOnly` (`src/lib/dates.ts`) created;
 *   2026-09-26          — broadcasts (`bangkok-datetime.ts`, approve dialog);
 *   member form         — the tenants barrel's IANA timezone check;
 *   2026-11-05 #732     — `/admin/invoices/new` 834 → 1866 KB, via
 *                         use-event-search → event-options → fiscal-year
 *                         (task #94).
 *
 * This one guard replaces the two scoped ones (broadcast-client-no-js-joda,
 * member-form-no-js-joda): every `'use client'` module under `src/` is a scan
 * root. Server-side js-joda (use-cases, ports, page loaders) is untouched —
 * only files reachable from a client module ship to the browser.
 *
 * The walk follows static value imports and `export … from` re-exports
 * (`import type` / `export type` are erased at build and skipped), resolving
 * `@/` and relative specifiers to files under `src/`.
 *
 * Positive controls, so the guard cannot pass vacuously:
 *   1. at least MIN_CLIENT_ROOTS `'use client'` roots are discovered;
 *   2. the walk reaches every file that used to leak;
 *   3. the SAME matcher must detect a js-joda import in fixture strings.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { stripCommentsPreserveLines } from '../../../scripts/lib/source-scan';

const ROOT = resolve(__dirname, '../../..');


/** Must be reached — proves the walk covers the files that leaked. */
const MUST_REACH = [
  'src/components/broadcast/bangkok-datetime.ts',
  'src/components/broadcast/admin/approve-dialog.tsx',
  'src/modules/tenants/domain/iana-timezone.ts',
  'src/app/(staff)/admin/invoices/new/_lib/event-options.ts',
] as const;

/**
 * About 444 `'use client'` modules under `src/` on 2026-11-16. The floor sits
 * under, so a broken discovery fails loudly while ordinary refactors do not
 * churn the number.
 */
const MIN_CLIENT_ROOTS = 400;

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

/**
 * Comments are stripped with the repo's string-aware scanner, so a `/**` glob
 * inside a line comment or a string cannot open a phantom block comment that
 * hides the imports after it.
 */
const stripComments = stripCommentsPreserveLines;

/**
 * Value-import specifiers of a module: `import … from 'x'`, bare
 * `import 'x'` (side-effect), `export … from 'x'` and dynamic `import('x')`.
 * Type-only forms are skipped.
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
  // Dynamic `import('x')`, including `next/dynamic(() => import('x'))`: a
  // lazy chunk still ships to the browser.
  const dynamicRe = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const m of code.matchAll(dynamicRe)) out.push(m[2]!);
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

/** Each file is read once: the directive pass and the walk share it. */
const sourceCache = new Map<string, string>();
function readSource(rel: string): string {
  let source = sourceCache.get(rel);
  if (source === undefined) {
    source = readFileSync(resolve(ROOT, rel), 'utf8');
    sourceCache.set(rel, source);
  }
  return source;
}

function walkGraph(entries: readonly string[]): { visited: Set<string>; hits: Hit[] } {
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const e of entries) {
    parent.set(e, null);
    queue.push(e);
  }
  const hits: Hit[] = [];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!;
    const source = readSource(file);
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

/** Every `'use client'` module under `src/` is a scan root. */
const clientRoots = walkTree(resolve(ROOT, 'src'))
  .map((abs) => relative(ROOT, abs).split('\\').join('/'))
  .filter((rel) => USE_CLIENT.test(readSource(rel)))
  .sort();

const { visited, hits } = walkGraph(clientRoots);

describe('the client graph carries no @js-joda (bundle budget)', () => {
  it(`positive control: at least ${MIN_CLIENT_ROOTS} 'use client' roots are discovered under src`, () => {
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
    expect(detect("const m = await import('@js-joda/timezone');")).toBe(true);
    // A `/**` glob inside a line comment must not hide the import after it.
    expect(detect("// see `src/**` for more\nimport '@js-joda/timezone';\n/* later */\n")).toBe(true);
    expect(detect("const glob = 'a/*';\nimport { ZoneId } from '@js-joda/core';\n/* later */\n")).toBe(true);
  });

  it('no file reachable from any client component imports @js-joda', () => {
    const report = hits.map((h) => `${h.specifier}  ←  ${h.chain.join('  →  ')}`).join('\n');
    expect(hits, `@js-joda reached from a client graph:\n${report}`).toEqual([]);
  });
});
