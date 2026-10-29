/**
 * Principle II's commit order, as a pure rule (`check:red-first`).
 *
 * A `fix:` / `feat:` commit that changes a module's `application/` or
 * `domain/` code needs an EARLIER `test:` commit on the same branch that
 * touches that module's tests — the RED commit (`docs/workflow.md` step 4).
 * `refactor:` / `docs:` / `chore:` / `test:` and infrastructure-only changes
 * are not behaviour changes the rule asks a RED commit for. D-023's
 * shared-commit exception never covers application/domain logic, so the only
 * escape is a `Red-First-Exempt: <reason>` trailer, which the PR then shows.
 *
 * Retro 2026-10-29: c5bc2f9c6 shipped import-leg application logic and its
 * tests in ONE commit; the rule lived only in `.claude/rules/rules.md`, and a
 * review reads the branch diff, not the commit order.
 */

export interface BranchCommit {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly files: ReadonlyArray<string>;
}

export interface RedFirstViolation {
  readonly sha: string;
  readonly subject: string;
  readonly modules: ReadonlyArray<string>;
}

const HEADER = /^(?:\[Spec Kit\]\s*)?([a-z]+)(?:\([^)]*\))?!?:/;
const LOGIC_FILE = /^src\/modules\/([^/]+)\/(?:application|domain)\//;
const EXEMPT_TRAILER = /^Red-First-Exempt:[ \t]*(\S.*)$/m;

function commitType(subject: string): string | null {
  return HEADER.exec(subject)?.[1] ?? null;
}

/**
 * Test folders named other than their module: `tests/unit/broadcast/` (singular)
 * and the `invoices/` folders under `tests/`. Every other module's tests use
 * its exact name.
 */
const TEST_FOLDER_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  broadcasts: ['broadcast'],
  invoicing: ['invoices'],
};

function touchesModuleTests(files: ReadonlyArray<string>, module: string): boolean {
  const names = [module, ...(TEST_FOLDER_ALIASES[module] ?? [])];
  return files.some((f) => f.startsWith('tests/') && f.split('/').some((seg) => names.includes(seg)));
}

/** Commits oldest first. `allowShas` are grandfathered SHA prefixes. */
export function findRedFirstViolations(
  commits: ReadonlyArray<BranchCommit>,
  allowShas: ReadonlyArray<string> = [],
): RedFirstViolation[] {
  const violations: RedFirstViolation[] = [];
  const earlierTests: BranchCommit[] = [];
  for (const commit of commits) {
    const type = commitType(commit.subject);
    // `perf:` and `revert:` change behaviour too, under another name.
    if (type === 'fix' || type === 'feat' || type === 'perf' || type === 'revert') {
      const modules = [
        ...new Set(
          commit.files.flatMap((f) => {
            const m = LOGIC_FILE.exec(f);
            return m?.[1] !== undefined ? [m[1]] : [];
          }),
        ),
      ];
      const missing = modules.filter((m) => !earlierTests.some((t) => touchesModuleTests(t.files, m)));
      const exempt =
        EXEMPT_TRAILER.test(commit.body) || allowShas.some((prefix) => commit.sha.startsWith(prefix));
      if (missing.length > 0 && !exempt) {
        violations.push({ sha: commit.sha, subject: commit.subject, modules: missing });
      }
    }
    if (type === 'test') earlierTests.push(commit);
  }
  return violations;
}
