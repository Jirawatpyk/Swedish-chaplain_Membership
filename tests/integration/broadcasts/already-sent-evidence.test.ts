/**
 * Spec 139 residual 8c — `readAlreadySentEvidenceInTx` on the Drizzle
 * broadcasts repo, live Neon.
 *
 * The erasure cascade writes ONE `broadcast_concurrent_action_blocked` row
 * (`dispatchBegun: true`, `resendOutcome: 'already_sent'`) when Resend had
 * already accepted an erased member's E-Blast for sending. A re-erasure (manual,
 * or the `reconcile-erasures` re-drive) asks this read first, so the row is
 * written once per broadcast; and the count `member_erased` carries is DERIVED
 * from these rows (distinct broadcasts per member), never accumulated, so a
 * re-drive's count is authoritative (review round 1, P7).
 *
 * Tenant scoping is two-layer (Principle I): `runInTenant` (FORCE RLS) AND an
 * explicit `tenant_id` predicate. The explicit one is load-bearing: the
 * `audit_log` policy also admits `tenant_id IS NULL` rows, so the NULL-tenant
 * case below is the one that fails without it. Another tenant's row is hidden
 * by RLS as well. The tx-tenant-mismatch refusal is in the cross-tenant
 * `it.each` of `audience-import-repo.test.ts`.
 *
 * With a broadcast id the read takes an advisory lock first, so two re-drives'
 * check-then-insert cannot both miss the row: the last case holds one tx open
 * across the read and proves the second waits for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('broadcasts repo — readAlreadySentEvidenceInTx (spec 139 residual 8c)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenantA) await tenantA.cleanup();
    if (tenantB) await tenantB.cleanup();
  });

  const evidencePayload = { dispatchBegun: true, resendOutcome: 'already_sent' };

  function evidenceEvent(tenant: TestTenant | null, broadcastId: string, memberId: string, extra: Record<string, unknown>) {
    return {
      tenantId: tenant?.ctx.slug ?? null,
      eventType: 'broadcast_concurrent_action_blocked' as const,
      actorUserId: 'system',
      summary: 'spec 139 evidence fixture',
      payload: { broadcastId, memberId, cascade: 'f3_member_archival_or_erasure', ...extra },
      requestId: null,
    };
  }

  /** The row the erasure cascade writes, under `tenantId` (or none). */
  async function emitEvidence(
    tenant: TestTenant | null,
    broadcastId: string,
    memberId: string = randomUUID(),
    extra: Record<string, unknown> = evidencePayload,
  ): Promise<void> {
    const event = evidenceEvent(tenant, broadcastId, memberId, extra);
    if (tenant === null) {
      await f7AuditAdapter.emit(null, event);
      return;
    }
    await runInTenant(tenant.ctx, (tx) => f7AuditAdapter.emit(tx, event));
  }

  async function readEvidence(tenant: TestTenant, memberId: string, broadcastId: string | null) {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    return repo.withTx((tx) =>
      repo.readAlreadySentEvidenceInTx(tx, tenant.ctx.slug, {
        memberId,
        broadcastId: broadcastId === null ? null : asBroadcastId(broadcastId),
      }),
    );
  }

  it("the tenant's own already_sent row for the broadcast → recorded", async () => {
    const broadcastId = randomUUID();
    const memberId = randomUUID();
    expect(await readEvidence(tenantA, memberId, broadcastId)).toEqual({ broadcastRecorded: false, memberBroadcastCount: 0 });
    await emitEvidence(tenantA, broadcastId, memberId);
    expect(await readEvidence(tenantA, memberId, broadcastId)).toEqual({ broadcastRecorded: true, memberBroadcastCount: 1 });
  });

  it("another tenant's row for the same broadcast id and member does not count", async () => {
    const broadcastId = randomUUID();
    const memberId = randomUUID();
    await emitEvidence(tenantB, broadcastId, memberId);
    expect(await readEvidence(tenantA, memberId, broadcastId)).toEqual({ broadcastRecorded: false, memberBroadcastCount: 0 });
    expect(await readEvidence(tenantB, memberId, broadcastId)).toEqual({ broadcastRecorded: true, memberBroadcastCount: 1 });
  });

  it('a tenant-NULL row with the same payload does not count (the audit_log policy admits it; the tenant_id predicate does not)', async () => {
    const broadcastId = randomUUID();
    const memberId = randomUUID();
    await emitEvidence(null, broadcastId, memberId);
    expect(await readEvidence(tenantA, memberId, broadcastId)).toEqual({ broadcastRecorded: false, memberBroadcastCount: 0 });
  });

  it('a dispatch-begun SKIP row (no resendOutcome) or a row for another broadcast does not count', async () => {
    const broadcastId = randomUUID();
    const memberId = randomUUID();
    await emitEvidence(tenantA, broadcastId, memberId, { dispatchBegun: true });
    await emitEvidence(tenantA, randomUUID());
    expect(await readEvidence(tenantA, memberId, broadcastId)).toEqual({ broadcastRecorded: false, memberBroadcastCount: 0 });
  });

  it("the member count is DISTINCT broadcasts for that member only — a duplicate row, another member's and another tenant's change nothing", async () => {
    const memberId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await emitEvidence(tenantA, first, memberId);
    // A duplicate (e.g. written before the advisory lock existed) is one broadcast.
    await emitEvidence(tenantA, first, memberId);
    await emitEvidence(tenantA, second, memberId);
    await emitEvidence(tenantA, randomUUID(), randomUUID());
    await emitEvidence(tenantB, randomUUID(), memberId);
    expect(await readEvidence(tenantA, memberId, null)).toEqual({ broadcastRecorded: false, memberBroadcastCount: 2 });
  });

  it('with a broadcast id, a second tx waits for the first to commit, so two re-drives write ONE evidence row', async () => {
    const broadcastId = asBroadcastId(randomUUID());
    const memberId = randomUUID();
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let firstRead!: () => void;
    const firstHasRead = new Promise<void>((r) => (firstRead = r));

    // Each re-drive does what the cascade does: read under the lock, insert
    // when nothing is recorded, on the same tx.
    const redrive = (hold: boolean) =>
      repo.withTx(async (tx) => {
        const seen = await repo.readAlreadySentEvidenceInTx(tx, tenantA.ctx.slug, { memberId, broadcastId });
        if (hold) {
          firstRead();
          await released;
        }
        if (!seen.broadcastRecorded) {
          await f7AuditAdapter.emit(tx, evidenceEvent(tenantA, broadcastId as string, memberId, evidencePayload));
        }
        return seen.broadcastRecorded;
      });

    const first = redrive(true);
    await firstHasRead;
    let secondDone = false;
    const second = redrive(false).then((recorded) => {
      secondDone = true;
      return recorded;
    });
    // Short: the dev branch has statement_timeout = 0, so a wrong lock HANGS.
    await new Promise((r) => setTimeout(r, 750));
    const secondFinishedWhileFirstHeld = secondDone;
    release();
    const [firstRecorded, secondRecorded] = await Promise.all([first, second]);
    expect(secondFinishedWhileFirstHeld).toBe(false);
    expect(firstRecorded).toBe(false);
    expect(secondRecorded).toBe(true);
    expect(await readEvidence(tenantA, memberId, null)).toEqual({ broadcastRecorded: false, memberBroadcastCount: 1 });
  });
});
