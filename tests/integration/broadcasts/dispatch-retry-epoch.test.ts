/**
 * F119 PR-E (migration 0311) — `broadcasts.dispatch_first_failed_at`, the FR-021
 * retry-budget anchor, on live Neon.
 *
 * What a unit test cannot see and this file pins:
 *
 *   1. `broadcasts_immutable_after_submit_fn` lets the dispatcher write the
 *      column on a post-submit row (its normal arm is a blocklist the column is
 *      not on) — and still refuses the frozen columns, alone or riding along
 *      with the stamp.
 *   2. Under the erasure GUC (`app.allow_broadcast_redaction = 'on'`) the column
 *      is REFUSED with `broadcast_redaction_only_pii_cols`. This is the half
 *      0311 actually changes — without it the scrub could restart or erase a
 *      row's retry clock. A positive control (subject still moves) proves the
 *      GUC took effect, so "refused" cannot come from a GUC that was never set.
 *   3. `markDispatchRetryStarted` keeps the FIRST stamp (COALESCE) and cannot
 *      reach a row that is not `approved`.
 *   4. `applyTransition` clears it on a status change and on a re-time.
 *
 * Probes that must not persist run in a SAVEPOINT that is always rolled back;
 * a probe that matched no row is a failure, never a false "ok". Requires 0311
 * applied to the target branch.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

type Status = NonNullable<NewBroadcastRow['status']>;
type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];
type Patch = Partial<NewBroadcastRow>;

const SEED_AT = new Date('2026-10-01T03:00:00Z');
const FIRST_FAILURE = new Date('2026-10-04T03:00:00Z');
const LATER_FAILURE = new Date('2026-10-04T03:05:00Z');
const REDACTION_GUC = sql`SET LOCAL app.allow_broadcast_redaction = 'on'`;

class Rollback extends Error {}

describe('F119 PR-E — broadcasts.dispatch_first_failed_at (mig 0311)', () => {
  let tenant: TestTenant;

  const seed = async (status: Status): Promise<BroadcastId> => {
    const id = randomUUID();
    const row: NewBroadcastRow = {
      tenantId: tenant.ctx.slug,
      broadcastId: id,
      requestedByMemberId: randomUUID(),
      requestedByMemberPlanIdSnapshot: 'plan-pr-e',
      submittedByUserId: randomUUID(),
      actorRole: 'member_self_service',
      subject: `PR-E ${status}`,
      bodyHtml: '<p>original</p>',
      bodySource: 'original',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      estimatedRecipientCount: 10,
      status,
      submittedAt: SEED_AT,
      scheduledFor: SEED_AT,
      proposedSendAt: SEED_AT,
    };
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    return asBroadcastId(id);
  };

  const readStamp = (id: BroadcastId): Promise<Date | null> =>
    runInTenant(tenant.ctx, async (tx) => {
      const [row] = await tx
        .select({ at: broadcasts.dispatchFirstFailedAt })
        .from(broadcasts)
        .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id)));
      if (row === undefined) throw new Error(`row ${id} not found`);
      return row.at;
    });

  /** One UPDATE in a savepoint that is always rolled back; classified by message. */
  async function probe(tx: Tx, id: BroadcastId, set: Patch): Promise<string> {
    try {
      await tx.transaction(async (sp) => {
        const rows = await sp
          .update(broadcasts)
          .set(set)
          .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id)))
          .returning({ id: broadcasts.broadcastId });
        if (rows.length !== 1) throw new Error(`probe matched ${rows.length} rows`);
        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) return 'ok';
      const message = errorChainMessage(e);
      if (message.includes('broadcast_immutable_after_submit')) return 'immutable';
      if (message.includes('broadcast_redaction_only_pii_cols')) return 'redaction';
      return `other: ${message.slice(0, 160)}`;
    }
    return 'unreachable';
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('the trigger admits the stamp on a submitted and an approved row, and still refuses the frozen columns', async () => {
    const submitted = await seed('submitted');
    const approved = await seed('approved');

    const got = await runInTenant(tenant.ctx, async (tx) => ({
      submittedStamp: await probe(tx, submitted, { dispatchFirstFailedAt: FIRST_FAILURE }),
      approvedStamp: await probe(tx, approved, { dispatchFirstFailedAt: FIRST_FAILURE }),
      approvedClear: await probe(tx, approved, { dispatchFirstFailedAt: null }),
      // The frozen set is unchanged by 0311 — alone, and riding with the stamp.
      subject: await probe(tx, approved, { subject: 'changed' }),
      segment: await probe(tx, approved, { dispatchFirstFailedAt: FIRST_FAILURE, segmentType: 'tier' }),
      proposal: await probe(tx, submitted, { dispatchFirstFailedAt: FIRST_FAILURE, proposedSendAt: LATER_FAILURE }),
    }));

    expect(got).toEqual({
      submittedStamp: 'ok',
      approvedStamp: 'ok',
      approvedClear: 'ok',
      subject: 'immutable',
      segment: 'immutable',
      proposal: 'immutable',
    });
  });

  it('under the erasure GUC the column is refused (0311), while a PII column still moves (control)', async () => {
    const approved = await seed('approved');

    const got = await runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(REDACTION_GUC);
      return {
        control: await probe(tx, approved, { subject: '[redacted]' }),
        stamp: await probe(tx, approved, { dispatchFirstFailedAt: FIRST_FAILURE }),
      };
    });

    expect(got).toEqual({ control: 'ok', stamp: 'redaction' });
  });

  it('markDispatchRetryStarted keeps the FIRST stamp and never reaches a row that is not approved', async () => {
    const approved = await seed('approved');
    const submitted = await seed('submitted');
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);

    await runInTenant(tenant.ctx, (tx) =>
      repo.markDispatchRetryStarted(tx, tenant.ctx.slug, approved, FIRST_FAILURE),
    );
    await runInTenant(tenant.ctx, (tx) =>
      repo.markDispatchRetryStarted(tx, tenant.ctx.slug, approved, LATER_FAILURE),
    );
    // A row outside `approved` is not in a dispatch attempt: no stamp, no error.
    await runInTenant(tenant.ctx, (tx) =>
      repo.markDispatchRetryStarted(tx, tenant.ctx.slug, submitted, FIRST_FAILURE),
    );

    expect((await readStamp(approved))?.toISOString()).toBe(FIRST_FAILURE.toISOString());
    expect(await readStamp(submitted)).toBeNull();
    // The status was not touched.
    const status = await runInTenant(tenant.ctx, (tx) => repo.findByIdInTx(tx, tenant.ctx.slug, approved));
    expect(status?.status).toBe('approved');
    expect(status?.dispatchFirstFailedAt?.toISOString()).toBe(FIRST_FAILURE.toISOString());
  });

  it('applyTransition clears it on a status change and on a re-time', async () => {
    const leaving = await seed('approved');
    const retimed = await seed('approved');
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    for (const id of [leaving, retimed]) {
      await runInTenant(tenant.ctx, (tx) => repo.markDispatchRetryStarted(tx, tenant.ctx.slug, id, FIRST_FAILURE));
      expect(await readStamp(id)).not.toBeNull();
    }

    const left = await runInTenant(tenant.ctx, (tx) =>
      repo.applyTransition(tx, tenant.ctx.slug, leaving, 'changes_requested', {}, 'approved'),
    );
    const moved = await runInTenant(tenant.ctx, (tx) =>
      repo.applyTransition(tx, tenant.ctx.slug, retimed, 'approved', { scheduledFor: LATER_FAILURE }, 'approved'),
    );

    expect(left.dispatchFirstFailedAt).toBeNull();
    expect(moved.dispatchFirstFailedAt).toBeNull();
    expect(await readStamp(leaving)).toBeNull();
    expect(await readStamp(retimed)).toBeNull();
  });
});
