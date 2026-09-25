/**
 * F119 T037 — the state-machine edges migration 0308 adds (data-model § 8.2)
 * behave identically at the DB trigger (`broadcasts_state_machine_fn`) and in
 * the Domain map (`canTransition`).
 *
 * Two halves, kept in separate `it` blocks on purpose:
 *   - DB: every `from` row of the § 8.2 table permits EXACTLY its listed
 *     targets and refuses the other thirteen with
 *     `broadcast_invalid_state_transition`; `expired_no_member_response` has
 *     no outgoing edge. Green once 0308 is applied (T048).
 *   - Domain parity: every (from,to) pair that involves at least one of the
 *     five new statuses is probed at the DB and compared with
 *     `canTransition`. RED until T051 widens the Domain union and the
 *     adjacency map — that is T051's RED, by design.
 *
 * "New edges only" (plan.md R-7): pairs between two pre-existing statuses are
 * out of the parity scope, which is what keeps the three recorded divergences
 * (`draft→cancelled`, `approved→failed_to_dispatch`, `sending→cancelled` —
 * trigger yes, Domain no) out of it. They are not fixed here.
 *
 * Probes run in SAVEPOINTs that are always rolled back — one seeded row per
 * status serves the whole matrix.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import {
  BROADCAST_TRANSITIONS,
  canTransition,
} from '@/modules/broadcasts/domain/policies/broadcast-status-transitions';
import {
  broadcasts,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

type Status = NonNullable<NewBroadcastRow['status']>;
type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];

const ALL_STATUSES: readonly Status[] = [
  'draft', 'submitted', 'approved', 'sending', 'sent', 'rejected', 'cancelled',
  'failed_to_dispatch', 'partially_sent', 'partial_delivery_accepted',
  'in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved',
  'expired_no_member_response',
];
const NEW_STATUSES: ReadonlySet<Status> = new Set<Status>([
  'in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved',
  'expired_no_member_response',
]);

/** data-model § 8.2 "New/changed CASE arms" — verbatim. */
const TABLE_8_2: ReadonlyArray<readonly [Status, readonly Status[]]> = [
  ['submitted', ['approved', 'rejected', 'cancelled', 'in_design']],
  ['in_design', ['awaiting_member_approval', 'rejected', 'cancelled']],
  ['awaiting_member_approval', ['member_approved', 'changes_requested', 'rejected', 'cancelled', 'expired_no_member_response']],
  ['changes_requested', ['in_design', 'rejected', 'cancelled']],
  ['member_approved', ['approved', 'changes_requested', 'in_design', 'rejected', 'cancelled']],
  ['approved', ['sending', 'cancelled', 'failed_to_dispatch', 'changes_requested', 'in_design']],
  ['expired_no_member_response', []],
];

class Rollback extends Error {}

describe('F119 T037 — § 8.2 state-machine edges (DB trigger ↔ Domain map)', () => {
  let tenant: TestTenant;
  const ids = new Map<Status, string>();

  const seedRow = (status: Status): NewBroadcastRow => ({
    tenantId: tenant.ctx.slug,
    broadcastId: randomUUID(),
    requestedByMemberId: randomUUID(),
    requestedByMemberPlanIdSnapshot: 'plan-t037',
    submittedByUserId: randomUUID(),
    actorRole: 'member_self_service',
    subject: `T037 ${status}`,
    bodyHtml: '<p>b</p>',
    bodySource: 'b',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 10,
    status,
    ...(status === 'sent' || status === 'partial_delivery_accepted'
      ? { quotaYearConsumed: 2026, quotaConsumedAt: new Date() }
      : {}),
  });

  /** 'permitted' | 'refused' — anything else is reported verbatim. */
  async function probe(tx: Tx, from: Status, to: Status): Promise<string> {
    try {
      await tx.transaction(async (sp) => {
        const rows = await sp
          .update(broadcasts)
          .set({ status: to })
          .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, ids.get(from)!)))
          .returning({ id: broadcasts.broadcastId });
        if (rows.length !== 1) throw new Error(`probe matched ${rows.length} rows`);
        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) return 'permitted';
      const message = errorChainMessage(e);
      if (message.includes('broadcast_invalid_state_transition')) return 'refused';
      return `other: ${message.slice(0, 160)}`;
    }
    return 'unreachable';
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const rows = ALL_STATUSES.map(seedRow);
    rows.forEach((r) => ids.set(r.status as Status, r.broadcastId!));
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(rows));
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  describe('DB trigger — broadcasts_state_machine_fn', () => {
    it.each(TABLE_8_2.map(([from, targets]) => [from, targets] as const))(
      'from `%s` the trigger permits exactly the § 8.2 targets',
      async (from, targets) => {
        const misses = await runInTenant(tenant.ctx, async (tx) => {
          const out: string[] = [];
          for (const to of ALL_STATUSES) {
            if (to === from) continue;
            const want = targets.includes(to) ? 'permitted' : 'refused';
            const got = await probe(tx, from, to);
            if (got !== want) out.push(`${from}→${to}: want ${want}, got ${got}`);
          }
          return out;
        });
        expect(misses).toEqual([]);
      },
    );

    it('`expired_no_member_response` has no outgoing edge', async () => {
      const permitted = await runInTenant(tenant.ctx, async (tx) => {
        const out: string[] = [];
        for (const to of ALL_STATUSES) {
          if (to === 'expired_no_member_response') continue;
          const got = await probe(tx, 'expired_no_member_response', to);
          if (got !== 'refused') out.push(`→${to}: ${got}`);
        }
        return out;
      });
      expect(permitted).toEqual([]);
    });
  });

  describe('Domain parity — canTransition (RED until T051 widens the Domain map)', () => {
    it('every (from,to) in data-model § 8.2 behaves identically at the DB and in `canTransition`', async () => {
      const pairs = ALL_STATUSES.flatMap((from) =>
        ALL_STATUSES.filter((to) => to !== from && (NEW_STATUSES.has(from) || NEW_STATUSES.has(to))).map(
          (to) => [from, to] as const,
        ),
      );
      const mismatches = await runInTenant(tenant.ctx, async (tx) => {
        const out: string[] = [];
        for (const [from, to] of pairs) {
          const db = await probe(tx, from, to);
          if (db !== 'permitted' && db !== 'refused') {
            out.push(`${from}→${to}: DB probe failed — ${db}`);
            continue;
          }
          const domain = canTransition(from, to)
            ? 'permitted'
            : 'refused';
          if (domain !== db) out.push(`${from}→${to}: DB ${db}, Domain ${domain}`);
        }
        return out;
      });
      expect(mismatches).toEqual([]);
    });

    it('`expired_no_member_response` is declared in the Domain map with no outgoing edge', () => {
      const map = BROADCAST_TRANSITIONS as Readonly<Record<string, ReadonlyArray<string>>>;
      expect(Object.hasOwn(map, 'expired_no_member_response')).toBe(true);
      expect(map['expired_no_member_response']).toEqual([]);
    });
  });
});
