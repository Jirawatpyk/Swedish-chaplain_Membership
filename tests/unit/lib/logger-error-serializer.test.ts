/**
 * Spec 140 s2d review round 1 (code-review #2) — the production logger reduces
 * an error at the root. drizzle-orm's `DrizzleQueryError` has enumerable
 * `query` and `params`, and its message quotes them; pino copies the message
 * of an `err` into `msg` when no message is given. Whatever a call site
 * passes under `err` / `error` / `cause`, the written line carries only the
 * error's class and SQLSTATE.
 *
 * Review round 2 (code-review #1, #2; pdpa H-2; security M1; the maintainer's
 * decision of 4 Nov 2026) — any non-string value under those keys, an Error
 * or a plain object with any field, becomes closed tokens plus stack frames:
 * `type`, `code`, `repoCode`, `errCode`, `statusCode`, `declineCode`,
 * `frames`. Never `message`, `stack`, `detail`, `params` or `query`.
 *
 * Captures the REAL `logger`'s output by spying on its destination stream, so
 * the test reads the production options (redaction, PAN formatter, the error
 * reduction), not a copy of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { DrizzleQueryError } from 'drizzle-orm';
import { logger, reduceLoggedError } from '@/lib/logger';

const EMAIL = 'a@x.io';

function leakyDbError(): DrizzleQueryError {
  const pg = Object.assign(new Error(`duplicate key value violates unique constraint "contacts_email_uniq"`), {
    code: '23505',
    detail: `Key (email)=(${EMAIL}) already exists.`,
  });
  return new DrizzleQueryError('update contacts set email = $1', [EMAIL], pg);
}

let lines: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  lines = [];
  const stream = (logger as unknown as Record<symbol, { write(s: string): unknown }>)[pino.symbols.streamSym]!;
  const original = stream.write;
  stream.write = (s: string) => {
    lines.push(s);
    return true;
  };
  restore = () => {
    stream.write = original;
  };
});

afterEach(() => restore());

/** The one written line, parsed. */
function written(): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** Nothing of the statement, its parameters or its message reaches the line. */
function expectNoErrorText(): void {
  expect(lines.join('')).not.toMatch(/a@x\.io|Failed query|update contacts|"params"|"query"|Key \(|duplicate key/);
}

/** The only keys the reducer writes (review round 2). */
const REDUCED_KEYS = ['type', 'errType', 'code', 'repoCode', 'errCode', 'statusCode', 'declineCode', 'kind', 'frames'];

/** The reduced value under `key` of a parsed line, with no key outside the closed set. */
function reduced(line: Record<string, unknown>, key = 'err'): Record<string, unknown> {
  const value = line[key] as Record<string, unknown>;
  expect(typeof value).toBe('object');
  for (const k of Object.keys(value)) expect(REDUCED_KEYS).toContain(k);
  return value;
}

/** The reduced value without its frames, for an exact comparison. */
function tokens(value: Record<string, unknown>): Record<string, unknown> {
  const { frames: _frames, ...rest } = value;
  return rest;
}

describe('the logger reduces an error at the root', () => {
  it('logger.error({ err: drizzleQueryError }) writes no params, no query and no message', () => {
    logger.error({ err: leakyDbError() });
    expectNoErrorText();
    expect(tokens(reduced(written()))).toEqual({ type: 'DrizzleQueryError', code: '23505' });
  });

  it('reduces `error` and `cause` the same way, beside a message', () => {
    logger.error({ error: leakyDbError(), cause: leakyDbError() }, 'op.failed');
    expectNoErrorText();
    const line = written();
    expect(tokens(reduced(line, 'error'))).toEqual({ type: 'DrizzleQueryError', code: '23505' });
    expect(tokens(reduced(line, 'cause'))).toEqual({ type: 'DrizzleQueryError', code: '23505' });
    expect(line.msg).toBe('op.failed');
  });

  it('reduces a plain object carrying a cause (a RepoError) and a bare Error argument', () => {
    logger.error({ err: { code: 'repo.unexpected', cause: leakyDbError() } }, 'repo.failed');
    logger.error(leakyDbError());
    expectNoErrorText();
    expect(lines).toHaveLength(2);
    // Review round 2 — the RepoError keeps its own closed code as `repoCode`.
    expect(reduced(JSON.parse(lines[0]!) as Record<string, unknown>)).toEqual({
      type: 'unknown',
      repoCode: 'repo.unexpected',
      code: '23505',
    });
    expect(tokens(reduced(JSON.parse(lines[1]!) as Record<string, unknown>))).toEqual({ type: 'DrizzleQueryError', code: '23505' });
  });

  it('keeps a string value and the key-based redaction; a plain object of any shape is reduced', () => {
    logger.error({ err: 'DrizzleQueryError', error: { kind: 'timeout' }, password: 'hunter2' }, 'op.failed');
    const line = written();
    expect(line.err).toBe('DrizzleQueryError');
    // Review round 2 follow-up — a token-shaped `kind` is a closed field.
    expect(line.error).toEqual({ type: 'unknown', kind: 'timeout' });
    expect(line.password).toBe('[REDACTED]');
  });

  it('reduces an error bound on a child logger', () => {
    logger.child({ err: leakyDbError() }).error('child.failed');
    expectNoErrorText();
    expect(tokens(reduced(written()))).toEqual({ type: 'DrizzleQueryError', code: '23505' });
  });
});

describe('the root reducer writes tokens and frames, never text (review round 2)', () => {
  it('a Drizzle-shaped plain object writes no message or email, and keeps its frames', () => {
    logger.error({
      err: {
        name: 'DrizzleQueryError',
        message: `Failed query: update contacts set email = $1\nparams: ${EMAIL}`,
        stack: `DrizzleQueryError: Failed query: update contacts set email = $1\nparams: ${EMAIL}\n    at f (/app/x.ts:1:1)\n    at g (/app/y.ts:2:2)`,
      },
    });
    expectNoErrorText();
    expect(reduced(written())).toEqual({ type: 'DrizzleQueryError', frames: ['at f (/app/x.ts:1:1)', 'at g (/app/y.ts:2:2)'] });
  });

  it('an events-style { name, message, stack } under `error` is reduced the same way', () => {
    logger.error({ error: { name: 'NeonDbError', message: `insert failed for ${EMAIL}`, stack: `NeonDbError: insert failed for ${EMAIL}\n    at h (/app/z.ts:3:3)` } }, 'audit.failed');
    expectNoErrorText();
    expect(reduced(written(), 'error')).toEqual({ type: 'NeonDbError', frames: ['at h (/app/z.ts:3:3)'] });
  });

  // Spec 140 s2d (review round 2 follow-up) — a Result error logged whole
  // (`{ err: result.error }`, about 100 sites outside members + broadcasts)
  // keeps its closed `kind` token; free text beside it is still dropped.
  it('a Result error keeps its token-shaped kind, never free text beside it', () => {
    logger.warn({ err: { kind: 'not_found', detail: `no row for ${EMAIL}` } }, 'lookup.failed');
    expectNoErrorText();
    expect(reduced(written())).toEqual({ type: 'unknown', kind: 'not_found' });
  });

  // Review round 3 follow-up — this repo's discriminants are dotted
  // (`resolve.server_error`, `process_webhook.server_error`).
  it('a dotted or colon-joined kind is kept', () => {
    logger.warn({ err: { kind: 'process_webhook.server_error' } }, 'webhook.failed');
    expect(reduced(written())).toEqual({ type: 'unknown', kind: 'process_webhook.server_error' });
  });

  it('a kind that is not token-shaped is dropped', () => {
    logger.warn({ err: { kind: 'free text with spaces' } }, 'lookup.failed');
    expect(reduced(written())).toEqual({ type: 'unknown' });
  });

  it('a Stripe-shaped error keeps errCode, statusCode and declineCode, never its message or raw payload', () => {
    class StripeCardError extends Error {
      readonly code = 'card_declined';
      readonly statusCode = 402;
      readonly decline_code = 'insufficient_funds';
      readonly raw = { message: `Card for ${EMAIL} declined`, billing_details: { email: EMAIL } };
    }
    logger.error({ err: new StripeCardError(`Your card was declined (${EMAIL}).`) });
    expectNoErrorText();
    expect(tokens(reduced(written()))).toEqual({
      type: 'StripeCardError',
      errCode: 'card_declined',
      statusCode: 402,
      declineCode: 'insufficient_funds',
    });
  });

  it('a RepoError a thrown Error wraps at `.error` (UseCaseAbort) keeps its repoCode and the SQLSTATE', () => {
    class UseCaseAbort extends Error {
      constructor(readonly error: unknown) {
        super('aborted');
      }
    }
    logger.error({ err: new UseCaseAbort({ code: 'repo.unexpected', cause: leakyDbError() }) });
    expectNoErrorText();
    expect(tokens(reduced(written()))).toEqual({ type: 'UseCaseAbort', repoCode: 'repo.unexpected', code: '23505' });
  });

  it('frames never carry the message, even a multi-line one with "at" lines; at most 8 frames', () => {
    const message = `boom\n    at ${EMAIL} (Failed query)\n    at second ${EMAIL}`;
    const e = new Error(message);
    const frames = Array.from({ length: 12 }, (_, i) => `    at fn${i} (/app/file${i}.ts:${i}:1)`);
    e.stack = `Error: ${message}\n${frames.join('\n')}`;
    logger.error({ err: e });
    expectNoErrorText();
    const value = reduced(written());
    expect(value.frames).toEqual(frames.slice(0, 8).map((f) => f.trim()));
  });

  it('never writes message, stack, detail, params or query, whatever the shape', () => {
    logger.error({
      err: { message: EMAIL, stack: EMAIL, detail: EMAIL, params: [EMAIL], query: EMAIL, code: 'Bad Code With Spaces' },
      cause: [EMAIL],
    });
    expectNoErrorText();
    const line = written();
    expect(JSON.stringify(line)).not.toMatch(/"message"|"stack"|"detail"|Bad Code/);
    expect(line.cause).toEqual({ type: 'unknown' });
  });
});

describe('the reducer keeps a Result type and only token-shaped values (review round 3)', () => {
  it('a plain object `type` discriminant is written as errType; the output type still means the class', () => {
    logger.warn({ err: { type: 'server_error', message: EMAIL } }, 'op.failed');
    expectNoErrorText();
    expect(reduced(written())).toEqual({ type: 'unknown', errType: 'server_error' });
  });

  it.each([
    ['a uuid', '550e8400-e29b-41d4-a716-446655440000'],
    ['a base64url value', 'dGhpcy1pcy1zZWNyZXQ_eA'],
    ['digits', '0812345678'],
  ])('%s under code / kind / name / declineCode / type is not written', (_label, value) => {
    logger.warn({ err: { code: value, kind: value, name: value, declineCode: value, type: value } }, 'op.failed');
    logger.warn({ err: Object.assign(new Error('x'), { code: value, kind: value, declineCode: value }) }, 'op.failed');
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toContain(value);
  });

  it('a plain object name becomes type only when it is an error class name', () => {
    logger.warn({ err: { name: 'lowercase_name' }, error: { name: 'NeonDbError' }, cause: { name: 'Bob' } }, 'op.failed');
    const line = written();
    expect(reduced(line)).toEqual({ type: 'unknown' });
    expect(reduced(line, 'error')).toEqual({ type: 'NeonDbError' });
    expect(reduced(line, 'cause')).toEqual({ type: 'unknown' });
  });

  it('errCode is written only for an Error instance, never for a plain object', () => {
    logger.warn({ err: { code: 'ECONNRESET' }, error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }, 'op.failed');
    const line = written();
    expect(reduced(line).errCode).toBeUndefined();
    expect(tokens(reduced(line, 'error'))).toEqual({ type: 'Error', errCode: 'ECONNRESET' });
  });

  it('a throwing stack getter yields { type: "unreducible" } and the log call does not throw', () => {
    const e = new Error('x');
    Object.defineProperty(e, 'stack', {
      get() {
        throw new Error(EMAIL);
      },
    });
    expect(() => logger.error({ err: e }, 'op.failed')).not.toThrow();
    expectNoErrorText();
    expect(reduced(written())).toEqual({ type: 'unreducible' });
  });

  it('the reduced value is frozen', () => {
    expect(Object.isFrozen(reduceLoggedError(new Error('x')))).toBe(true);
    expect(Object.isFrozen(reduceLoggedError({ kind: 'timeout' }))).toBe(true);
  });
});

describe('frames are cut by structure, not by message text (review round 3)', () => {
  it('a one-letter message keeps its frames intact', () => {
    const e = new Error('a');
    const original = (e.stack ?? '').split(/\r?\n/).map((l) => l.trim());
    logger.error({ err: e });
    const frames = (reduced(written()).frames ?? []) as string[];
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(original).toContain(f);
  });

  it('a stack read before the message was mutated yields no message line', () => {
    const e = new Error(`boom\n    at ${EMAIL}`);
    void e.stack;
    e.message = 'other';
    logger.error({ err: e });
    expectNoErrorText();
    for (const f of reduced(written()).frames as string[]) expect(f).toMatch(/:\d+:\d+\)?$/);
  });
});

