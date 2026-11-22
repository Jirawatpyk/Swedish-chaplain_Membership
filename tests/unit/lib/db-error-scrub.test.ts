// @vitest-environment node
/**
 * #804 — a DB error that leaves our DB layer carries no SQL, no bound
 * parameters and no row values, while every field a reader outside the
 * transaction decides on (class, SQLSTATE, constraint / table / column
 * names, Postgres's names-only message, our trigger tokens) survives.
 */
import { inspect } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logger';
import { scrubDbError } from '@/lib/db-error-scrub';
import {
  isExclusionViolationOnConstraint,
  isLastAdminTriggerError,
  isUniqueViolationOnConstraint,
  pgErrorCode,
  pgErrorMeta,
  primaryContactTriggerViolation,
} from '@/lib/db-errors';
import { errClassWithCode, errLogFields } from '@/lib/log-id';

const EMAIL = 'somchai.k@example.co.th';
const NAME = 'Somchai Kittisak';
const SQL_TEXT = 'insert into "members" ("email", "name") values ($1, $2)';
const PII = [EMAIL, NAME, 'insert into', 'Key (', 'values ($1'];

/** A postgres-js server error exactly as `connection.js` builds one: the
 *  server fields by `Object.assign`, then `stack` / `query` / `parameters` /
 *  `args` / `types` by `Object.defineProperties` (non-writable,
 *  non-configurable). */
function driverError(fields: Record<string, unknown>): Error {
  const e = new postgres.PostgresError({
    severity_local: 'ERROR',
    severity: 'ERROR',
    detail: `Key (email)=(${EMAIL}) already exists.`,
    hint: `try ${NAME}`,
    where: `SQL statement "${SQL_TEXT}"`,
    internal_query: SQL_TEXT,
    position: '12',
    file: 'nbtinsert.c',
    line: '666',
    routine: '_bt_check_unique',
    ...fields,
  } as never);
  Object.defineProperties(e, {
    stack: { value: `${e.stack}\n    at Query.handle (node_modules/postgres/src/query.js:140:65)`, enumerable: false },
    query: { value: SQL_TEXT, enumerable: false },
    parameters: { value: [EMAIL, NAME], enumerable: false },
    args: { value: [EMAIL, NAME], enumerable: false },
    types: { value: [25, 25], enumerable: false },
  });
  return e;
}

function uniqueViolation(): Error {
  return driverError({
    code: '23505',
    message: 'duplicate key value violates unique constraint "members_email_uniq"',
    schema_name: 'public',
    table_name: 'members',
    column_name: 'email',
    constraint_name: 'members_email_uniq',
  });
}

function drizzleError(cause: unknown): DrizzleQueryError {
  return new DrizzleQueryError(SQL_TEXT, [EMAIL, NAME], cause as Error);
}

function printed(e: unknown): string {
  return `${inspect(e, { depth: 10 })}\n${(e as Error).stack ?? ''}\n${JSON.stringify(e)}`;
}

function expectNoPii(e: unknown): void {
  const text = printed(e);
  for (const needle of PII) expect(text).not.toContain(needle);
}

