/**
 * Spec 139 residual 8c — `hasAlreadySentEvidenceInTx` on the Drizzle
 * broadcasts repo, live Neon.
 *
 * The erasure cascade writes ONE `broadcast_concurrent_action_blocked` row
 * (`dispatchBegun: true`, `resendOutcome: 'already_sent'`) when Resend had
 * already accepted an erased member's E-Blast for sending. A re-erasure (manual,
 * or the `reconcile-erasures` re-drive) asks this read first, so the row is
 * written once per broadcast.
 *
 * Tenant scoping is two-layer (Principle I): `runInTenant` (FORCE RLS) AND an
 * explicit `tenant_id` predicate. The explicit one is load-bearing: the
 * `audit_log` policy also admits `tenant_id IS NULL` rows, so the NULL-tenant
 * case below is the one that fails without it. Another tenant's row is hidden
 * by RLS as well. The tx-tenant-mismatch refusal is in the cross-tenant
 * `it.each` of `audience-import-repo.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('broadcasts repo — hasAlreadySentEvidenceInTx (spec 139 residual 8c)', () => {
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

  /** The row the erasure cascade writes, under `tenantId` (or none). */
  async function emitEvidence(
    tenant: TestTenant | null,
    broadcastId: string,
    extra: Record<string, unknown> = { dispatchBegun: true, resendOutcome: 'already_sent' },
  ): Promise<void> {
    const event = {
      tenantId: tenant?.ctx.slug ?? null,
      eventType: 'broadcast_concurrent_action_blocked' as const,
      actorUserId: 'system',
      summary: 'spec 139 evidence fixture',
      payload: { broadcastId, cascade: 'f3_member_archival_or_erasure', ...extra },
      requestId: null,
    };
    if (tenant === null) {
      await f7AuditAdapter.emit(null, event);
      return;
    }
    await runInTenant(tenant.ctx, (tx) => f7AuditAdapter.emit(tx, event));
  }

  async function hasEvidence(tenant: TestTenant, broadcastId: string): Promise<boolean> {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    return repo.withTx((tx) => repo.hasAlreadySentEvidenceInTx(tx, tenant.ctx.slug, asBroadcastId(broadcastId)));
  }

  it("the tenant's own already_sent row for the broadcast → true", async () => {
    const broadcastId = randomUUID();
    expect(await hasEvidence(tenantA, broadcastId)).toBe(false);
    await emitEvidence(tenantA, broadcastId);
    expect(await hasEvidence(tenantA, broadcastId)).toBe(true);
  });

  it("another tenant's row for the same broadcast id does not count", async () => {
    const broadcastId = randomUUID();
    await emitEvidence(tenantB, broadcastId);
    expect(await hasEvidence(tenantA, broadcastId)).toBe(false);
    expect(await hasEvidence(tenantB, broadcastId)).toBe(true);
  });

  it('a tenant-NULL row with the same payload does not count (the audit_log policy admits it; the tenant_id predicate does not)', async () => {
    const broadcastId = randomUUID();
    await emitEvidence(null, broadcastId);
    expect(await hasEvidence(tenantA, broadcastId)).toBe(false);
  });

  it('a dispatch-begun SKIP row (no resendOutcome) or a row for another broadcast does not count', async () => {
    const broadcastId = randomUUID();
    await emitEvidence(tenantA, broadcastId, { dispatchBegun: true });
    await emitEvidence(tenantA, randomUUID());
    expect(await hasEvidence(tenantA, broadcastId)).toBe(false);
  });
});
