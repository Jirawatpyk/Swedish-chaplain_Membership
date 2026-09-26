/**
 * Bundle guard — the member create / edit client graph must never reach
 * `@js-joda/*`.
 *
 * `@js-joda/timezone` is imported for its side effect (it registers the full
 * IANA tz database), so a bundler cannot tree-shake it: ONE value import on a
 * client path ships ~900 KB of ZoneRules data to the browser. On 2026-09-26
 * that is exactly what pushed `/admin/members/new` (2149 KB) and
 * `/admin/members/[memberId]/edit` (2180 KB) past their 1330 / 1350 KB
 * ceilings in `scripts/check-bundle-budgets.ts`. The leak was:
 *
 *   create-/edit-member-client.tsx ('use client')
 *     → member-form/schema.ts (BILLING_CYCLES)
 *     → modules/members/domain/member.ts
 *     → modules/tenants (barrel)
 *     → modules/tenants/domain/iana-timezone.ts → '@js-joda/timezone'
 *
 * The `tenants` barrel is a Domain-only module imported from dozens of client
 * components, so it is a root of this scan too. `pnpm check:bundle-budgets`
 * needs a full `pnpm build`; this static walk catches the same regression in
 * the unit suite.
 *
 * The walk follows static value imports and `export … from` re-exports
 * (`import type` / `export type` are erased at build and skipped), resolving
 * `@/` and relative specifiers to files under `src/`.
 *
 * Positive controls, so the guard cannot pass vacuously:
 *   1. the walk must visit at least MIN_FILES_SCANNED files;
 *   2. it must reach the tenants `iana-timezone.ts` VO (the file that leaked);
 *   3. the SAME matcher must detect a js-joda import in fixture strings.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

const ENTRY_POINTS = [
  'src/components/members/create-member-client.tsx',
  'src/components/members/edit-member-client.tsx',
  'src/modules/tenants/index.ts',
] as const;

/** Must be reached — proves the walk crosses member.ts → tenants barrel. */
const MUST_REACH = 'src/modules/tenants/domain/iana-timezone.ts';

/**
 * 63 files reachable from the three entry points on 2026-09-26. The floor
 * sits under, so a broken resolver fails loudly while ordinary refactors do
 * not churn the number.
 */
const MIN_FILES_SCANNED = 50;

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

const { visited, hits } = walkGraph(ENTRY_POINTS);

describe('member create/edit client graph carries no @js-joda (bundle budget)', () => {
  it('positive control: every entry point exists on disk', () => {
    const missing = ENTRY_POINTS.filter((e) => !existsSync(resolve(ROOT, e)));
    expect(missing).toEqual([]);
  });

  it(`positive control: the walk visits at least ${MIN_FILES_SCANNED} files`, () => {
    expect(visited.size).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
  });

  it(`positive control: the walk reaches ${MUST_REACH}`, () => {
    expect(visited.has(MUST_REACH)).toBe(true);
  });

  it('positive control: the matcher detects js-joda imports (side-effect, named, CRLF) and skips type-only / comments', () => {
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

  it('no file reachable from the member form or the tenants barrel imports @js-joda', () => {
    const report = hits.map((h) => `${h.specifier}  ←  ${h.chain.join('  →  ')}`).join('\n');
    expect(hits, `@js-joda reached from a client graph:\n${report}`).toEqual([]);
  });
});
