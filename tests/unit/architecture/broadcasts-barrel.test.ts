/**
 * Architecture test — F7 broadcasts module barrel boundary
 * (Phase 5 Round 1 R1.3-S2 + R1.3 H-code-2 mitigation).
 *
 * **Why a source-scan test (and not an ESLint rule):**
 *
 * The cross-module barrel-guard pattern was supposed to be enforced
 * by ESLint via `no-restricted-imports` in `eslint.config.mjs` (master
 * block at line 217). Round 1 of the Phase 5 review surfaced that the
 * F6 events branded-types block (lines ~688-790 of `eslint.config.mjs`)
 * has `files: ["src/**\/*.{ts,tsx}"]` + flat-config "last-wins" rule
 * definition that silently SHADOWS every barrel-guard rule defined
 * earlier in the config. Removing the shadow surfaces ~89 pre-existing
 * Constitution III violations across F1+F4+F5+F6+F8 — out of scope for
 * the Phase 5 US7 review (plan R1.3-S1 risk mitigation #4 explicitly
 * authorizes NOT blocking R1.3 ship on Phase 4 backfix).
 *
 * Mitigation strategy: keep the shadow (status quo) but add this
 * source-scan test as defence-in-depth. The test enumerates every
 * consumer file under `src/app/**` + `src/components/**` and asserts:
 *
 *   1. ALL current deep imports are accounted for in `KNOWN_BACKLOG`
 *      below — any NEW deep import slipping through fails the test.
 *   2. EVERY entry in `KNOWN_BACKLOG` still exists in source — a fix
 *      that removes a deep import must also remove the allowlist
 *      entry (prevents stale allowlists rotting).
 *
 * **Failure modes caught:**
 *
 * - NEW deep imports in `src/app/**` or `src/components/**` reaching
 *   into `@/modules/broadcasts/{domain,application,infrastructure}/**`
 *   (the original H-code-2 finding scope).
 * - Stale allowlist entries (a deep import that was refactored to the
 *   barrel but its allowlist entry was forgotten).
 *
 * **Out of scope:**
 *
 * - Intra-module imports — canonical use-case→port wiring.
 * - `src/lib/**` adapters that legitimately cross the module boundary.
 * - Pre-existing F1+F4+F5+F6+F8 module-internal barrel violations
 *   surfaced by the ESLint shadow analysis — tracked separately.
 *
 * **Refactor path for F7.1 backlog (consumers):**
 *
 *   1. Add the missing symbol to `src/modules/broadcasts/index.ts`
 *      (Domain types ARE exportable; Infrastructure singletons should
 *      be wrapped in `makeXyzDeps(tenantId)` composition factory).
 *   2. Update the consumer's import path to use `@/modules/broadcasts`.
 *   3. Remove the corresponding line from `KNOWN_BACKLOG` here.
 *   4. Run this test — it should pass without that allowlist entry.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..', '..');

/**
 * Directories to scan for consumer files (Presentation + cross-module
 * surfaces that MUST go through the broadcasts barrel).
 */
const SCAN_ROOTS = [
  join(PROJECT_ROOT, 'src', 'app'),
  join(PROJECT_ROOT, 'src', 'components'),
] as const;

/**
 * Forbidden deep-import patterns (canonical aliased + relative forms).
 */
