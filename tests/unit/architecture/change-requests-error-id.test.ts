/**
 * F114 T107 — the `errorId` taxonomy: every failing arm of every F114 route
 * handler names ITSELF as `M114.<surface>.<route>.<arm>`, so an alert keyed
 * on a route's prefix matches every failure that route can produce and never
 * a neighbour's. The defect this guards against shipped in F8: a shared
 * helper hardcoded one route's id and 24 callers logged it
 * (`scripts/check-f8-error-id.ts`); the same gate shape — a source scan with
 * positive controls — is applied here as a vitest architecture test.
 *
 * Rules:
 *   1. every route file in the F114 set (the LIST below is hand-maintained —
 *      a route added without a row here is a failure, see rule 5) declares at
 *      least one `errorId` literal (the parse cannot be vacuous per file);
 *   2. every literal starts with `M114.` followed by the segment the MAPPING
 *      derives from the file path — the route names itself, never another;
 *   3. no two ROUTE FILES share an identical full literal (the F8 defect);
 *   4. two positive controls: a fixture with a wrong prefix is rejected by the
 *      same checker, and a fixture with the right prefix is accepted;
 *   5. every F114 route file on disk is in the mapping (a new route must be
 *      given its segment on purpose).
 *
 * Literals are collected in BOTH forms the routes use — `errorId: '…'` and
 * `errorId: \`\${ERROR_ID}.arm\`` with `const ERROR_ID = '…'` /
 * `const HISTORY_ERROR_ID = '…'` resolved in-file — and comments are
 * stripped first, so prose about an id is not an id. Line handling is
 * `\r?\n`-safe (the working tree is CRLF).
 *
 * PR-3 review (SEC-3): the `errorIdPrefix:` call sites are collected too. Four
 * routes hand their prefix to `refuseWhenAttemptsExhausted`, which appends
 * `.attempts_exhausted` / `.attempt_bucket_fell_back` and logs it — so the id
 * that reaches the log never appears as an `errorId:` literal in the route,
 * and a route passing a NEIGHBOUR's `ERROR_ID` const was invisible to rules 2
 * and 3. That is the F8 defect exactly (one hardcoded id, 24 callers): the
 * only difference is that the literal travels as an argument. Prefixes are
 * resolved through the same `consts` map and checked by the same
 * `violations()`, where a prefix matches its route by EQUALITY (the helper
 * supplies the arm).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const API = 'src/app/api';

/**
 * File path (under src/app/api) → the `M114.<surface>.<route>` prefix every
 * errorId in that file must carry. `portal/change-requests/route.ts` hosts
 * two handlers (submit + own history), hence two prefixes.
 */
const ROUTE_PREFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['portal/change-requests/route.ts', ['M114.portal.submit', 'M114.portal.history']],
  ['portal/change-requests/gate/route.ts', ['M114.portal.gate']],
  ['portal/change-requests/current/route.ts', ['M114.portal.withdraw']],
  ['portal/change-requests/[id]/route.ts', ['M114.portal.history_item']],
  ['portal/change-requests/[id]/acknowledge/route.ts', ['M114.portal.acknowledge']],
  ['admin/change-requests/route.ts', ['M114.admin.queue']],
  ['admin/change-requests/[id]/route.ts', ['M114.admin.review']],
  ['admin/change-requests/[id]/decide/route.ts', ['M114.admin.decide']],
  ['admin/members/[id]/change-requests/route.ts', ['M114.admin.member_history']],
  ['admin/settings/member-changes/route.ts', ['M114.admin.setting']],
];

/** The trees whose every route.ts must appear in ROUTE_PREFIXES (rule 5). */
const ROUTE_TREES = ['portal/change-requests', 'admin/change-requests', 'admin/members/[id]/change-requests', 'admin/settings/member-changes'] as const;

function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRoutes(full, out);
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

