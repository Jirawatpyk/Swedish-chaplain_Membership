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
  describeStorageError,
  errorChainMessage,
  isExclusionViolation,
  isExclusionViolationOnConstraint,
  isLastAdminTriggerError,
  isUniqueViolation,
  isUniqueViolationOnConstraint,
  pgErrorCode,
  pgErrorMeta,
  primaryContactTriggerViolation,
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

describe('primaryContactTriggerViolation (108 round 4, F4-#9 / F4-#10)', () => {
  const MEMBER = '30e0cf36-7fe7-45c0-b01e-b839d835ddef';
  const RAISE = `primary-contact-invariant: member ${MEMBER} in tenant test-swecham-af8fb8f9 has 0 live primary contact(s)`;

  it('parses member, tenant and count from the real raise — one decoder for every caller', () => {
    expect(primaryContactTriggerViolation(pgError('23514', RAISE))).toEqual({
      livePrimaries: 0,
      memberId: MEMBER,
      tenantSlug: 'test-swecham-af8fb8f9',
    });
  });

  it('reads a count of 2 (the lost-race side)', () => {
    const v = primaryContactTriggerViolation(pgError('23514', RAISE.replace('has 0', 'has 2')));
    expect(v?.livePrimaries).toBe(2);
    expect(v?.memberId).toBe(MEMBER);
  });

  it('walks the .cause chain the Drizzle wrapper adds', () => {
    const wrapped = withCause(new Error('Failed query: commit'), pgError('23514', RAISE));
    expect(primaryContactTriggerViolation(wrapped)?.memberId).toBe(MEMBER);
  });

  it('an unparseable message lands on the actionable side (0 → "needs a primary"), never on "retry"', () => {
    expect(
      primaryContactTriggerViolation(pgError('23514', 'primary-contact-invariant: reworded raise')),
    ).toEqual({ livePrimaries: 0, memberId: null, tenantSlug: null });
  });

  it('returns null for an unrelated check_violation and for a different SQLSTATE', () => {
    expect(
      primaryContactTriggerViolation(pgError('23514', 'last-admin-protection: cannot demote')),
    ).toBeNull();
    expect(primaryContactTriggerViolation(pgError('23505', RAISE))).toBeNull();
    expect(primaryContactTriggerViolation(null)).toBeNull();
  });
});

describe('pgErrorCode', () => {
  it('returns the SQLSTATE from anywhere in the cause chain (Drizzle wraps the Postgres error)', () => {
    const wrapped = withCause(new Error('Failed query: DELETE … params: a,b'), pgError('55P03', 'lock timeout'));
    expect(pgErrorCode(wrapped)).toBe('55P03');
    expect(pgErrorCode(pgError('23505', 'dup'))).toBe('23505');
  });

  it('returns undefined when no link carries a code', () => {
    expect(pgErrorCode(new Error('plain'))).toBeUndefined();
    expect(pgErrorCode('boom')).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
  });
});

describe('pgErrorMeta (spec 140 s2d, #736c)', () => {
  // A PostgresError as postgres-js builds it: the names are metadata, while
  // `detail` / `where` / `hint` / `message` can quote the row's values.
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "contacts_email_uniq"'), {
    code: '23505',
    constraint_name: 'contacts_email_uniq',
    table_name: 'contacts',
    column_name: 'email',
    detail: 'Key (email)=(ann@example.com) already exists.',
    where: 'SQL statement "insert into contacts values (ann@example.com)"',
    hint: 'ann@example.com',
  });

  it('reads only the constraint, table and column names, through a Drizzle wrapper', () => {
    const wrapped = withCause(new Error('Failed query: insert into contacts (email) values ($1) params: ann@example.com'), pg);
    const meta = pgErrorMeta(wrapped);
    expect(meta).toEqual({ constraint: 'contacts_email_uniq', table: 'contacts', column: 'email' });
    expect(JSON.stringify(meta)).not.toMatch(/ann@example\.com|Key \(|insert into|duplicate key/);
  });

  it('omits a name the driver did not set, and keeps a non-string name out', () => {
    const partial = Object.assign(new Error('x'), { code: '23503', constraint_name: 'fk_x', table_name: 42 });
    expect(pgErrorMeta(partial)).toEqual({ constraint: 'fk_x' });
  });

  it('is undefined when no PostgresError is in the chain', () => {
    expect(pgErrorMeta(new Error('plain'))).toBeUndefined();
    expect(pgErrorMeta('boom')).toBeUndefined();
    expect(pgErrorMeta(null)).toBeUndefined();
    expect(pgErrorMeta(Object.assign(new Error('x'), { code: '23505' }))).toEqual({});
  });
});

