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
 * ## The first version of this gate was blind, and its own markers caused it
 *
 * It stripped `//` AFTER looking for `/*`, so a line comment containing a glob
 * — including the `rbac-portal-identity-ok: /portal/** …` markers this task
 * added — opened a phantom block comment and blanked every line down to the
 * next `*​/`. Measured after the fact: 341 source lines of `src/config/nav.ts`
 * invisible, i.e. the whole of `staffNavConfig`, plus four other files. Four
 * planted mutants survived. It reported `23 marked, 0 unmarked` throughout.
 *
 * The comment-scanner now lives in `scripts/lib/source-scan.ts`, is
 * character-wise and string-aware, and is shared with the sibling gates so a
 * fix lands in one place. Two consequences are load-bearing here:
 * `MIN_EXPECTED_SITES` fails a scan that finds implausibly little, and
 * `markerApplies` requires the marker to be comment-hosted.
 *
 * Honest limits, stated so nobody mistakes a pass for a proof:
 *  - Only the roots in SCOPE are scanned. A role literal in a use case, a
 *    module, or a component outside them is not caught here.
 *  - Only `<role-ish identifier> ===/!== '<role>'` is matched, in that order.
 *    NOT matched: the Yoda form `'admin' === role`; array membership
 *    (`roles.includes(role)`, `ROLES.indexOf(role) > 1`) — note the repo still
 *    has one at `src/config/nav.ts`; `switch (role)`; a role smuggled through
 *    an intermediate variable; or a comparison built from a template literal.
 *  - A marker is a CLAIM by the author. The gate proves the claim was made,
 *    not that it is true. Review marker diffs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripCommentLines, markerApplies } from './lib/source-scan';

/** Decision surfaces: where an unmarked role literal is most likely a gate. */
const SCOPE = [
  'src/app/api',
  'src/lib',
  'src/config',
  'src/components/command-palette',
  'src/components/layout',
  // `shell` hosts `command-palette-root.tsx`, whose role literal decides
  // whether the staff palette mounts at all — omitted from the first version,
  // which left a decision site in the very machinery this gate cites as its
  // motivating incident.
  'src/components/shell',
  // The role-DENSEST folder in the product, and it was out of scope entirely:
  // the users table, both role pickers and the role badges all live here. Six
  // literals were invisible. Each now carries a marker stating what it does
  // instead of authorizing, which a reviewer can check against the code beside
  // it — "we looked" is the claim, not "they were all fine". Same argument as
  // the `shell` entry above.
  'src/components/auth',
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
 * Absolute floor on how many role literals the scan must FIND.
 *
 * `scanned === 0` catches a wrong scope root but not a broken parser — and a
 * broken parser is exactly what shipped. A gate that reports "0 unmarked"
 * because it saw nothing is worse than no gate at all. Raise this deliberately
 * when sites are legitimately removed; never lower it to make a run pass.
 *
 * Pinned to the MEASURED TOTAL — `marked + unmarked`, which is what `scanned`
 * counts — not to the `marked` counter. 39 as of PR 4, after
 * `src/components/auth` joined SCOPE. Reading the wrong counter set this to 38
 * for a while: one below the truth, i.e. exactly the slack this docblock
 * forbids, inside the gate whose whole thesis is that a low floor is how
 * partial blindness ships.
 *
 * The earlier 28 (against a then-total of 33) left the scanner free to go ~15%
 * blind before tripping. The T065 gate reported "0 unmarked" while it could not
 * see 341 lines of src/config/nav.ts.
 */
const MIN_EXPECTED_SITES = 39;

/**
 * Every accepted claim. Each says what the literal is doing INSTEAD of
 * authorizing, so a reviewer can check the claim against the code beside it.
 */
const MARKERS: ReadonlyArray<{ marker: string; means: string }> = [
  {
    marker: 'rbac-narrow-ok',
    means:
      "a TYPE narrow onto a use case's own role union, admitting exactly what the permission gate above already admitted",
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
    means: "inspects a role VALUE carried in a request payload, not the actor's role",
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
  {
    // Distinct from the D9 marker on purpose. D9 is permanent; this one marks
    // an arm of the legacy leg that PR 5 DELETES. Sharing one marker would tell
    // whoever does PR 5 to leave both alone.
    marker: 'rbac-legacy-shim-arm-ok',
    means: 'an arm of the flag-OFF legacy shim — removed wholesale by PR 5, not exempt forever',
  },
  {
    // Deliberately NOT folded into `rbac-subgate-ok`. That one marks a literal
    // that WITHHOLDS data from an authorised response; this one marks a literal
    // that withholds nothing — an icon, an advisory line, a form field that is
    // irrelevant for the chosen role. Sharing a marker would make the stricter
    // claim unreadable, because a reviewer could no longer tell which kind of
    // "it's fine" was being asserted.
    marker: 'rbac-presentation-only-ok',
    means:
      'chooses an icon, hint or form-field visibility inside an already-authorised render; ' +
      'withholds no data and grants nothing',
  },
];

const MARKER_NAMES = MARKERS.map((m) => m.marker);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
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
      const isMarked = markerApplies(rawLines, i, MARKER_NAMES, codeLines);
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

const total = marked + findings.length;
if (total < MIN_EXPECTED_SITES) {
  console.error(
    `check:authorization-role-reads ABORT — found only ${total} role literal(s) across ` +
      `${scanned} file(s); at least ${MIN_EXPECTED_SITES} are known to exist. The scanner is ` +
      'broken or the scope shrank. Do NOT lower MIN_EXPECTED_SITES to make this pass.',
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `check:authorization-role-reads — ${findings.length} unmarked role literal(s) on a decision surface:\n` +
      findings.join('\n') +
      '\n\nEither replace it with canPerform(role, key, legacyRow), or — if it is ' +
      'not an authorization decision — add the marker that says what it IS. The marker ' +
      'must be COMMENT-HOSTED: after `//` on the same line, or in the contiguous comment ' +
      'block directly above (at most 3 code lines up).\n' +
      MARKERS.map((k) => `  ${k.marker}: ${k.means}`).join('\n'),
  );
  process.exit(1);
}

console.log(
  `check:authorization-role-reads — OK (${scanned} file(s); ${marked} marked role literal(s), 0 unmarked).`,
);
