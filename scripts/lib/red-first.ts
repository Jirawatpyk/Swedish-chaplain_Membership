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

const HEADER = /^(?:\[Spec Kit\]\s*)?([a-z]+)(?:\(([^)]*)\))?!?:/;
/** `git revert`'s default subject is `Revert "<original subject>"`. */
const GIT_REVERT = /^Revert "/;
const LOGIC_FILE = /^src\/modules\/([^/]+)\/(?:application|domain)\//;
const EXEMPT_TRAILER = /^Red-First-Exempt:[ \t]*(\S.*)$/m;

function commitType(subject: string): string | null {
  if (GIT_REVERT.test(subject)) return 'revert';
  return HEADER.exec(subject)?.[1] ?? null;
}

function commitScope(subject: string): string | null {
  return HEADER.exec(subject)?.[2] ?? null;
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

/**
 * A `test:` commit counts as module M's RED when its scope names M (or an
 * alias, or M's singular), or it touches a `tests/**` path with a folder named
 * for M, or a file whose name starts with M's singular (`event-attendees-port…`
 * for `events`, flat files in `tests/contract/`).
 */
function isRedFor(commit: BranchCommit, module: string): boolean {
  const singular = module.endsWith('s') ? module.slice(0, -1) : module;
  const names = [module, ...(TEST_FOLDER_ALIASES[module] ?? [])];
  const scope = commitScope(commit.subject);
  if (scope !== null && (names.includes(scope) || scope === singular)) return true;
  return commit.files.some((f) => {
    if (!f.startsWith('tests/')) return false;
    const segs = f.split('/');
    const base = segs[segs.length - 1] ?? '';
    return segs.slice(0, -1).some((seg) => names.includes(seg)) || [...names, singular].some((n) => base.startsWith(n));
  });
}

/** Commits oldest first. Grandfathering is the caller's (`scripts/check-red-first.ts` ALLOW). */
export function findRedFirstViolations(commits: ReadonlyArray<BranchCommit>): RedFirstViolation[] {
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
      const missing = modules.filter((m) => !earlierTests.some((t) => isRedFor(t, m)));
      const exempt = EXEMPT_TRAILER.test(commit.body);
      if (missing.length > 0 && !exempt) {
        violations.push({ sha: commit.sha, subject: commit.subject, modules: missing });
      }
    }
    if (type === 'test') earlierTests.push(commit);
  }
  return violations;
}
