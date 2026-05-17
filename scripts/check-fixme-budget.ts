#!/usr/bin/env tsx
/**
 * Fixme/skip budget enforcement — guards against the F4 ship-with-fixmes
 * class of regression net erosion.
 *
 * Context (retrospective 2026-05-17): F4 (Invoices & Receipts) shipped
 * with ~20+ `test.fixme` markers in user-story acceptance scenarios
 * (AS1–AS6 invoice-draft-issue, AS1–AS3 invoice-void, AS1–AS4
 * invoice-pay, AS2/AS4 invoice-member-page-integration). The Constitution
 * Principle II TDD discipline was satisfied at the spec level ("test
 * authored before implementation") but the fixme markers meant the
 * tests never RAN — so 2 LIVE product bugs (combined-receipt-hint server
 * crash + RSC 404 status drift) reached production undetected.
 *
 * This check enforces a per-suite budget on `test.fixme` + `test.skip`
 * + bare `it.skip` markers in E2E + contract suites. Unit suites
 * legitimately use conditional skips (viewport gating, env-flag gating)
 * so are NOT counted.
 *
 * Exit non-zero (CI failure) if any suite exceeds its budget.
 *
 * Usage:
 *   pnpm check:fixme                 # enforce budgets
 *   pnpm check:fixme --list          # print per-file fixme/skip locations
 *
 * Budgets live in BUDGETS below — bumping a budget should require a
 * code-review reason (track the rationale in the PR description).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface Budget {
  readonly suite: string;
  readonly globRoots: ReadonlyArray<string>;
  readonly budget: number;
  readonly notes: string;
}

// Per-suite fixme/skip budgets. 0 = no fixmes allowed (ship blocker).
// Bumping a budget MUST be accompanied by a code-review rationale.
const BUDGETS: ReadonlyArray<Budget> = [
  {
    suite: 'tests/e2e (excluding viewport-gated conditional skips)',
    globRoots: ['tests/e2e'],
    budget: 0,
    notes:
      'F4 ship-with-fixmes regression class. test.fixme + bare test.skip ' +
      'must be 0. Conditional test.skip(condition, "reason") inside a test ' +
      'body is allowed (viewport-gated, env-flag-gated) and NOT counted.',
  },
  {
    suite: 'tests/contract',
    globRoots: ['tests/contract'],
    budget: 0,
    notes:
      'Contract tests pin external API + cross-module surface promises. ' +
      'A fixme here means the surface is unfrozen — never acceptable on a ' +
      'release branch.',
  },
];

interface Match {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly kind: 'fixme' | 'bare-skip';
}

// Match patterns that DISABLE a test outright:
//   test.fixme('...', ...)           — explicit "broken/not implemented" marker
//   it.fixme('...', ...)
//   test.skip('...', ...)            — bare static skip (NOT conditional skip)
//   it.skip('...', ...)
//
// Does NOT match:
//   test.skip(condition, 'reason')   — conditional skip inside test body
//   test.skip(!ENV_VAR, '...')       — env-gated skip (legitimate)
//
// The discriminator is "first argument is a string literal" — bare skip
// uses a string title; conditional skip uses an expression.
const DISABLE_PATTERNS: ReadonlyArray<{ re: RegExp; kind: Match['kind'] }> = [
  { re: /\b(?:test|it)\.fixme\s*\(\s*['"`]/g, kind: 'fixme' },
  { re: /\b(?:test|it)\.skip\s*\(\s*['"`]/g, kind: 'bare-skip' },
];

function* walk(root: string): Generator<string> {
  const abs = resolve(root);
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(abs);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(abs, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile() && /\.(?:spec|contract|test)\.ts$/.test(name)) {
      yield full;
    }
  }
}

function scanFile(path: string): ReadonlyArray<Match> {
  const out: Match[] = [];
  const source = readFileSync(path, 'utf8');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { re, kind } of DISABLE_PATTERNS) {
      // Reset regex state (globals are stateful across .test() calls).
      re.lastIndex = 0;
      if (re.test(line)) {
        out.push({
          file: path,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
          kind,
        });
      }
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const listMode = args.includes('--list');

  const cwd = process.cwd();
  let totalViolations = 0;
  const report: Array<{ budget: Budget; matches: ReadonlyArray<Match> }> = [];

  for (const budget of BUDGETS) {
    const matches: Match[] = [];
    for (const root of budget.globRoots) {
      for (const file of walk(root)) {
        matches.push(...scanFile(file));
      }
    }
    report.push({ budget, matches });
    if (matches.length > budget.budget) {
      totalViolations += matches.length - budget.budget;
    }
  }

  // Always print summary.

  console.log('\n=== check:fixme budget report ===\n');
  for (const { budget, matches } of report) {
    const status =
      matches.length <= budget.budget
        ? `\x1b[32mPASS\x1b[0m (${matches.length}/${budget.budget})`
        : `\x1b[31mFAIL\x1b[0m (${matches.length}/${budget.budget})`;

    console.log(`${status} ${budget.suite}`);
    if (listMode || matches.length > budget.budget) {
      for (const m of matches) {
        const rel = relative(cwd, m.file).replace(/\\/g, '/');

        console.log(`  [${m.kind}] ${rel}:${m.line}  ${m.snippet}`);
      }
    }
  }

  console.log('');

  if (totalViolations > 0) {

    console.error(
      `\x1b[31m✗ check:fixme: ${totalViolations} budget violation(s)\x1b[0m`,
    );

    console.error(
      '  test.fixme + bare test.skip block release branches. Either ' +
        'implement the test, convert to conditional skip(expr, "reason"), ' +
        'or delete it.',
    );
    process.exit(1);
  }

  console.log('\x1b[32m✓ check:fixme: all suites within budget\x1b[0m\n');
}

main();
