/**
 * Spec 140 s2d (#736c) — the rule behind `pnpm check:log-error-objects`
 * (`scripts/lib/log-error-objects-rules.ts`). The gate's own positive control
 * is the fixture; this file pins the parse itself: CRLF, multi-line calls, the
 * line it reports, and that only `logger.<level>(…)` arguments are read.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as rules from '../../../scripts/lib/log-error-objects-rules';

const { findLogErrorObjects } = rules;

const lines = (src: string) => findLogErrorObjects('x.ts', src).map((f) => f.line);

describe('findLogErrorObjects', () => {
  it('reads a multi-line call on a CRLF checkout and reports the line of the value', () => {
    const src = [
      'try { run(); } catch (e) {',
      '  logger.error(',
      '    {',
      '      tenantId,',
      '      err: e instanceof Error ? e.message : String(e),',
      '    },',
      "    'op.failed',",
      '  );',
      '}',
    ].join('\r\n');
    expect(lines(src)).toEqual([5]);
  });

  it('reads `deps.logger.<level>`, every level and (#739 B3b) a server console call, not a Result', () => {
    const src = [
      'try { run(); } catch (e) {',
      '  deps.logger.fatal({ err: e });',
      '  logger.trace({ err: e });',
      '  console.error({ err: e });',
      '  return err({ code: "repo.unexpected", cause: e });',
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([2, 3, 4]);
  });

  it('refuses error text in the message argument too', () => {
    const src = "try { run(); } catch (e) { logger.warn({ err: errKind(e) }, `failed: ${e.message}`); }";
    expect(findLogErrorObjects('x.ts', src)).toEqual([{ line: 1, message: 'a template embedding `.message`' }]);
  });

  it('treats any catch binding as an error, whatever its name', () => {
    const src = 'try { run(); } catch (boom) { logger.error({ failure: boom }); }';
    expect(findLogErrorObjects('x.ts', src)[0]?.message).toBe('failure: the error object `boom`');
  });

  it('allows the reducers and token names', () => {
    const src = [
      'try { run(); } catch (e) {',
      '  logger.error({ ...errLogFields(e), step: errStep(e), meta: pgErrorMeta(e), kind: classifyThrown(e).kind });',
      '  logger.error({ err: errKind(e), code: pgErrorCode(e), repoCode: x.error.code, errClass, actor: hashId(id) });',
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([]);
  });

  it('parses a .tsx file as TSX, so JSX before a logger call does not hide it', () => {
    // Parsed as TS, the backtick in the JSX text opens a template literal that
    // swallows every line after it, the logger call on line 6 included.
    const src = [
      'export function Row() {',
      '  try { run(); } catch (e) { logger.error({ err: e }); }',
      '  return <p className="hint">Press the ` key</p>;',
      '}',
      'export function Other() {',
      '  try { run(); } catch (e) { logger.error({ err: e.message }); }',
      '}',
    ].join('\n');
    expect(findLogErrorObjects('row.tsx', src).map((f) => f.line)).toEqual([2, 6]);
  });

  // Review round 2 (security #4, code-review #8) — a value read off an error
  // into a local is as error-ish as the read itself: one hop, by scope.
  it('follows one hop: a local destructured or assigned off an error is refused where it is logged', () => {
    const src = [
      'try { run(); } catch (e) {',
      '  const { message } = e;',
      '  logger.warn({ message });',
      '  const m = e.message;',
      '  logger.warn({ m });',
      '  const { code } = e;',
      '  logger.warn({ code });',
      '}',
      'function f(result: R) {',
      '  const { errClass } = result.error;',
      "  logger.error({ err: errClass }, 'x');",
      '}',
      'function g(result: R) {',
      "  logger.error({ errClass }, 'x');",
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([3, 5, 11]);
  });

  it('counts every logger call it parsed, for the real-tree floor', () => {
    const src = [
      "logger.info({ id }, 'a');",
      "deps.logger.warn({ id }, 'b');",
      'logger.child({ id });',
      "console.error({ id }, 'c');",
    ].join('\n');
    // #739 B3b — a server file's console call counts too.
    expect(rules.scanLogErrorObjects('x.ts', src)).toEqual({ findings: [], loggerCalls: 4, wrappers: [] });
  });

  // #740 B2 — the two forms the B1 reviews found the rule could not see.
  it('walks the arms of a conditional or `??` when they are object literals', () => {
    const src = [
      'try { run(); } catch (e) {',
      "  logger.error({ err: e instanceof Error ? { message: e.message } : { message: 'x' } });",
      '  logger.error({',
      '    ...(e instanceof Error',
      '      ? { stack: e.stack }',
      '      : {}),',
      '  });',
      "  logger.error({ err: e instanceof Error ? { kind: errKind(e) } : { kind: 'unknown' } });",
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([2, 5]);
  });

  it('checks the context argument of a registered log wrapper at its call site', () => {
    expect(rules.LOG_WRAPPERS.recordAuditEmitFailure).toBeDefined();
    const src = [
      'try { run(); } catch (e) {',
      "  recordAuditEmitFailure(t, 'a', 'b', 'c', { err: e.message });",
      "  recordAuditEmitFailure(t, 'a', 'b', 'c', { ...errLogFields(e) });",
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([2]);
  });

  it('refuses an unregistered function whose parameter reaches a log line, and names it', () => {
    const src = [
      'export function logThing(tenantId: string, context: Record<string, unknown>) {',
      "  logger.warn({ tenantId, ...context }, 'x');",
      '}',
      'const adapter = { warn(message: string, meta?: Record<string, unknown>) { logger.warn({ ...(meta ?? {}) }, message); } };',
    ].join('\n');
    const findings = findLogErrorObjects('x.ts', src);
    expect(findings.map((f) => f.line)).toEqual([2]);
    expect(findings[0]?.message).toContain('logThing');
    expect(rules.scanLogErrorObjects('x.ts', src).wrappers).toEqual([{ name: 'logThing', index: 1 }]);
  });

  it('#740 B2 review: a parameter logged under an error-detail key is a wrapper; a tenant id is not', () => {
    const src = [
      'export function failPage(arm: string, code: string) {',
      "  logger.error({ errorId: arm, err: code }, 'x');",
      '}',
      'export function note(tenantId: string) {',
      "  logger.info({ tenantId }, 'x');",
      '}',
    ].join('\n');
    const scan = rules.scanLogErrorObjects('x.ts', src);
    expect(scan.findings.map((f) => f.line)).toEqual([2]);
    expect(scan.findings[0]?.message).toContain('failPage');
    expect(scan.wrappers).toEqual([{ name: 'failPage', index: 1 }]);
  });

  it('#740 B2 review: a logger held in a local is read, and the left side of `&&` is not logged', () => {
    const src = [
      'const log = deps.logger;',
      'const child = logger.child({ mod: "x" });',
      'try { void 0; } catch (e) {',
      "  log.error({ err: e }, 'x');",
      "  child.warn({ msg: e.message }, 'x');",
      "  logger.error({ ...(e && { kind: errKind(e) }) }, 'x');",
      '}',
    ].join('\n');
    const scan = rules.scanLogErrorObjects('x.ts', src);
    expect(scan.findings.map((f) => f.line)).toEqual([4, 5]);
    expect(scan.loggerCalls).toBe(4); // the three level calls and `logger.child(…)`
  });

  it('#740 B2 review: stepToken keeps a code-built step and drops driver text', async () => {
    const { stepToken } = await import('@/lib/log-id');
    expect(stepToken('count-pending: repo.unexpected')).toBe('count-pending: repo.unexpected');
    expect(stepToken('queue: repo.not_found')).toBe('queue: repo.not_found');
    expect(stepToken('deploy_skew_gateway_arm')).toBe('deploy_skew_gateway_arm');
    expect(stepToken('Failed query: select * from members where email = $1')).toBeUndefined();
    expect(stepToken('insert failed for a@b.example')).toBeUndefined();
    expect(stepToken('x: ' + 'a'.repeat(80))).toBeUndefined();
    expect(stepToken(42)).toBeUndefined();
  });

  it('the fixture: every `// refused` line is found and no `// allowed` line is', () => {
    const path = 'scripts/__fixtures__/log-error-objects.fixture.txt';
    const text = readFileSync(path, 'utf8');
    const marked = (tag: string) =>
      text
        .split(/\r?\n/)
        .flatMap((l, i) => (new RegExp(`// ${tag}\\s*$`).test(l) ? [i + 1] : []));
    const refused = marked('refused');
    const allowed = marked('allowed');
    expect(refused.length).toBeGreaterThan(20);
    expect(allowed.length).toBeGreaterThan(5);
    const found = new Set(lines(text));
    expect([...found].sort((a, b) => a - b)).toEqual(refused);
    for (const line of allowed) expect(found.has(line), `allowed line ${line}`).toBe(false);
  });
});

describe('#739 B3b — the log rule reads console, computed levels and allSettled rejections', () => {
  it("reads a server file's console call, and skips a 'use client' file's", () => {
    const body = 'try { run(); } catch (e) {\n  console.warn("x", { err: e.message });\n}\n';
    expect(lines(body)).toEqual([2]);
    expect(lines(`'use client';\n${body}`)).toEqual([]);
    // The directive is read from the parse, so a leading comment and CRLF cannot hide it.
    expect(lines(`// c\r\n'use client';\r\n${body.replace(/\n/g, '\r\n')}`)).toEqual([]);
  });

  it('reads a computed-level logger call', () => {
    expect(lines('try { run(); } catch (e) {\n  logger[lvl]({ err: e.message }, "x");\n}\n')).toEqual([2]);
  });

  it('treats an allSettled element reason as an error, through a local', () => {
    const src = [
      'const settled = await Promise.allSettled(ps);',
      'settled.map((r) => {',
      '  const s = String(r.reason);',
      '  logger.error({ reason: s }, "x");',
      '  logger.error({ ...errLogFields(r.reason) }, "x");',
      '});',
    ].join('\n');
    expect(lines(src)).toEqual([4]);
  });

  it('leaves a `.reason` field of anything else alone', () => {
    expect(lines('items.map((r) => logger.info({ reason: r.reason }, "x"));')).toEqual([]);
  });
});

describe('#739 B3a — findCaughtErrorLiterals', () => {
  const scan = (src: string) => rules.findCaughtErrorLiterals('x.ts', src).map((f) => f.message);

  it('refuses caught text in a Result, a body or a span status', () => {
    expect(scan("try {} catch (e) { return err({ message: (e as Error).message }); }")).toHaveLength(1);
    expect(scan("try {} catch (e) { NextResponse.json({ error: String(e) }); }")).toHaveLength(1);
    expect(scan("try {} catch (e) { span.setStatus({ code: 2, message: `${e}` }); }")).toHaveLength(1);
  });

  it('follows a local holding the text, one hop', () => {
    expect(scan("try {} catch (e) { const m = e instanceof Error ? e.message : ''; return { reason: m }; }")).toHaveLength(1);
  });

  it('allows the class, a Result error field, error chaining and a log line', () => {
    expect(scan("try {} catch (e) { return err({ errClass: errKind(e), cause: e }); }")).toEqual([]);
    expect(scan("try {} catch (e) { return err({ message: result.error.message }); }")).toEqual([]);
    expect(scan("try {} catch (e) { logger.error({ err: errKind(e) }, 'x'); }")).toEqual([]);
  });

  it('chains only an error object under cause, never a local holding its text', () => {
    expect(scan("try {} catch (e) { const m = (e as Error).message; return err({ cause: m }); }")).toHaveLength(1);
    expect(scan("try {} catch (raw) { const c = raw instanceof Error ? raw : new Error('x'); throw new X('y', { cause: c }); }")).toEqual([]);
  });

  it('ignores a value outside a catch', () => {
    expect(scan("const e = new Error('x'); err({ message: e.message });")).toEqual([]);
  });

  it('#739 B3b part 2: a parameter typed unknown (or named like an error) is caught, by its text only', () => {
    expect(scan('function f(e: unknown) { return { reason: String(e) }; }')).toHaveLength(1);
    expect(scan('function f(err) { const m = err.message; return { detail: m }; }')).toHaveLength(1);
    expect(scan('function f(e: unknown) { return { err: errKind(e), data: parse(e), raw: e }; }')).toEqual([]);
    expect(scan('function f(row: unknown) { return { label: `x.${row.kind}` }; }')).toEqual([]);
  });

  it('#739 B3b part 2: a .catch body local, .then rejection handler and destructured bindings', () => {
    expect(scan('p.catch((e) => { const m = String(e); return { detail: m }; });')).toHaveLength(1);
    expect(scan('p.then(() => ({ ok: 1 }), (r) => ({ reason: String(r) }));')).toHaveLength(1);
    expect(scan('try {} catch ({ message }) { return { detail: message }; }')).toHaveLength(1);
    expect(
      scan(
        "async function f() { const all = await Promise.allSettled([p]); for (const r of all) { const { reason } = r; return { e: String(reason) }; } }",
      ),
    ).toHaveLength(1);
  });

  it('#739 B3b part 2: a client file console call is the browser console, not a sink', () => {
    const src = "'use client';\ntry {} catch (e) { console.error({ err: String(e) }, 'x'); }";
    expect(rules.findCaughtErrorLiterals('x.tsx', src)).toEqual([]);
    expect(rules.findCaughtErrorLiterals('x.tsx', "'use client';\ntry {} catch (e) { setState({ detail: String(e) }); }")).toHaveLength(1);
  });

  it('#739 B3b part 2: counts the catch scopes it parsed, for the real-tree floor', () => {
    expect(
      rules.countCaughtScopes('x.ts', 'try {} catch (e) {}\np.catch((x) => 1);\nfunction f(e: unknown) {}\nfunction g(n: number) {}'),
    ).toBe(3);
  });
});
