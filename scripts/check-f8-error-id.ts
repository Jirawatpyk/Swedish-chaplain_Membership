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
  const adminLeg = all.filter((p) => p.startsWith(`${SRC}/admin/renewals/`));
  const portalLeg = all.filter((p) => p.startsWith(`${SRC}/portal/renewal/`));
  // Floor check on each prefix leg. The three POSITIVE_CONTROL entries cannot
  // detect a typo'd `admin/renewals/` prefix on their own, because every file
  // under it also arrives via the composition leg — so that leg could rot to
  // zero and the controls would still be found. These floors are what notices.
  if (adminLeg.length < 15 || portalLeg.length < 2) {
    throw new Error(
      `check:f8-error-id scope rot: admin/renewals/ matched ${adminLeg.length} ` +
        `(expected >=15), portal/renewal/ matched ${portalLeg.length} (expected >=2). ` +
        'A prefix has changed or been mistyped; the gate would run over a truncated set.',
    );
  }
  const byPath = [...adminLeg, ...portalLeg];
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

/**
 * End offset of the block opened just before `start` (i.e. `start` is the first
 * character INSIDE it), by brace balance. String and template contents are
 * skipped so a brace inside a literal cannot unbalance the scan.
 */
function blockEnd(code: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return code.length;
}

const failures: string[] = [];
const files = inScope();

/** Declared id -> the file that declared it, so two routes cannot share one. */
const declaredBy = new Map<string, string>();

/**
 * The `F8ErrorId` union, parsed from its source rather than duplicated here.
 * A `const ERROR_ID` is only checked against the union by `tsc` where it is
 * PASSED to the helper; the two portal routes never pass theirs anywhere, so
 * without this the union and their ids could drift apart silently.
 */
function unionMembers(): ReadonlySet<string> {
  const src = readFileSync('src/lib/renewals-route-helpers.ts', 'utf8');
  const block = /export type F8ErrorId =([\s\S]*?);\n/.exec(src);
  if (!block) return new Set();
  return new Set([...block[1]!.matchAll(/'(F8\.[A-Z_]+)'/g)].map((m) => m[1]!));
}
const UNION = unionMembers();
if (UNION.size === 0) {
  failures.push(
    'Could not parse the F8ErrorId union from src/lib/renewals-route-helpers.ts —\n' +
      '    the taxonomy check is inert. Fix the parser before trusting this gate.',
  );
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const code = stripCommentsPreserveLines(raw);
  const rel = file.slice(`${SRC}/`.length);

  const decl = /const ERROR_ID(?:: F8ErrorId)? = '(F8\.[A-Z_]+)';/.exec(code);
  if (!decl) {
    failures.push(
      `${rel}\n    declares no ERROR_ID. Add \`const ERROR_ID = 'F8.<NAME>';\` and add\n    that name to the F8ErrorId union in src/lib/renewals-route-helpers.ts.`,
    );
    continue;
  }
  const id = decl[1]!;

  // (4) two routes must not share an entry. `F8ErrorId` is a union of literals,
  // so `tsc` is perfectly happy with a copy-pasted route keeping the id of the
  // file it was copied from — which is the original defect, restored.
  const prior = declaredBy.get(id);
  if (prior !== undefined) {
    failures.push(
      `${rel}\n    declares ${id}, already declared by ${prior}. Two routes sharing an\n    entry is the defect this taxonomy exists to prevent: an alert names one\n    route while the failure is in the other.`,
    );
  } else {
    declaredBy.set(id, rel);
  }

  // (5) the declared id must actually BE in the union.
  if (UNION.size > 0 && !UNION.has(id)) {
    failures.push(
      `${rel}\n    declares ${id}, which is not a member of the F8ErrorId union. Add it to\n    src/lib/renewals-route-helpers.ts (the union is the taxonomy).`,
    );
  }

  // (3) a hardcoded F8 literal anywhere else is how one route inherits
  // another's name — the exact defect the union + this gate replace. BOTH
  // quote styles: this branch's own convention is a backtick template, so a
  // single-quote-only rule would miss a hardcoded id written the local way.
  for (const m of code.matchAll(/errorId: ['`](F8\.[A-Z_.]+)['`]/g)) {
    failures.push(
      `${rel}\n    hardcodes errorId '${m[1]}'. Build it from ERROR_ID instead, so the route\n    cannot come to speak in another route's name.`,
    );
  }

  // (6) `const _exhaustive: never = …` followed by a RETURN is the shape that
  // made this gate's own vouching false: the first version of this branch
  // stamped 24 routes with "matches every 500 this route can produce" while
  // ten of them still returned a 500 from that arm and logged nothing — the
  // gate never looked, because the arm is not a `catch`. `assertNever` throws
  // instead, so the outer catch and its errorId actually run.
  for (const m of code.matchAll(/const _exhaustive: never = /g)) {
    failures.push(
      `${rel}:${lineOfIndex(code, m.index!) + 1}\n    exhaustiveness arm returns instead of throwing, so an unmapped error kind\n    produces a 500 with NO log line and no errorId. Use\n    \`assertNever(x, \`\${ERROR_ID}: unhandled error kind '…'\`)\`.`,
    );
  }

  // (2) every logger.error inside a catch must carry an errorId, AND a catch
  // that answers 500 must log at all. `catch {` with no binding is valid JS and
  // 13 files in scope use it — the parameter group has to be optional or this
  // rule silently skips them.
  for (const m of code.matchAll(/\}\s*catch\s*(?:\([^)]*\))?\s*\{/g)) {
    const start = m.index! + m[0].length;
    // The catch's OWN block, by brace balance. Slicing "up to the next catch"
    // was wrong and produced six false positives on the first run: a
    // JSON-parse `catch { return 400 }` swallowed the entire rest of the
    // handler, including the `status: 500` arms of a switch it does not own.
    const body = code.slice(start, blockEnd(code, start));
    const at = body.indexOf('logger.error(');
    if (at === -1) {
      if (body.includes('status: 500')) {
        failures.push(
          `${rel}:${lineOfIndex(code, start) + 1}\n    a catch answers 500 but logs nothing, so the failure is invisible to every\n    alert rule. Log it with \`errorId: \\\`\${ERROR_ID}.<SUFFIX>\\\`\`.`,
        );
      }
      continue;
    }
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
