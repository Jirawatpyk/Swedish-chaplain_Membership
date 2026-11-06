/**
 * The admin E-Blast queue's keyset cursor keeps its sort key at the column's
 * own precision (live Neon).
 *
 * `timestamptz` holds microseconds; a JS `Date` holds milliseconds. The cursor
 * used to carry `keyOf(last)` (a `Date`), so the next page compared
 * `(col, id)` with a key rounded down to the millisecond: on an ascending view
 * the previous page's last rows came back, and on a descending view rows in
 * that millisecond were skipped (R137, 2026-11-05: page 2 of the Awaiting
 * review queue misbehaved over 55 SQL-seeded rows). The T114 pagination test
 * seeds whole-millisecond `Date`s, so it could not see this.
 *
 * Seeds 55 `submitted` rows whose `stage_entered_at` differ by 137 µs (all
 * inside a few milliseconds), walks `loadAdminBroadcastQueue` at 50 a page in
 * both directions, and asserts every row comes exactly once, in order, and
 * the last page has no cursor. A second tenant with the same seed is never
 * seen (Principle I).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { loadAdminBroadcastQueue } from '@/lib/admin-broadcast-queue';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const COUNT = 55;
const PAGE = 50;

let tenantA: TestTenant;
let tenantB: TestTenant;
const idsA = new Set<string>();
const idsB = new Set<string>();

async function seed(tenant: TestTenant, ids: Set<string>): Promise<void> {
  const member = randomUUID();
  const rows: NewBroadcastRow[] = Array.from({ length: COUNT }, (_, i) => {
    const broadcastId = randomUUID();
    ids.add(broadcastId);
    return {
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: member,
      requestedByMemberPlanIdSnapshot: 'plan-cursor-precision',
      submittedByUserId: randomUUID(),
      actorRole: 'member_self_service',
      subject: `cursor precision ${i}`,
      bodyHtml: '<p>b</p>',
      bodySource: 'b',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      estimatedRecipientCount: 10,
      status: 'submitted',
      // Microsecond-distinct, sub-millisecond values: the shape a SQL seed or
      // `now()` writes and a JS Date cannot carry.
      stageEnteredAt: sql`timestamptz '2026-11-01 03:00:00.000123+00' + ${i} * interval '137 microseconds'` as unknown as Date,
      submittedAt: new Date('2026-11-01T02:00:00.000Z'),
      proposedSendAt: new Date('2026-12-01T03:00:00.000Z'),
      currentRound: 0,
    };
  });
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(broadcasts).values(rows);
  });
}

async function walk(
  tenant: TestTenant,
  sort: 'stage_entered_at_asc' | 'stage_entered_at_desc',
): Promise<{ ids: string[]; times: string[]; pages: number; lastCursor: string | null }> {
  const ids: string[] = [];
  const times: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let lastCursor: string | null = null;
  for (; pages < 5; ) {
    const page = await loadAdminBroadcastQueue(tenant.ctx, {
      statusFilter: ['submitted'] as BroadcastStatus[],
      pageSize: PAGE,
      sort,
      ...(cursor !== undefined && { cursor }),
    });
    pages += 1;
    for (const item of page.items) {
      ids.push(item.broadcastId);
      times.push(item.stageEnteredAt);
    }
    lastCursor = page.nextCursor;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { ids, times, pages, lastCursor };
}

describe('admin E-Blast queue keyset — microsecond sort keys (live Neon)', () => {
  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    await seed(tenantA, idsA);
    await seed(tenantB, idsB);
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
  }, 120_000);

  for (const sort of ['stage_entered_at_asc', 'stage_entered_at_desc'] as const) {
    it(`${sort}: every row exactly once over two pages, and the last page has no cursor`, async () => {
      const { ids, times, pages, lastCursor } = await walk(tenantA, sort);
      expect(pages).toBe(2);
      expect(lastCursor).toBeNull();
      expect(ids).toHaveLength(COUNT);
      expect(new Set(ids).size).toBe(COUNT);
      expect(new Set(ids)).toEqual(idsA);
      const ms = times.map((t) => Date.parse(t));
      expect(ms).toEqual([...ms].sort((a, b) => (sort === 'stage_entered_at_asc' ? a - b : b - a)));
    }, 120_000);
  }

  it('the walk never sees the other tenant\'s rows (Principle I)', async () => {
    const { ids } = await walk(tenantA, 'stage_entered_at_asc');
    expect(ids.some((id) => idsB.has(id))).toBe(false);
  }, 120_000);
});
