/**
 * Phase 8 / Slice E — integration test: dispatch-failure transactional
 * notification on live Neon (FR-021 / AS2), through `buildAudienceTick`.
 *
 * Spec 140 s4 deleted the legacy dispatch leg this file used to drive; the two
 * cases were ported to the import tick, the only dispatch leg (plan.md § Slice 4
 * — plan review, row 7: ported, not deleted).
 *
 * Verifies the end-to-end Slice E flow:
 *   1. Seed two tenants, a live requesting member and an approved broadcast
 *      whose current dispatch attempt FIRST failed 65 min ago
 *      (`dispatch_first_failed_at`, F119 PR-E / 0311 — the budget counts from
 *      the first retryable failure, read by `_dispatch-retry-epoch.ts`).
 *   2. Run `buildAudienceTick` with a gateway fake whose `createAudience`
 *      throws `retryable` (an extended Resend outage on tick 1).
 *   3. The budget is spent → the row goes `failed_to_dispatch`.
 *   4. `enqueueDispatchFailureNotification` enqueues an outbox row with
 *      `notification_type = 'broadcast_failed_to_dispatch_notification'` to the
 *      requesting member's primary contact.
 *   5. Tenant isolation (Principle I) — tenant B's outbox is unchanged.
 *
 * **The gateway is a fake, never real Resend**: dev and prod share the Resend
 * Broadcasts key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { ok } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { asBroadcastId } from '@/modules/broadcasts';
import { buildAudienceTick, type BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedLiveRequester } from '../helpers/seed-live-requester';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { emailTransactionalBridge } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleBroadcastOrphansRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-orphans-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { membershipAccessBridge } from '@/modules/broadcasts/infrastructure/membership-access-bridge';

/**
 * F119 PR-A — the send-time standing reads, REAL on both halves (the F3 halt
 * list + the F8 access bridge): the seeded requesting member is neither halted
 * nor has a renewal cycle, so both answer "in good standing" and the tick runs.
 */
const LIVE_STANDING = { membersBridge, haltReadFresh: membersBridge, membershipAccess: membershipAccessBridge };

/** F119 — dispatch deps require a brand port; these cases send with no brand configured. */
const NO_BRAND_CHROME = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

/**
 * A gateway whose tick-1 `createAudience` throws `retryable`: an extended
 * Resend outage. Every other method records itself and throws — nothing past
 * the audience create may run on these rows.
 */
function makeRetryableGateway(calls: string[]): BroadcastsGatewayPort {
  const notUsed = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error(`${name} is not used here`);
  };
  return {
    async createAudience() {
      calls.push('createAudience');
      throw {
        kind: 'retryable',
        subKind: 'server_5xx',
        reason: 'Resend 503 — service unavailable (test stub)',
      };
    },
    createContactImport: notUsed('createContactImport'),
    getContactImport: notUsed('getContactImport'),
    createBroadcast: notUsed('createBroadcast'),
    sendBroadcast: notUsed('sendBroadcast'),
    retrieveBroadcast: notUsed('retrieveBroadcast'),
    getAudienceContactCount: notUsed('getAudienceContactCount'),
    removeContactFromAudience: notUsed('removeContactFromAudience'),
    deleteAudience: notUsed('deleteAudience'),
    deleteBroadcastOnce: notUsed('deleteBroadcastOnce'),
    retrieveBroadcastOnce: notUsed('retrieveBroadcastOnce'),
    deleteBroadcast: notUsed('deleteBroadcast'),
    listAudiences: notUsed('listAudiences'),
  };
}

/**
 * Spec 139 — the requester is a REAL live member: the send-standing gate
 * refuses a `requested_by_member_id` with no `members` row like an erased one
 * (P4). The plan it is seeded on needs a real user as `created_by`.
 */
let requesterUser: TestUser;

interface SeedSpec {
  readonly broadcastId: string;
  readonly subject: string;
  /**
   * F119 PR-E — when the attempt first failed (the FR-021 anchor), minutes
   * before now. Omitted = NULL, i.e. no failure yet.
   */
  readonly firstFailedMinutesAgo?: number;
}

