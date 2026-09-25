/**
 * F7 retention sweep (migration 0310) — the SQL shape of the phase-3 delete,
 * `deleteExpiredForRetention`.
 *
 * R2: the time budget is checked only between batches, and the Neon pooler can
 * drop `statement_timeout`, so a batch waiting on a row lock (the cascade into
 * a delivery another transaction holds) could hang the run. The FIRST statement
 * of the batch's work is `SET LOCAL lock_timeout = '5s'`: a wait ends with
 * 55P03, the use case counts the batch as a failure, and the run row is still
 * written. A fake repo cannot see a `SET LOCAL`, which is why this reads the
 * statements the adapter actually sends.
 *
 * What the DELETE removes is proven on live Neon in
 * `tests/integration/broadcasts/broadcast-retention-sweep.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';

/** The text of a drizzle sql template (nested fragments included). */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'object' && c !== null && 'value' in c) return (c as { value: readonly string[] }).value.join('');
      if (typeof c === 'object' && c !== null && 'queryChunks' in c) return sqlText(c);
      return ' ? ';
    })
    .join('');
}

const TENANT = 'tenant-retention';
const NOW = new Date('2031-06-15T20:50:00.000Z');

function recordingTx(): { tx: unknown; statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    tx: {
      execute: vi.fn(async (q: unknown) => {
        const text = sqlText(q);
        statements.push(text);
        if (text.includes("current_setting('app.current_tenant'")) return [{ current_tenant: TENANT }];
        return [] as unknown;
      }),
    },
  };
}

describe('deleteExpiredForRetention — SQL shape', () => {
  it("sets lock_timeout = '5s' as its FIRST statement, then deletes with a re-checked, SKIP LOCKED sub-select", async () => {
    const { tx, statements } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.deleteExpiredForRetention(TENANT as never, NOW, ['7f3c1a52-0000-4000-8000-000000000001'], tx);

    expect(statements[0]).toMatch(/^\s*SET LOCAL lock_timeout = '5s'\s*$/);
    const del = statements.find((s) => /DELETE FROM broadcasts/.test(s));
    expect(del).toBeDefined();
    // Eligibility is re-checked under the lock, not trusted from the read.
    expect(del).toContain('FOR UPDATE SKIP LOCKED');
    expect(del).toContain('make_interval(years => retention_years::int)');
    expect(del).toContain('resend_audience_id IS NULL OR audience_deleted_at IS NOT NULL');
    expect(del).toMatch(/status::text IN/);
    // Only the rows the caller confirmed.
    expect(del).toMatch(/broadcast_id = ANY\(/);
    // The anchor comes back for the run row's range.
    expect(del).toMatch(/RETURNING[\s\S]*AS anchor/);
  });

  it('an empty id list sends nothing at all', async () => {
    const { tx, statements } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    const out = await repo.deleteExpiredForRetention(TENANT as never, NOW, [], tx);

    expect(out).toEqual({ swept: [] });
    expect(statements).toEqual([]);
  });
});
