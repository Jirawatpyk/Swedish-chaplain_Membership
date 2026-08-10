/**
 * check:staff-page-guard (016-rbac-permissions T037).
 *
 * Every `(staff)/admin/**​/page.tsx` MUST call `requirePagePermission` exactly
 * once, with LITERAL arguments, and those literals MUST be the (key, row) pair
 * the frozen baseline records for that page.
 *
 * Why literals: the whole authorization surface has to be readable statically.
 * A computed key (`requirePagePermission(keyFor(x), …)`) cannot be audited by
 * this script, by a reviewer scanning the diff, or by the role × endpoint
 * matrix — so it is rejected outright rather than warned about.
 *
 * Why the baseline cross-check: the call alone proves a page is gated, not that
 * it is gated CORRECTLY. Tying the literals to `rbac-observed-baseline.ts` is
 * what makes the matrix test's per-role verdicts apply to the real page.
 *
 * Exemptions: exactly the redirect-only pages listed in the baseline's
 * `GUARD_EXEMPT_PAGES` — a page that only calls `redirect()` has no surface of
 * its own to protect. The list lives in the baseline, not here, so it cannot
 * grow quietly in a script nobody reads.
 *
 * Clone of the `portal-guard-core` gate precedent. Wired into `.husky/pre-push`
 * and the `quality-gates.yml` static step.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const PAGES_DIR = join(ROOT, 'src', 'app', '(staff)', 'admin');
const BASELINE = join(ROOT, 'tests', 'helpers', 'rbac-observed-baseline.ts');

interface BaselineRow {
  readonly key: string;
  readonly row: string;
}

function loadBaseline(): { pages: Map<string, BaselineRow>; exempt: Set<string> } {
  const src = readFileSync(BASELINE, 'utf8');
  const pages = new Map<string, BaselineRow>();
  const re = /\{ surface: '([^']+)', kind: 'page', key: '([^']+)', row: \{ kind: '([^']+)' \}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    pages.set(m[1]!, { key: m[2]!, row: m[3]! });
  }
  const exemptBlock = /export const GUARD_EXEMPT_PAGES[^=]*=\s*\[([^\]]*)\]/.exec(src);
  const exempt = new Set<string>(
    [...(exemptBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!),
  );
  return { pages, exempt };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === 'page.tsx') out.push(p);
  }
  return out;
}

/**
 * Blank out block + line comments so a scan sees code only. Deliberately naive
 * (it does not understand comment-like text inside string literals) — that is
 * acceptable here because the only consumer looks for an `if (…role !== '…')`
 * statement, which no string literal in these pages contains.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `.../admin/plans/[year]/page.tsx` → `/admin/plans/[year]`; `(home)` → `/admin`. */
function surfaceOf(file: string): string {
  const rel = relative(PAGES_DIR, file).split(sep).slice(0, -1);
  const parts = rel.filter((p) => p !== '(home)');
  return parts.length === 0 ? '/admin' : `/admin/${parts.join('/')}`;
}

const { pages: baseline, exempt } = loadBaseline();
const errors: string[] = [];
const seen = new Set<string>();

for (const file of walk(PAGES_DIR)) {
  const surface = surfaceOf(file);
  const src = readFileSync(file, 'utf8');
  const shown = relative(ROOT, file).replace(/\\/g, '/');

  if (exempt.has(surface)) {
    if (/requirePagePermission/.test(stripComments(src))) {
      errors.push(`${shown}: listed in GUARD_EXEMPT_PAGES but calls requirePagePermission`);
    }
    // A redirect-only page must actually be redirect-only.
    if (!/\bredirect\(/.test(src)) {
      errors.push(`${shown}: exempt as redirect-only, but no redirect() call found`);
    }
    seen.add(surface);
    continue;
  }

  const expected = baseline.get(surface);
  if (expected === undefined) {
    errors.push(`${shown}: no row in rbac-observed-baseline.ts for '${surface}'`);
    continue;
  }
  seen.add(surface);

  // Scan CODE only, consistently: several pages name the helper in their
  // header prose, and counting those as call sites would make documenting the
  // guard a build failure.
  const code = stripComments(src);
  const calls = [
    ...code.matchAll(/requirePagePermission\(\s*'([^']*)'\s*,\s*([A-Za-z_$][\w$]*)/g),
  ];
  const anyCall = (code.match(/requirePagePermission\(/g) ?? []).length;

  if (anyCall === 0) {
    errors.push(`${shown}: no requirePagePermission call`);
    continue;
  }
  if (anyCall !== calls.length) {
    errors.push(
      `${shown}: requirePagePermission called with non-literal arguments (${anyCall} call(s), ${calls.length} literal)`,
    );
    continue;
  }
  if (calls.length !== 1) {
    errors.push(`${shown}: expected exactly 1 requirePagePermission call, found ${calls.length}`);
    continue;
  }

  const [, key, row] = calls[0]!;
  if (key !== expected.key) {
    errors.push(`${shown}: declares key '${key}', baseline says '${expected.key}'`);
  }
  if (row !== expected.row) {
    errors.push(`${shown}: declares row '${row}', baseline says '${expected.row}'`);
  }

  // A leftover role literal means the sweep left a second, invisible gate that
  // the matrix cannot see — and one that would deny super_admin after Migration C.
  // Scan CODE only: several pages legitimately quote the old guard in their
  // header prose, and a gate that fails on documentation teaches people to
  // delete documentation.
  const roleGate = /if\s*\([^)]*\brole\s*!==\s*'(admin|manager)'/.exec(stripComments(src));
  if (roleGate !== null) {
    errors.push(`${shown}: still contains a role-literal deny arm — ${roleGate[0].trim()}`);
  }
}

for (const surface of baseline.keys()) {
  if (!seen.has(surface)) errors.push(`baseline row '${surface}' has no page file`);
}

if (errors.length > 0) {
  console.error('check:staff-page-guard FAILED\n');
  errors.forEach((e) => console.error('  ✗ ' + e));
  console.error(
    `\n${errors.length} problem(s). Every staff page declares its permission as a ` +
      'literal pair matching tests/helpers/rbac-observed-baseline.ts.',
  );
  process.exit(1);
}

console.log(
  `check:staff-page-guard — OK (${seen.size} page(s): ${baseline.size} guarded, ${exempt.size} exempt).`,
);
