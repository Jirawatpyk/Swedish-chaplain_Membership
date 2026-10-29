/**
 * `check:red-first` — Principle II's commit order, checked mechanically
 * (retro 2026-10-29: c5bc2f9c6 shipped import-leg application logic and its
 * tests in ONE commit, and nothing noticed until a review read the history).
 */
import { describe, expect, it } from 'vitest';

import { findRedFirstViolations, type BranchCommit } from '../../../scripts/lib/red-first';

const c = (sha: string, subject: string, files: string[], body = ''): BranchCommit => ({
  sha,
  subject,
  body,
  files,
});

const LOGIC = 'src/modules/broadcasts/application/use-cases/build-audience-tick.ts';
const TEST = 'tests/unit/broadcasts/application/build-audience-tick-failure-paths.test.ts';

describe('findRedFirstViolations', () => {
  it('flags a fix: touching application/ with no earlier test: commit for that module (positive control)', () => {
    const v = findRedFirstViolations([c('aaa1111', 'fix(broadcasts): x', [LOGIC, TEST])]);
    expect(v).toEqual([{ sha: 'aaa1111', subject: 'fix(broadcasts): x', modules: ['broadcasts'] }]);
  });

  it('passes when a test: commit touching the module tests comes first', () => {
    const v = findRedFirstViolations([
      c('aaa1111', 'test(broadcasts): red', [TEST]),
      c('bbb2222', 'fix(broadcasts): green', [LOGIC]),
    ]);
    expect(v).toEqual([]);
  });

  it('a test: commit AFTER the logic commit does not count', () => {
    const v = findRedFirstViolations([
      c('bbb2222', 'feat(broadcasts): green', [LOGIC]),
      c('aaa1111', 'test(broadcasts): red', [TEST]),
    ]);
    expect(v.map((x) => x.sha)).toEqual(['bbb2222']);
  });

  it('a test: commit for ANOTHER module does not count', () => {
    const v = findRedFirstViolations([
      c('aaa1111', 'test(invoicing): red', ['tests/unit/invoicing/x.test.ts']),
      c('bbb2222', 'fix(broadcasts): green', [LOGIC]),
    ]);
    expect(v.map((x) => x.sha)).toEqual(['bbb2222']);
  });

  it('matches the singular test folder too (tests/unit/broadcast vs broadcasts)', () => {
    const v = findRedFirstViolations([
      c('aaa1111', 'test(broadcast): red', ['tests/unit/broadcast/compose.test.ts']),
      c('bbb2222', 'fix(broadcasts): green', [LOGIC]),
    ]);
    expect(v).toEqual([]);
  });

  it('covers domain/ as well as application/, and the [Spec Kit] prefix', () => {
    const v = findRedFirstViolations([
      c('bbb2222', '[Spec Kit] feat(members): green', ['src/modules/members/domain/member.ts']),
    ]);
    expect(v.map((x) => x.modules)).toEqual([['members']]);
  });

  it('ignores refactor:, docs:, chore: and test: commits, and infrastructure/-only changes', () => {
    const v = findRedFirstViolations([
      c('a1', 'refactor(broadcasts): extract helper', [LOGIC]),
      c('a2', 'docs(broadcasts): comments', [LOGIC]),
      c('a3', 'chore: bump', [LOGIC]),
      c('a4', 'fix(broadcasts): adapter', ['src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts']),
    ]);
    expect(v).toEqual([]);
  });

  it('a Red-First-Exempt trailer with a reason exempts the commit; an empty one does not', () => {
    const v = findRedFirstViolations([
      c('a1', 'fix(broadcasts): x', [LOGIC], 'Body.\n\nRed-First-Exempt: test and code share a commit, failing run recorded in plan.md'),
      c('a2', 'fix(broadcasts): y', [LOGIC], 'Red-First-Exempt:   '),
    ]);
    expect(v.map((x) => x.sha)).toEqual(['a2']);
  });

  it('an allow-listed SHA prefix is exempt', () => {
    const v = findRedFirstViolations([c('c5bc2f9c6abc', 'fix(broadcasts): x', [LOGIC])], ['c5bc2f9c6']);
    expect(v).toEqual([]);
  });
});
