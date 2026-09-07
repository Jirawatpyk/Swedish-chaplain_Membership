/**
 * Gate — every F8 renewals route names itself in the errorId taxonomy, and
 * every 500 it can answer with is accompanied by a log carrying that name.
 *
 * The defect this exists to prevent, in the form it actually shipped:
 * `requireRenewalAdminContext` hardcoded
 * `errorId: 'F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED'` while being composed by
 * 24 routes, so a session-lookup failure on the money path paged SRE with an id
 * naming the tier-upgrade accept route. Separately, most F8 routes had no
 * `errorId` on their outer catch at all, while
 * `docs/runbooks/audit-emit-loss.md` told SRE to pin alert rules to that field.
 * (Run the gate for the current set — a count written here would rot, and every
 * count written into this migration's comments has been wrong once.)
 *
 * The `F8ErrorId` union already makes an un-named helper CALLER a compile error.
 * This gate covers what the type system cannot see. The rules themselves live in
 * `scripts/lib/f8-error-id-rules.ts` as pure functions and are unit-tested in
 * `tests/unit/scripts/check-f8-error-id.test.ts` — three rounds of review each
 * proved a rule wrong, and each time the proof lived in a throwaway script that
 * the next round could not reproduce. This file is now only the I/O: find the
 * files, apply the rules, check the controls, report.
 *
 * Scope is derived, never hand-listed: the renewals + portal-renewal path
 * prefixes UNION every route that composes `requireRenewalAdminContext`. That
 * last clause is what pulls in the three `admin/members/**` routes which are F8
 * surfaces despite their path, and it keeps working when a route moves.
 *
 * Run: `pnpm check:f8-error-id`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsPreserveLines } from './lib/source-scan';
import { checkSource } from './lib/f8-error-id-rules';

const SRC = 'src/app/api';
/**
 * `node:path` yields a backslash separator on Windows; every path this gate
 * reports uses `/`. (Not `String.raw` with a lone backslash — the lexer reads
 * the closing backtick as escaped and the template never terminates.)
 */
const SEP = '\\';

/**
 * Positive control (the `check:actor-role-truth` pattern). Each entry must be
 * FOUND, in scope, carrying that exact id, so a scope rule that rots fails
 * loudly instead of passing vacuously over an empty file set — which is how a
 * green gate comes to prove nothing.
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
  // Floor on the ADMIN leg. The POSITIVE_CONTROL entries cannot detect a typo'd
  // `admin/renewals/` prefix, because every file under it also arrives via the
  // composition leg — that leg could rot to zero and the controls would still
  // be found. This floor is what notices. The portal leg needs no real floor
  // (no portal route composes the helper, so they arrive by prefix alone and
  // the `redeem-link` control already fails if that prefix rots); `>= 1` is
  // only a total-wipe guard, deliberately not pinned to the current count.
  if (adminLeg.length < 15 || portalLeg.length < 1) {
    throw new Error(
      `check:f8-error-id scope rot: admin/renewals/ matched ${adminLeg.length} ` +
        `(expected >=15), portal/renewal/ matched ${portalLeg.length} (expected >=1). ` +
        'A prefix has changed or been mistyped; the gate would run over a truncated set.',
    );
  }
  const byComposition = all.filter((p) =>
    // Stripped, not raw: a non-F8 route that merely MENTIONS the helper in a
    // comment would otherwise be dragged into scope and told to declare an F8
    // id it has no business having.
    stripCommentsPreserveLines(readFileSync(p, 'utf8')).includes(
      'requireRenewalAdminContext',
    ),
  );
  return [...new Set([...adminLeg, ...portalLeg, ...byComposition])].sort();
}

/**
 * The `F8ErrorId` union, parsed from its source rather than duplicated here. A
 * `const ERROR_ID` is only checked against the union by `tsc` where it is
 * PASSED to the helper; the two portal routes never pass theirs anywhere, so
 * without this the union and their ids could drift apart silently.
 */
function unionMembers(): ReadonlySet<string> {
  const src = readFileSync('src/lib/renewals-route-helpers.ts', 'utf8');
  const block = /export type F8ErrorId =([\s\S]*?);\n/.exec(src);
  if (!block) return new Set();
  return new Set([...block[1]!.matchAll(/'(F8\.[A-Z_]+)'/g)].map((m) => m[1]!));
}

const failures: string[] = [];
const files = inScope();
const union = unionMembers();
if (union.size === 0) {
  failures.push(
    'Could not parse the F8ErrorId union from src/lib/renewals-route-helpers.ts —\n' +
      '    the taxonomy check is inert. Fix the parser before trusting this gate.',
  );
}

/** Declared id -> the file that declared it, so two routes cannot share one. */
const declaredBy = new Map<string, string>();

for (const file of files) {
  const rel = file.slice(`${SRC}/`.length);
  const code = stripCommentsPreserveLines(readFileSync(file, 'utf8'));
  const { declaredId, failures: found } = checkSource(code, union);

  for (const f of found) failures.push(`${rel}:${f.line}\n    ${f.message}`);

  if (declaredId !== null) {
    // Two routes must not share an entry. `F8ErrorId` is a union of literals,
    // so `tsc` is perfectly happy with a copy-pasted route keeping the id of
    // the file it was copied from — which is the original defect, restored.
    const prior = declaredBy.get(declaredId);
    if (prior !== undefined) {
      failures.push(
        `${rel}\n    declares ${declaredId}, already declared by ${prior}. Two routes sharing\n    an entry is the defect this taxonomy exists to prevent: an alert names one\n    route while the failure is in the other.`,
      );
    } else {
      declaredBy.set(declaredId, rel);
    }
  }
}

for (const [suffix, id] of POSITIVE_CONTROL) {
  const path = `${SRC}/${suffix}`;
  if (!files.includes(path)) {
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
    'Each F8 renewals route names itself once, and every 500 it can answer with\n' +
      'carries that name in the log, so an alert keyed on `<ERROR_ID>.*` matches\n' +
      'every failure the route can produce.\n',
  );
  process.exit(1);
}

console.log(
  `✓ check:f8-error-id — ${files.length} F8 route(s) in scope, each naming itself; ` +
    `${POSITIVE_CONTROL.length} positive control(s) found.`,
);
