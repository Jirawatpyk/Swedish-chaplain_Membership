/**
 * Architecture test — F9 insights module barrel boundary
 * (verify-run finding F1 / Constitution Principle III backstop).
 *
 * **Why a source-scan test (and not just ESLint):**
 *
 * Constitution Principle III mandates every `src/modules/*` module ship a
 * public barrel + an ESLint `no-restricted-imports` rule blocking deep imports
 * into its `domain`/`application`/`infrastructure` internals. The F9 rule was
 * added to `eslint.config.mjs` (T003), but — like every other barrel-guard rule
 * — it is silently SHADOWED at runtime by the F6 events flat-config block
 * (`files: ["src/**\/*.{ts,tsx}"]`, last-wins). T003 promised "a source-scan
 * architecture test backstops it"; the `/speckit.verify.run` F1 finding caught
 * that the backstop was never actually added (broadcasts/events/invoicing have
 * one; insights did not). This file closes that gap.
 *
 * It enumerates every consumer file under `src/app/**` + `src/components/**`
 * (the Presentation surface that MUST reach insights only through the barrel)
 * and asserts:
 *
 *   1. NO deep import into `@/modules/insights/{domain,application,infrastructure}/**`
 *      (current baseline is ZERO — every consumer already uses `@/modules/insights`).
 *   2. `KNOWN_BACKLOG` stays empty — if a future change introduces a deep import,
 *      the test fails loudly rather than letting Principle III silently rot.
 *
 * Mirrors `tests/unit/architecture/broadcasts-barrel.test.ts`. Out of scope:
 * intra-module use-case→port wiring; `src/lib/**` adapters; the source adapters
 * INSIDE insights that legitimately import sibling barrels (covered by the
 * positive-direction boundary contract in
 * `tests/contract/insights/source-adapters-boundary.contract.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

const SCAN_ROOTS = [
  join(PROJECT_ROOT, 'src', 'app'),
  join(PROJECT_ROOT, 'src', 'components'),
] as const;

/** Forbidden deep-import patterns (canonical aliased + relative forms). */
const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /from\s+['"]@\/modules\/insights\/(domain|application|infrastructure)\//,
  /from\s+['"]\.{1,2}(?:\/\.\.)*\/modules\/insights\/(domain|application|infrastructure)\//,
] as const;

/**
 * Allowlist of CURRENT deep imports. F9 ships CLEAN — every consumer reaches
 * insights through the `@/modules/insights` barrel — so this set is EMPTY and
 * MUST stay empty. A new deep import that is genuinely unavoidable should first
 * try to export the needed symbol from `src/modules/insights/index.ts`; only if
 * that is impossible add a `${file}::${importPath}` key here with a one-line
 * rationale (matching the broadcasts-barrel deferral convention).
 */
const KNOWN_BACKLOG: ReadonlySet<string> = new Set<string>([]);

async function* walkTs(dir: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walkTs(full);
    } else if (
      s.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

interface DeepImport {
  readonly key: string; // `${file}::${importPath}`
  readonly text: string;
}

function extractImportPath(line: string): string | null {
  const match = line.match(/from\s+['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

async function findDeepImports(): Promise<DeepImport[]> {
  const offenders: DeepImport[] = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of walkTs(root)) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (FORBIDDEN_PATH_PATTERNS.some((re) => re.test(line))) {
          const repoRel = file.replace(PROJECT_ROOT + sep, '').replaceAll(sep, '/');
          const importPath = extractImportPath(line) ?? `<line ${i + 1}>`;
          offenders.push({ key: `${repoRel}::${importPath}`, text: line.trim() });
        }
      }
    }
  }
  return offenders;
}

describe('insights module barrel — architecture guard (verify F1)', () => {
  it('forbids deep imports from src/app/** + src/components/** into insights internals', async () => {
    const offenders = await findDeepImports();
    const offenderKeys = new Set(offenders.map((o) => o.key));

    const newViolations = offenders.filter((o) => !KNOWN_BACKLOG.has(o.key));
    if (newViolations.length > 0) {
      const formatted = newViolations.map((o) => `  ${o.key} → ${o.text}`).join('\n');
      throw new Error(
        `Constitution Principle III violation — deep import(s) into insights internals:\n${formatted}\n\n` +
          'Use the public barrel `@/modules/insights` instead. If the needed ' +
          'symbol is missing, ADD IT TO `src/modules/insights/index.ts` rather ' +
          'than importing the deep path. (F9 ships clean — KNOWN_BACKLOG is empty.)',
      );
    }

    const staleAllowlist = [...KNOWN_BACKLOG].filter((k) => !offenderKeys.has(k));
    if (staleAllowlist.length > 0) {
      throw new Error(
        `Stale KNOWN_BACKLOG entries (refactored deep imports left dangling):\n${staleAllowlist
          .map((k) => `  ${k}`)
          .join('\n')}\n\nRemove these from KNOWN_BACKLOG.`,
      );
    }

    expect(offenders.length).toBe(KNOWN_BACKLOG.size);
  });
});
