/**
 * Round 3 review G7 — unit coverage for `src/lib/db-errors.ts`.
 *
 * The Drizzle 0.45 upgrade wraps Postgres errors with a `Failed query:`
 * message and stashes the original on `.cause`. All three helpers
 * (`isLastAdminTriggerError`, `isUniqueViolation`, `errorChainMessage`)
 * walk the cause chain. Lock that contract here so a future Drizzle
 * upgrade (or refactor that drops the chain walk) is caught at unit
 * level.
 */
import { describe, expect, it } from 'vitest';
import {
  errorChainMessage,
  isLastAdminTriggerError,
  isUniqueViolation,
} from '@/lib/db-errors';

function pgError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

function withCause(top: Error, cause: unknown): Error {
  (top as Error & { cause?: unknown }).cause = cause;
  return top;
}

describe('isLastAdminTriggerError', () => {
  it('returns true for direct check_violation with last-admin-protection message', () => {
    expect(
      isLastAdminTriggerError(
        pgError('23514', 'last-admin-protection: cannot demote sole admin'),
      ),
    ).toBe(true);
  });

  it('returns true when buried under a Drizzle wrapper Error.cause', () => {
    const wrapped = withCause(
      new Error('Failed query: UPDATE users SET role = $1'),
      pgError('23514', 'last-admin-protection: cannot disable sole admin'),
    );
    expect(isLastAdminTriggerError(wrapped)).toBe(true);
  });

  it('returns true even with two-deep .cause chain', () => {
    const inner = pgError('23514', 'last-admin-protection violation');
    const mid = withCause(new Error('drizzle inner'), inner);
    const outer = withCause(new Error('drizzle outer'), mid);
    expect(isLastAdminTriggerError(outer)).toBe(true);
  });

  it('returns false for unrelated check_violation', () => {
    expect(
      isLastAdminTriggerError(pgError('23514', 'positive_amount_check failed')),
    ).toBe(false);
  });

  it('returns false for a different SQLSTATE', () => {
    expect(
      isLastAdminTriggerError(pgError('23505', 'last-admin-protection')),
    ).toBe(false);
  });

  it('returns false for null / undefined / plain string', () => {
    expect(isLastAdminTriggerError(null)).toBe(false);
    expect(isLastAdminTriggerError(undefined)).toBe(false);
    expect(isLastAdminTriggerError('boom')).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('returns true for direct SQLSTATE 23505', () => {
    expect(
      isUniqueViolation(pgError('23505', 'duplicate key value violates unique constraint')),
    ).toBe(true);
  });

  it('returns true when buried under .cause', () => {
    const wrapped = withCause(
      new Error('Failed query: INSERT INTO members ...'),
      pgError('23505', 'members_email_lower_uniq'),
    );
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('returns false for non-unique constraint codes', () => {
    expect(isUniqueViolation(pgError('23514', 'check failed'))).toBe(false);
    expect(isUniqueViolation(pgError('23503', 'fk violated'))).toBe(false);
  });

  it('returns false for null / undefined / non-error values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
  });
});

describe('errorChainMessage', () => {
  it('joins messages across the .cause chain with " | " separator', () => {
    const inner = new Error('inner');
    const mid = withCause(new Error('mid'), inner);
    const outer = withCause(new Error('outer'), mid);
    expect(errorChainMessage(outer)).toBe('outer | mid | inner');
  });

  it('returns single message when no .cause chain', () => {
    expect(errorChainMessage(new Error('alone'))).toBe('alone');
  });

  it('falls back to String(value) when value is not an Error', () => {
    expect(errorChainMessage('plain string')).toBe('plain string');
    expect(errorChainMessage({ code: 'not-error' })).toContain('object');
  });

  it('returns empty string for null / undefined', () => {
    expect(errorChainMessage(null)).toBe('');
    expect(errorChainMessage(undefined)).toBe('');
  });
});
