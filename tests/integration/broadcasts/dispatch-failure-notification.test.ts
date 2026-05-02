/**
 * Phase 8 / Slice E — integration test: dispatch-failure transactional
 * notification on live Neon (FR-021 / AS2).
 *
 * Verifies the end-to-end Slice E flow:
 *   1. Seed a tenant + member + plan + approved broadcast with
 *      `scheduled_for = now() - 65min` (past 1h retry budget).
 *   2. Run `dispatchScheduledBroadcast` with a Resend gateway stub
 *      that throws `retryable`.
 *   3. Slice D budget logic kicks in → row transitions to
 *      `failed_to_dispatch` + `broadcast_failed_to_dispatch` audit row.
 *   4. Slice E `enqueueDispatchFailureNotification` enqueues an
 *      outbox row with `notification_type =
 *      'broadcast_failed_to_dispatch_notification'` to the member's
 *      primary contact email.
 *   5. Tenant isolation — tenant B's outbox is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import {
  asBroadcastId,
  dispatchScheduledBroadcast,
} from '@/modules/broadcasts';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import {
  createTwoTestTenants,
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

/**
 * Stub `BroadcastsGatewayPort` that throws `retryable` on every send
 * to simulate an extended Resend outage. Slice D's 1h budget should
 * convert this into a terminal `failed_to_dispatch`.
 */
function makeRetryableGateway(): BroadcastsGatewayPort {
  return {
    async createAudience(name) {
      return { audienceId: `aud-test-${name.slice(0, 8)}` };
    },
    async addContactsToAudience() {},
    async createBroadcast() {
      return { broadcastId: 'bcast-test-1' };
    },
    async sendBroadcast() {
      throw {
        kind: 'retryable',
        subKind: 'server_5xx',
        reason: 'Resend 503 — service unavailable (test stub)',
      };
    },
    async retrieveBroadcast() {
      return { kind: 'not_found' as const };
    },
    async getAudienceContactCount() {
      return { kind: 'not_found' as const };
    },
  };
}

const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface SeedSpec {
  readonly broadcastId: string;
  readonly memberId: string;
  readonly planId: string;
  readonly subject: string;
  readonly scheduledForMinutesAgo: number; // negative offset from FROZEN_NOW
}