/** Strip block + line comments (line-ending agnostic) so prose is not parsed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

/** The file's own `const <NAME>_ID = '…'` declarations, comments already stripped. */
function constsOf(code: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const m of code.matchAll(/const\s+([A-Z_]*ERROR_ID)\s*=\s*'([^']+)'/g)) consts.set(m[1]!, m[2]!);
  return consts;
}

/**
 * Every `errorId` literal a file can log, template forms resolved through the
 * file's own `const <NAME>_ID = '…'` / `const ERROR_ID = '…'` declarations.
 */
export function collectErrorIds(source: string): string[] {
  const code = stripComments(source);
  const consts = constsOf(code);
  const ids: string[] = [];
  for (const m of code.matchAll(/errorId:\s*'([^']+)'/g)) ids.push(m[1]!);
  for (const m of code.matchAll(/errorId:\s*`([^`]+)`/g)) {
    const resolved = m[1]!.replace(/\$\{([A-Z_]*ERROR_ID)\}/g, (_all, name: string) => consts.get(name) ?? `<unresolved:${name}>`);
    ids.push(resolved);
  }
  return ids;
}

/**
 * SEC-3 — every PREFIX a file hands to a shared logging helper
 * (`refuseWhenAttemptsExhausted({ errorIdPrefix })`), resolved through the same
 * `consts` map. The helper appends the arm, so what lands in the log is
 * `<prefix>.attempts_exhausted` — an id that appears nowhere in the route as
 * an `errorId:` literal.
 */
export function collectErrorIdPrefixes(source: string): string[] {
  const code = stripComments(source);
  const consts = constsOf(code);
  const prefixes: string[] = [];
  for (const m of code.matchAll(/errorIdPrefix:\s*'([^']+)'/g)) prefixes.push(m[1]!);
  for (const m of code.matchAll(/errorIdPrefix:\s*([A-Z_]*ERROR_ID)\b/g)) {
    prefixes.push(consts.get(m[1]!) ?? `<unresolved:${m[1]!}>`);
  }
  return prefixes;
}

/**
 * Rule 2 as a pure function so the positive control can exercise it.
 *
 * An `errorId` must START WITH one of the route's prefixes plus a dot; an
 * `errorIdPrefix` IS the prefix (the helper supplies the arm), so an exact
 * match counts too — both forms are judged here, against the same list.
 */
export function violations(ids: readonly string[], prefixes: readonly string[]): string[] {
  return ids.filter((id) => !prefixes.some((p) => id === p || id.startsWith(`${p}.`)));
}

describe('F114 errorId taxonomy (T107)', () => {
  it('positive control: a wrong prefix is rejected and the right one accepted by the same checker', () => {
    const fixture = [
      "const ERROR_ID = 'M114.admin.queue';",
      "logger.error({ errorId: `${ERROR_ID}.use_case_failed` }, 'x');",
      "logger.error({ errorId: 'M114.admin.decide.use_case_failed' }, 'y');",
      "logger.error({ errorId: 'F8.MEMBER_RENEW.CONTEXT' }, 'z');",
      "// errorId: 'M114.admin.queue.in_a_comment'",
    ].join('\r\n');
    const ids = collectErrorIds(fixture);
    expect(ids).toEqual(['M114.admin.decide.use_case_failed', 'F8.MEMBER_RENEW.CONTEXT', 'M114.admin.queue.use_case_failed']);
    expect(violations(ids, ['M114.admin.queue'])).toEqual(['M114.admin.decide.use_case_failed', 'F8.MEMBER_RENEW.CONTEXT']);
    expect(violations(['M114.admin.queue.use_case_failed'], ['M114.admin.queue'])).toEqual([]);
  });

  it('positive control: every route file on disk under the F114 trees is in the mapping, and every mapped file exists', () => {
    const onDisk = ROUTE_TREES.flatMap((tree) => {
      const abs = resolve(ROOT, API, tree);
      return existsSync(abs) ? walkRoutes(abs) : [];
    })
      .map((abs) => abs.slice(resolve(ROOT, API).length + 1).split('\\').join('/'))
      .sort();
    const mapped = ROUTE_PREFIXES.map(([file]) => file).sort();
    expect(onDisk).toEqual(mapped);
    expect(onDisk.length).toBeGreaterThanOrEqual(10);
  });

  it('positive control: an errorIdPrefix carrying a NEIGHBOUR route\'s const is a violation, its own is not (SEC-3)', () => {
    const fixture = [
      "const ERROR_ID = 'M114.portal.submit';",
      "const NEIGHBOUR_ERROR_ID = 'M114.portal.withdraw';",
      'const refusal = await refuseWhenAttemptsExhausted({',
      '  key: `f114:submit-attempts:${tenant.slug}:${user.id}`,',
      '  errorIdPrefix: NEIGHBOUR_ERROR_ID,',
      '});',
      "// errorIdPrefix: 'M114.portal.gate' — prose, not a call site",
    ].join('\r\n');
    expect(collectErrorIdPrefixes(fixture)).toEqual(['M114.portal.withdraw']);
    expect(violations(collectErrorIdPrefixes(fixture), ['M114.portal.submit'])).toEqual(['M114.portal.withdraw']);
    // its OWN const, and the bare-literal form, both pass the same checker
    expect(violations(collectErrorIdPrefixes("const ERROR_ID = 'M114.portal.submit';\r\nerrorIdPrefix: ERROR_ID,"), ['M114.portal.submit'])).toEqual([]);
    expect(collectErrorIdPrefixes("errorIdPrefix: 'M114.portal.submit',")).toEqual(['M114.portal.submit']);
    // an unresolvable const must not silently vanish from the check
    expect(violations(collectErrorIdPrefixes('errorIdPrefix: MISSING_ERROR_ID,'), ['M114.portal.submit'])).toEqual([
      '<unresolved:MISSING_ERROR_ID>',
    ]);
  });

  const perFile = ROUTE_PREFIXES.map(([file, prefixes]) => {
    const abs = resolve(ROOT, API, file);
    const source = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    return { file, prefixes, ids: collectErrorIds(source), bucketPrefixes: collectErrorIdPrefixes(source) };
  });

  it('positive control: the attempt-bucket prefixes are actually found on disk (the SEC-3 parse is not vacuous)', () => {
    const withBuckets = perFile.filter((f) => f.bucketPrefixes.length > 0).map((f) => f.file);
    expect(withBuckets.sort()).toEqual(
      [
        'portal/change-requests/route.ts',
        'portal/change-requests/current/route.ts',
        'portal/change-requests/[id]/route.ts',
        'portal/change-requests/[id]/acknowledge/route.ts',
      ].sort(),
    );
  });

  it.each(perFile.map((f) => [f.file, f] as const))('%s: every errorId names this route (M114.<surface>.<route>.<arm>)', (_file, f) => {
    expect(f.ids.length, `${f.file} declares no errorId literal — the parse is vacuous or the route logs nothing on failure`).toBeGreaterThan(0);
    for (const id of f.ids) expect(id, `${f.file} logs ${id}`).toMatch(/^M114\.(portal|admin)\.[a-z_]+\.[a-z_]+$/);
    // a PREFIX is one segment shorter — the helper appends the arm
    for (const p of f.bucketPrefixes) expect(p, `${f.file} passes ${p} to a shared logger`).toMatch(/^M114\.(portal|admin)\.[a-z_]+$/);
    expect(
      violations([...f.ids, ...f.bucketPrefixes], f.prefixes),
      `${f.file} logs an id that names another route`,
    ).toEqual([]);
  });

  it('no two route files share an identical full errorId literal (the F8 shared-helper defect)', () => {
    const owner = new Map<string, string>();
    const shared: string[] = [];
    for (const f of perFile) {
      for (const id of new Set(f.ids)) {
        const prior = owner.get(id);
        if (prior !== undefined && prior !== f.file) shared.push(`${id}: ${prior} and ${f.file}`);
        owner.set(id, f.file);
      }
    }
    expect(shared).toEqual([]);
  });
});
