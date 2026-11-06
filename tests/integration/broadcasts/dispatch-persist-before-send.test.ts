/**
 * 2026-09-10 follow-up (9) — the property #353 shipped, proven on live Neon.
 *
 * #353 persisted `resend_broadcast_id` in its OWN transaction, before the
 * send, so a tick that dies between `sendBroadcast` returning and the status
 * flip committing leaves the resource on the row and the next tick REUSES it
 * instead of minting a second one (the F4 double-send window). Every test of
 * that property ran against doubles: `attachBroadcastId` was a recording stub,
 * `withTx` was `fn(null)`. So "the CAS refuses a different id" was asserted
 * about a repo that has no CAS.
 *
 * This file asserts the repo half against the real repo and a real row:
 * `attachBroadcastId`'s compare-and-set is enforced by SQL, not by the double —
 * the same id is idempotent, a different id throws
 * `BroadcastConcurrentMutationError`.
 *
 * Spec 140 s4 deleted the legacy dispatch leg, and with it this file's
 * end-to-end case (a retryable send on that leg left the id committed and the
 * next tick inherited it). The import tick's persist-before-send is covered by
 * `build-audience-tick-failure-paths.test.ts` ("persists the minted id BEFORE
 * the send, in its own transaction") and its inherited-draft re-entry cases,
 * and on live Neon by the re-entry cases of `audience-import-two-tick.test.ts`.
 *
 * Live Neon `dev` branch; no Resend call is made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { asBroadcastId } from '@/modules/broadcasts';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedLiveRequester } from '../helpers/seed-live-requester';

const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

/**
 * Spec 139 — the requester is a REAL live member. The plan it is seeded on
 * needs a real user as `created_by`.
 */
let requesterUser: TestUser;

async function seedApprovedBroadcast(tenant: TestTenant, broadcastId: string): Promise<void> {
  const { memberId } = await seedLiveRequester(tenant.ctx, requesterUser.userId);
  await runInTenant(tenant.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count, status,
        retention_years, scheduled_for, submitted_at, approved_at,
        approved_by_user_id, created_at, updated_at
      ) VALUES (
        ${tenant.ctx.slug},
        ${broadcastId}::uuid,
        ${memberId}::uuid,
        ${'plan-x'},
        ${randomUUID()}::uuid,
        ${'member_self_service'},
        ${'Persist-before-send test'},
        ${'<p>Body</p>'},
        ${'plain'},
        ${'Test Member via Test Chamber'},
        ${'reply@example.com'},
        ${'all_members'},
        NULL,
        NULL,
        ${0},
        ${'approved'}::broadcast_status,
        ${5},
        ${FROZEN_NOW.toISOString()}::timestamptz,
        ${FROZEN_NOW.toISOString()}::timestamptz,
        ${FROZEN_NOW.toISOString()}::timestamptz,
        ${randomUUID()}::uuid,
        ${FROZEN_NOW.toISOString()}::timestamptz,
        ${FROZEN_NOW.toISOString()}::timestamptz
      )
    `),
  );
}

async function readRow(
  tenant: TestTenant,
  broadcastId: string,
): Promise<{ status: string; resendBroadcastId: string | null; resendAudienceId: string | null } | null> {
  const rows = await runInTenant(tenant.ctx, async (tx) =>
    tx
      .select({
        status: broadcasts.status,
        resendBroadcastId: broadcasts.resendBroadcastId,
        resendAudienceId: broadcasts.resendAudienceId,
      })
      .from(broadcasts)
      .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, broadcastId))),
  );
  return rows[0] ?? null;
}

describe('dispatch — resend_broadcast_id is persisted in its OWN tx before the send (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    requesterUser = await createActiveTestUser('admin');
  });

  afterAll(async () => {
    await tenant.cleanup();
    if (requesterUser) await deleteTestUser(requesterUser).catch(() => {});
  });

  it('attachBroadcastId is a real compare-and-set: same id idempotent, different id refused by SQL', async () => {
    const broadcastId = randomUUID();
    await seedApprovedBroadcast(tenant, broadcastId);
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const bid = asBroadcastId(broadcastId);

    await repo.withTx((tx) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'bcast-cas-first', null));
    // Same value again: idempotent, no throw.
    await expect(
      repo.withTx((tx) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'bcast-cas-first', null)),
    ).resolves.toBeUndefined();
    // A DIFFERENT value: the CAS matches zero rows and the repo probes the
    // real status to name it — this is what the dispatch arm's `attach_lost`
    // reclaim keys on, and it is enforced by the UPDATE's WHERE, not a double.
    await expect(
      repo.withTx((tx) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'bcast-cas-second', null)),
    ).rejects.toBeInstanceOf(BroadcastConcurrentMutationError);

    const row = await readRow(tenant, broadcastId);
    expect(row!.resendBroadcastId).toBe('bcast-cas-first');
  });
});
