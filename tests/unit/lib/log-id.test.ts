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
import { errLogFields, hashId } from '@/lib/log-id';
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
