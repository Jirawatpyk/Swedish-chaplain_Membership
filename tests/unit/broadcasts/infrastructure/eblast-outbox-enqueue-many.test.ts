/**
 * `eblastNotificationOutbox.enqueueManyInTx` without a database: one multi-row
 * INSERT per `EBLAST_ENQUEUE_MANY_CHUNK` requests (the per-recipient loop it
 * replaces grew with the roster, R81), the empty no-op, the REQUIRED tx
 * (SC-004), and a short insert that must throw rather than pass as a partial
 * hand-off. The live row shape is pinned in
 * tests/integration/broadcasts/eblast-outbox-enqueue-many.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  EBLAST_ENQUEUE_MANY_CHUNK,
  eblastNotificationOutbox,
} from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import type { EblastNotificationEnqueue } from '@/modules/broadcasts/application/ports/eblast-notification-outbox-port';
import type { TenantContext } from '@/modules/tenants';

const tenant = { slug: 'test-tenant' } as unknown as TenantContext;
const dialect = new PgDialect();
/** Bound parameters per outbox row (tenant, type, email, locale, context). */
const PARAMS_PER_ROW = 5;

const requests = (n: number): EblastNotificationEnqueue[] =>
  Array.from({ length: n }, (_, i) => ({
    type: 'eblast_submitted_marketing',
    toEmail: `marketing${i}@swecham.test`,
    locale: 'en',
    contextData: { tenantId: 'test-tenant', broadcastId: 'b-1', recipientUserId: `u-${i}` },
  }));

/** A tx whose `execute` records each statement's row count and returns one id per row (or `short` fewer). */
function recordingTx(short = 0) {
  const chunkSizes: number[] = [];
  const tx = {
    execute: vi.fn(async (q: SQL) => {
      const rows = dialect.sqlToQuery(q).params.length / PARAMS_PER_ROW;
      chunkSizes.push(rows);
      return Array.from({ length: rows - short }, (_, i) => ({ id: `row-${i}` }));
    }),
  };
  return { tx, chunkSizes };
}

describe('eblastNotificationOutbox.enqueueManyInTx', () => {
  it('splits a large roster into chunks of EBLAST_ENQUEUE_MANY_CHUNK, one INSERT each', async () => {
    const { tx, chunkSizes } = recordingTx();
    await eblastNotificationOutbox.enqueueManyInTx(tx, tenant, requests(EBLAST_ENQUEUE_MANY_CHUNK * 2 + 5));
    expect(chunkSizes).toEqual([EBLAST_ENQUEUE_MANY_CHUNK, EBLAST_ENQUEUE_MANY_CHUNK, 5]);
    const query = dialect.sqlToQuery(tx.execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/INSERT INTO notifications_outbox/);
    expect(query.sql).toMatch(/::notification_type/);
    expect(query.sql).toMatch(/RETURNING id/);
    expect(query.params.slice(0, PARAMS_PER_ROW)).toEqual([
      'test-tenant',
      'eblast_submitted_marketing',
      'marketing0@swecham.test',
      'en',
      JSON.stringify({ tenantId: 'test-tenant', broadcastId: 'b-1', recipientUserId: 'u-0' }),
    ]);
  });

  it('an empty list issues no INSERT', async () => {
    const { tx } = recordingTx();
    await eblastNotificationOutbox.enqueueManyInTx(tx, tenant, []);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('a null tx throws: the rows must share the transaction of the state change', async () => {
    await expect(eblastNotificationOutbox.enqueueManyInTx(null, tenant, requests(2))).rejects.toThrow(TypeError);
  });

  it('fewer rows inserted than requested throws, never a partial hand-off', async () => {
    const { tx } = recordingTx(1);
    await expect(eblastNotificationOutbox.enqueueManyInTx(tx, tenant, requests(3))).rejects.toThrow(/2 rows for 3 requests/);
  });
});
