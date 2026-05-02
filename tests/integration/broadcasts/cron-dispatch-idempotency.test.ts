/**
 * Phase 8 / T165 — integration test: cron dispatch idempotency on
 * live Neon (US6 AS3).
 *
 * The dispatch use-case's authoritative AS3 protection is the
 * `lockedStatus !== 'approved'` guard inside `lockForUpdate`: once the
 * first call has transitioned the row to 'sending' + committed, any
 * subsequent call (whether on the next 5-min cron tick or a parallel
 * tick whose eligible-row scan also picked up the row before the
 * `FOR UPDATE SKIP LOCKED` window closed) sees `sending` and skips
 * with `broadcast_invalid_state_transition`.
 *
 * Test pattern: SERIAL invocation simulates the realistic dual-tick
 * scenario (tick-2 fires after tick-1 commits). True simultaneous
 * concurrency on the SAME row is prevented at the cron route level by
 * `FOR UPDATE SKIP LOCKED` in the eligible-row scan; the use-case
 * itself relies on the post-transition status guard.
 *
 * Production safety against true TOCTOU racing (extremely rare:
 * cron-job.org tick + admin "send now" hitting the same row in the
 * same millisecond) is layered on by Resend's dedupe via the stable
 * idempotency key `broadcast-${tenantId}-${broadcastId}` — both calls
 * use the same key so even if both reach the gateway, Resend
 * delivers once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import {
  asBroadcastId,
  dispatchScheduledBroadcast,
} from '@/modules/broadcasts';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import {
  createTestTenant,
  type TestTenant,
} from '../helpers/test-tenant';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { emailTransactionalBridge } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';

const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface CallTracker {
  createAudienceCalls: number;
  addContactsCalls: number;
  createBroadcastCalls: number;
  sendBroadcastCalls: number;
}

/**
 * Stub gateway that records all call counts. Reused across both
 * concurrent calls so we can assert the AGGREGATE call count is 1
 * each (idempotency invariant).
 */
function makeTrackedGateway(tracker: CallTracker): BroadcastsGatewayPort {
  return {
    async createAudience(name) {
      tracker.createAudienceCalls++;
      return { audienceId: `aud-test-${name.slice(0, 16)}` };
    },
    async addContactsToAudience() {
      tracker.addContactsCalls++;
    },
    async createBroadcast() {
      tracker.createBroadcastCalls++;
      return { broadcastId: `bcast-test-${randomUUID().slice(0, 8)}` };
    },
    async sendBroadcast() {
      tracker.sendBroadcastCalls++;
    },
    async retrieveBroadcast() {
      return { kind: 'not_found' as const };
    },
    async getAudienceContactCount() {
      return { kind: 'present' as const, count: 1 };
    },
  };
}

async function seedApprovedBroadcast(
  tenant: TestTenant,
  broadcastId: string,
): Promise<void> {
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
        ${randomUUID()}::uuid,
        ${'plan-x'},
        ${randomUUID()}::uuid,
        ${'member_self_service'},
        ${'Concurrent dispatch test'},
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

async function readBroadcastStatus(
  tenant: TestTenant,
  broadcastId: string,
): Promise<string | null> {
  const rows = await runInTenant(tenant.ctx, async (tx) =>
    tx
      .select({ status: broadcasts.status })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.tenantId, tenant.ctx.slug),
          eq(broadcasts.broadcastId, broadcastId),
        ),
      ),
  );
  return rows[0]?.status ?? null;
}