/**
 * Spec 140 s2d review round 2 (code-review #3, security L2) — the cause walk
 * is bounded, and only a SQLSTATE-shaped code counts. An unbounded walk over
 * a cyclic `.cause` is a synchronous loop: the log call that reaches it never
 * returns. A Stripe or Node `.code` (`card_declined`, `ECONNRESET`) is not a
 * SQLSTATE, and the walk goes on past it to the Postgres error beneath.
 */
describe('pgErrorCode / pgErrorMeta — bounded walk, SQLSTATE-shaped codes only (review round 2)', () => {
  function cyclic(): Error {
    const a = new Error('a');
    const b = new Error('b');
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;
    return a;
  }

  it('a cyclic cause returns instead of looping', () => {
    expect(pgErrorCode(cyclic())).toBeUndefined();
    expect(pgErrorMeta(cyclic())).toBeUndefined();
  }, 5_000);

  it('stops after 10 hops: a SQLSTATE 11 hops down is not read, one 10 hops down is', () => {
    let eleven: unknown = pgError('40P01', 'deadlock detected');
    for (let i = 0; i < 11; i += 1) eleven = withCause(new Error(`wrap ${i}`), eleven);
    expect(pgErrorCode(eleven)).toBeUndefined();
    let ten: unknown = pgError('40P01', 'deadlock detected');
    for (let i = 0; i < 10; i += 1) ten = withCause(new Error(`wrap ${i}`), ten);
    expect(pgErrorCode(ten)).toBe('40P01');
  });

  it('skips a code that is not a SQLSTATE and reads the Postgres error beneath it', () => {
    const stripe = withCause(Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }), pgError('57P01', 'terminating'));
    expect(pgErrorCode(stripe)).toBe('57P01');
    expect(pgErrorCode(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBeUndefined();
    expect(pgErrorCode(pgError('repo.unexpected', 'x'))).toBeUndefined();
    expect(pgErrorMeta(Object.assign(new Error('x'), { code: 'card_declined', constraint_name: 'nope' }))).toBeUndefined();
  });
});

describe('pgErrorCode — a SQLSTATE holds a digit (review round 3)', () => {
  it('EPIPE and EPERM are not read as a SQLSTATE; 23505 and P0001 are', () => {
    expect(pgErrorCode(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBeUndefined();
    expect(pgErrorCode(pgError('EPERM', 'operation not permitted'))).toBeUndefined();
    expect(pgErrorCode(pgError('23505', 'duplicate key'))).toBe('23505');
    expect(pgErrorCode(pgError('P0001', 'raise'))).toBe('P0001');
  });
});

/**
 * Spec 140 s2d review round 3 (code-review #8) — every cause walk in
 * `db-errors.ts` is bounded by one shared walker. A cyclic `.cause` is a
 * synchronous loop that no vitest timeout can interrupt, so the chain counts
 * its own reads and throws past 1,000: an unbounded walker fails with
 * "unbounded cause walk" instead of hanging the worker.
 */
describe('every cause walk is bounded (review round 3)', () => {
  function cyclic(): Error {
    let reads = 0;
    const a = Object.assign(new Error('a'), { code: '00000' });
    const b = Object.assign(new Error('b'), { code: '00000' });
    for (const [from, to] of [[a, b], [b, a]] as const) {
      Object.defineProperty(from, 'cause', {
        get() {
          reads += 1;
          if (reads > 1_000) throw new Error('unbounded cause walk');
          return to;
        },
      });
    }
    return a;
  }

  it.each([
    ['isLastAdminTriggerError', () => isLastAdminTriggerError(cyclic())],
    ['primaryContactTriggerViolation', () => primaryContactTriggerViolation(cyclic())],
    ['errorChainMessage', () => errorChainMessage(cyclic())],
    ['pgErrorCode', () => pgErrorCode(cyclic())],
    ['pgErrorMeta', () => pgErrorMeta(cyclic())],
    ['isUniqueViolation', () => isUniqueViolation(cyclic())],
    ['isUniqueViolationOnConstraint', () => isUniqueViolationOnConstraint(cyclic(), 'c')],
    ['isExclusionViolation', () => isExclusionViolation(cyclic())],
    ['isExclusionViolationOnConstraint', () => isExclusionViolationOnConstraint(cyclic(), 'c')],
    ['describeStorageError', () => describeStorageError(cyclic())],
  ])('%s returns on a cyclic cause', (_name, walk) => {
    expect(walk).not.toThrow();
  }, 5_000);

  it('errorChainMessage keeps at most 11 links (the 10-hop bound) and still joins them', () => {
    expect(errorChainMessage(cyclic()).split(' | ')).toHaveLength(11);
  });
});
