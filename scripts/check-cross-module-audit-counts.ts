/**
 * Round 9 S-R8-3 — cross-module audit-event count pre-flight check.
 *
 * Closes the stale-test class surfaced at Round 4 W-R7-2 where F8
 * Phase 2 Wave C added 4 plan_change_* events to F2's audit catalogue
 * but the F2 unit test (`expect(F2_AUDIT_EVENT_TYPES.length).toBe(10)`)
 * was missed in the cross-module-update sweep — the failing state was
 * only caught at staff-review Round 3, weeks after the source change.
 *
 * This script enforces at PR-time that:
 *   - F2 source const length === F2 test assertion
 *   - F8 source const length === F8 test assertion
 *
 * Round 10 I2 — corrected scope claim. Original docstring said the
 * script also validated against the spec-catalogue count, but the
 * code only reads source const + test assertion. Spec-catalogue
 * drift (the original W-R7-2 root cause for spec-vs-source) is
 * caught by `scripts/check-audit-event-count.ts` (F5 precedent
 * pattern, prose-vs-source). Both scripts together cover spec-vs-
 * source AND test-vs-source drift; this script is the test-pinning
 * half of the pair.
 *
 * Pattern mirrors `scripts/check-audit-event-count.ts` (F5 spec-prose
 * drift). Wire into CI via `pnpm check:audit-counts` (companion to
 * existing `pnpm check:audit-events`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

interface ModuleCheck {
  readonly module: string;
  readonly sourceFile: string;
  readonly sourceConstName: string;
  readonly testFile: string;
  readonly testAssertionPattern: RegExp;
}

const CHECKS: readonly ModuleCheck[] = [
  {
    module: 'F2 plans',
    sourceFile: 'src/modules/plans/domain/audit-event.ts',
    sourceConstName: 'F2_AUDIT_EVENT_TYPES',
    testFile: 'tests/unit/plans/domain/audit-event.test.ts',
    // Match `expect(F2_AUDIT_EVENT_TYPES.length).toBe(N)` — extract N.
    testAssertionPattern: /F2_AUDIT_EVENT_TYPES\.length\)\.toBe\((\d+)\)/,
  },
  {
    module: 'F8 renewals',
    sourceFile:
      'src/modules/renewals/application/ports/renewal-audit-emitter.ts',
    sourceConstName: 'F8_AUDIT_EVENT_TYPES',
    testFile: 'tests/unit/renewals/application/ports.test.ts',
    testAssertionPattern: /F8_AUDIT_EVENT_TYPES\.length\)\.toBe\((\d+)\)/,
  },
];

/**
 * Round 10 I5 — exported as pure function so unit tests can pin the
 * regex semantics with fixture strings. Returns:
 *   `-1` when the const literal cannot be located (file refactor /
 *        rename → caller treats as fail-loud)
 *   `0`  when the const exists but no entries match (e.g. quote-style
 *        refactor `'foo'` → `"foo"` → caller treats as fail-loud per
 *        S2; no real audit catalogue ships with 0 entries)
 *   `N`  count of single-quoted entries in the const literal
 */
export function countConstEntries(content: string, name: string): number {
  // Find `export const NAME = [` and count single-quoted entries until `] as const`.
  const startMatch = content.match(
    new RegExp(`export const ${name}\\s*=\\s*\\[`),
  );
  if (!startMatch) return -1;
  const startIdx = startMatch.index! + startMatch[0].length;
  const endMatch = content.slice(startIdx).match(/\]\s*as\s*const/);
  if (!endMatch) return -1;
  const block = content.slice(startIdx, startIdx + endMatch.index!);
  // Count single-quoted entries (excluding comments).
  return block.match(/^\s*'[^']+'/gm)?.length ?? 0;
}

// Round 10 I5 — wrap the script body so test files can `import
// { countConstEntries }` without triggering the disk-reading body.
// Vitest sets `import.meta.env.MODE = 'test'`; the `tsx` CLI invocation
// does not, so this conditional executes only under direct CLI use.
function main(): void {
let exitCode = 0;
for (const check of CHECKS) {
  const source = readFileSync(resolve(ROOT, check.sourceFile), 'utf-8');
  const sourceCount = countConstEntries(source, check.sourceConstName);
  if (sourceCount === -1) {
    console.error(
      `[check:audit-counts] ${check.module}: cannot find ${check.sourceConstName} in ${check.sourceFile}`,
    );
    exitCode = 1;
    continue;
  }
  // Round 10 S2 — guard the silent "0 entries" failure mode where the
  // const literal exists but a quote-style refactor (single→double or
  // backtick) makes the regex find zero entries. Production audit
  // catalogues always have ≥1 entry; treat 0 as a regex/refactor
  // mismatch and fail loud.
  if (sourceCount === 0) {
    console.error(
      `[check:audit-counts] ${check.module}: regex matched ${check.sourceConstName} ` +
        `but found 0 single-quoted entries — possible quote-style refactor ` +
        `(single→double quotes). Inspect ${check.sourceFile}.`,
    );
    exitCode = 1;
    continue;
  }

  const testSource = readFileSync(resolve(ROOT, check.testFile), 'utf-8');
  const testMatch = testSource.match(check.testAssertionPattern);
  if (!testMatch) {
    console.error(
      `[check:audit-counts] ${check.module}: cannot find length assertion ` +
        `matching ${check.testAssertionPattern} in ${check.testFile}`,
    );
    exitCode = 1;
    continue;
  }
  const testCount = Number(testMatch[1]);

  if (sourceCount !== testCount) {
    console.error(
      `[check:audit-counts] ${check.module}: DRIFT — source has ${sourceCount} events ` +
        `but test asserts ${testCount}. Update ${check.testFile}.`,
    );
    exitCode = 1;
  } else {
    console.log(
      `[check:audit-counts] ${check.module}: ✓ ${sourceCount} events (source ↔ test in sync)`,
    );
  }
}

if (exitCode !== 0) {
  console.error(
    '\n[check:audit-counts] Cross-module audit-event count drift detected. ' +
      'Update the test assertion(s) above before merge.',
  );
  process.exit(exitCode);
}
console.log('[check:audit-counts] OK — all cross-module audit catalogues in sync.');
}

// Run when invoked as a CLI entry point (not when imported by tests).
// `process.argv[1]` ends with this filename for direct `tsx` calls; under
// vitest, the worker entry differs.
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].includes('check-cross-module-audit-counts')
) {
  main();
}