const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /from\s+['"]@\/modules\/broadcasts\/(domain|application|infrastructure)\//,
  /from\s+['"]\.{1,2}(?:\/\.\.)*\/modules\/broadcasts\/(domain|application|infrastructure)\//,
] as const;

/**
 * Allowlist of CURRENT deep imports (captured 2026-05-20 during
 * R1.3-S2). These pre-date the H-code-2 fix and represent pre-existing
 * F7 Phase 1-4 violations that surface once the ESLint shadow is
 * audited. The plan R1.3-S1 risk mitigation #4 authorizes deferral to
 * F7.1 backlog; this allowlist makes the deferral VISIBLE + locks in
 * the architecture decision: no NEW deep imports allowed beyond this
 * baseline.
 *
 * Format: `${repo-relative path}:${line}` — exact match required so
 * any drift (line shift, file rename) fails the test loudly.
 *
 * Total: 40 entries (12 consumer files across Phase 1-4 work).
 */
const KNOWN_BACKLOG: ReadonlySet<string> = new Set([
  // /portal/broadcasts/new/page.tsx (3) — F7.1a US2 + US7 compose
  'src/app/(member)/portal/broadcasts/new/page.tsx:24',
  'src/app/(member)/portal/broadcasts/new/page.tsx:25',
  'src/app/(member)/portal/broadcasts/new/page.tsx:26',
  // /admin/broadcasts/[id]/page.tsx (1) — F7.1a US1 batch detail
  'src/app/(staff)/admin/broadcasts/[id]/page.tsx:23',
  // /admin/broadcasts/templates/[id]/edit/page.tsx (2) — F7.1a US7 edit
  'src/app/(staff)/admin/broadcasts/templates/[id]/edit/page.tsx:26',
  'src/app/(staff)/admin/broadcasts/templates/[id]/edit/page.tsx:28',
  // /admin/settings/broadcasts/page.tsx (3) — F7.1a US2 settings
  'src/app/(staff)/admin/settings/broadcasts/page.tsx:28',
  'src/app/(staff)/admin/settings/broadcasts/page.tsx:29',
  'src/app/(staff)/admin/settings/broadcasts/page.tsx:30',
  // /api/admin/broadcasts/settings/allowlist/route.ts (4) — F7.1a US2 API
  'src/app/api/admin/broadcasts/settings/allowlist/route.ts:17',
  'src/app/api/admin/broadcasts/settings/allowlist/route.ts:18',
  'src/app/api/admin/broadcasts/settings/allowlist/route.ts:22',
  'src/app/api/admin/broadcasts/settings/allowlist/route.ts:23',
  // /api/broadcasts/inline-image-upload/route.ts (3) — F7.1a US2 upload
  'src/app/api/broadcasts/inline-image-upload/route.ts:21',
  'src/app/api/broadcasts/inline-image-upload/route.ts:22',
  'src/app/api/broadcasts/inline-image-upload/route.ts:26',
  // /api/cron/broadcasts/dispatch-batches/route.ts (14) — F7.1a US1 cron
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:50',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:52',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:55',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:56',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:60',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:61',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:62',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:63',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:64',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:65',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:66',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:67',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:68',
  'src/app/api/cron/broadcasts/dispatch-batches/route.ts:69',
  // /api/cron/broadcasts/split-large-broadcasts/route.ts (6) — F7.1a US1 cron
  'src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:48',
  'src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:50',
  'src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:52',
  'src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:54',
  'src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:55',
  'src/app/api/cron/broadcasts/split-large-broadcasts/route.ts:56',
  // /components/broadcast/* (4) — F7 MVP queue + status display
  'src/components/broadcast/admin/queue-filters.tsx:42',
  'src/components/broadcast/status-badge-mapping.ts:21',
  'src/components/broadcast/tiptap-editor.tsx:32',
  'src/components/broadcast/tiptap-editor.tsx:33',
]);

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
  readonly key: string; // `${file}:${line}`
  readonly text: string;
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
          const repoRel = file
            .replace(PROJECT_ROOT + sep, '')
            .replaceAll(sep, '/');
          offenders.push({
            key: `${repoRel}:${i + 1}`,
            text: line.trim(),
          });
        }
      }
    }
  }
  return offenders;
}

describe('broadcasts module barrel — architecture guard (R1.3-S2)', () => {
  it('forbids NEW deep imports from src/app/** + src/components/** into broadcasts internals', async () => {
    const offenders = await findDeepImports();
    const offenderKeys = new Set(offenders.map((o) => o.key));

    // (1) Find NEW deep imports (in source but not in allowlist).
    const newViolations = offenders.filter((o) => !KNOWN_BACKLOG.has(o.key));
    if (newViolations.length > 0) {
      const formatted = newViolations
        .map((o) => `  ${o.key} → ${o.text}`)
        .join('\n');
      throw new Error(
        `Constitution Principle III violation — NEW deep import(s) into broadcasts internals:\n${formatted}\n\n` +
          'Use the public barrel `@/modules/broadcasts` instead. ' +
          'If the needed symbol is missing from the barrel, ADD IT TO ' +
          '`src/modules/broadcasts/index.ts` rather than importing the ' +
          'deep path. See the test file header for the full refactor ' +
          'protocol.\n\n' +
          'Hint: if this import IS legitimately needed and matches an ' +
          'existing F7.1 backlog refactor, add the `${file}:${line}` key ' +
          'to KNOWN_BACKLOG in this test file along with a one-line ' +
          'context comment. Do not silently allow drift.',
      );
    }

    // (2) Find stale allowlist entries (in allowlist but no longer in source).
    const staleAllowlist: string[] = [];
    for (const key of KNOWN_BACKLOG) {
      if (!offenderKeys.has(key)) {
        staleAllowlist.push(key);
      }
    }
    if (staleAllowlist.length > 0) {
      throw new Error(
        `Stale KNOWN_BACKLOG entries (refactored deep imports left dangling):\n${staleAllowlist
          .map((k) => `  ${k}`)
          .join('\n')}\n\n` +
          'Remove these entries from KNOWN_BACKLOG in this test file. ' +
          'A stale allowlist defeats the architecture-test defence.',
      );
    }

    // Both checks passed — current source = allowlist exactly.
    expect(offenders.length).toBe(KNOWN_BACKLOG.size);
  });
});