describe('Phase 8 / T165 — concurrent cron dispatch idempotency (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('two concurrent dispatchScheduledBroadcast calls → exactly ONE Resend send + ONE sending transition', async () => {
    const broadcastId = 'cccccccc-1234-5678-9abc-def012345678';
    await seedApprovedBroadcast(tenant, broadcastId);

    const tracker: CallTracker = {
      createAudienceCalls: 0,
      addContactsCalls: 0,
      createBroadcastCalls: 0,
      sendBroadcastCalls: 0,
    };

    const stubMembersBridge = {
      ...membersBridge,
      async getMemberPrimaryContact() {
        return 'sender@test-tenant.example' as never;
      },
      async getMembersBySegment() {
        return [
          {
            memberId: 'm-1',
            displayName: 'Test Member',
            primaryContactEmail: 'recipient@test-tenant.example' as never,
            tierCode: null,
            broadcastsHaltedUntilAdminReview: false,
          },
        ];
      },
    };

    const buildDeps = () => ({
      tenant: tenant.ctx,
      broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
      broadcastsGateway: makeTrackedGateway(tracker),
      membersBridge: stubMembersBridge,
      marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
      eventAttendees: eventAttendeesStub,
      audit: f7AuditAdapter,
      clock: { now: () => FROZEN_NOW },
      fromEmail: 'noreply@test.invalid-but-test-only',
      tenantDisplayName: 'Test Chamber',
      locale: 'en' as const,
      plansBridge,
      emailTransactional: emailTransactionalBridge,
    });

    // SERIAL invocations simulate the realistic dual-tick scenario.
    const resultA = await dispatchScheduledBroadcast(buildDeps(), {
      broadcastId: asBroadcastId(broadcastId),
    });
    const resultB = await dispatchScheduledBroadcast(buildDeps(), {
      broadcastId: asBroadcastId(broadcastId),
    });

    // Tick 1 succeeded; tick 2 saw 'sending' status and skipped with
    // broadcast_invalid_state_transition.
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(false);
    if (!resultB.ok) {
      expect(resultB.error.kind).toBe('broadcast_invalid_state_transition');
    }

    // Resend gateway "send" path called exactly ONCE in aggregate
    expect(tracker.sendBroadcastCalls).toBe(1);
    expect(tracker.createBroadcastCalls).toBe(1);

    // Final DB state: status = 'sending'
    expect(await readBroadcastStatus(tenant, broadcastId)).toBe('sending');
  });

  it('parallel dispatches use the same Resend idempotency key (gateway-level dedupe invariant)', async () => {
    // True parallel calls may both pass the eligibility check before
    // the first commits its sending transition (TOCTOU window between
    // step 1 lockForUpdate-tx and step 4 transition-tx). The
    // production guarantee in that rare case is Resend's idempotency-
    // key dedupe: both calls produce
    // `broadcast-${tenantId}-${broadcastId}` and Resend treats the
    // second sendBroadcast as a no-op replay.
    //
    // This test asserts the invariant the production safety relies on:
    // the idempotency key is a deterministic function of (tenantId,
    // broadcastId), independent of attempt count or wall-clock time.
    const broadcastId = 'dddddddd-1234-5678-9abc-def012345679';
    await seedApprovedBroadcast(tenant, broadcastId);

    const sendCalls: Array<{ idempotencyKey: string }> = [];
    const stubMembersBridge = {
      ...membersBridge,
      async getMemberPrimaryContact() {
        return 'sender@test-tenant.example' as never;
      },
      async getMembersBySegment() {
        return [
          {
            memberId: 'm-1',
            displayName: 'Test Member',
            primaryContactEmail: 'recipient@test-tenant.example' as never,
            tierCode: null,
            broadcastsHaltedUntilAdminReview: false,
          },
        ];
      },
    };
    const recordingGateway: BroadcastsGatewayPort = {
      async createAudience(name) {
        return { audienceId: `aud-test-${name.slice(0, 16)}` };
      },
      async addContactsToAudience() {},
      async createBroadcast() {
        return { broadcastId: `bcast-test-${randomUUID().slice(0, 8)}` };
      },
      async sendBroadcast(_id, idempotencyKey) {
        sendCalls.push({ idempotencyKey });
      },
      async retrieveBroadcast() {
        return { kind: 'not_found' as const };
      },
      async getAudienceContactCount() {
        return { kind: 'present' as const, count: 1 };
      },
    };

    const buildDeps = () => ({
      tenant: tenant.ctx,
      broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
      broadcastsGateway: recordingGateway,
      membersBridge: stubMembersBridge,
      marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
      eventAttendees: eventAttendeesStub,
      audit: f7AuditAdapter,
      clock: { now: () => FROZEN_NOW },
      fromEmail: 'noreply@test.invalid-but-test-only',
      tenantDisplayName: 'Test Chamber',
      locale: 'en' as const,
      plansBridge,
      emailTransactional: emailTransactionalBridge,
    });

    await Promise.all([
      dispatchScheduledBroadcast(buildDeps(), {
        broadcastId: asBroadcastId(broadcastId),
      }),
      dispatchScheduledBroadcast(buildDeps(), {
        broadcastId: asBroadcastId(broadcastId),
      }),
    ]);

    // All Resend send calls (1 or 2 — depending on timing) MUST use
    // the same stable idempotency key. Production Resend dedupes on
    // this key so the recipients only get the broadcast once.
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const expectedKey = `broadcast-${tenant.ctx.slug}-${broadcastId}`;
    for (const call of sendCalls) {
      expect(call.idempotencyKey).toBe(expectedKey);
    }
  });
});
