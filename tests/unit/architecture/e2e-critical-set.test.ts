/**
 * The `@critical` e2e set (spec 123 slice 2, DW-7).
 *
 * `e2e-critical.yml` runs `--grep @critical` on every PR against a fresh
 * `ci-e2e/` branch, inside a 25-minute budget. The set is sized from the
 * spike's per-spec times (plan.md § Evidence), so it is an explicit list:
 * tagging one more spec is a budget decision, made here.
 *
 * Every tagged spec must run on the shared CI branch, so none may import the
 * throwaway-tenant helper (it needs `E2E_X_TENANT_HEADER_ENABLED`, which the
 * production boot in CI does not set) or the `/test-fixtures` routes — directly
 * or through a local helper it imports.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const E2E_DIR = join(process.cwd(), 'tests', 'e2e');

const CRITICAL_SET = [
  'admin-journey.spec.ts',
  'critical-invoice-issue.spec.ts',
  'critical-member-profile.spec.ts',
  'f9-dashboard.spec.ts',
  'member-sign-in.spec.ts',
  'members-directory-search.spec.ts',
  'payment-promptpay-happy-path.spec.ts',
  'portal-invoices.spec.ts',
  'staff-sign-in.spec.ts',
];

// Dropped after run 39100353012 (budget): member-nav (202 s per project) and
// renewal-pipeline-dashboard (118 / 168 s) were the slowest additions and put the
// projected job over 25 minutes. Both also failed there on CI-only causes (F7 is
// off in CI; a 5 s wall-clock assertion from a US runner); see plan.md § Evidence.

const FORBIDDEN = /throwaway-tenant|\/test-fixtures/;

function specFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return specFiles(path);
    return entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** `@critical` in a test or describe title, or in its `{ tag }` option — not in a comment. */
function isTagged(source: string): boolean {
  const code = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const inTitle = /(?:test|describe)(?:\.\w+)*\(\s*['"`][^'"`]*@critical\b/;
  const inTagOption = /\btag:\s*(?:\[[^\]]*)?['"`]@critical['"`]/;
  return inTitle.test(code) || inTagOption.test(code);
}

/** The spec's source plus every relative module it imports, one level deep. */
function sourceWithLocalImports(file: string): string {
  const source = readFileSync(file, 'utf8');
  const local = [...source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!);
  const imported = local.map((spec) => {
    const base = resolve(dirname(file), spec);
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
      try {
        return readFileSync(candidate, 'utf8');
      } catch {
        // try the next resolution
      }
    }
    return '';
  });
  return [source, ...imported].join('\n');
}

describe('e2e @critical set scan (positive control)', () => {
  it('recognises a tag in a title and ignores one in a comment', () => {
    expect(isTagged("test.describe('staff sign-in @critical', () => {")).toBe(true);
    expect(isTagged("test('x @f4 @critical', async () => {")).toBe(true);
    expect(isTagged("test('issue one', { tag: '@critical' }, async () => {")).toBe(true);
    expect(isTagged("test.describe('x', { tag: ['@f4', '@critical'] }, () => {")).toBe(true);
    expect(isTagged('// @critical is a CI tag')).toBe(false);
  });
});

describe('tests/e2e @critical set', () => {
  const tagged = specFiles(E2E_DIR)
    .filter((file) => isTagged(readFileSync(file, 'utf8')))
    .map((file) => relative(E2E_DIR, file).replace(/\\/g, '/'))
    .sort();

  it('the scan finds tagged specs (an empty scan checks nothing)', () => {
    expect(tagged.length).toBeGreaterThanOrEqual(1);
  });

  it('equals the budgeted allow-list exactly', () => {
    expect(tagged).toEqual([...CRITICAL_SET].sort());
  });

  it('imports neither the throwaway tenant nor /test-fixtures, directly or via a local helper', () => {
    const offenders = tagged.filter((spec) => FORBIDDEN.test(sourceWithLocalImports(join(E2E_DIR, spec))));
    expect(offenders).toEqual([]);
  });
});