describe('scrubDbError — what leaves carries no SQL, parameters or values (#804)', () => {
  it('a DrizzleQueryError over a unique violation: no SQL, no params, no detail; class, code and names kept', () => {
    const raw = drizzleError(uniqueViolation());
    expect(printed(raw)).toContain(EMAIL); // control: the leak is real

    const out = scrubDbError(raw);

    expect(out).toBe(raw); // the drizzle error is scrubbed in place
    expect(out).toBeInstanceOf(DrizzleQueryError);
    expectNoPii(out);
    const cause = (out as { cause: unknown }).cause;
    expect(cause).toBeInstanceOf(postgres.PostgresError);
    expect(cause).toMatchObject({
      code: '23505',
      constraint_name: 'members_email_uniq',
      table_name: 'members',
      column_name: 'email',
      schema_name: 'public',
      severity: 'ERROR',
      message: 'duplicate key value violates unique constraint "members_email_uniq"',
    });
  });

  it('every reader outside the transaction still answers', () => {
    const out = scrubDbError(drizzleError(uniqueViolation()));
    expect(pgErrorCode(out)).toBe('23505');
    expect(isUniqueViolationOnConstraint(out, 'members_email_uniq')).toBe(true);
    expect(pgErrorMeta(out)).toEqual({ constraint: 'members_email_uniq', table: 'members', column: 'email' });
    expect(errClassWithCode(out)).toBe('DrizzleQueryError:23505');
    expect(errLogFields(out)).toMatchObject({ err: 'DrizzleQueryError', code: '23505' });

    const excl = scrubDbError(
      drizzleError(
        driverError({
          code: '23P01',
          message: 'conflicting key value violates exclusion constraint "invoices_membership_coverage_no_overlap"',
          constraint_name: 'invoices_membership_coverage_no_overlap',
        }),
      ),
    );
    expect(isExclusionViolationOnConstraint(excl, 'invoices_membership_coverage_no_overlap')).toBe(true);
  });

  it('our trigger tokens survive (last-admin, primary-contact with its ids)', () => {
    const lastAdmin = scrubDbError(
      drizzleError(driverError({ code: '23514', message: 'last-admin-protection: cannot demote sole admin' })),
    );
    expect(isLastAdminTriggerError(lastAdmin)).toBe(true);

    const memberId = '11111111-2222-4333-8444-555555555555';
    const primary = scrubDbError(
      driverError({
        code: '23514',
        message: `primary-contact-invariant: member ${memberId} in tenant swecham has 0 live primary contact(s)`,
      }),
    );
    expect(primaryContactTriggerViolation(primary)).toEqual({ livePrimaries: 0, memberId, tenantSlug: 'swecham' });
  });

  it('a SQLSTATE class 22 message, which can quote the input, becomes the code', () => {
    const out = scrubDbError(
      drizzleError(driverError({ code: '22P02', message: `invalid input syntax for type uuid: "${EMAIL}"` })),
    );
    expectNoPii(out);
    expect((out as { cause: Error }).cause.message).toBe('22P02');
    expect(pgErrorCode(out)).toBe('22P02');
  });

  it('a driver error thrown on its own (e.g. at COMMIT) comes back as a clean clone of the same class', () => {
    const raw = uniqueViolation();
    const out = scrubDbError(raw);
    expect(out).not.toBe(raw);
    expect(out).toBeInstanceOf(postgres.PostgresError);
    expect((out as Error).name).toBe('PostgresError');
    expect(pgErrorCode(out)).toBe('23505');
    expectNoPii(out);
    expect((out as Error).stack).toMatch(/^PostgresError: duplicate key/);
  });

  it('an app error keeps its own object, class and message; only its driver links change', () => {
    class IssueInternal extends Error {}
    const app = new IssueInternal('issue: audit_failed', { cause: drizzleError(uniqueViolation()) });
    const out = scrubDbError(app);
    expect(out).toBe(app);
    expect((out as Error).message).toBe('issue: audit_failed');
    expectNoPii(out);
    expect(pgErrorCode(out)).toBe('23505');
  });

  it('a driver error held under `.error` or inside `errors[]` is scrubbed too', () => {
    const held = { kind: 'repo.unexpected', error: drizzleError(uniqueViolation()) };
    expectNoPii(scrubDbError(held));
    const agg = new AggregateError([uniqueViolation(), drizzleError(uniqueViolation())], 'batch failed');
    expectNoPii(scrubDbError(agg));
  });

  it('review round 1 — a parameter line that looks like a stack frame never survives', () => {
    const sneaky = `notes\n    at ${EMAIL} office`;
    const raw = new DrizzleQueryError(SQL_TEXT, [sneaky, NAME], uniqueViolation());
    expect(raw.stack).toContain(`    at ${EMAIL} office`); // control
    expectNoPii(scrubDbError(raw));
    const classTwentyTwo = driverError({ code: '22P02', message: `invalid input syntax for type uuid: "x\n    at ${EMAIL} (y:1:1)"` });
    expectNoPii(scrubDbError(classTwentyTwo));
  });

  it('review round 1 — a walk that hits its node bound says so', () => {
    const many = Array.from({ length: 30 }, () => drizzleError(uniqueViolation()));
    scrubDbError(new AggregateError(many, 'batch failed'));
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'db.error_scrub_truncated' }),
      expect.any(String),
    );
  });

  it('R171 — a fresh DrizzleQueryError whose stack was never read keeps its frames', () => {
    // V8 formats `stack` lazily on first read; no `.stack` touch before the scrub.
    const fresh = new DrizzleQueryError(SQL_TEXT, [EMAIL, NAME], uniqueViolation());
    scrubDbError(fresh);
    const stack = fresh.stack ?? '';
    expect(stack.startsWith('DrizzleQueryError: Failed query')).toBe(true);
    expect(stack).toMatch(/\n\s+at .*db-error-scrub\.test\.ts/);
    for (const needle of PII) expect(stack).not.toContain(needle);
  });

  it('is idempotent', () => {
    const once = scrubDbError(drizzleError(uniqueViolation()));
    const twice = scrubDbError(once);
    expect(twice).toBe(once);
    expect(pgErrorCode(twice)).toBe('23505');
  });

  it('a second copy of the classes (another bundle) is still caught by shape', () => {
    class DrizzleQueryErrorCopy extends Error {
      constructor(
        public query: string,
        public params: unknown[],
        public override cause?: unknown,
      ) {
        super(`Failed query: ${query}\nparams: ${params.join(',')}`);
      }
    }
    class PostgresErrorCopy extends Error {
      constructor(x: Record<string, unknown>) {
        super(x.message as string);
        this.name = 'PostgresError';
        Object.assign(this, x);
      }
    }
    const raw = new DrizzleQueryErrorCopy(SQL_TEXT, [EMAIL, NAME], new PostgresErrorCopy({
      code: '23505',
      severity: 'ERROR',
      message: 'duplicate key value violates unique constraint "members_email_uniq"',
      detail: `Key (email)=(${EMAIL}) already exists.`,
      constraint_name: 'members_email_uniq',
    }));
    const out = scrubDbError(raw);
    expectNoPii(out);
    expect((out as { cause: unknown }).cause).toBeInstanceOf(PostgresErrorCopy);
    expect(isUniqueViolationOnConstraint(out, 'members_email_uniq')).toBe(true);
  });

  it('a plain Error and a socket error are left alone', () => {
    const plain = new Error(`boom ${EMAIL}`);
    expect(scrubDbError(plain)).toBe(plain);
    expect(plain.message).toBe(`boom ${EMAIL}`);
    const socket = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104 });
    expect(scrubDbError(socket)).toBe(socket);
    expect(socket.message).toBe('read ECONNRESET');
  });

  it('a cyclic cause chain ends', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(scrubDbError(a)).toBe(a);
  });

  it('review round 1 — even a logger that throws on the failure line gives back the original', () => {
    const raw = drizzleError(uniqueViolation());
    Object.freeze(raw);
    vi.mocked(logger.error).mockImplementationOnce(() => {
      throw new Error('logger down');
    });
    expect(scrubDbError(raw)).toBe(raw);
  });

  it('it is total: a scrub that throws gives back the original and logs the failure', () => {
    const raw = drizzleError(uniqueViolation());
    Object.freeze(raw); // the in-place scrub of message / query now throws
    const out = scrubDbError(raw);
    expect(out).toBe(raw);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'db.error_scrub_failed' }),
      expect.any(String),
    );
  });
});
