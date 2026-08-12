/**
 * 016 T065 — no undeclared role literal decides anything on a decision surface.
 *
 * RBAC v2 replaced ~175 role comparisons with permission checks, but a role
 * literal is invisible to type-checking and to the union-widening sweep: adding
 * `marketing` to the `Role` union does not make `role === 'admin'` fail to
 * compile, it just makes it silently answer `false`. That is how this feature
 * shipped a palette that was blank for marketing and a sidebar offering four
 * links D4 had already closed. Both were found by hand, twice.
 *
 * So: on the surfaces that DECIDE things, every role-literal comparison must
 * carry a marker saying which non-authorization job it is doing. Anything
 * unmarked fails. The marker sits AT THE SITE rather than in a central
 * allowlist, because a central list drifts out of sync with the code it
 * describes and nobody reads it while editing.
 *
 * Not a substitute for `check:api-route-guard` (which asserts each handler's
 * declared permission against the frozen baseline). This one catches the
 * SECOND decision — the `if` inside the handler, the filter in the nav config —
 * which that gate cannot see.
 *
 * Honest limits, stated so nobody mistakes a pass for a proof:
 *  - Only the roots in SCOPE are scanned. A role literal in a use case or a
 *    component outside them is not caught here.
 *  - Only `<role-ish identifier> ===/!== '<role>'` is matched. `switch (role)`,
 *    `ROLES.indexOf(role) > 1`, or a role smuggled through a variable are not.
 *  - A marker is a CLAIM by the author. The gate proves the claim was made,
 *    not that it is true.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Decision surfaces: where an unmarked role literal is most likely a gate. */
const SCOPE = [
  'src/app/api',
  'src/lib',
  'src/config',
  'src/components/command-palette',
  'src/components/layout',
] as const;

/**
 * Identifiers that hold an ACTOR/SUBJECT role. Matching on the left-hand side
 * rather than on the literal alone removes the structural false positives —
 * `z.enum(['admin', …])` validates a submitted VALUE, and
 * `seg.segment === 'admin'` is a URL path segment that merely spells like a
 * role — without needing a marker for either.
 */
const ROLE_IDENT = String.raw`(?:[A-Za-z_$][\w$]*\.)?(?:role|Role|newRole|actorRole|sessionRole|currentUserRole)`;
const ROLE_LITERAL = `'(?:super_admin|admin|manager|marketing|member)'`;
const COMPARISON = new RegExp(
  String.raw`${ROLE_IDENT}\s*(?:===|!==)\s*${ROLE_LITERAL}`,
  'g',
);

/**
 * A marker must appear within this many lines ABOVE the comparison. Small
 * enough that it cannot be inherited from an unrelated block further up.
 */
const MARKER_LOOKBACK = 8;

/**
 * Every accepted claim. Each says what the literal is doing INSTEAD of
 * authorizing, so a reviewer can check the claim against the code beside it.
 */
const MARKERS: ReadonlyArray<{ marker: string; means: string }> = [
  {
    marker: 'rbac-narrow-ok',
    means:
      'a TYPE narrow onto a use case\'s own role union, admitting exactly what the permission gate above already admitted',
  },
  {
    marker: 'rbac-subgate-ok',
    means: 'gates a FIELD or optional SECTION of an already-authorised response',
  },
  {
    marker: 'rbac-portal-identity-ok',
    means:
      'answers "is this the member portal subject?" — a portal/identity split, not a staff authorization decision',
  },
  {
    marker: 'rbac-payload-value-ok',
    means: 'inspects a role VALUE carried in a request payload, not the actor\'s role',
  },
  {
    marker: 'rbac-audit-projection-ok',
    means: 'projects the actor role onto a narrower union for an audit field; grants nothing',
  },
  {
    marker: 'rbac-d9-override-ok',
    means:
      'the F6 route-local denial-shape override (D9) — a PERMANENT exemption that survives PR 5',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

function stripLineComment(line: string): string {
  const i = line.indexOf('//');
  return i === -1 ? line : line.slice(0, i);
}

/**
 * Blank out comments LINE BY LINE, so index N of the result is line N+1 of the
 * source.
 *
 * The obvious version — replace each block comment with a count of newlines —
 * is off by one per comment, which shifts every reported line AND makes the
 * marker lookback read the wrong window, so a correctly marked site is reported
 * as unmarked. That is exactly what the first run of this gate did.
 */
function stripCommentLines(src: string): readonly string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      inBlock = false;
      out.push(stripLineComment(line.slice(end + 2)));
      continue;
    }
    const start = line.indexOf('/*');
    if (start !== -1 && line.indexOf('*/', start) === -1) {
      inBlock = true;
      out.push(stripLineComment(line.slice(0, start)));
      continue;
    }
    out.push(stripLineComment(line.replace(/\/\*.*?\*\//g, '')));
  }
  return out;
}

const ROOT = process.cwd();
const findings: string[] = [];
let scanned = 0;
let marked = 0;

for (const root of SCOPE) {
  const abs = join(ROOT, root);
  let files: string[];
  try {
    files = walk(abs);
  } catch {
    console.error(`check:authorization-role-reads ABORT — scope root missing: ${root}`);
    process.exit(1);
  }
  for (const file of files) {
    scanned += 1;
    const raw = readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const codeLines = stripCommentLines(raw);
    for (const [i, codeLine] of codeLines.entries()) {
      COMPARISON.lastIndex = 0;
      const hits = [...codeLine.matchAll(COMPARISON)];
      if (hits.length === 0) continue;
      const line = i + 1;
      const window = rawLines.slice(Math.max(0, i - MARKER_LOOKBACK), line).join('\n');
      const isMarked = MARKERS.some((k) => window.includes(k.marker));
      for (const m of hits) {
        if (isMarked) {
          marked += 1;
          continue;
        }
        findings.push(`  ✗ ${relative(ROOT, file).replace(/\\/g, '/')}:${line}: ${m[0]}`);
      }
    }
  }
}

if (scanned === 0) {
  // A walk that found nothing means the scope is wrong, not that the code is
  // clean. Without this, a bad path would make the gate pass forever.
  console.error('check:authorization-role-reads ABORT — scanned 0 files.');
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `check:authorization-role-reads — ${findings.length} unmarked role literal(s) on a decision surface:\n` +
      findings.join('\n') +
      '\n\nEither replace it with canPerform(role, key, legacyRow), or — if it is ' +
      'not an authorization decision — add the marker that says what it IS, on a ' +
      `comment line within ${MARKER_LOOKBACK} lines above:\n` +
      MARKERS.map((k) => `  ${k.marker}: ${k.means}`).join('\n'),
  );
  process.exit(1);
}

console.log(
  `check:authorization-role-reads — OK (${scanned} file(s); ${marked} marked role literal(s), 0 unmarked).`,
);
