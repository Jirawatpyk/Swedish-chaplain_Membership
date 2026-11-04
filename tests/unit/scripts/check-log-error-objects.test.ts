/**
 * Spec 140 s2d (#736c) — the rule behind `pnpm check:log-error-objects`
 * (`scripts/lib/log-error-objects-rules.ts`). The gate's own positive control
 * is the fixture; this file pins the parse itself: CRLF, multi-line calls, the
 * line it reports, and that only `logger.<level>(…)` arguments are read.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findLogErrorObjects } from '../../../scripts/lib/log-error-objects-rules';

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

  it('reads `deps.logger.<level>` and every level, and only the logger', () => {
    const src = [
      'try { run(); } catch (e) {',
      '  deps.logger.fatal({ err: e });',
      '  logger.trace({ err: e });',
      '  console.error({ err: e });',
      '  return err({ code: "repo.unexpected", cause: e });',
      '}',
    ].join('\n');
    expect(lines(src)).toEqual([2, 3]);
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
