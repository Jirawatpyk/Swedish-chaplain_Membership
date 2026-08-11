/**
 * check:api-route-guard — the API counterpart to `check:staff-page-guard`
 * (016-rbac-permissions, review finding C3).
 *
 * ## Why this exists
 *
 * The frozen capture in `tests/helpers/rbac-observed-baseline.ts` is the referee
 * for the whole PR-2 authorization sweep, but until this script it was only ever
 * applied to PAGES. `check-staff-page-guard.ts` reads each `page.tsx`, extracts
 * the literal `(key, row)` pair, and compares it to the baseline. The ~131 API
 * surfaces — which are most of the attack surface, and all of the money and PII
 * handlers — had no equivalent:
 *
 *   - `role-endpoint-matrix.test.ts` evaluates the baseline DATA. It never opens
 *     a route file, and on each leg the evaluator discards the other leg's
 *     argument, so a mispaired (key, row) is invisible to it BY CONSTRUCTION.
 *   - `api-route-exhaustiveness.test.ts` only asserts that a route id appears in
 *     the baseline array.
 *
 * Net effect before this gate: a handler could declare any key and any row, and
 * every check stayed green. That is exactly how four residual `role === 'admin'`
 * deny arms survived a commit titled "role-literal sweep" and left `super_admin`
 * unable to issue a credit note or void an invoice after Migration C.
 *
 * ## What it checks, per `src/app/api/**​/route.ts`
 *
 *  1. Every declared gate argument is a LITERAL (a computed key cannot be
 *     compared to the baseline, so it is rejected outright).
 *  2. The SET of (key, row) pairs declared in the file equals the set the
 *     baseline expects for that path across all its methods. Set equality rather
 *     than per-method matching because a call site cannot be attributed to an
 *     exported handler without parsing scopes — set equality still catches a
 *     wrong key, a missing key, and an extra key.
 *  3. No leftover STAFF-role literal deny arm. Comparisons against `'member'`
 *     are allowed: `member` is never a staff role, so narrowing it out is the
 *     safe direction and is how several handlers satisfy a discriminated-union
 *     actor type.
 *
 * Routes with no baseline row are skipped — their class (public / cron-bearer /
 * webhook-signature / portal-member / session-any) is owned by
 * `api-route-exhaustiveness.test.ts`, which fails on anything unclassified.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');
const BASELINE = join(ROOT, 'tests', 'helpers', 'rbac-observed-baseline.ts');

/** A (key, row) pair, rendered as a comparable string. */
type Pair = string;

const pairOf = (key: string, row: string): Pair => `${key} :: ${row}`;

/**
 * Baseline rows carry either a bare row kind (`{ kind: 'legacyAdminOnly' }`) or
 * a mapped row with data (`{ kind: 'mappedLegacy', resource: 'x', action: 'y' }`).
 * Render both into the same shape the source scan produces.
 */
function loadBaseline(): Map<string, Set<Pair>> {
  const src = readFileSync(BASELINE, 'utf8');
  const byPath = new Map<string, Set<Pair>>();
  const re =
    /\{ surface: '([^']+)', kind: 'api', key: '([^']+)', row: \{ kind: '([^']+)'(?:, resource: '([^']+)', action: '([^']+)')? \}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const [, surface, key, kind, resource, action] = m;
    const path = surface!.split(' ').slice(1).join(' ');
    const row = kind === 'mappedLegacy' ? `mappedLegacy(${resource},${action})` : kind!;
    const set = byPath.get(path) ?? new Set<Pair>();
    set.add(pairOf(key!, row));
    byPath.set(path, set);
  }
  return byPath;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry === 'route.ts') out.push(p);
  }
  return out;
}

/**
 * Blank out comments so prose describing a guard is never counted as one.
 *
 * LINE comments are stripped FIRST, and that order is load-bearing: this repo
 * has line comments containing `/**` (e.g. a prose reference to the route glob
 * `/admin/events/**` in `api/admin/events/import/route.ts:48`). Stripping block
 * comments first makes the regex latch onto that `/*` and swallow everything up
 * to the next `*​/` — 564 lines in that file, which silently hid the guard this
 * gate exists to find. The `[^:]` guard keeps `https://` intact.
 */
