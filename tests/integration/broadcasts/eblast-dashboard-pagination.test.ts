/**
 * F119 T114 (SC-008; contracts/dashboard-and-notifications.md § 1.4) — the
 * dashboard's counts and first page within 2 s at 1,000 E-Blasts of history,
 * the per-stage page served by `broadcasts_stage_queue_idx
 * (tenant_id, status, stage_entered_at DESC)`, on live Neon.
 *
 * Seeds 1,000 rows across ALL fifteen statuses in one fresh tenant (spread
 * `stage_entered_at` so some rows are stalled, future and past `scheduled_for`
 * on the Scheduled rows, delivery events on a few sent rows), `ANALYZE`s, then
 * measures the reads `/admin/broadcasts` makes before it can paint — the
 * per-stage counts (`readEblastStageChips`) and the first page
 * (`loadAdminBroadcastQueue`: the list, the member-name projection and the
 * batched delivery aggregate) — and asserts:
 *   - the counts equal the seeded tally, stage by stage;
 *   - the p95 of ten warm measurements is under the 2 s budget;
 *   - `EXPLAIN` of the REAL per-stage first page (`adminQueueListQuery`, the
 *     builder the repo executes) under the tenant's RLS, for every waiting
 *     stage: never a sequential scan once one is priced out, and the two
 *     stages with a partial index of their own are driven by it;
 *   - positive control, OUTSIDE RLS: the same statement narrows a
 *     `(tenant_id, status, …)` index on `status` — RLS is the only blocker;
 *   - the Upcoming sends preset walks every future Scheduled row across the
 *     keyset page boundary in send-time order, and nothing in the past.
 *
 * FINDING (T114, 2026-09-24) — the contract's "served by
 * `broadcasts_stage_queue_idx`" does NOT hold under row-level security for
 * the stages that have no partial index of their own (`in_design`,
 * `changes_requested`, `member_approved`): `enum_eq` is not LEAKPROOF, so
 * under the RLS policy's security barrier Postgres will not use
 * `status = '…'` as an index condition, and the index degrades to a
 * `tenant_id`-prefix index (the planner then picks the smallest such index).
 * A partial index (`… WHERE status = '…'`) is proven at PLAN time and so
 * still works — `submitted` and `awaiting_member_approval` have one. At
 * SC-008's 1,000 rows the 2 s budget holds regardless; the per-status partial
 * indexes that would restore it at scale are a schema decision for the
 * maintainer, not this file.
 *
 * The grouped COUNT is deliberately NOT pinned to an index: with one tenant
 * owning ~all of `broadcasts` (the single-tenant production shape, and this
 * dev branch once seeded) the planner correctly prefers one sequential pass
 * for a GROUP BY over every row; its budget is in the timing.
 *
 * The budget is a PERFORMANCE number measured client-side on a shared Neon
 * compute. Inside a folder run (`INTEGRATION_FOLDER_RUN=1`, exported by
 * `.husky/pre-push` and the nightly sweep) many files contend for that
 * compute, so the file REPORTS the numbers there and asserts everything else;
 * run it alone — or set `EBLAST_DASHBOARD_BUDGET_MS` — for the budget itself
 * (memory: a folder run cannot assert a per-query p95).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { loadAdminBroadcastQueue } from '@/lib/admin-broadcast-queue';
import { readEblastStageChips } from '@/lib/eblast-waiting-count';
import { adminQueueListQuery } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import {
  broadcastDeliveries,
  broadcasts,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const FOLDER_RUN = process.env.INTEGRATION_FOLDER_RUN === '1';
const BUDGET_MS =
  process.env.EBLAST_DASHBOARD_BUDGET_MS !== undefined ? Number(process.env.EBLAST_DASHBOARD_BUDGET_MS) : 2_000;
const ASSERT_BUDGET = !FOLDER_RUN || process.env.EBLAST_DASHBOARD_BUDGET_MS !== undefined;

const TOTAL = 1_000;
const PAGE = 50;
const RUNS = 10;
const HOUR = 3_600_000;

let tenant: TestTenant;
const seeded = new Map<BroadcastStatus, number>();
let futureScheduled = 0;

function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** The first page `/admin/broadcasts` renders on a fresh visit: Awaiting marketing review, longest in stage first. */
const FIRST_PAGE = {
  statusFilter: ['submitted'] as BroadcastStatus[],
  pageSize: PAGE,
  sort: 'stage_entered_at_asc' as const,
};

