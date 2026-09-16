/**
 * 117 — every route that RESERVES an idempotency record must be able to
 * RELEASE it.
 *
 * The class: `withIdempotency` / `reserveIdempotencyRecord` store
 * `{ bodyHash, response: null }` for 24 h, and `classifyIdempotencyRequest`
 * reads a reserved-but-unwritten record as a CONFLICT. Any arm that exits
 * without remembering — a 429, a 5xx, a thrown error, an early return — leaves
 * the key burnt, so the client's correct retry (same key, same body) answers
 * the conflict status for the full TTL. PR #371 / T121 fixed one route by
 * hand; seventeen others had no release call at all, which is why this is a
 * gate and not a review note.
 *
 * Rules:
 *   1. every file under `src/app/**` (plus the shared plans guard) that calls
 *      `withIdempotency(` or `reserveIdempotencyRecord(` must also call
 *      `runIdempotent(` (the closure helper, which releases in `finally`) or
 *      `releaseIdempotencyRecord(` (the hand-written T121 shape);
 *   2. `rememberIdempotentResponse` / `remember` is never handed a literal
 *      status ≥ 500 — an infra fault must never be replayable;
 *   3. positive controls, because a scan that cannot tell "nothing to find"
 *      from "not looking" is not a check: the scan must find at least
 *      MIN_RESERVING_FILES files, a fixture that reserves without releasing
 *      must FAIL rule 1, a fixture that releases must PASS it, and a fixture
 *      remembering a 500 must FAIL rule 2.
 *
 * Comments are stripped before parsing (this docblock names every symbol it
 * forbids) and line handling is `\r?\n`-safe — the working tree is CRLF, and a
 * gate anchored on `\n` is inert on every Windows checkout while CI stays
 * green (the `check:f8-error-id` precedent).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/**
 * Floor for the scan, not a target. 20 route files + the shared plans guard
 * reserve today; the floor sits below that so adding a route does not fail the
 * gate, but a parse that silently collapses to nothing does.
 */
const MIN_RESERVING_FILES = 17;

/** Extra non-`route.ts` files that own a reservation on a route's behalf. */
const EXTRA_FILES = ['src/app/api/plans/_idempotency-guard.ts'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === 'route.ts') out.push(full);
  }
  return out;
}

/** Strip block + line comments (line-ending agnostic) so prose is not parsed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\r?\n)[ \t]*\/\/[^\r\n]*/g, '$1');
}

/** Does this source RESERVE an idempotency record? */
function reserves(code: string): boolean {
  return /\bwithIdempotency\s*\(/.test(code) || /\breserveIdempotencyRecord\s*\(/.test(code);
}

/** Does this source have a way to RELEASE one? */
function releases(code: string): boolean {
  return /\brunIdempotent\s*\(/.test(code) || /\breleaseIdempotencyRecord\s*\(/.test(code);
}

/**
 * Literal `status: 5xx` inside a remember call's argument list (rule 2).
 * Grep-level by design: a status carried in a variable (`errorResponse`) is
 * out of reach of a source scan, and `runIdempotent`'s own `remember` refuses
 * a 429 / 5xx at RUNTIME, which is the backstop for those.
 */
function remembersServerError(code: string): readonly string[] {
  const hits: string[] = [];
  const call = /\b(?:rememberIdempotentResponse|remember)\s*\(/g;
  for (;;) {
    if (call.exec(code) === null) break;
    // Balance parens from the opening one to find the call's argument span.
    let depth = 1;
    let i = call.lastIndex;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    const args = code.slice(call.lastIndex, i - 1);
    const bad = /\bstatus\s*:\s*5\d\d\b/.exec(args);
    if (bad) hits.push(bad[0]);
  }
  return hits;
}

const files: ReadonlyArray<{ readonly path: string; readonly code: string }> = [
  ...walk(join(ROOT, 'src/app')),
  ...EXTRA_FILES.map((p) => join(ROOT, p)).filter((p) => existsSync(p)),
].map((full) => ({
  path: full.slice(ROOT.length + 1).replace(/\\/g, '/'),
  code: stripComments(readFileSync(full, 'utf8')),
}));

const reserving = files.filter((f) => reserves(f.code));

describe('117 — idempotency reservations are releasable (architecture gate)', () => {
  it('finds the reserving files at all (positive control for the scan)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(reserving.length).toBeGreaterThanOrEqual(MIN_RESERVING_FILES);
    // The shared plans guard reserves on five routes' behalf — if the walk
    // stopped finding it, rule 1 would be checking the wrong set.
    expect(reserving.map((f) => f.path)).toContain('src/app/api/plans/_idempotency-guard.ts');
  });

  it('rule 1 — every reserving file can release its reservation', () => {
    const offenders = reserving.filter((f) => !releases(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('rule 2 — no remember call is handed a literal 5xx status', () => {
    const offenders = files
      .flatMap((f) => remembersServerError(f.code).map((hit) => `${f.path}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('positive control — a reservation with no release FAILS rule 1', () => {
    const fixture = stripComments(`
      // releaseIdempotencyRecord is only named in this comment
      const reserved = await reserveIdempotencyRecord(tenant, key, hash);
      if (!reserved.ok) return json503();
      await rememberIdempotentResponse(tenant, key, hash, { status: 200, body });
    `);
    expect(reserves(fixture)).toBe(true);
    expect(releases(fixture)).toBe(false);
  });

  it('positive control — both release shapes PASS rule 1', () => {
    const viaHelper = 'await reserveIdempotencyRecord(t, k, h); return runIdempotent(t, { key: k, bodyHash: h }, async ({ remember }) => {});';
    const byHand = 'await reserveIdempotencyRecord(t, k, h); await releaseIdempotencyRecord(t, k);';
    expect(reserves(viaHelper) && releases(viaHelper)).toBe(true);
    expect(reserves(byHand) && releases(byHand)).toBe(true);
  });

  it('positive control — remembering a 500 FAILS rule 2, a 200 passes', () => {
    expect(remembersServerError('await rememberIdempotentResponse(t, k, h, { status: 500, body });')).toEqual(['status: 500']);
    expect(remembersServerError('await remember({ status: 503, body: errorBody });')).toEqual(['status: 503']);
    expect(remembersServerError('await rememberIdempotentResponse(t, k, h, { status: 200, body });')).toEqual([]);
  });
});