function stripComments(src: string): string {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `src/app/api/plans/[year]/route.ts` → `/api/plans/[year]`. */
function surfaceOf(file: string): string {
  const rel = relative(join(ROOT, 'src', 'app'), file).split(sep).slice(0, -1);
  return '/' + rel.join('/');
}

/**
 * Extract every gate declaration in a route file, in the three forms the repo
 * uses. Returns `null` for the pair when an argument is not a literal, so the
 * caller can report it rather than silently passing.
 */
function declaredPairs(
  code: string,
  rawLines: readonly string[],
): { pairs: Pair[]; nonLiteral: number } {
  const pairs: Pair[] = [];
  let nonLiteral = 0;

  // 1. requireApiPermission(request, 'key', <row>)
  const direct = code.matchAll(
    /requireApiPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'\s*,\s*(mappedLegacy\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)|[A-Za-z_$][\w$]*)/g,
  );
  for (const m of direct) {
    const [, key, rowExpr, resource, action] = m;
    pairs.push(pairOf(key!, resource ? `mappedLegacy(${resource},${action})` : rowExpr!));
  }
  const directCalls = (code.match(/requireApiPermission\(/g) ?? []).length;
  nonLiteral += directCalls - [...code.matchAll(
    /requireApiPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'\s*,\s*(mappedLegacy\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)|[A-Za-z_$][\w$]*)/g,
  )].length;

  // 2. requireRenewalAdminContext(request, 'action', 'key') — the F8 wrapper
  //    composes requireApiPermission with mappedLegacy('renewal', action),
  //    mapping the 'manager_exception' label onto the 'read' population.
  const renewals = code.matchAll(
    /requireRenewalAdminContext\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g,
  );
  for (const m of renewals) {
    const [, action, key] = m;
    const mapped = action === 'manager_exception' ? 'read' : action!;
    pairs.push(pairOf(key!, `mappedLegacy(renewal,${mapped})`));
  }
  const renewalCalls = (code.match(/requireRenewalAdminContext\(/g) ?? []).length;
  nonLiteral += renewalCalls - [...code.matchAll(
    /requireRenewalAdminContext\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g,
  )].length;

  // 3. F6 route-local guards (D9): adminOnly[Writer]Guard({ permissionKey: 'x', … })
  for (const m of code.matchAll(/permissionKey:\s*'([^']+)'/g)) {
    pairs.push(pairOf(m[1]!, 'legacyF6Guard'));
  }

  // 4. canPerform(role, 'key', row) used as the ADMISSION decision. Two F6 GET
  //    handlers decide this way so they can keep the FR-035 404-for-non-staff
  //    denial shape instead of the sweep's uniform 403 (D9 route-local
  //    override). It is still a real gate and must match the baseline.
  //
  //    A `canPerform` that gates a FIELD or an optional SECTION of an
  //    already-authorised response (DoB on the member read, the refundable
  //    invoices arm of the palette) is a sub-gate, not the surface's admission
  //    decision, so it carries a `SUBGATE_MARKER` and is excluded here. The
  //    marker is required rather than inferred: without it an admission
  //    decision could hide behind the same syntax.
  //    Scanned on the RAW source, because the marker lives in a comment and
  //    `stripComments` would remove it. Comment lines are skipped explicitly so
  //    prose naming `canPerform` is never counted as a call.
  for (const [i, line] of rawLines.entries()) {
    if (isCommentLine(line)) continue;
    if (markerNear(rawLines, i, SUBGATE_MARKER)) continue;
    const m =
      /canPerform\(\s*[A-Za-z_$][\w$.]*\s*,\s*'([^']+)'\s*,\s*(mappedLegacy\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)|[A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (m === null) continue;
    const [, key, rowExpr, resource, action] = m;
    pairs.push(pairOf(key!, resource ? `mappedLegacy(${resource},${action})` : rowExpr!));
  }

  return { pairs, nonLiteral };
}

/** A source line that is entirely comment (`//`, `*`, `/*`). */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * True when an opt-out marker sits on this line or in the short comment block
 * immediately above it. A window rather than same-line only, because the repo's
 * house style puts the reason on its own comment line above the code.
 */
function markerNear(lines: readonly string[], index: number, marker: string): boolean {
  for (let i = Math.max(0, index - 4); i <= index; i += 1) {
    if (lines[i]?.includes(marker)) return true;
  }
  return false;
}

/**
 * § 7.1 two-step per-TARGET contract. The six mutating users routes gate twice:
 * step 1 on the wider `users.member_accounts` before the target row is read,
 * then step 2 on `users.manage` once the target (or the requested role) is known
 * to be a staff row. The frozen baseline records only the step-2 key, because
 * that is the surface's effective permission for the case the D4 narrowing is
 * about — so the step-1 key is an EXPECTED extra declaration here, not drift.
 *
 * Keeping this allowance in the gate (rather than adding a second baseline row)
 * preserves the baseline as a frozen capture. The two-step behaviour itself is
 * pinned behaviourally by the contract tests on all six routes.
 */
const STEP_ONE_COMPANION: Readonly<Record<string, Pair>> = Object.fromEntries(
  [
    '/api/auth/invite',
    '/api/auth/users/[id]/role',
    '/api/auth/users/[id]/disable',
    '/api/auth/users/[id]/enable',
    '/api/auth/users/[id]/reissue-invite',
    '/api/auth/users/[id]/revoke-invite',
  ].map((p) => [p, pairOf('users.member_accounts', 'mappedLegacy(auth:user,write)')]),
);

/**
 * A leftover deny arm comparing against a STAFF role. `'member'` is excluded on
 * purpose — narrowing a member out is the safe direction and several handlers
 * need it to satisfy a discriminated-union actor type.
 */
/**
 * ANY identifier (or property chain) compared with `===`/`!==` to a staff-role
 * string literal. Deliberately NOT restricted to identifiers named `*role`:
 * the first version of this rule required a name ending in `Role`, which
 * matched `sessionRole` but silently missed the far more common
 * `ctx.current.user.role` — i.e. it missed the exact shape of the four defects
 * this gate was written to catch. A mutation test (re-inserting the deny arm on
 * the invoice-void route) is what surfaced that; keep one when editing this.
 */
const STAFF_ROLE_LITERAL =
  /(?:^|[^\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*(===|!==)\s*'(admin|manager|super_admin|marketing)'/;

/**
 * Opt-out for a comparison that is a TYPE narrow feeding a use-case schema
 * rather than an authorization decision. Must name the reason on the same line.
 */
const NARROW_MARKER = 'rbac-narrow-ok';

/**
 * Opt-out for a `canPerform` that gates a FIELD or an optional SECTION of an
 * already-authorised response, rather than deciding admission to the surface.
 */
const SUBGATE_MARKER = 'rbac-subgate-ok';

const baseline = loadBaseline();
const errors: string[] = [];
const seen = new Set<string>();
let checked = 0;

for (const file of walk(API_DIR)) {
  const surface = surfaceOf(file);
  const expected = baseline.get(surface);
  if (expected === undefined) continue; // non-role-matrix class; owned elsewhere
  seen.add(surface);
  checked += 1;

  const shown = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const code = stripComments(src);
  const rawLines = src.split(/\r?\n/);
  const { pairs, nonLiteral } = declaredPairs(code, rawLines);

  if (nonLiteral > 0) {
    errors.push(`${shown}: ${nonLiteral} gate call(s) with non-literal arguments`);
    continue;
  }
  if (pairs.length === 0) {
    errors.push(`${shown}: baseline expects a role-matrix gate but the file declares none`);
    continue;
  }

  const declared = new Set(pairs);
  for (const want of expected) {
    if (!declared.has(want)) {
      errors.push(`${shown}: baseline expects [${want}] — file declares [${[...declared].join('] [')}]`);
    }
  }
  const companion = STEP_ONE_COMPANION[surface];
  for (const got of declared) {
    if (expected.has(got) || got === companion) continue;
    errors.push(`${shown}: declares [${got}] which is not in the baseline for '${surface}'`);
  }
  if (companion !== undefined && !declared.has(companion)) {
    errors.push(
      `${shown}: § 7.1 step-1 gate missing — expected [${companion}] before the target row is read`,
    );
  }

  // Scanned on the RAW source for the same reason as the sub-gate scan: the
  // opt-out marker lives in a comment. Comment lines are skipped so a header
  // quoting the old guard is never reported as a live deny arm.
  for (const [i, line] of rawLines.entries()) {
    if (isCommentLine(line)) continue;
    if (markerNear(rawLines, i, NARROW_MARKER)) continue;
    const hit = STAFF_ROLE_LITERAL.exec(line);
    if (hit !== null) {
      errors.push(
        `${shown}:${i + 1}: staff-role literal behind the gate — ${hit[0].trim()} ` +
          `(a second, invisible gate the matrix cannot see; it would deny super_admin after Migration C. ` +
          `If this is a TYPE narrow, not an authorization decision, add a "${NARROW_MARKER}" comment on the line.)`,
      );
    }
  }
}

for (const path of baseline.keys()) {
  if (!seen.has(path)) errors.push(`baseline expects a route file for '${path}' — none found`);
}

if (errors.length > 0) {
  console.error('check:api-route-guard FAILED\n');
  errors.forEach((e) => console.error('  ✗ ' + e));
  console.error(
    `\n${errors.length} problem(s). Every staff API handler declares its permission as a ` +
      'literal pair matching tests/helpers/rbac-observed-baseline.ts, and carries no ' +
      'staff-role literal behind the gate.',
  );
  process.exit(1);
}

console.log(`check:api-route-guard — OK (${checked} route file(s) matched against the baseline).`);