async function seedApprovedBroadcast(tenant: TestTenant, spec: SeedSpec): Promise<void> {
  const firstFailedAt =
    spec.firstFailedMinutesAgo === undefined
      ? null
      : new Date(Date.now() - spec.firstFailedMinutesAgo * 60 * 1000).toISOString();
  const requester = await seedLiveRequester(tenant.ctx, requesterUser.userId);
  await runInTenant(tenant.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count, status,
        retention_years, scheduled_for, submitted_at, approved_at,
        approved_by_user_id, dispatch_first_failed_at
      ) VALUES (
        ${tenant.ctx.slug},
        ${spec.broadcastId}::uuid,
        ${requester.memberId}::uuid,
        ${requester.planId},
        ${randomUUID()}::uuid,
        ${'member_self_service'},
        ${spec.subject},
        ${'<p>Body</p>'},
        ${'plain'},
        ${'Test Member via Test Chamber'},
        ${'reply@example.com'},
        ${'all_members'},
        NULL,
        NULL,
        ${1},
        ${'approved'}::broadcast_status,
        ${5},
        now() - interval '65 minutes',
        now() - interval '65 minutes',
        now() - interval '65 minutes',
        ${randomUUID()}::uuid,
        ${firstFailedAt}::timestamptz
      )
    `),
  );
}

async function countOutboxRows(tenant: TestTenant, notificationType?: string): Promise<number> {
  const where = notificationType
    ? and(
        eq(notificationsOutbox.tenantId, tenant.ctx.slug),
        eq(notificationsOutbox.notificationType, notificationType as never),
      )
    : eq(notificationsOutbox.tenantId, tenant.ctx.slug);
  return runInTenant(tenant.ctx, async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(notificationsOutbox)
      .where(where);
    return rows[0]?.n ?? 0;
  });
}

/**
 * The tick's deps on the REAL repo, audit adapter and outbox bridge. The
 * requester's primary contact is stubbed to a known address so the FR-021 email
 * is enqueued; every other members-bridge read delegates to the real bridge.
 * The resolver is injected: this file tests the budget and the notification,
 * not the audience query.
 */
function makeDeps(tenant: TestTenant, gateway: BroadcastsGatewayPort): BuildAudienceTickDeps {
  return {
    tenant: tenant.ctx,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
    orphans: makeDrizzleBroadcastOrphansRepo(tenant.ctx.slug),
    broadcastsGateway: gateway,
    brandChrome: NO_BRAND_CHROME,
    audit: f7AuditAdapter,
    clock: systemClock,
    tickBudget: { tickStartedAt: Date.now() },
    fromEmail: 'noreply@test.invalid-but-test-only',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    resolveRecipients: async () =>
      ok({ recipients: ['recipient@test-tenant.example'], estimatedCount: 1, orphans: [], droppedByPreference: 0 }),
    membersBridge: {
      ...membersBridge,
      async getMemberPrimaryContact() {
        return 'sender@test-tenant.example' as never;
      },
    },
    emailTransactional: emailTransactionalBridge,
    plansBridge,
    sendStanding: LIVE_STANDING,
  };
}

async function readRow(tenant: TestTenant, broadcastId: string) {
  const rows = await runInTenant(tenant.ctx, async (tx) =>
    tx
      .select({ status: broadcasts.status, failureReason: broadcasts.failureReason })
      .from(broadcasts)
      .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, broadcastId))),
  );
  return rows[0];
}

describe('Phase 8 / Slice E — dispatch-failure-notification integration (live Neon, import tick)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    requesterUser = await createActiveTestUser('admin');
    tenantA = t.a;
    tenantB = t.b;
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
    if (requesterUser) await deleteTestUser(requesterUser).catch(() => {});
  });

  it('past-budget retryable failure → outbox row inserted with broadcast_failed_to_dispatch_notification + tenant isolation holds', async () => {
    const broadcastId = randomUUID();
    await seedApprovedBroadcast(tenantA, {
      broadcastId,
      subject: 'Failed dispatch test',
      firstFailedMinutesAgo: 65, // past the 1h budget, counted from the first failure
    });

    const outboxCountBefore = await countOutboxRows(tenantA, 'broadcast_failed_to_dispatch_notification');
    const tenantBOutboxCountBefore = await countOutboxRows(tenantB);

    const calls: string[] = [];
    const result = await buildAudienceTick(makeDeps(tenantA, makeRetryableGateway(calls)), {
      broadcastId: asBroadcastId(broadcastId),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'audience_import_failed', reason: 'retry_budget_exhausted' });
    }
    expect(calls).toEqual(['createAudience']);

    // Outbox row was inserted for tenant A
    expect(await countOutboxRows(tenantA, 'broadcast_failed_to_dispatch_notification')).toBe(outboxCountBefore + 1);

    // Tenant B's outbox is UNCHANGED (Principle I, cross-tenant).
    expect(await countOutboxRows(tenantB)).toBe(tenantBOutboxCountBefore);

    // Verify the inserted row has the correct shape
    const outboxRows = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, tenantA.ctx.slug),
            eq(notificationsOutbox.notificationType, 'broadcast_failed_to_dispatch_notification' as never),
          ),
        )
        .limit(1),
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.toEmail).toBe('sender@test-tenant.example');
    const ctxData = outboxRows[0]?.contextData as Record<string, unknown>;
    expect(ctxData['broadcastId']).toBe(broadcastId);
    expect(ctxData['tenantDisplayName']).toBe('Test Chamber');
    // Round 4 L1 — the member-facing value is the TOKEN the email builder looks
    // up (a composite matched no i18n key and fell to `generic`).
    expect(ctxData['reason']).toBe('retry_budget_exhausted');

    const row = await readRow(tenantA, broadcastId);
    expect(row?.status).toBe('failed_to_dispatch');
    expect(row?.failureReason).toBe('retry_budget_exhausted');
  });

  it('within-budget retryable failure → NO outbox row (row stays approved)', async () => {
    const broadcastId = randomUUID();
    await seedApprovedBroadcast(tenantA, {
      broadcastId,
      subject: 'Within-budget retry test',
      // No first failure yet: this failure stamps the clock, 0 ms into the hour.
    });

    const outboxCountBefore = await countOutboxRows(tenantA, 'broadcast_failed_to_dispatch_notification');

    const calls: string[] = [];
    const result = await buildAudienceTick(makeDeps(tenantA, makeRetryableGateway(calls)), {
      broadcastId: asBroadcastId(broadcastId),
    });

    // Within budget: transient, the row stays approved for the next tick.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'dispatch.server_error', phase: 'gateway' });
    }
    expect(await countOutboxRows(tenantA, 'broadcast_failed_to_dispatch_notification')).toBe(outboxCountBefore);

    const row = await readRow(tenantA, broadcastId);
    expect(row?.status).toBe('approved');
  });
});
