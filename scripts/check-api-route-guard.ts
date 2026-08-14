/**
 * check:api-route-guard — the API counterpart to `check:staff-page-guard`
 * (016-rbac-permissions, review finding C3; hardened per the post-remediation
 * re-review, which defeated the first version six different ways).
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
 *  2. PER-METHOD matching: each exported handler's declarations are compared
 *     against the baseline rows for exactly that `METHOD /path`. The first
 *     version compared one SET for the whole file, which the re-review defeated
 *     two ways on multi-method files: swapping the keys between GET and POST
 *     left the set identical, and downgrading PATCH to a pair its sibling GET
 *     already declared was absorbed by set-dedup. Both now fail. Files whose
 *     gate objects live at MODULE scope (the F6 `permissionKey:` guards — the
 *     scanner cannot attribute a module-level object to the handler that uses
 *     it without real scope analysis) fall back to file-level set equality;
 *     their per-method behaviour is pinned by the F6 contract/unit tests, which
 *     run the real guards.
 *  3. No leftover STAFF-role literal deny arm (see the scanner's own docstring
 *     for its honest limits). Comparisons against `'member'` are allowed:
 *     `member` is never a staff role, so narrowing it out is the safe direction
 *     and is how several handlers satisfy a discriminated-union actor type.
 *
 * Routes with no baseline row are skipped — their class (public / cron-bearer /
 * webhook-signature / portal-member / session-any) is owned by
 * `api-route-exhaustiveness.test.ts`, which fails on anything unclassified.
 *
 * ## Fail-loud guarantee on the baseline parse
 *
 * The baseline is scraped with a regex bound to the row literal's exact shape.
 * The re-review proved the first version FAILED OPEN: reformatting a single row
 * made its path vanish from the parsed map, the route was silently skipped, and
 * the script still printed OK — the vanished row happened to be the members
 * backup CSV that emits every contact's date of birth. The parse is now
 * reconciled against an independent count of `kind: 'api'` occurrences in the
 * same file and aborts on any mismatch.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  lineOfIndex,
  markerApplies,
  stripCommentLines,
  stripCommentsPreserveLines,
} from './lib/source-scan';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src', 'app', 'api');
const BASELINE = join(ROOT, 'tests', 'helpers', 'rbac-observed-baseline.ts');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The comparable unit is the PERMISSION KEY alone since PR 5 — the legacy row
 * half of the old (key :: row) pair died with the leg. Keyed per METHOD —
 * see § 2 of the header.
 */
type Pair = string;

const pairOf = (key: string): Pair => key;

