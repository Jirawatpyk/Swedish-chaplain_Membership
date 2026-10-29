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
  // An EMPTY value counts as unset: `..HEAD` would read as an empty range and
  // pass silently. Both must look like a revision, never like an option.
  const head = process.env.RED_FIRST_HEAD || 'HEAD';
  let base = process.env.RED_FIRST_BASE || undefined;
  const REV = /^(?:HEAD|[0-9a-f]{7,40})$/;
  if (!REV.test(head) || (base !== undefined && !REV.test(base))) {
    console.error('check:red-first: RED_FIRST_BASE / RED_FIRST_HEAD must be a commit SHA (or HEAD)');
    process.exit(1);
  }
  if (base === undefined) {
    try {
      base = git(['merge-base', 'origin/main', head]).trim();
    } catch {
      console.error('check:red-first: cannot resolve merge-base(origin/main, HEAD); run `git fetch origin main` or set RED_FIRST_BASE');
      process.exit(1);
    }
  }
  // ONE spawn for the whole range: each record is `\x1e<sha>\x1f<subject>\x1f<body>\x1f`
  // then the `--name-only` file list. `--no-renames` lists both sides of a
  // rename, as `diff-tree -r` did.
  const log = git([
    'log', '--reverse', '--no-merges', '--no-renames', '--name-only',
    '--format=%x1e%H%x1f%s%x1f%b%x1f', '--end-of-options', `${base}..${head}`,
  ]);
  const commits: BranchCommit[] = log
    .split('\x1e')
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', subject = '', body = '', files = ''] = record.split('\x1f');
      return { sha, subject: subject.trim(), body, files: files.split('\n').filter(Boolean) };
    });
  // A non-empty range that parses to no commit means the parse broke, not that
  // there is nothing to check (positive control).
  if (commits.length === 0 && git(['rev-parse', base]).trim() !== git(['rev-parse', head]).trim()) {
    if (git(['rev-list', '--count', '--no-merges', `${base}..${head}`]).trim() !== '0') {
      console.error('check:red-first: the range has commits but none parsed — the gate checked nothing');
      process.exit(1);
    }
  }
  const allowFor = (sha: string) => ALLOW.find((a) => sha.startsWith(a.sha));
  const found = findRedFirstViolations(commits);
  for (const v of found) {
    const entry = allowFor(v.sha);
    if (entry !== undefined) console.log(`check:red-first: allowed ${v.sha.slice(0, 9)} ${v.subject} — ${entry.why}`);
  }
  const violations = found.filter((v) => allowFor(v.sha) === undefined);
  if (violations.length > 0) {
    console.error(`check:red-first: ${violations.length} commit(s) change application/domain logic with no earlier test: commit for the module:`);
    for (const v of violations) console.error(`  ${v.sha.slice(0, 9)} ${v.subject}  [${v.modules.join(', ')}]`);
    console.error('Commit the failing test first (test(<module>): …), or add a `Red-First-Exempt: <reason>` trailer.');
    console.error('Not your commits? A stale origin/main pulls main\'s squash commits into the range: run `git fetch origin main` first.');
    process.exit(1);
  }
  console.log(`check:red-first: ${commits.length} commit(s) on the branch, every logic change has a RED commit before it`);
}

main();