async function seedApprovedBroadcast(
  tenant: TestTenant,
  spec: SeedSpec,
): Promise<void> {
  const scheduledFor = new Date(
    FROZEN_NOW.getTime() - spec.scheduledForMinutesAgo * 60 * 1000,
  );
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
        ${spec.broadcastId}::uuid,
        ${spec.memberId}::uuid,
        ${spec.planId},
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
        ${0},
        ${'approved'}::broadcast_status,
        ${5},
        ${scheduledFor.toISOString()}::timestamptz,
        ${scheduledFor.toISOString()}::timestamptz,
        ${scheduledFor.toISOString()}::timestamptz,
        ${randomUUID()}::uuid,
        ${scheduledFor.toISOString()}::timestamptz,
        ${scheduledFor.toISOString()}::timestamptz
      )
    `),
  );
}

async function countOutboxRows(
  tenant: TestTenant,
  notificationType?: string,
): Promise<number> {
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

describe('Phase 8 / Slice E — dispatch-failure-notification integration (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    tenantA = t.a;
    tenantB = t.b;
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  it('past-budget retryable failure → outbox row inserted with broadcast_failed_to_dispatch_notification + tenant isolation holds', async () => {
    // Member primary contact returns null in this test (no F3 member row
    // seeded — getMemberPrimaryContact returns null which short-circuits
    // the email enqueue per Slice E best-effort guard). To test the
    // happy enqueue path, stub the membersBridge inline via a custom
    // deps assembly.
    const broadcastId = '88888888-8888-8888-8888-888888888888';
    const memberId = '99999999-9999-9999-9999-999999999999';
    await seedApprovedBroadcast(tenantA, {
      broadcastId,
      memberId,
      planId: 'plan-x',
      subject: 'Failed dispatch test',
      scheduledForMinutesAgo: 65, // past the 1h budget
    });

    const outboxCountBefore = await countOutboxRows(
      tenantA,
      'broadcast_failed_to_dispatch_notification',
    );
    const tenantBOutboxCountBefore = await countOutboxRows(tenantB);

    // Custom membersBridge override: getMemberPrimaryContact returns
    // a known email so Slice E enqueues the outbox row. Other methods
    // delegate to the real bridge (won't be called in this path).
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

    const result = await dispatchScheduledBroadcast(
      {
        tenant: tenantA.ctx,
        broadcastsRepo: makeDrizzleBroadcastsRepo(tenantA.ctx.slug),
        broadcastsGateway: makeRetryableGateway(),
        membersBridge: stubMembersBridge,
        marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantA.ctx.slug),
        eventAttendees: eventAttendeesStub,
        audit: f7AuditAdapter,
        clock: { now: () => FROZEN_NOW },
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge,
        emailTransactional: emailTransactionalBridge,
      },
      { broadcastId: asBroadcastId(broadcastId) },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_failed_to_dispatch');
    }

    // Outbox row was inserted for tenant A
    const outboxCountAfter = await countOutboxRows(
      tenantA,
      'broadcast_failed_to_dispatch_notification',
    );
    expect(outboxCountAfter).toBe(outboxCountBefore + 1);

    // Tenant B's outbox is UNCHANGED
    expect(await countOutboxRows(tenantB)).toBe(tenantBOutboxCountBefore);

    // Verify the inserted row has the correct shape
    const outboxRows = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, tenantA.ctx.slug),
            eq(
              notificationsOutbox.notificationType,
              'broadcast_failed_to_dispatch_notification' as never,
            ),
          ),
        )
        .limit(1),
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.toEmail).toBe('sender@test-tenant.example');
    const ctxData = outboxRows[0]?.contextData as Record<string, unknown>;
    expect(ctxData['broadcastId']).toBe(broadcastId);
    expect(ctxData['tenantDisplayName']).toBe('Test Chamber');
    expect(typeof ctxData['reason']).toBe('string');
    expect(ctxData['reason'] as string).toContain(
      'retry_budget_exhausted_after_1h',
    );
  });

  it('within-budget retryable failure → NO outbox row (row stays approved)', async () => {
    const broadcastId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const memberId = 'bbbbbbbb-1111-2222-3333-444444444444';
    await seedApprovedBroadcast(tenantA, {
      broadcastId,
      memberId,
      planId: 'plan-x',
      subject: 'Within-budget retry test',
      scheduledForMinutesAgo: 30, // WITHIN the 1h budget
    });

    const outboxCountBefore = await countOutboxRows(
      tenantA,
      'broadcast_failed_to_dispatch_notification',
    );

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

    const result = await dispatchScheduledBroadcast(
      {
        tenant: tenantA.ctx,
        broadcastsRepo: makeDrizzleBroadcastsRepo(tenantA.ctx.slug),
        broadcastsGateway: makeRetryableGateway(),
        membersBridge: stubMembersBridge,
        marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenantA.ctx.slug),
        eventAttendees: eventAttendeesStub,
        audit: f7AuditAdapter,
        clock: { now: () => FROZEN_NOW },
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge,
        emailTransactional: emailTransactionalBridge,
      },
      { broadcastId: asBroadcastId(broadcastId) },
    );

    // Within budget: row stays approved, gateway_retryable returned
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('gateway_retryable');
    }
    // No outbox row enqueued
    expect(
      await countOutboxRows(tenantA, 'broadcast_failed_to_dispatch_notification'),
    ).toBe(outboxCountBefore);

    // Verify the broadcast stayed in 'approved' status
    const rows = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select({ status: broadcasts.status })
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.tenantId, tenantA.ctx.slug),
            eq(broadcasts.broadcastId, broadcastId),
          ),
        ),
    );
    expect(rows[0]?.status).toBe('approved');
  });
});
