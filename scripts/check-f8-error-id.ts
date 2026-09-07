/**
 * Gate — every F8 renewals route names itself in the errorId taxonomy.
 *
 * The defect this exists to prevent, in the form it actually shipped:
 * `requireRenewalAdminContext` hardcoded
 * `errorId: 'F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED'` while being composed by
 * 24 routes, so a session-lookup failure on the money path paged SRE with an
 * id naming the tier-upgrade accept route. Separately, most F8 routes had no
 * `errorId` on their outer catch at all, leaving `F8.*` blind to them, while
 * `docs/runbooks/audit-emit-loss.md` told SRE to pin alert rules to that field.
 * (Run the gate for the current set — a count written here would rot, and
 * every count written into this migration's comments has been wrong once.)
 *
 * The `F8ErrorId` union already makes an un-named helper CALLER a compile
 * error. This gate covers the half the type system cannot see:
 *
 *   1. a route in scope that declares no `ERROR_ID`
 *   2. a `logger.error` inside a `catch` that carries no `errorId` — the
 *      regression shape, since deleting one line is invisible to `tsc`
 *   3. a hardcoded `errorId: 'F8.…'` string literal, which is how one route
 *      comes to speak in another route's name
 *
 * Scope is derived, never hand-listed: the renewals + portal-renewal path
 * prefixes UNION every route that composes `requireRenewalAdminContext`. That
 * last clause is what pulls in the three `admin/members/**` routes which are
 * F8 surfaces despite their path, and it keeps working when a route moves.
 *
 * Comments are stripped string-aware before matching. A promise in a comment
 * is exactly what this codebase keeps mistaking for an implementation, so an
 * `errorId` mentioned in a `//` line must NOT satisfy the gate.
 *
 * Run: `pnpm check:f8-error-id`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { lineOfIndex, stripCommentsPreserveLines } from './lib/source-scan';

const SRC = 'src/app/api';
/**
 * `node:path` yields a backslash separator on Windows; every path this gate
 * reports uses `/`. (Not `String.raw` with a lone backslash — the lexer reads
 * the closing backtick as escaped and the template never terminates.)
 */
const SEP = '\\';

/**
 * Positive control (the `check:actor-role-truth` pattern). Each entry must be
 * FOUND, in scope, carrying that exact id. A scope glob or regex that rots
 * then fails loudly instead of passing vacuously over an empty file set —
 * which is how a green gate comes to prove nothing.
 */
const POSITIVE_CONTROL: ReadonlyArray<readonly [string, string]> = [
  ['admin/renewals/[cycleId]/mark-paid-offline/route.ts', 'F8.CYCLE_MARK_PAID_OFFLINE'],
  ['admin/members/[id]/renew/route.ts', 'F8.MEMBER_RENEW'],
  ['portal/renewal/redeem-link/route.ts', 'F8.PORTAL_REDEEM_LINK'],
];

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === 'route.ts') out.push(full.split(SEP).join('/'));
  }
  return out;
}

function inScope(): string[] {
  const all = walk(SRC, []);
  const byPath = all.filter(
    (p) => p.startsWith(`${SRC}/admin/renewals/`) || p.startsWith(`${SRC}/portal/renewal/`),
  );
  // the clause that pulls in the three admin/members/** F8 routes, and that
  // keeps working when a route moves. Stripped, not raw: a non-F8 route that
  // merely MENTIONS the helper in a comment would otherwise be dragged into
  // scope and told to declare an F8 id it has no business having.
  const byComposition = all.filter((p) =>
    stripCommentsPreserveLines(readFileSync(p, 'utf8')).includes(
      'requireRenewalAdminContext',
    ),
  );
  return [...new Set([...byPath, ...byComposition])].sort();
}

const failures: string[] = [];
const files = inScope();

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const code = stripCommentsPreserveLines(raw);
  const rel = file.slice(`${SRC}/`.length);

  const decl = /const ERROR_ID = '(F8\.[A-Z_]+)';/.exec(code);
  if (!decl) {
    failures.push(
      `${rel}\n    declares no ERROR_ID. Add \`const ERROR_ID = 'F8.<NAME>';\` and add\n    that name to the F8ErrorId union in src/lib/renewals-route-helpers.ts.`,
    );
    continue;
  }

  // (3) a hardcoded F8 literal anywhere else is how one route inherits
  // another's name — the exact defect the union + this gate replace.
  for (const m of code.matchAll(/errorId: '(F8\.[A-Z_.]+)'/g)) {
    failures.push(
      `${rel}\n    hardcodes errorId '${m[1]}'. Build it from ERROR_ID instead, so the route\n    cannot come to speak in another route's name.`,
    );
  }

  // (2) every logger.error inside a catch must carry an errorId
  for (const m of code.matchAll(/\}\s*catch\s*\([^)]*\)\s*\{/g)) {
    const start = m.index! + m[0].length;
    const next = code.indexOf('catch (', start);
    const body = code.slice(start, next === -1 ? code.length : next);
    const at = body.indexOf('logger.error(');
    if (at === -1) continue;
    const obj = body.slice(at, at + 900).split('},')[0]!;
    if (!obj.includes('errorId')) {
      // `lineOfIndex` is 0-based and counts on the comment-STRIPPED text,
      // which `stripCommentsPreserveLines` keeps line-aligned with the file.
      const line = lineOfIndex(code, start + at) + 1;
      failures.push(
        `${rel}:${line}\n    logger.error inside a catch carries no errorId, so no F8 alert rule can\n    match this failure (docs/runbooks/audit-emit-loss.md).`,
      );
    }
  }
}

// positive control
for (const [suffix, id] of POSITIVE_CONTROL) {
  const path = `${SRC}/${suffix}`;
  const found = files.includes(path);
  if (!found) {
    failures.push(
      `POSITIVE CONTROL: ${suffix} is not in scope. The scope rule has rotted —\n    this gate may be passing over an empty or truncated file set.`,
    );
    continue;
  }
  if (
    !stripCommentsPreserveLines(readFileSync(path, 'utf8')).includes(
      `const ERROR_ID = '${id}';`,
    )
  ) {
    failures.push(
      `POSITIVE CONTROL: ${suffix} no longer declares ${id}. Either the id was\n    renamed (update this control) or the declaration regex has rotted.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n✗ check:f8-error-id — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'Every F8 renewals route names itself once and uses that name for both the\n' +
      'helper\'s .CONTEXT_RESOLUTION_FAILED line and its own catch, so a rule keyed\n' +
      'on `<name>.*` matches every failure the route can produce.\n',
  );
  process.exit(1);
}

console.log(
  `✓ check:f8-error-id — ${files.length} F8 route(s) in scope, each naming itself; ` +
    `${POSITIVE_CONTROL.length} positive control(s) found.`,
);
