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

// ---------------------------------------------------------------------------
// Spec 142 (AO2, AO3) — the deleted row has one writer: `emitOnce`.
// ---------------------------------------------------------------------------

/**
 * A plain emit of `broadcast_audience_deleted` would bypass migration 0328's
 * arbiter: the index refuses its second row with a 23505, which the row helper
 * logs as a lost row. So the event's literal may appear in code only in the
 * files that declare it, read it or write it through `emitOnce`, and no
 * emit-family call may carry it in its arguments. The deleted-row builder
 * (`audienceDeletedInput`) may be called only inside the arguments of
 * `emitOnce(`.
 *
 * Out of reach (as above): the literal built from parts, or held in a variable
 * declared in an allowlisted file and passed on elsewhere; a call through an
 * alias of `emit`.
 */
const DELETED_LITERAL = /['"`]broadcast_audience_deleted['"`]/;
const DELETED_LITERAL_FILES = [
  'src/modules/auth/infrastructure/db/schema.ts',
  'src/modules/broadcasts/application/ports/audit-port.ts',
  'src/modules/broadcasts/application/use-cases/_audience-audit.ts',
  'src/modules/broadcasts/infrastructure/audit-adapter.ts',
  'src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts',
] as const;
const EMIT_FAMILY = /\b(emit|emitTyped|emitMany|emitManyTyped|safeAuditEmit|safeAuditEmitTyped|emitOnce)\s*(?:<[^>()]*>)?\s*\(/g;

/** The argument text of the call whose `(` is at `open`, up to its balanced `)`. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

interface EmitScan {
  readonly emitCalls: number;
  readonly emitOnceCalls: number;
  readonly violations: string[];
}

function scanDeletedWriters(file: string, source: string): EmitScan {
  const src = stripComments(source);
  const violations: string[] = [];
  let emitCalls = 0;
  let emitOnceCalls = 0;
  const onceArgs: Array<readonly [number, number]> = [];
  for (const m of src.matchAll(EMIT_FAMILY)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = argsAt(src, open);
    if (m[1] === 'emitOnce') {
      emitOnceCalls++;
      onceArgs.push([open, open + args.length + 1]);
      continue;
    }
    emitCalls++;
    if (DELETED_LITERAL.test(args) || /\baudienceDeletedInput\s*\(/.test(args)) {
      violations.push(`${file}: ${m[1]}( carries the deleted row`);
    }
  }
  if (DELETED_LITERAL.test(src) && !(DELETED_LITERAL_FILES as readonly string[]).includes(file)) {
    violations.push(`${file}: names broadcast_audience_deleted outside the allowlist`);
  }
  for (const m of src.matchAll(/\baudienceDeletedInput\s*\(/g)) {
    const at = m.index ?? 0;
    const insideOnce = onceArgs.some(([from, to]) => at > from && at < to);
    const isDeclaration = /function\s+$/.test(src.slice(Math.max(0, at - 20), at));
    if (!insideOnce && !isDeclaration) violations.push(`${file}: audienceDeletedInput( outside emitOnce(`);
  }
  return { emitCalls, emitOnceCalls, violations };
}

function scanRepoDeletedWriters(): EmitScan & { readonly onceIn: string[] } {
  const root = process.cwd();
  const all = walk(join(root, 'src')).map((full) => {
    const file = relative(root, full).split(sep).join('/');
    return { file, scan: scanDeletedWriters(file, readFileSync(full, 'utf8')) };
  });
  return {
    emitCalls: all.reduce((n, f) => n + f.scan.emitCalls, 0),
    emitOnceCalls: all.reduce((n, f) => n + f.scan.emitOnceCalls, 0),
    violations: all.flatMap((f) => f.scan.violations),
    onceIn: all.filter((f) => f.scan.emitOnceCalls > 0).map((f) => f.file),
  };
}

describe('spec 142 — the deleted row is written only through emitOnce', () => {
  const found = scanRepoDeletedWriters();

  it('positive control: the scan finds emit calls at all, and the deleted-row writer calls emitOnce', () => {
    expect(found.emitCalls).toBeGreaterThan(20);
    expect(found.onceIn).toContain('src/modules/broadcasts/application/use-cases/_audience-audit.ts');
  });

  it('no emit-family call carries broadcast_audience_deleted, and the literal stays in its files', () => {
    expect(found.violations).toEqual([]);
  });

  it.each([
    ['a plain emit with the literal', "async function x() { await audit.emit(tx, { eventType: 'broadcast_audience_deleted' }); }"],
    ['a typed emit with a type argument', 'async function x() { await audit.emitTyped<E>(tx, { eventType: "broadcast_audience_deleted" }); }'],
    ['a fail-soft emit', 'async function x() { await safeAuditEmit(deps, tx, { eventType: `broadcast_audience_deleted` }); }'],
    ['a plain emit of the builder', 'async function x() { await audit.emit(tx, audienceDeletedInput(t, p)); }'],
    ['the builder outside emitOnce', 'async function x() { const i = audienceDeletedInput(t, p); await audit.emitOnce(tx, i); }'],
  ])('catch case: %s is a violation', (_label, source) => {
    expect(scanDeletedWriters(`${UC}/_audience-audit.ts`, source).violations).not.toEqual([]);
  });

  it('catch case: the literal outside the allowlist is a violation; the builder inside emitOnce is not', () => {
    expect(scanDeletedWriters('src/x.ts', "const e = 'broadcast_audience_deleted';").violations).not.toEqual([]);
    expect(
      scanDeletedWriters(
        `${UC}/_audience-audit.ts`,
        'function audienceDeletedInput(a, b) { return a; }\nasync function x() { await audit.emitOnce(tx, audienceDeletedInput(t, p)); }',
      ).violations,
    ).toEqual([]);
  });
});
