// @vitest-environment node
/**
 * #804 — `installDbErrorScrub` on a REAL drizzle postgres-js db (over a fake
 * client whose every query rejects with a postgres-js server error): a query
 * outside any transaction, and a throw that leaves a transaction, come out
 * scrubbed; inside the transaction callback the error is still raw.
 */
import { inspect } from 'node:util';
import { sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { installDbErrorScrub } from '@/lib/db-error-scrub';
import { pgErrorCode } from '@/lib/db-errors';

const EMAIL = 'somchai.k@example.co.th';

const members = pgTable('members', { email: text('email').primaryKey(), name: text('name') });

function serverError(): Error {
  return new postgres.PostgresError({
    severity: 'ERROR',
    code: '23505',
    message: 'duplicate key value violates unique constraint "members_pkey"',
    detail: `Key (email)=(${EMAIL}) already exists.`,
    constraint_name: 'members_pkey',
    table_name: 'members',
  } as never);
}

function rejecting(): Promise<never> & { values: () => Promise<never> } {
  const p = Promise.reject(serverError());
  p.catch(() => {});
  return Object.assign(p, {
    values: () => {
      const q = Promise.reject(serverError());
      q.catch(() => {});
      return q;
    },
  });
}

function fakeClient(): ReturnType<typeof postgres> {
  const txClient = { options: { parsers: {}, serializers: {} }, unsafe: () => rejecting() };
  return {
    options: { parsers: {}, serializers: {} },
    unsafe: () => rejecting(),
    begin: async (cb: (c: unknown) => Promise<unknown>) => cb(txClient),
  } as unknown as ReturnType<typeof postgres>;
}

function makeDb() {
  return installDbErrorScrub(drizzle(fakeClient(), { schema: { members } }));
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function leaks(e: unknown): boolean {
  const text = `${inspect(e, { depth: 10 })}\n${(e as Error).stack ?? ''}`;
  return text.includes(EMAIL) || text.includes('insert into') || text.includes('Key (');
}

describe('installDbErrorScrub (#804)', () => {
  it('a bare insert / select / execute / relational query rejects scrubbed', async () => {
    const db = makeDb();
    const errors = [
      await caught(db.insert(members).values({ email: EMAIL, name: 'Somchai' }) as Promise<unknown>),
      await caught(db.select().from(members) as Promise<unknown>),
      await caught(db.execute(sql`select * from members where email = ${EMAIL}`)),
      await caught(db.query.members.findFirst()),
    ];
    for (const e of errors) {
      expect(leaks(e)).toBe(false);
      expect(pgErrorCode(e)).toBe('23505');
      expect((e as Error).constructor.name).toBe('DrizzleQueryError');
    }
  });

  it('inside a transaction the error is raw; once it leaves the transaction it is scrubbed', async () => {
    const db = makeDb();
    let inside: unknown;
    const outside = await caught(
      db.transaction(async (tx) => {
        try {
          await tx.insert(members).values({ email: EMAIL, name: 'Somchai' });
        } catch (e) {
          inside = e;
          expect(leaks(e)).toBe(true); // the in-tx catch still reads the raw text
          expect((e as { params?: unknown }).params).toEqual([EMAIL, 'Somchai']);
          throw e;
        }
      }),
    );
    expect(outside).toBe(inside);
    expect(leaks(outside)).toBe(false);
    expect(pgErrorCode(outside)).toBe('23505');
  });

  it('a driver error thrown by the transaction itself (e.g. at COMMIT) is scrubbed', async () => {
    const client = fakeClient() as unknown as { begin: unknown };
    client.begin = async () => {
      throw serverError();
    };
    const db = installDbErrorScrub(drizzle(client as never, { schema: { members } }));
    const e = await caught(db.transaction(async () => 'never'));
    expect(e).toBeInstanceOf(postgres.PostgresError);
    expect(leaks(e)).toBe(false);
    expect(pgErrorCode(e)).toBe('23505');
  });

  it('a db without the drizzle internals it expects is refused at install', () => {
    expect(() => installDbErrorScrub({ transaction: () => undefined } as never)).toThrow(/installDbErrorScrub/);
  });
});
