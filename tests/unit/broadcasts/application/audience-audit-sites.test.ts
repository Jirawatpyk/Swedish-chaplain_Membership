/**
 * Spec 139 slice 2 (DA2) — a source scan that pins every Resend call that
 * hands a recipient list to a segment (`createContactImport`) or deletes a
 * segment (`deleteAudience`), and whether each one is audited.
 *
 * Audited sites write their Art. 30 row before the call, in the same function
 * (`recordAudienceDisclosed` / `recordAudienceDeleted` /
 * `recordReclaimedAudienceDeleted`). Exempt sites write none, because their
 * segment never held recipients (spec DA2): `reclaimUnattachedAudience` (a
 * segment created on this tick whose attach failed) and `settleOrphanAtResend`
 * (the drain and erasure settle of `audience_leaked` segments, whose only
 * writer is `reclaimUnattachedAudience`). A NEW call site, in any file under
 * `src/`, fails this test until it is added to `SITES` as audited or exempt.
 *
 * What the scan matches: a member call in three spellings — `.m(`, `?.m(` and
 * a bracket `['m'](` — with or without a type argument, after comments are
 * stripped. Each spelling class has a catch case below. What stays out of its
 * reach is `OUT_OF_REACH` (the unit tests at each site cover only those).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const OUT_OF_REACH = [
  'a destructured method: const { deleteAudience } = gateway; deleteAudience(id)',
  'an alias: const del = gateway.deleteAudience; del(id)',
  'a method name in a variable: gateway[name](id)',
  'a dynamic import, or a call through a barrel re-export under another name',
  'a call inside an arrow function or method: it is attributed to the nearest enclosing `function` declaration',
  "a record call in a branch other than the delete's own: the scan checks only that it appears textually before the call in the same function",
] as const;

type Method = 'deleteAudience' | 'createContactImport';
type Audit = 'recordAudienceDisclosed' | 'recordAudienceDeleted' | 'recordReclaimedAudienceDeleted' | 'exempt';

interface Site {
  readonly file: string;
  readonly fn: string;
  readonly method: Method;
}

const UC = 'src/modules/broadcasts/application/use-cases';

/** Every call site in `src/`, and how it is audited. */
const SITES: ReadonlyArray<Site & { readonly audit: Audit }> = [
  { file: `${UC}/build-audience-tick.ts`, fn: 'submitImport', method: 'createContactImport', audit: 'recordAudienceDisclosed' },
  { file: `${UC}/build-audience-tick.ts`, fn: 'restartAudienceBuild', method: 'deleteAudience', audit: 'recordAudienceDeleted' },
  { file: `${UC}/build-audience-tick.ts`, fn: 'reclaimUnattachedAudience', method: 'deleteAudience', audit: 'exempt' },
  { file: `${UC}/cleanup-orphaned-audiences.ts`, fn: 'handleOne', method: 'deleteAudience', audit: 'recordAudienceDeleted' },
  { file: `${UC}/reclaim-orphaned-audiences.ts`, fn: 'handleOne', method: 'deleteAudience', audit: 'recordReclaimedAudienceDeleted' },
  { file: `${UC}/_settle-orphan-at-resend.ts`, fn: 'settleOrphanAtResend', method: 'deleteAudience', audit: 'exempt' },
];

const METHODS: readonly Method[] = ['deleteAudience', 'createContactImport'];

/** Block and line comments out; a `//` inside a quoted string (a URL) is kept. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, pre: string) => pre);
}

function callPattern(method: Method): RegExp {
  // `.m(`, `?.m(`, `.m<T>(`, `['m'](`, `["m"]?.(`.
  return new RegExp(
    String.raw`(?:\?\.|\.)\s*${method}\s*(?:<[^>()]*>)?\s*\(|\[\s*['"\x60]${method}['"\x60]\s*\]\s*(?:\?\.)?\s*\(`,
    'g',
  );
}

const FN_DECL = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g;

interface FoundCall extends Site {
  /** The source of the enclosing function, from its declaration to the call. */
  readonly before: string;
}

