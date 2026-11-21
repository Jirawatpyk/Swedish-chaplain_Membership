/**
 * #804 — on the live Neon dev branch, a real DB error that leaves our DB
 * layer carries no SQL, no bound parameters and no row values, and still
 * names its SQLSTATE and constraint.
 *
 * Cases: a unique violation whose `detail` quotes an email (a transaction
 * that escapes), a class-22 cast error whose message quotes the input
 * (a bare `db` query, and inside `runInTenant`), and the same error caught
 * INSIDE the transaction, which stays raw. Every value here is fake.
 */
import { inspect } from 'node:util';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { pgErrorCode, pgErrorMeta } from '@/lib/db-errors';
import { asTenantContext } from '@/modules/tenants';

const FAKE_EMAIL = 'r171.scrub.probe@example.invalid';
const TENANT_A = asTenantContext('test-db-error-scrub-a');
const TENANT_B = asTenantContext('test-db-error-scrub-b');

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function printed(e: unknown): string {
  return `${inspect(e, { depth: 10 })}\n${(e as Error).stack ?? ''}`;
}

describe('db error scrub on live Postgres (#804)', () => {
  it('a unique violation that escapes a transaction: no email, no SQL; code and constraint kept', async () => {
    let inside: string | undefined;
    const e = await caught(
      db.transaction(async (tx) => {
        await tx.execute(sql`create temp table r171_scrub (email text primary key) on commit drop`);
        await tx.execute(sql`insert into r171_scrub (email) values (${FAKE_EMAIL})`);
        try {
          await tx.execute(sql`insert into r171_scrub (email) values (${FAKE_EMAIL})`);
        } catch (err) {
          inside = printed(err);
          throw err;
        }
      }),
    );
    expect(inside).toContain(FAKE_EMAIL); // control: raw inside the tx
    expect(printed(e)).not.toContain(FAKE_EMAIL);
    expect(printed(e)).not.toContain('insert into');
    expect(pgErrorCode(e)).toBe('23505');
    expect(pgErrorMeta(e)).toMatchObject({ constraint: 'r171_scrub_pkey', table: 'r171_scrub' });
  });

  it('a bare db query whose cast error quotes the input: no input, code kept', async () => {
    const e = await caught(db.execute(sql`select ${FAKE_EMAIL}::uuid as id`));
    expect(printed(e)).not.toContain(FAKE_EMAIL);
    expect(pgErrorCode(e)).toBe('22P02');
  });

  it('the same error under runInTenant, for two tenants: no input either way', async () => {
    for (const ctx of [TENANT_A, TENANT_B]) {
      const e = await caught(runInTenant(ctx, (tx) => tx.execute(sql`select ${FAKE_EMAIL}::uuid as id`)));
      expect(printed(e)).not.toContain(FAKE_EMAIL);
      expect(pgErrorCode(e)).toBe('22P02');
    }
  });
});
