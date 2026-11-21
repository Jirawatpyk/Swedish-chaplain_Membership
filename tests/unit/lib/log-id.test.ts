/**
 * hashId() unit test (observability.md § 3 — log-correlation stability).
 *
 * The contract this test pins:
 *   1. Deterministic: same input always produces the same output.
 *      This is the ONLY reason this helper exists — log aggregators
 *      use it to join lines for the same user across deployments.
 *   2. Short hex output, no prefix.
 *   3. Non-crashing on edge inputs (empty string, unicode).
 *   4. Distinct outputs for distinct inputs in the normal case.
 *
 * If a refactor changes the djb2 algorithm (e.g., `33` → `31` or
 * signed vs unsigned coercion), the first assertion will fail with
 * a pinned hex value, preventing a silent log-correlation break.
 */
import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { errClassWithCode, errKind, errLogFields, hashId } from '@/lib/log-id';
import { UseCaseAbort } from '@/modules/members/application/tx-abort';

describe('hashId() — djb2 log-correlation hash', () => {
  it('produces a stable, pinned output for a known input', () => {
    // If this value changes, log correlation across deployments
    // breaks silently. Update ONLY if the algorithm is deliberately
    // rotated (and plan a deploy-coordinated flush of log filters).
    expect(hashId('abc')).toBe('b873285');
  });

  it('is deterministic across calls', () => {
    const a = hashId('user-00000000-0000-0000-0000-000000000001');
    const b = hashId('user-00000000-0000-0000-0000-000000000001');
    expect(a).toBe(b);
  });

  it('returns lowercase hex digits only', () => {
    const result = hashId('some-user-id');
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('does not throw on empty string', () => {
    expect(() => hashId('')).not.toThrow();
    // djb2 seed is 5381 → hex "1505"
    expect(hashId('')).toBe('1505');
  });

  it('produces distinct outputs for distinct inputs', () => {
    const a = hashId('alice@swecham.test');
    const b = hashId('bob@swecham.test');
    expect(a).not.toBe(b);
  });

  it('handles unicode (Thai email) without throwing', () => {
    expect(() => hashId('สมาชิก@swecham.test')).not.toThrow();
    const result = hashId('สมาชิก@swecham.test');
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('output length is always ≤ 8 chars (unsigned 32-bit hex)', () => {
    // `>>> 0` caps the integer at 32 bits unsigned → max 0xFFFFFFFF
    // → 8 hex chars. Shorter outputs are padding-free (no leading 0).
    const samples = [
      '',
      'a',
      'some-user',
      '00000000-0000-0000-0000-000000000001',
      'very-long-user-identifier-with-many-characters-to-stress-test',
    ];
    for (const s of samples) {
      expect(hashId(s).length).toBeLessThanOrEqual(8);
    }
  });
});

/**
 * Spec 140 s2d review round 1 (code-review #8) — a thrown Error that wraps a
 * RepoError. The plan row named only `cause`; `UseCaseAbort` keeps its
 * RepoError at `.error`, so both are read (`cause` first).
 */
describe('errLogFields() — a thrown Error wrapping a RepoError', () => {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "c"'), { code: '23505' });
  const repoError = { code: 'repo.unexpected', cause: new DrizzleQueryError('insert into t values ($1)', ['a@x.io'], pg) };

  it('a UseCaseAbort carrying a RepoError logs its repoCode and SQLSTATE', () => {
    expect(errLogFields(new UseCaseAbort(repoError))).toEqual({
      err: 'UseCaseAbort',
      repoCode: 'repo.unexpected',
      code: '23505',
    });
  });

  it('an Error whose cause is a RepoError logs its repoCode and SQLSTATE', () => {
    expect(errLogFields(new Error('lookup_failed', { cause: repoError }))).toEqual({
      err: 'Error',
      repoCode: 'repo.unexpected',
      code: '23505',
    });
  });

  it('a wrapped code that is not a closed token is "unrecognised"; a plain Error adds no repoCode', () => {
    expect(errLogFields(new UseCaseAbort({ code: 'Key (email)=(a@x.io)' }))).toEqual({
      err: 'UseCaseAbort',
      repoCode: 'unrecognised',
    });
    expect(errLogFields(new Error('boom'))).toEqual({ err: 'Error' });
    expect(errLogFields(pg)).toEqual({ err: 'Error', code: '23505' });
    // A driver error is `{ code }`-shaped too, but an Error: it is the SQLSTATE, never a repoCode.
    expect(errLogFields(repoError.cause)).toEqual({ err: 'DrizzleQueryError', code: '23505' });
  });
});

/**
 * Spec 140 s2d review round 3 (code-review #2, #3) — a Node `.code` on a
 * thrown Error is a token but not a SQLSTATE: it is returned as `errCode`, so
 * the explicit `...errLogFields(e)` sites keep `ECONNRESET` / `EPIPE`.
 */
describe('errLogFields() — a Node code is errCode, never a SQLSTATE (review round 3)', () => {
  it('EPIPE gives no code and gives errCode', () => {
    expect(errLogFields(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toEqual({ err: 'Error', errCode: 'EPIPE' });
  });

  it('ECONNRESET reaches errLogFields', () => {
    expect(errLogFields(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toEqual({
      err: 'Error',
      errCode: 'ECONNRESET',
    });
  });

  it('a code that is not token-shaped (a uuid) is not errCode; a Result code that is a uuid is "unrecognised"', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(errLogFields(Object.assign(new Error('x'), { code: uuid }))).toEqual({ err: 'Error' });
    expect(errLogFields({ code: uuid })).toEqual({ err: 'unknown', repoCode: 'unrecognised' });
  });
});

/**
 * Spec 140 s2d review round 4 (reliability LOW-2) — the first token-shaped,
 * non-SQLSTATE own `.code` along the bounded cause walk is `errCode`, so a
 * Drizzle wrapper over a socket reset still says which reset it was.
 */
describe('errLogFields() — errCode from the cause chain (review round 4)', () => {
  it('a DrizzleQueryError over ECONNRESET gives errCode ECONNRESET', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(errLogFields(new DrizzleQueryError('select 1', [], reset))).toEqual({
      err: 'DrizzleQueryError',
      errCode: 'ECONNRESET',
    });
  });
});

describe('errLogFields() — a Result error keyed on kind or type (#740 B1 review)', () => {
  it('a { kind, message } error gives its kind as resultKind, never the message', () => {
    const fields = errLogFields({ kind: 'server_error', message: 'insert failed for a@x.io' });
    expect(fields).toEqual({ err: 'unknown', resultKind: 'server_error' });
    expect(JSON.stringify(fields)).not.toContain('a@x.io');
  });

  it('a { type, issues } error gives its type as resultKind', () => {
    expect(errLogFields({ type: 'invalid_payload', issues: [{ message: 'x' }] })).toEqual({
      err: 'unknown',
      resultKind: 'invalid_payload',
    });
  });

  it('#740 B2 review: a code-built `<op>: <code>` message is kept as step', () => {
    expect(errLogFields({ type: 'server_error', message: 'count-pending: repo.unexpected' })).toEqual({
      err: 'unknown',
      resultKind: 'server_error',
      step: 'count-pending: repo.unexpected',
    });
    expect(errLogFields({ kind: 'server_error', message: 'Failed query: select 1 -- a@x.io' })).toEqual({
      err: 'unknown',
      resultKind: 'server_error',
    });
  });

  it('#739 B3b: a message that is the error class is err; `<step>: <Class>` is step and err', () => {
    expect(errLogFields({ kind: 'server_error', message: 'NeonDbError' })).toEqual({
      err: 'NeonDbError',
      resultKind: 'server_error',
    });
    expect(errLogFields({ type: 'server_error', message: 'plan_lookup: TypeError' })).toEqual({
      err: 'TypeError',
      resultKind: 'server_error',
      step: 'plan_lookup',
    });
  });

  it('#739 B3b: text that is not a bare class never becomes err', () => {
    for (const message of [
      'Duplicate key',
      'error',
      'TypeError: boom',
      `${'A'.repeat(65)}`,
      'Error@a.io',
      'plan_lookup: Failed for a@x.io',
    ]) {
      const fields = errLogFields({ kind: 'server_error', message });
      expect(fields.err).toBe('unknown');
      expect(JSON.stringify(fields)).not.toContain('a.io');
    }
  });

  it('#739 B3b review: a { code } Result with no cause reads its `<step>: <Class>` message too', () => {
    expect(errLogFields({ code: 'plan_lookup.server_error', message: 'plan_lookup: NeonDbError' })).toEqual({
      err: 'NeonDbError',
      repoCode: 'plan_lookup.server_error',
      step: 'plan_lookup',
    });
    expect(errLogFields({ code: 'repo.unexpected', message: 'Failed for a@x.io' })).toEqual({
      err: 'unknown',
      repoCode: 'repo.unexpected',
    });
    // memberSelfUpdate's repo-abort step is a token, so it is logged.
    expect(errLogFields({ type: 'server_error', message: 'self_update: repo.unexpected' }).step).toBe(
      'self_update: repo.unexpected',
    );
  });

  it('a kind that is not token-shaped is unrecognised', () => {
    expect(errLogFields({ kind: 'Failed for a@x.io' })).toEqual({ err: 'unknown', resultKind: 'unrecognised' });
  });

  it('a { code } error keeps repoCode and adds no resultKind', () => {
    expect(errLogFields({ code: 'repo.unexpected', kind: 'server_error' })).toEqual({
      err: 'unknown',
      repoCode: 'repo.unexpected',
    });
  });
});

describe('errKind() — a DOMException gives its name (#739 B3b)', () => {
  it('AbortError and TimeoutError are told apart; a free-form name stays DOMException', () => {
    expect(errKind(new DOMException('stop', 'AbortError'))).toBe('AbortError');
    expect(errKind(new DOMException('late', 'TimeoutError'))).toBe('TimeoutError');
    expect(errKind(new DOMException('x', 'not a name a@b.io'))).toBe('DOMException');
    expect(errKind(new TypeError('a@b.io'))).toBe('TypeError');
  });
});

describe('errClassWithCode() — the class and the SQLSTATE, never the text (#739 follow-up, PR 2)', () => {
  class PostgresError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  it('a Postgres error gives `<Class>:<SQLSTATE>`, and its message never appears', () => {
    const e = new PostgresError('duplicate key value: (email)=(a@b.example)', '23505');
    expect(errClassWithCode(e)).toBe('PostgresError:23505');
  });

  it('a Postgres error under a wrapping Error is found through the cause chain', () => {
    const wrapped = new Error('Failed query: insert … params: a@b.example', {
      cause: new PostgresError('deadlock detected', '40P01'),
    });
    expect(errClassWithCode(wrapped)).toBe('Error:40P01');
  });

  it('an error with no SQLSTATE gives the class alone', () => {
    expect(errClassWithCode(new TypeError('x a@b.example'))).toBe('TypeError');
    expect(errClassWithCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('Error');
    expect(errClassWithCode('a string')).toBe('unknown');
  });

  it('review round 1 — a class name that is not token-shaped is written as unknown', () => {
    const e = Object.assign(new Error('x'), { code: '23505' });
    Object.defineProperty(e, 'constructor', { value: { name: 'a@b.example' } });
    expect(errClassWithCode(e)).toBe('unknown:23505');
    // code-review round 1 — and the SQLSTATE still reaches the log line.
    expect(errLogFields({ kind: 'server_error', message: 'unknown:23505' })).toEqual({
      err: 'unknown',
      resultKind: 'server_error',
      code: '23505',
    });
  });

  it('errLogFields reads `<Class>:<SQLSTATE>` and `<step>: <Class>:<SQLSTATE>` as err, step and code', () => {
    expect(errLogFields({ kind: 'server_error', message: 'NeonDbError:40001' })).toEqual({
      err: 'NeonDbError',
      resultKind: 'server_error',
      code: '40001',
    });
    expect(errLogFields({ code: 'plan_lookup.server_error', message: 'plan_lookup: PostgresError:23505' })).toEqual({
      err: 'PostgresError',
      repoCode: 'plan_lookup.server_error',
      step: 'plan_lookup',
      code: '23505',
    });
  });

  it('a suffix that is not a SQLSTATE, or text around it, is never read', () => {
    for (const message of ['Error:2350', 'Error:abcde', 'a@b:23505', 'Error:23505 a@b.example', 'Error: 23505']) {
      const fields = errLogFields({ kind: 'server_error', message });
      expect(fields).toEqual({ err: 'unknown', resultKind: 'server_error' });
    }
  });
});