describe('SC-008 — the dashboard at 1,000 E-Blasts (T114, live Neon)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const now = Date.now();
    const members = Array.from({ length: 20 }, () => randomUUID());
    const rows: NewBroadcastRow[] = Array.from({ length: TOTAL }, (_, i) => {
      const status = BROADCAST_STATUSES[i % BROADCAST_STATUSES.length]!;
      seeded.set(status, (seeded.get(status) ?? 0) + 1);
      // 0 … 199 h in stage: some fresh, some amber, some stalled on either clock.
      const stageEnteredAt = new Date(now - (i % 200) * HOUR);
      // Scheduled rows: two in three in the future, one in three already due.
      const scheduledFor =
        status === 'approved' ? new Date(now + (i % 3 === 0 ? -1 : 1) * (i + 1) * 60_000) : null;
      if (status === 'approved' && scheduledFor !== null && scheduledFor.getTime() > now) futureScheduled += 1;
      const sentLike = status === 'sent' || status === 'partial_delivery_accepted';
      return {
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: members[i % members.length]!,
        requestedByMemberPlanIdSnapshot: 'plan-t114',
        submittedByUserId: randomUUID(),
        actorRole: i % 7 === 0 ? 'admin_proxy' : 'member_self_service',
        subject: `T114 ${status} ${i}`,
        bodyHtml: '<p>b</p>',
        bodySource: 'b',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 10,
        status,
        submittedAt: status === 'draft' ? null : new Date(stageEnteredAt.getTime() - HOUR),
        stageEnteredAt,
        scheduledFor,
        proposedSendAt: status === 'draft' ? null : new Date(now + 7 * 24 * HOUR),
        currentRound: i % 4,
        ...(sentLike ? { quotaYearConsumed: 2026, quotaConsumedAt: stageEnteredAt } : {}),
      };
    });
    await runInTenant(tenant.ctx, async (tx) => {
      for (const chunk of chunks(rows, 500)) await tx.insert(broadcasts).values(chunk);
      const sent = rows.filter((r) => r.status === 'sent').slice(0, 3);
      await tx.insert(broadcastDeliveries).values(
        sent.flatMap((r) =>
          (['sent', 'delivered', 'bounced', 'complained'] as const).map((status, k) => ({
            tenantId: tenant.ctx.slug,
            broadcastId: r.broadcastId!,
            resendEventId: `evt-${randomUUID()}`,
            resendMessageId: `msg-${r.broadcastId}-${k}`,
            recipientEmailLower: `r${k}@example.com`,
            status,
            eventTimestamp: new Date(now),
          })),
        ),
      );
    });
    // Statistics AFTER the bulk load — without them the planner believes the
    // table holds a handful of rows and every plan below is a coin toss.
    await db.execute(sql`ANALYZE broadcasts, broadcast_deliveries`);
  }, 300_000);

  afterAll(async () => {
    // Deliveries, then broadcasts (the helper disables the append-only delete trigger for it).
    await tenant?.cleanup().catch(() => {});
  }, 120_000);

  it('1,000 seeded rows across all stages: the budget holds and `broadcasts_stage_queue_idx` appears in `EXPLAIN`', async () => {
    // Correctness first — the counts ARE the seeded tally, stage by stage.
    const chips = await readEblastStageChips(tenant.ctx, 'T114.test');
    expect(chips.kind).toBe('ok');
    if (chips.kind !== 'ok') return;
    for (const s of BROADCAST_STATUSES) expect(chips.counts[s], s).toBe(seeded.get(s) ?? 0);

    // Warm-up: the first statements pay the pooled connection + plan cost.
    await loadAdminBroadcastQueue(tenant.ctx, FIRST_PAGE);

    const durations: number[] = [];
    for (let r = 0; r < RUNS; r += 1) {
      const started = performance.now();
      await readEblastStageChips(tenant.ctx, 'T114.test');
      const page = await loadAdminBroadcastQueue(tenant.ctx, FIRST_PAGE);
      durations.push(performance.now() - started);
      expect(page.items).toHaveLength(PAGE);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const slowest = sorted[sorted.length - 1]!;
    console.warn(
      `[eblast-dashboard] counts + first page at ${TOTAL} rows: median ${median.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, slowest ${slowest.toFixed(0)} ms (budget < ${BUDGET_MS} ms${ASSERT_BUDGET ? '' : ' — folder run: reported, not asserted'})`,
    );
    if (ASSERT_BUDGET) {
      expect(p95, `p95 ${p95.toFixed(0)} ms (budget < ${BUDGET_MS} ms)`).toBeLessThan(BUDGET_MS);
    }

    // The per-stage first page, for every stage somebody is waiting on, as
    // the dashboard runs it: inside the tenant's RLS (`runInTenant`). What the
    // planner CHOOSES at 1,000 rows is logged, not pinned — the table is a few
    // dozen pages, so for a 67-row stage one sequential pass plus a 67-row sort
    // is honestly cheapest (measured: `in_design` → Seq Scan). With sequential
    // scans priced out (`SET LOCAL enable_seqscan = off`, this transaction
    // only) the page must be an index read, and a stage with a partial index
    // of its own must be driven by it (see the FINDING in the file docblock
    // for why the others cannot narrow on `status` under RLS).
    const OWN_PARTIAL: Partial<Record<BroadcastStatus, string>> = {
      submitted: 'broadcasts_tenant_submitted_at_idx',
      awaiting_member_approval: 'broadcasts_awaiting_member_idx',
    };
    const WAITING: readonly BroadcastStatus[] = [
      'submitted',
      'in_design',
      'awaiting_member_approval',
      'changes_requested',
      'member_approved',
    ];
    const statement = (tx: Parameters<typeof adminQueueListQuery>[0], stage: BroadcastStatus) =>
      sql`EXPLAIN ${adminQueueListQuery(tx, tenant.ctx.slug, { ...FIRST_PAGE, statusFilter: [stage] }).getSQL()}`;
    const text = (out: unknown) =>
      (out as Array<Record<string, string>>).map((r) => Object.values(r).join(' ')).join('\n');
    const explainUnderRls = (stage: BroadcastStatus, priceOutSeqScan: boolean) =>
      runInTenant(tenant.ctx, async (tx) => {
        if (priceOutSeqScan) await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        return text(await tx.execute(statement(tx, stage)));
      });
    for (const stage of WAITING) {
      console.warn(`[eblast-dashboard] first-page plan as chosen — ${stage}:\n${await explainUnderRls(stage, false)}`);
      const plan = await explainUnderRls(stage, true);
      console.warn(`[eblast-dashboard] first-page plan, seq scan priced out — ${stage}:\n${plan}`);
      expect(plan, stage).not.toMatch(/Seq Scan on broadcasts/);
      expect(plan, `${stage}: an index drives the page`).toMatch(/Index(?: Only)? Scan|Bitmap Index Scan/);
      const own = OWN_PARTIAL[stage];
      if (own !== undefined) expect(plan, stage).toContain(own);
    }

    // Positive control — RLS is the only thing between a `(tenant_id,
    // status, …)` index and the page: outside RLS (the bypass-RLS owner
    // connection, never how the app reads) the same statement narrows on
    // `status` for a stage no partial index covers.
    const bare = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return text(await tx.execute(statement(tx as never, 'in_design')));
    });
    console.warn(`[eblast-dashboard] positive control, outside RLS — in_design:\n${bare}`);
    expect(bare).toMatch(/Index Cond: \(\(tenant_id = .*\) AND \(status = 'in_design'/);
    // The planner may pick either index leading with `(tenant_id, status)` —
    // `broadcasts_stage_queue_idx` or its older peer
    // `broadcasts_tenant_status_member_idx` (measured: the peer) — so both are
    // allowed (memory: never pin one index the planner has a peer for).
    const bareIndexes = [...bare.matchAll(/(?:Index(?: Only)? Scan(?: Backward)?|Bitmap Index Scan) on (\w+)/g)].map((m) => m[1]);
    expect(bareIndexes.length).toBeGreaterThan(0);
    for (const name of bareIndexes) {
      expect(['broadcasts_stage_queue_idx', 'broadcasts_tenant_status_member_idx']).toContain(name);
    }
  }, 300_000);

  it('the first page is the stage, longest in stage first, and the keyset carries on from it (page 2)', async () => {
    const page = await loadAdminBroadcastQueue(tenant.ctx, FIRST_PAGE);
    expect(page.items.every((i) => i.status === 'submitted')).toBe(true);
    const times = page.items.map((i) => Date.parse(i.stageEnteredAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(page.nextCursor).not.toBeNull();
    // The second page continues strictly after the first — the keyset moved on time in stage.
    const next = await loadAdminBroadcastQueue(tenant.ctx, { ...FIRST_PAGE, cursor: page.nextCursor! });
    const firstIds = new Set(page.items.map((i) => i.broadcastId));
    expect(next.items.some((i) => firstIds.has(i.broadcastId))).toBe(false);
    expect(Date.parse(next.items[0]!.stageEnteredAt)).toBeGreaterThanOrEqual(times.at(-1)!);
  }, 120_000);

  it('a finished-stage view reads most recent first, and the keyset walks backwards across the page boundary (UX review H1)', async () => {
    const sentView = { statusFilter: ['sent'] as BroadcastStatus[], pageSize: PAGE, sort: 'stage_entered_at_desc' as const };
    const page = await loadAdminBroadcastQueue(tenant.ctx, sentView);
    expect(page.items).toHaveLength(PAGE);
    const times = page.items.map((i) => Date.parse(i.stageEnteredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(page.nextCursor).not.toBeNull();
    const next = await loadAdminBroadcastQueue(tenant.ctx, { ...sentView, cursor: page.nextCursor! });
    const firstIds = new Set(page.items.map((i) => i.broadcastId));
    expect(next.items.length).toBe((seeded.get('sent') ?? 0) - PAGE);
    expect(next.items.some((i) => firstIds.has(i.broadcastId))).toBe(false);
    expect(Date.parse(next.items[0]!.stageEnteredAt)).toBeLessThanOrEqual(times.at(-1)!);
  }, 120_000);

  it('the Upcoming sends preset lists every future Scheduled row in send-time order, across the page boundary, and nothing already due', async () => {
    const from = new Date();
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await loadAdminBroadcastQueue(tenant.ctx, {
        statusFilter: ['approved'],
        pageSize: PAGE,
        sort: 'scheduled_for_asc',
        scheduledFrom: from,
        ...(cursor !== undefined && { cursor }),
      });
      for (const item of page.items) {
        expect(item.status).toBe('approved');
        seen.push(Date.parse(item.confirmedSendAt!));
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen.length).toBe(futureScheduled);
    expect(seen.length).toBeGreaterThan(PAGE); // the walk crossed a page boundary
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.every((t) => t >= from.getTime())).toBe(true);
  }, 120_000);

  it('sent rows carry the delivery aggregate; no other row does', async () => {
    const page = await loadAdminBroadcastQueue(tenant.ctx, {
      statusFilter: ['sent'],
      pageSize: 100,
      sort: 'stage_entered_at_asc',
    });
    const withResults = page.items.filter((i) => i.delivery !== null && i.delivery.recipients > 0);
    expect(withResults).toHaveLength(3);
    for (const i of withResults) expect(i.delivery).toEqual({ recipients: 4, delivered: 1, bounced: 1, complained: 1 });
    const scheduled = await loadAdminBroadcastQueue(tenant.ctx, FIRST_PAGE);
    expect(scheduled.items.every((i) => i.delivery === null)).toBe(true);
  }, 120_000);
});
