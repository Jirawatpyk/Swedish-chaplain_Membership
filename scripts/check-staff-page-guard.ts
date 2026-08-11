/**
 * check:staff-page-guard (016-rbac-permissions T037; hardened alongside the API
 * gate after the post-remediation re-review).
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
 * ## The affordance-literal scan (re-review round 2)
 *
 * The original leftover-literal rule here was an `if (…role !== 'admin')` regex
 * — it could not see `const canWrite = role === 'admin'`, which is the shape of
 * ~20 AFFORDANCE literals the re-review found on staff pages (mutation CTAs,
 * approve buttons, readOnly toggles). Those are not admission gates, so the
 * page loads — but after Migration C promotes every human admin to
 * `super_admin`, each one flips false and the admin portal renders read-only
 * for every human while the APIs behind the buttons accept the calls. That is
 * the C1 defect one layer up. The scan now uses the API gate's scanner
 * (identifier-chain compare in either operand order, single or double quotes,
 * array-literal `.includes()`, line-wrap tolerant) and covers EVERY `.tsx`
 * under `(staff)/admin` — `_components/` included, because `canMutate = role
 * === 'admin'` was found living in one. Deliberate narrows carry a
 * comment-hosted `rbac-narrow-ok` marker. Honest limits are the same as the
 * API gate's (switch/case, laundered const, predicate calls) — behavioural
 * pins are the net for those shapes.
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
  // Fail-loud reconciliation (same disease as the API gate's first version:
  // a reformatted row silently vanished from the parsed map and its page went
  // unpoliced while the script printed OK). Counted as `kind: 'page', key:` —
  // the bare string also appears in the BaselineRow TYPE declaration
  // (`readonly kind: 'page' | 'api';`), which is not a row.
  const declaredPageRows = (src.match(/kind: 'page', key:/g) ?? []).length;
  if (pages.size !== declaredPageRows || pages.size < 40) {
    console.error(
      `check:staff-page-guard ABORT — baseline parse drift: regex read ${pages.size} ` +
        `page row(s) but the file contains ${declaredPageRows} \`kind: 'page'\` marker(s). ` +
        'Restore the one-line literal row shape (or update the parser and this guard together).',
    );
    process.exit(1);
  }
  const exemptBlock = /export const GUARD_EXEMPT_PAGES[^=]*=\s*\[([^\]]*)\]/.exec(src);
  const exempt = new Set<string>(
    [...(exemptBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]!),
  );
  return { pages, exempt };
}

function walk(dir: string, pred: (entry: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, pred, out);
    else if (pred(entry)) out.push(p);
  }
  return out;
}

/**
 * Blank out comments while PRESERVING line structure (so scan hits report real
 * line numbers and markers can be checked on the raw lines). Three passes whose
 * order is load-bearing — see the API gate's copy for the war stories:
 * single-line block comments first (`/* a // b *​/` would otherwise lose its
 * terminator to the line pass), then line comments (a line comment containing
 * `/**` would feed the block pass a false opener), then multi-line blocks
 * reduced to their newlines.
 */
function stripCommentsPreserveLines(src: string): string {
  return src
    .replace(/\/\*[^\n]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
}

/** 0-based line number of a character offset within `text`. */
function lineOfIndex(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** A source line that is entirely comment (`//`, `*`, `/*`). */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Comment-hosted opt-out marker: same line after `//`, or in the contiguous
 * comment block at most MAX_CODE_GAP code lines above. Mirrors the API gate;
 * see its docstring for why comment-hosting (a marker string in CODE silenced
 * its neighbours in the first version).
 */
const MAX_CODE_GAP = 3;
function markerApplies(lines: readonly string[], index: number, marker: string): boolean {
  const line = lines[index] ?? '';
  const slash = line.indexOf('//');
  if (slash >= 0 && line.slice(slash).includes(marker)) return true;
  let i = index - 1;
  let codeGap = 0;
  while (i >= 0) {
    const l = lines[i] ?? '';
    if (isCommentLine(l)) {
      for (let j = i; j >= 0 && isCommentLine(lines[j] ?? ''); j -= 1) {
        if (lines[j]!.includes(marker)) return true;
      }
      return false;
    }
    if (l.trim() !== '') {
      codeGap += 1;
      if (codeGap > MAX_CODE_GAP) return false;
    }
    i -= 1;
  }
  return false;
}

const NARROW_MARKER = 'rbac-narrow-ok';

const STAFF_ROLE = `(admin|manager|super_admin|marketing)`;
const CMP_LITERAL = new RegExp(
  `(?:^|[^\\w$.])((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*[A-Za-z_$][\\w$]*)\\s*(===|!==)\\s*['"]${STAFF_ROLE}['"]` +
    `|['"]${STAFF_ROLE}['"]\\s*(===|!==)\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*[A-Za-z_$][\\w$]*`,
  'g',
);
const INCLUDES_LITERAL = new RegExp(
  `\\[\\s*(?:['"]${STAFF_ROLE}['"]\\s*,?\\s*)+\\]\\s*\\.\\s*includes\\s*\\(`,
  'g',
);

/** `.../admin/plans/[year]/page.tsx` → `/admin/plans/[year]`; `(home)` → `/admin`. */
function surfaceOf(file: string): string {
  const rel = relative(PAGES_DIR, file).split(sep).slice(0, -1);
  const parts = rel.filter((p) => p !== '(home)');
  return parts.length === 0 ? '/admin' : `/admin/${parts.join('/')}`;
}

const { pages: baseline, exempt } = loadBaseline();
const errors: string[] = [];
const seen = new Set<string>();

for (const file of walk(PAGES_DIR, (e) => e === 'page.tsx')) {
  const surface = surfaceOf(file);
  const src = readFileSync(file, 'utf8');
  const shown = relative(ROOT, file).replace(/\\/g, '/');

  if (exempt.has(surface)) {
    if (/requirePagePermission/.test(stripCommentsPreserveLines(src))) {
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
  const code = stripCommentsPreserveLines(src);
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
}

// Affordance-literal scan over EVERY staff-surface .tsx (see header) — pages,
// _components, layouts alike. A hit is a role decision the evaluator cannot
// see; after Migration C it silently strips humans of the affordance it gates.
for (const file of walk(PAGES_DIR, (e) => e.endsWith('.tsx'))) {
  const src = readFileSync(file, 'utf8');
  const shown = relative(ROOT, file).replace(/\\/g, '/');
  const code = stripCommentsPreserveLines(src);
  const rawLines = src.split(/\r?\n/);
  for (const re of [CMP_LITERAL, INCLUDES_LITERAL]) {
    re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(code)) !== null) {
      const line = lineOfIndex(code, hit.index);
      if (markerApplies(rawLines, line, NARROW_MARKER)) continue;
      errors.push(
        `${shown}:${line + 1}: staff-role literal — ${hit[0].trim()} ` +
          `(affordance/deny decisions must go through canPerform(role, key, row) so both legs ` +
          `and Migration C stay correct; a TYPE narrow takes a "${NARROW_MARKER}" comment).`,
      );
    }
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
      'literal pair matching tests/helpers/rbac-observed-baseline.ts, and staff role ' +
      'decisions go through the evaluator.',
  );
  process.exit(1);
}

console.log(
  `check:staff-page-guard — OK (${seen.size} page(s): ${baseline.size} guarded, ${exempt.size} exempt).`,
);