describe('SQLSTATE must hold a digit; Node codes stay visible (review round 3)', () => {
  it('an Error with code EPIPE writes no code and writes errCode', () => {
    logger.error({ err: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
    expect(tokens(reduced(written()))).toEqual({ type: 'Error', errCode: 'EPIPE' });
  });
});

describe('one shared token shape (review round 4, row 1)', () => {
  // A real sha256, letter first: it is the digit cap (at most 4) that refuses
  // it. An all-letter hex value cannot be told from a word, and is kept.
  const HEX = 'd1a5ac9a015fac2ef7b341673635512a1511f41fe37d111b267f039eec5d4f58';

  it.each([
    ['a 64-character lowercase hex value', HEX],
    ['a word then nine digits', 'a_123456789'],
  ])('%s under kind is not written', (_label, value) => {
    logger.warn({ err: { kind: value } }, 'op.failed');
    expect(reduced(written())).toEqual({ type: 'unknown' });
    expect(lines.join('')).not.toContain(value);
  });

  it('a hyphenated kind is kept, and a dotted one still is', () => {
    logger.warn({ err: { kind: 'last-admin-protection' }, error: { kind: 'resolve.server_error' } }, 'op.failed');
    const line = written();
    expect(reduced(line)).toEqual({ type: 'unknown', kind: 'last-admin-protection' });
    expect(reduced(line, 'error')).toEqual({ type: 'unknown', kind: 'resolve.server_error' });
  });

  it('a digit-led word inside a kind is kept (gateway_5xx)', () => {
    logger.warn({ err: { kind: 'gateway_5xx' } }, 'op.failed');
    expect(reduced(written())).toEqual({ type: 'unknown', kind: 'gateway_5xx' });
  });
});

describe('a bare Error name, capped (review round 4, row 2)', () => {
  it('{ name: "Error" } gives type "Error"', () => {
    logger.warn({ err: { name: 'Error' } }, 'op.failed');
    expect(reduced(written())).toEqual({ type: 'Error' });
  });

  it('a 10 KB name ending in Error gives "unknown"', () => {
    logger.warn({ err: { name: `${'A'.repeat(10_240)}Error` } }, 'op.failed');
    expect(reduced(written())).toEqual({ type: 'unknown' });
  });
});

describe('errCode from the cause chain (review round 4, row 3)', () => {
  it('a DrizzleQueryError over ECONNRESET gives errCode ECONNRESET', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    logger.error({ err: new DrizzleQueryError('select 1', [], reset) });
    expect(tokens(reduced(written()))).toEqual({ type: 'DrizzleQueryError', errCode: 'ECONNRESET' });
  });
});

describe('a frame must look like a frame (review round 4, row 4)', () => {
  // Shapes measured on Node 22 (named, anonymous, async, getter, constructor,
  // private method, `[as …]` alias, Windows CJS, ESM file URL, node:internal),
  // plus webpack-internal and an eval-less `<anonymous>` location.
  const REAL = [
    '    at named (file:///C:/Users/a/app/frames.mjs:2:27)',
    '    at file:///C:/Users/a/app/frames.mjs:3:10',
    '    at async file:///C:/Users/a/app/frames.mjs:6:7',
    '    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)',
    '    at get g (file:///C:/Users/a/app/frames.mjs:10:72)',
    '    at new F (C:\\Users\\a\\app\\c.cjs:2:24)',
    '    at #p (C:\\Users\\a\\app\\c.cjs:1:24)',
    '    at Object.<anonymous> (C:\\Users\\a\\app\\c.cjs:3:21)',
    '    at Function.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:171:5)',
    '    at node:internal/main/run_main_module:36:49',
    '    at handler (webpack-internal:///(rsc)/./src/app/api/x/route.ts:12:3)',
    '    at /var/task/.next/server/chunks/123.js:1:2048',
    '    at <anonymous>:1:7',
  ];

  it('real V8 frame shapes are kept', () => {
    const e = new Error('x');
    e.stack = `Error: x\n${REAL.join('\n')}`;
    logger.error({ err: e });
    // At most 8 frames: check them in two passes.
    expect(reduced(written()).frames).toEqual(REAL.slice(0, 8).map((f) => f.trim()));
    lines = [];
    e.stack = `Error: x\n${REAL.slice(8).join('\n')}`;
    logger.error({ err: e });
    expect(reduced(written()).frames).toEqual(REAL.slice(8).map((f) => f.trim()));
  });

  it('a message line "at <email> <phone>:1:2" is not kept', () => {
    const e = new Error('x');
    e.stack = 'Error: x\n    at somchai@example.com 0812345678:1:2\n    at f (/app/x.ts:1:1)';
    logger.error({ err: e });
    expect(lines.join('')).not.toMatch(/somchai|0812345678/);
    expect(reduced(written()).frames).toEqual(['at f (/app/x.ts:1:1)']);
  });
});
