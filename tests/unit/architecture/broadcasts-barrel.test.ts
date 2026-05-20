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
 * R3.5 M-4 — format changed from `file:line` to `file::importPath`.
 * Line-number keys were fragile: any unrelated edit shifting lines
 * above a backlog import broke the test with confusing "stale + new"
 * dual failures. Content-key matching is drift-resistant — the
 * allowlist only changes when the actual deep-import path is added
 * or removed.
 *
 * Total: 40 entries (11 consumer files across Phase 1-4 work).
 * R4.4 L-5 — count corrected from "12" → "11" (cmdk-pages share the
 * same allowlist file group; the actual distinct consumer file count
 * is 11 per the grouping comments below).
 */
const KNOWN_BACKLOG: ReadonlySet<string> = new Set([
  // /portal/broadcasts/new/page.tsx (3) — F7.1a US2 + US7 compose
  "src/app/(member)/portal/broadcasts/new/page.tsx::@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo",
  "src/app/(member)/portal/broadcasts/new/page.tsx::@/modules/broadcasts/application/use-cases/_safe-audit-emit",
  "src/app/(member)/portal/broadcasts/new/page.tsx::@/modules/broadcasts/infrastructure/feature-flags",
  // /admin/broadcasts/[id]/page.tsx (1) — F7.1a US1 batch detail
  "src/app/(staff)/admin/broadcasts/[id]/page.tsx::@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo",
  // /admin/broadcasts/templates/[id]/edit/page.tsx (2) — F7.1a US7 edit
  "src/app/(staff)/admin/broadcasts/templates/[id]/edit/page.tsx::@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo",
  "src/app/(staff)/admin/broadcasts/templates/[id]/edit/page.tsx::@/modules/broadcasts/application/use-cases/_safe-audit-emit",
  // /admin/settings/broadcasts/page.tsx (3) — F7.1a US2 settings
  "src/app/(staff)/admin/settings/broadcasts/page.tsx::@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo",
  "src/app/(staff)/admin/settings/broadcasts/page.tsx::@/modules/broadcasts/application/use-cases/manage-image-allowlist",
  "src/app/(staff)/admin/settings/broadcasts/page.tsx::@/modules/broadcasts/infrastructure/feature-flags",
  // /api/admin/broadcasts/settings/allowlist/route.ts (4) — F7.1a US2 API
  "src/app/api/admin/broadcasts/settings/allowlist/route.ts::@/modules/broadcasts/application/use-cases/manage-image-allowlist",
  "src/app/api/admin/broadcasts/settings/allowlist/route.ts::@/modules/broadcasts/infrastructure/broadcasts-deps",
  "src/app/api/admin/broadcasts/settings/allowlist/route.ts::@/modules/broadcasts/infrastructure/feature-flags",
  "src/app/api/admin/broadcasts/settings/allowlist/route.ts::@/modules/broadcasts/domain/value-objects/image-source-allowlist",
  // /api/broadcasts/inline-image-upload/route.ts (3) — F7.1a US2 upload
  "src/app/api/broadcasts/inline-image-upload/route.ts::@/modules/broadcasts/application/use-cases/upload-inline-image",
  "src/app/api/broadcasts/inline-image-upload/route.ts::@/modules/broadcasts/infrastructure/broadcasts-deps",
  "src/app/api/broadcasts/inline-image-upload/route.ts::@/modules/broadcasts/infrastructure/feature-flags",
  // /api/cron/broadcasts/dispatch-batches/route.ts (14) — F7.1a US1 cron
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/domain/value-objects/email-lower",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/domain/broadcast",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/domain/policies/batch-concurrency-policy",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/application/services/batch-dispatcher",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/application/use-cases/dispatch-broadcast-batch",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/members-bridge",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/event-attendees-stub",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/audit-adapter",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/noop-advisory-lock",
  "src/app/api/cron/broadcasts/dispatch-batches/route.ts::@/modules/broadcasts/infrastructure/broadcasts-deps",
  // /api/cron/broadcasts/split-large-broadcasts/route.ts (6) — F7.1a US1 cron
  "src/app/api/cron/broadcasts/split-large-broadcasts/route.ts::@/modules/broadcasts/domain/value-objects/email-lower",
  "src/app/api/cron/broadcasts/split-large-broadcasts/route.ts::@/modules/broadcasts/domain/broadcast",
  "src/app/api/cron/broadcasts/split-large-broadcasts/route.ts::@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo",
  "src/app/api/cron/broadcasts/split-large-broadcasts/route.ts::@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo",
  "src/app/api/cron/broadcasts/split-large-broadcasts/route.ts::@/modules/broadcasts/infrastructure/members-bridge",
  "src/app/api/cron/broadcasts/split-large-broadcasts/route.ts::@/modules/broadcasts/infrastructure/event-attendees-stub",
  // /components/broadcast/* (5) — F7 MVP queue + status display + F7.1a US7 template form
  "src/components/broadcast/admin/queue-filters.tsx::@/modules/broadcasts/domain/value-objects/broadcast-status",
  "src/components/broadcast/status-badge-mapping.ts::@/modules/broadcasts/domain/value-objects/broadcast-status",
  "src/components/broadcast/tiptap-editor.tsx::@/modules/broadcasts/infrastructure/tiptap-image-extension-config",
  "src/components/broadcast/tiptap-editor.tsx::@/modules/broadcasts/infrastructure/tiptap-bracket-placeholder-config",
  // R5 Final 2 hotfix — template-form.tsx (client) deep-imports the
  // pure-constants `_template-field-limits.ts` to break the barrel
  // import chain that pulled in `@/modules/payments` infrastructure
  // (which imports `revalidateTag`/`unstable_cache` from `next/cache`,
  // server-only). See template-form.tsx for the full import-trace
  // rationale; long-term fix is to extract `verifyContactEmail →
  // renewals-deps` to a port.
  "src/components/broadcast/admin/template-form.tsx::@/modules/broadcasts/application/use-cases/_template-field-limits",
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
  readonly key: string; // `${file}::${importPath}` (R3.5 M-4 — was `:line`)
  readonly text: string;
}

/**
 * R3.5 M-4 — extract the deep-import PATH from a violating line so
 * the allowlist key is drift-resistant against unrelated line shifts.
 * Matches `from '...'` or `from "..."` and returns the path content
 * inside the quotes. Returns null if no path can be extracted (line
 * matched the regex but isn't a clean import statement — defensive).
 *
 * R4.3 M-12 — KNOWN LIMITATION: this is a SINGLE-LINE scanner. Multi-
 * line imports of the form
 *
 *     import {
 *       Foo,
 *       Bar,
 *     } from '@/modules/broadcasts/domain/foo';
 *
 * have `from '...'` on a different line than the named-import list,
 * so the FORBIDDEN_PATH_PATTERNS regex matches the `from` line but
 * not the named-import line. The current implementation still catches
 * these (the `from`-line carries the forbidden path) but loses the
 * named-import context. For drift the simpler key is acceptable; if
 * a future scenario needs the named-import list, swap to a TS AST
 * scan (e.g., `ts-morph`) rather than extending the regex.
 */
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
          const repoRel = file
            .replace(PROJECT_ROOT + sep, '')
            .replaceAll(sep, '/');
          const importPath = extractImportPath(line) ?? `<line ${i + 1}>`;
          offenders.push({
            key: `${repoRel}::${importPath}`,
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
          'existing F7.1 backlog refactor, add the `${file}::${importPath}` ' +
          'key to KNOWN_BACKLOG in this test file along with a one-line ' +
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