/** Every call of a pinned method in one source text. */
function scanSource(file: string, source: string): FoundCall[] {
  const src = stripComments(source);
  const decls = [...src.matchAll(FN_DECL)].map((m) => ({ name: m[1]!, at: m.index ?? 0 }));
  const found: FoundCall[] = [];
  for (const method of METHODS) {
    for (const m of src.matchAll(callPattern(method))) {
      const at = m.index ?? 0;
      const decl = [...decls].reverse().find((d) => d.at < at);
      found.push({ file, fn: decl?.name ?? '<module>', method, before: src.slice(decl?.at ?? 0, at) });
    }
  }
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

function scanRepo(): FoundCall[] {
  const root = process.cwd();
  return walk(join(root, 'src')).flatMap((full) =>
    scanSource(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8')),
  );
}

/** Which audited sites lack their row before the call. */
function unaudited(found: readonly FoundCall[]): string[] {
  return SITES.filter((s) => s.audit !== 'exempt').flatMap((s) => {
    const call = found.find((f) => f.file === s.file && f.fn === s.fn && f.method === s.method);
    return call !== undefined && new RegExp(String.raw`\b${s.audit}\s*\(`).test(call.before) ? [] : [`${s.file} ${s.fn} ${s.method}`];
  });
}

const key = (s: Site) => `${s.file} ${s.fn} ${s.method}`;

describe('spec 139 s2 DA2 — the segment calls are pinned, and the audited ones write their row first', () => {
  const found = scanRepo();

  it('positive control: the scan of src/ finds call sites at all (a broken parse would find none)', () => {
    expect(found.length).toBeGreaterThanOrEqual(SITES.length);
  });

  it('every call site is in SITES, and every SITES entry still exists (one call each)', () => {
    expect(found.map(key).sort()).toEqual(SITES.map(key).sort());
  });

  it('every audited site writes its row in the same function, before the call', () => {
    expect(unaudited(found)).toEqual([]);
  });

  it.each([
    ['a method call', 'async function x() { await gw.deleteAudience(id); }'],
    ['an optional call', 'async function x() { await gw?.deleteAudience(id); }'],
    ['a type argument', 'async function x() { await gw.createContactImport<string>(id, list); }'],
    ['a bracket call', "async function x() { await gw['deleteAudience'](id); }"],
    ['an optional bracket call', 'async function x() { await gw["createContactImport"]?.(id, list); }'],
  ])('catch case: %s is found', (_label, source) => {
    expect(scanSource('src/x.ts', source)).toHaveLength(1);
  });

  it('a comment or a port declaration is not a call', () => {
    expect(
      scanSource('src/x.ts', [
        '// gw.deleteAudience(id)',
        '/* gw.createContactImport(a, b) */',
        'interface P { deleteAudience(audienceId: string): Promise<void>; }',
        "const url = 'https://api.resend.com/segments'; // gw.deleteAudience(x)",
      ].join('\n')),
    ).toEqual([]);
  });

  it('a row written AFTER the call, or in another function, does not count as audited', () => {
    const after = scanSource(
      `${UC}/cleanup-orphaned-audiences.ts`,
      'async function handleOne() { await gw.deleteAudience(id); await recordAudienceDeleted(d, f, p); }',
    );
    const elsewhere = scanSource(
      `${UC}/cleanup-orphaned-audiences.ts`,
      'async function a() { await recordAudienceDeleted(d, f, p); }\nasync function handleOne() { await gw.deleteAudience(id); }',
    );
    for (const f of [after, elsewhere]) {
      expect(unaudited(f)).toContain(`${UC}/cleanup-orphaned-audiences.ts handleOne deleteAudience`);
    }
  });

  it('names what the scan cannot see', () => {
    expect(OUT_OF_REACH).toHaveLength(6);
  });
});
