/**
 * Architecture tripwire — route-level `loading.tsx` files must stay free of
 * client components that call `useSearchParams()` (directly or via their
 * imports from the same route's `_components`).
 *
 * WHY (2026-07-31 incident): `/admin/renewals/loading.tsx` rendered the real
 * `<RenewalsSectionTabs>` (a `'use client'` component calling
 * `useSearchParams()`). Inside a route-level loading fallback that hook
 * SUSPENDS — and a Suspense fallback that itself suspends cannot paint, so
 * soft navigation onto the route froze on the previous page (repro: land on
 * /admin/renewals/tasks, hard-refresh, click the Renewals tab → stuck).
 *
 * Scope: static source scan of every `loading.tsx` under `src/app` plus the
 * FIRST level of relative `./_components/*` imports each one pulls in. One
 * level is deliberate: loading files should only ever import leaf skeleton
 * modules; if a deeper chain smuggles the hook back in, the render freeze
 * would be caught by manual QA, while this cheap guard catches the exact
 * mistake class that shipped.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '../../../src/app');

function walkLoadingFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkLoadingFiles(full, out);
    else if (entry === 'loading.tsx') out.push(full);
  }
  return out;
}

/** Relative `./...` import specifiers in a source file. */
function relativeImports(source: string): string[] {
  return [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => {
    const spec = m[1] ?? '';
    return spec;
  });
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

describe('route loading.tsx files', () => {
  const loadingFiles = walkLoadingFiles(APP_ROOT);

  it('found at least the renewals loading file (walker sanity)', () => {
    expect(loadingFiles.some((f) => f.replace(/\\/g, '/').includes('admin/renewals/loading.tsx'))).toBe(true);
  });

  it.each(loadingFiles.map((f) => [f.replace(/\\/g, '/').split('src/app/')[1] ?? f, f]))(
    '%s (and its direct relative imports) never uses useSearchParams',
    (_label, file) => {
      const sources: Array<{ where: string; code: string }> = [
        { where: file, code: readFileSync(file, 'utf8') },
      ];
      for (const spec of relativeImports(sources[0]!.code)) {
        const resolved = resolveImport(file, spec);
        if (resolved) sources.push({ where: resolved, code: readFileSync(resolved, 'utf8') });
      }
      for (const { where, code } of sources) {
        // Strip comments so prose ABOUT the hook (the renewals docstring
        // documents this very incident) does not trip the guard.
        const stripped = code
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
        expect(
          stripped.includes('useSearchParams'),
          `useSearchParams reachable from a loading.tsx fallback (${where}) — it suspends there and freezes route transitions`,
        ).toBe(false);
      }
    },
  );
});