function loadBaseline(): Map<string, Map<string, Set<Pair>>> {
  const src = readFileSync(BASELINE, 'utf8');
  const byPath = new Map<string, Map<string, Set<Pair>>>();
  const re = /\{ surface: '([^']+)', kind: 'api', key: '([^']+)' \}/g;
  let m: RegExpExecArray | null;
  let parsed = 0;
  while ((m = re.exec(src)) !== null) {
    parsed += 1;
    const [, surface, key] = m;
    const [method, ...pathParts] = surface!.split(' ');
    const path = pathParts.join(' ');
    const methods = byPath.get(path) ?? new Map<string, Set<Pair>>();
    const set = methods.get(method!) ?? new Set<Pair>();
    set.add(pairOf(key!));
    methods.set(method!, set);
    byPath.set(path, methods);
  }
  // Fail-loud reconciliation (see header). Counted as `kind: 'api', key:` on
  // the raw text, so a row the regex can no longer read still counts — any
  // drift between the two aborts instead of silently narrowing coverage. The
  // `key:` suffix keeps the BaselineRow TYPE declaration (`readonly kind:
  // 'page' | 'api';`) out of the count; it bit the page gate's copy of this
  // check on its very first run.
  const declaredApiRows = (src.match(/kind: 'api', key:/g) ?? []).length;
  if (parsed !== declaredApiRows || parsed < 100) {
    console.error(
      `check:api-route-guard ABORT — baseline parse drift: regex read ${parsed} ` +
        `api row(s) but the file contains ${declaredApiRows} \`kind: 'api'\` marker(s). `,
    );
    console.error(
      'A baseline row was probably reformatted out of the one-line literal shape ' +
        'this script parses. Restore the shape (or update the parser + this guard ' +
        'together); skipping the row would silently un-police its route.',
    );
    process.exit(1);
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

// Comment stripping + line mapping + marker hosting now come from the SHARED
// string-aware scanner (016 post-ship review finding V3b closed the deferred
// migration): the private three-pass regex stripper this file carried was not
// string-aware — a string literal containing `/*` with no `*/` on the same
// line (a MIME accept `'image/*'`, a glob) opened a phantom block comment and
// blanked everything to the next `*/`, silently blinding the leftover
// role-literal scan (check 3) — the exact 341-line-blindness class
// `scripts/lib/source-scan.ts` was written to close. Its private markerApplies
// also honored a marker hosted inside a string/URL on the decision line
// (finding #11); the shared copy decides comment-hosting from the stripped
// code.

/** `src/app/api/plans/[year]/route.ts` → `/api/plans/[year]`. */
function surfaceOf(file: string): string {
  const rel = relative(join(ROOT, 'src', 'app'), file).split(sep).slice(0, -1);
  return '/' + rel.join('/');
}

interface Located {
  readonly pair: Pair;
  readonly line: number; // 0-based
}

/**
 * Extract every gate declaration with its line, in the four forms the repo
 * uses. Regexes are whitespace-tolerant so multi-line call formatting (the
 * T028 codemod's default) is matched — the first version's per-line scan for
 * `canPerform` could not see a wrapped call at all.
 */
function declaredPairs(
  code: string,
  rawLines: readonly string[],
  codeLines: readonly string[],
): { located: Located[]; nonLiteral: number } {
  const located: Located[] = [];
  let nonLiteral = 0;

  // 1. requireApiPermission(request, 'key')
  const FORM1 = /requireApiPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'/g;
  let literal1 = 0;
  for (const m of code.matchAll(FORM1)) {
    literal1 += 1;
    located.push({ pair: pairOf(m[1]!), line: lineOfIndex(code, m.index!) });
  }
  nonLiteral += (code.match(/requireApiPermission\(/g) ?? []).length - literal1;

  // 2. requireRenewalAdminContext(request, 'action', 'key') — the F8 wrapper
  //    composes requireApiPermission; only the key matters post-PR-5.
  const FORM2 =
    /requireRenewalAdminContext\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
  let literal2 = 0;
  for (const m of code.matchAll(FORM2)) {
    literal2 += 1;
    located.push({ pair: pairOf(m[2]!), line: lineOfIndex(code, m.index!) });
  }
  nonLiteral += (code.match(/requireRenewalAdminContext\(/g) ?? []).length - literal2;

  // 3. F6 route-local guards (D9): adminOnly[Writer]Guard({ permissionKey: 'x', … })
  for (const m of code.matchAll(/permissionKey:\s*'([^']+)'/g)) {
    located.push({ pair: pairOf(m[1]!), line: lineOfIndex(code, m.index!) });
  }

  // 4. canPerform(role, 'key', row) used as the ADMISSION decision. Two F6 GET
  //    handlers decide this way so they can keep the FR-035 404-for-non-staff
  //    denial shape instead of the sweep's uniform 403 (D9 route-local
  //    override). It is still a real gate and must match the baseline.
  //
  //    A `canPerform` that gates a FIELD or an optional SECTION of an
  //    already-authorised response (DoB on the member read, the refundable
  //    invoices arm of the palette) is a sub-gate, not the surface's admission
  //    decision, so it carries a `SUBGATE_MARKER` (comment-hosted; checked on
  //    the RAW lines because comment stripping removes it) and is excluded.
  //    The marker is required rather than inferred: without it an admission
  //    decision could hide behind the same syntax.
  const FORM4 = /canPerform\(\s*[A-Za-z_$][\w$.]*\s*,\s*'([^']+)'/g;
  for (const m of code.matchAll(FORM4)) {
    const line = lineOfIndex(code, m.index!);
    if (markerApplies(rawLines, line, [SUBGATE_MARKER], codeLines)) continue;
    located.push({ pair: pairOf(m[1]!), line });
  }

  return { located, nonLiteral };
}

interface HandlerSegment {
  readonly method: HttpMethod;
  readonly startLine: number; // 0-based, inclusive
}

/**
 * Locate exported handler starts, in declaration order, plus `export const
 * GET = POST` style aliases (the Vercel-cron GET=POST shim).
 */
function handlerSegments(code: string): {
  segments: HandlerSegment[];
  aliases: Map<HttpMethod, HttpMethod>;
} {
  const segments: HandlerSegment[] = [];
  const aliases = new Map<HttpMethod, HttpMethod>();
  const methodAlt = HTTP_METHODS.join('|');
  const fnRe = new RegExp(
    `^export\\s+(?:async\\s+)?function\\s+(${methodAlt})\\b`,
    'gm',
  );
  for (const m of code.matchAll(fnRe)) {
    segments.push({ method: m[1] as HttpMethod, startLine: lineOfIndex(code, m.index!) });
  }
  // Alias form anchored to end-of-line so `export const GET = POSTish` can
  // never read as an alias to POST.
  const aliasRe = new RegExp(
    `^export\\s+const\\s+(${methodAlt})\\s*=\\s*(${methodAlt})\\s*;?\\s*$`,
    'gm',
  );
  for (const m of code.matchAll(aliasRe)) {
    aliases.set(m[1] as HttpMethod, m[2] as HttpMethod);
  }
  // 016 post-ship review finding #14 — arrow/delegate handlers:
  //   export const POST = async (req) => …
  //   export const POST = withSentry(async (req) => …)
  //   export const POST = handle
  // yielded ZERO segments, so every gate declaration landed in the 'module'
  // region and the whole file silently fell back to the weaker file-level
  // set-union check — where swapping keys between GET and POST leaves the set
  // identical and a downgraded method is absorbed by dedup, the two defeats
  // the per-method rewrite exists to catch. Any `export const METHOD = <expr>`
  // that is not the METHOD-alias form above starts a handler segment.
  const constRe = new RegExp(`^export\\s+const\\s+(${methodAlt})\\s*=\\s*(.*)$`, 'gm');
  const aliasRhs = new RegExp(`^(${methodAlt})\\s*;?\\s*$`);
  for (const m of code.matchAll(constRe)) {
    if (aliasRhs.test((m[2] ?? '').trim())) continue;
    segments.push({ method: m[1] as HttpMethod, startLine: lineOfIndex(code, m.index!) });
  }
  segments.sort((a, b) => a.startLine - b.startLine);
  return { segments, aliases };
}

/** Region owner of a 0-based line: an HTTP method, or 'module'. */
function regionOf(segments: readonly HandlerSegment[], line: number): HttpMethod | 'module' {
  let owner: HttpMethod | 'module' = 'module';
  for (const seg of segments) {
    if (seg.startLine <= line) owner = seg.method;
    else break;
  }
  return owner;
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
 * preserves the baseline as a frozen capture. The two-step behaviour itself —
 * including the branch placement this script cannot see — is pinned by the
 * step-2 contract tests on all six routes (invite included as of the
 * post-remediation re-review; it was the one route the codemod missed).
 */
const STEP_ONE_COMPANION: Readonly<Record<string, Pair>> = Object.fromEntries(
  [
    '/api/auth/invite',
    '/api/auth/users/[id]/role',
    '/api/auth/users/[id]/disable',
    '/api/auth/users/[id]/enable',
    '/api/auth/users/[id]/reissue-invite',
    '/api/auth/users/[id]/revoke-invite',
  ].map((p) => [p, pairOf('users.member_accounts')]),
);

/**
 * Leftover deny arms comparing against a STAFF role. `'member'` is excluded on
 * purpose — narrowing a member out is the safe direction.
 *
 * Two shapes are scanned, on comment-stripped line-preserving text so wrapped
 * comparisons are visible (the first version scanned per raw line and a
 * newline between the operator and the literal escaped it):
 *
 *   1. identifier-chain `===`/`!==` staff-role literal, either operand order,
 *      single or double quotes;
 *   2. `['admin', …].includes(x)` over an array literal of staff roles.
 *
 * ## Honest limits (all proven to slip past regex scanning)
 *
 * `switch (role) { case 'manager': … }`, a role literal laundered through a
 * named constant (`const ONLY = 'admin'; role !== ONLY`), and predicate calls
 * (`isAdministrativeRole(role, false)`, `!isStaffRole(role)`) are NOT caught
 * here. The behavioural net for this class is the super_admin happy-path
 * contract tests on the money routes (credit-notes + invoice-void), which fail
 * on ANY handler-level deny of an admitted super_admin regardless of how it is
 * spelled. When adding a staff API surface, add that pin too.
 */
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

/**
 * Opt-out for a comparison that is a TYPE narrow feeding a use-case schema
 * rather than an authorization decision. Comment-hosted, same line or the
 * contiguous comment block above — see `markerApplies`.
 */
const NARROW_MARKER = 'rbac-narrow-ok';

/**
 * Opt-out for a `canPerform` that gates a FIELD or an optional SECTION of an
 * already-authorised response, rather than deciding admission to the surface.
 */
const SUBGATE_MARKER = 'rbac-subgate-ok';

/**
 * Routes that declare a staff gate yet legitimately carry no baseline row.
 * Exactly one: the dual-audience GDPR artefact proxy, which a subject MEMBER
 * also reaches (session-any, not role-matrix) — see
 * `api-route-exhaustiveness.test.ts` SESSION_ANY. Any OTHER gated-but-
 * unbaselined route is a staff surface hiding under an auto-classified prefix
 * (`/api/payments/**`, `/api/portal/**`, `/api/broadcasts/**`,
 * `/api/internal/**`), which both gates and the exhaustiveness "no
 * staff-looking route hides" check (scoped to /api/admin + /api/auth/users)
 * would otherwise miss — re-review finding 11.
 */
const GATED_WITHOUT_BASELINE_OK: ReadonlySet<string> = new Set([
  '/api/internal/exports/[jobId]/download',
]);

/** True when the file declares any admission gate this script understands. */
function declaresStaffGate(code: string): boolean {
  return (
    /requireApiPermission\(/.test(code) ||
    /requireRenewalAdminContext\(/.test(code) ||
    /permissionKey:\s*'/.test(code)
  );
}

const baseline = loadBaseline();
const errors: string[] = [];
const seen = new Set<string>();
let checked = 0;

for (const file of walk(API_DIR)) {
  const surface = surfaceOf(file);
  const expectedByMethod = baseline.get(surface);
  if (expectedByMethod === undefined) {
    // Non-role-matrix class, owned elsewhere — UNLESS the file declares a staff
    // gate, in which case it is a role-matrix surface missing its baseline row.
    const code = stripCommentsPreserveLines(readFileSync(file, 'utf8'));
    if (declaresStaffGate(code) && !GATED_WITHOUT_BASELINE_OK.has(surface)) {
      const shown = relative(ROOT, file).replace(/\\/g, '/');
      errors.push(
        `${shown}: declares a staff permission gate but has no row in ` +
          `rbac-observed-baseline.ts. A staff API surface must be in the frozen ` +
          `baseline (or, if genuinely session-any like the GDPR export proxy, be ` +
          `added to GATED_WITHOUT_BASELINE_OK with a reason).`,
      );
    }
    continue;
  }
  seen.add(surface);
  checked += 1;

  const shown = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const codeLines = stripCommentLines(src);
  const code = codeLines.join('\n');
  const rawLines = src.split(/\r?\n/);
  const { located, nonLiteral } = declaredPairs(code, rawLines, codeLines);

  if (nonLiteral > 0) {
    errors.push(`${shown}: ${nonLiteral} gate call(s) with non-literal arguments`);
    continue;
  }
  if (located.length === 0) {
    errors.push(`${shown}: baseline expects a role-matrix gate but the file declares none`);
    continue;
  }

  const companion = STEP_ONE_COMPANION[surface];
  const { segments, aliases } = handlerSegments(code);
  // 016 post-ship review finding #14 (fail-loud half) — a baselined route
  // whose exported handlers the scanner cannot see would silently attribute
  // everything to 'module' and degrade to the weaker file-level fallback.
  // A valid route file MUST export at least one handler, so zero recognized
  // segments means the scanner is blind to a new export shape — say so.
  if (segments.length === 0 && aliases.size === 0) {
    errors.push(
      `${shown}: no exported HTTP handler recognized — the gate would degrade to the ` +
        `file-level fallback blindly. Export handlers as 'export async function METHOD' / ` +
        `'export const METHOD = …', or teach handlerSegments the new shape.`,
    );
    continue;
  }
  const byRegion = new Map<string, Set<Pair>>();
  for (const { pair, line } of located) {
    const region = regionOf(segments, line);
    const set = byRegion.get(region) ?? new Set<Pair>();
    set.add(pair);
    byRegion.set(region, set);
  }
  for (const [alias, target] of aliases) {
    const targetSet = byRegion.get(target);
    if (targetSet !== undefined) byRegion.set(alias, targetSet);
  }

  const modulePairs = byRegion.get('module');
  if (modulePairs !== undefined && modulePairs.size > 0) {
    // F6 allowance — module-scope guard objects cannot be attributed to a
    // handler textually; fall back to file-level set equality. Per-method
    // behaviour of these guards is pinned by the F6 contract/unit tests.
    const declared = new Set(located.map((l) => l.pair));
    const expectedUnion = new Set<Pair>();
    for (const set of expectedByMethod.values()) for (const p of set) expectedUnion.add(p);
    for (const want of expectedUnion) {
      if (!declared.has(want)) {
        errors.push(
          `${shown}: baseline expects [${want}] — file declares [${[...declared].join('] [')}]`,
        );
      }
    }
    for (const got of declared) {
      if (expectedUnion.has(got) || got === companion) continue;
      errors.push(`${shown}: declares [${got}] which is not in the baseline for '${surface}'`);
    }
    if (companion !== undefined && !declared.has(companion)) {
      errors.push(
        `${shown}: § 7.1 step-1 gate missing — expected [${companion}] before the target row is read`,
      );
    }
  } else {
    // Strict per-method matching.
    for (const [method, expected] of expectedByMethod) {
      const declared = byRegion.get(method);
      if (declared === undefined || declared.size === 0) {
        errors.push(
          `${shown}: baseline expects a gate in the ${method} handler — none declared there`,
        );
        continue;
      }
      for (const want of expected) {
        if (!declared.has(want)) {
          errors.push(
            `${shown}: ${method} expects [${want}] — handler declares [${[...declared].join('] [')}]`,
          );
        }
      }
      for (const got of declared) {
        if (expected.has(got) || got === companion) continue;
        errors.push(
          `${shown}: ${method} declares [${got}] which is not in the baseline for '${method} ${surface}'`,
        );
      }
      if (companion !== undefined && !declared.has(companion)) {
        errors.push(
          `${shown}: § 7.1 step-1 gate missing in ${method} — expected [${companion}]`,
        );
      }
    }
    // A handler that declares pairs for a method the baseline does not know is
    // drift in the other direction (e.g. a new PATCH added without a baseline
    // row — it would otherwise be policed by nothing).
    for (const [region, set] of byRegion) {
      if (region === 'module' || expectedByMethod.has(region) || set.size === 0) continue;
      if (aliases.has(region as HttpMethod)) continue;
      errors.push(
        `${shown}: ${region} handler declares a gate but '${region} ${surface}' has no baseline row`,
      );
    }
  }

  // Leftover staff-role literal scan — on comment-stripped line-preserving
  // text (so wrapped comparisons are visible and prose can never false-
  // positive), with comment-hosted markers checked against the RAW lines.
  for (const re of [CMP_LITERAL, INCLUDES_LITERAL]) {
    re.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(code)) !== null) {
      const line = lineOfIndex(code, hit.index);
      if (markerApplies(rawLines, line, [NARROW_MARKER], codeLines)) continue;
      errors.push(
        `${shown}:${line + 1}: staff-role literal behind the gate — ${hit[0].trim()} ` +
          `(a second, invisible gate the matrix cannot see; it would deny super_admin after Migration C. ` +
          `If this is a TYPE narrow, not an authorization decision, add a "${NARROW_MARKER}" comment ` +
          `on the line or in the comment block directly above it.)`,
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
      'literal pair matching tests/helpers/rbac-observed-baseline.ts (per METHOD), and ' +
      'carries no staff-role literal behind the gate.',
  );
  process.exit(1);
}

console.log(`check:api-route-guard — OK (${checked} route file(s) matched against the baseline).`);
