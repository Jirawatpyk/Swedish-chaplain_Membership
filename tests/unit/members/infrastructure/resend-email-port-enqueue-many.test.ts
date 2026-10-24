/**
 * `enqueueManyInTx` without a database: chunking under the Postgres
 * bind-parameter cap, and the two failure branches that must come back as
 * `err` (the use case turns them into a rollback), never as `ok` or a throw.
 * The live-Neon row shape is pinned in
 * tests/integration/members/email-port-enqueue-many.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ runInTenant: vi.fn() }));

import type { TenantTx } from '@/lib/db';
import type { EmailEnqueue } from '@/modules/members/application/ports/email-port';
import { ENQUEUE_MANY_CHUNK, enqueueManyInTx } from '@/modules/members/infrastructure/adapters/resend-email-port';
import type { TenantContext } from '@/modules/tenants';

const ctx = { slug: 'test-tenant' } as unknown as TenantContext;
const requests = (n: number): EmailEnqueue[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'member_change_request_submitted_staff',
    toEmail: `Reviewer${i}@Swecham.Test`,
    locale: 'en',
    contextData: { i },
  }));

/** A tx whose INSERT … VALUES … RETURNING chain records each chunk. */
function fakeTx(returning: (rows: unknown[]) => Promise<Array<{ id: string }>>) {
  const chunks: Array<Array<{ toEmail: string; tenantId: string }>> = [];
  let seq = 0;
  const tx = {
    insert: () => ({
      values: (rows: Array<{ toEmail: string; tenantId: string }>) => {
        chunks.push(rows);
        return { returning: () => returning(rows) };
      },
    }),
  } as unknown as TenantTx;
  const ids = (rows: unknown[]) => Promise.resolve(rows.map(() => ({ id: `row-${(seq += 1)}` })));
  return { tx, chunks, ids };
}

describe('enqueueManyInTx', () => {
  it('splits a large roster into chunks of ENQUEUE_MANY_CHUNK and returns one id per request', async () => {
    let ids: (rows: unknown[]) => Promise<Array<{ id: string }>> = async () => [];
    const f = fakeTx((rows) => ids(rows));
    ids = f.ids;
    const n = ENQUEUE_MANY_CHUNK * 2 + 5;
    const result = await enqueueManyInTx(f.tx, ctx, requests(n));
    expect(result.ok).toBe(true);
    expect(f.chunks.map((c) => c.length)).toEqual([ENQUEUE_MANY_CHUNK, ENQUEUE_MANY_CHUNK, 5]);
    if (result.ok) expect(result.value.outboxRowIds).toHaveLength(n);
    expect(f.chunks[0]![0]).toMatchObject({ toEmail: 'reviewer0@swecham.test', tenantId: 'test-tenant' });
  });

  it('an empty list issues no INSERT', async () => {
    const f = fakeTx(async () => []);
    expect(await enqueueManyInTx(f.tx, ctx, [])).toEqual({ ok: true, value: { outboxRowIds: [] } });
    expect(f.chunks).toHaveLength(0);
  });

  it('fewer rows returned than requested is an error, not a partial success', async () => {
    const f = fakeTx(async (rows) => rows.slice(1).map((_, i) => ({ id: `row-${i}` })));
    const result = await enqueueManyInTx(f.tx, ctx, requests(3));
    expect(result).toMatchObject({ ok: false, error: { code: 'repo.unexpected' } });
  });

  it('a thrown database error comes back as err, not a throw', async () => {
    const f = fakeTx(async () => {
      throw new Error('connection reset');
    });
    const result = await enqueueManyInTx(f.tx, ctx, requests(2));
    expect(result).toMatchObject({ ok: false, error: { code: 'repo.unexpected' } });
  });
});
