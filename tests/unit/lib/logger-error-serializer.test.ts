/**
 * Spec 140 s2d review round 1 (code-review #2) — the production logger reduces
 * an error at the root. drizzle-orm's `DrizzleQueryError` has enumerable
 * `query` and `params`, and its message quotes them; pino copies the message
 * of an `err` into `msg` when no message is given. Whatever a call site
 * passes under `err` / `error` / `cause`, the written line carries only the
 * error's class and SQLSTATE.
 *
 * Captures the REAL `logger`'s output by spying on its destination stream, so
 * the test reads the production options (redaction, PAN formatter, the error
 * reduction), not a copy of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { DrizzleQueryError } from 'drizzle-orm';
import { logger } from '@/lib/logger';

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

describe('the logger reduces an error at the root', () => {
  it('logger.error({ err: drizzleQueryError }) writes no params, no query and no message', () => {
    logger.error({ err: leakyDbError() });
    expectNoErrorText();
    expect(written().err).toEqual({ type: 'DrizzleQueryError', code: '23505' });
  });

  it('reduces `error` and `cause` the same way, beside a message', () => {
    logger.error({ error: leakyDbError(), cause: leakyDbError() }, 'op.failed');
    expectNoErrorText();
    const line = written();
    expect(line.error).toEqual({ type: 'DrizzleQueryError', code: '23505' });
    expect(line.cause).toEqual({ type: 'DrizzleQueryError', code: '23505' });
    expect(line.msg).toBe('op.failed');
  });

  it('reduces a plain object carrying a cause (a RepoError) and a bare Error argument', () => {
    logger.error({ err: { code: 'repo.unexpected', cause: leakyDbError() } }, 'repo.failed');
    logger.error(leakyDbError());
    expectNoErrorText();
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as { err: unknown }).err).toEqual({ type: 'unknown', code: '23505' });
    expect((JSON.parse(lines[1]!) as { err: unknown }).err).toEqual({ type: 'DrizzleQueryError', code: '23505' });
  });

  it('keeps a string value, a token object, and the key-based redaction', () => {
    logger.error({ err: 'DrizzleQueryError', error: { kind: 'timeout' }, password: 'hunter2' }, 'op.failed');
    const line = written();
    expect(line.err).toBe('DrizzleQueryError');
    expect(line.error).toEqual({ kind: 'timeout' });
    expect(line.password).toBe('[REDACTED]');
  });

  it('reduces an error bound on a child logger', () => {
    logger.child({ err: leakyDbError() }).error('child.failed');
    expectNoErrorText();
    expect(written().err).toEqual({ type: 'DrizzleQueryError', code: '23505' });
  });
});
