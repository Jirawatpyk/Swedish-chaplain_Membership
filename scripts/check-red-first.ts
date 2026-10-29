#!/usr/bin/env tsx
/**
 * `pnpm check:red-first` — every `fix:` / `feat:` commit on this branch that
 * changes a module's `application/` or `domain/` code has an earlier `test:`
 * commit for that module (Principle II, `docs/workflow.md` step 4). The rule
 * itself is `scripts/lib/red-first.ts`; this file only reads the git history.
 *
 * Range: `RED_FIRST_BASE..RED_FIRST_HEAD`, defaulting to
 * `merge-base(origin/main, HEAD)..HEAD`. CI passes both from the PR event and
 * checks out with full history (`quality-gates.yml`). A base that cannot be
 * resolved FAILS rather than skips: a gate that cannot tell "nothing to find"
 * from "not looking" checks nothing.
 *
 * Escape hatch: a `Red-First-Exempt: <reason>` trailer on the commit.
 */
import { execFileSync } from 'node:child_process';

import { findRedFirstViolations, type BranchCommit } from './lib/red-first';

/**
 * Grandfathered SHA prefixes, each with its reason. A squash merge removes a
 * branch's commits from `main`, so an entry only matters while its branch is
 * open; delete it once that PR merges.
 */
const ALLOW: ReadonlyArray<{ readonly sha: string; readonly why: string }> = [
  {
    sha: 'c5bc2f9c6',
    why: '138 — the commit whose shared RED/GREEN prompted this gate (retro 2026-10-29); disclosed in the PR',
  },
];

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\r/g, '');
}

function main(): void {
  const head = process.env.RED_FIRST_HEAD ?? 'HEAD';
  let base = process.env.RED_FIRST_BASE;
  if (base === undefined) {
    try {
      base = git(['merge-base', 'origin/main', head]).trim();
    } catch {
      console.error('check:red-first: cannot resolve merge-base(origin/main, HEAD); fetch origin/main or set RED_FIRST_BASE');
      process.exit(1);
    }
  }
  const shas = git(['rev-list', '--reverse', '--no-merges', `${base}..${head}`]).split('\n').filter(Boolean);
  const commits: BranchCommit[] = shas.map((sha) => {
    const subject = git(['show', '-s', '--format=%s', sha]).trim();
    const body = git(['show', '-s', '--format=%b', sha]);
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean);
    return { sha, subject, body, files };
  });
  const violations = findRedFirstViolations(
    commits,
    ALLOW.map((a) => a.sha),
  );
  if (violations.length > 0) {
    console.error(`check:red-first: ${violations.length} commit(s) change application/domain logic with no earlier test: commit for the module:`);
    for (const v of violations) console.error(`  ${v.sha.slice(0, 9)} ${v.subject}  [${v.modules.join(', ')}]`);
    console.error('Commit the failing test first (test(<module>): …), or add a `Red-First-Exempt: <reason>` trailer.');
    process.exit(1);
  }
  console.log(`check:red-first: ${commits.length} commit(s) on the branch, every logic change has a RED commit before it`);
}

main();
