/**
 * 2026-09-10 follow-up (9) — the property #353 shipped, proven on live Neon.
 *
 * #353 persisted `resend_broadcast_id` in its OWN transaction, before the
 * send, so a tick that dies between `sendBroadcast` returning and the status
 * flip committing leaves the resource on the row and the next tick REUSES it
 * instead of minting a second one (the F4 double-send window). Every test of
 * that property ran against doubles: `attachBroadcastId` was a recording stub,
 * `withTx` was `fn(null)`. So "its own tx" and "the CAS refuses a different id"
 * were asserted about a repo that has no transactions and no CAS.
 *
 * This file asserts both against the real repo and a real row:
 *
 *   1. A retryable send failure leaves `resend_broadcast_id` COMMITTED on a row
 *      still `approved` — the write survived the tick's error path, which is
 *      what "separate tx" means at the database.
 *   2. The next tick INHERITS it: no second `createBroadcast`, no second
 *      contact push, and the send is retried against the same resource.
 *   3. `attachBroadcastId`'s compare-and-set is enforced by SQL, not by the
 *      double: the same id is idempotent, a different id throws
 *      `BroadcastConcurrentMutationError`.
 *
 * `retrieveBroadcast` answers `draft` on the second tick — the one status
 * MEASURED to mean "never handed to /send" — so the gate falls through to the
 * send, exactly as it would in production after a failed send.
 *
 * Live Neon `dev` branch; no Resend call is made (the gateway is a stub).
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
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { emailTransactionalBridge } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface Tracker {
  createAudienceCalls: number;
  addContactsCalls: number;
  createBroadcastCalls: number;
  sendBroadcastCalls: number;
  retrieveCalls: number;
  deleteBroadcastCalls: string[];
}

/**
 * Stub gateway: the FIRST send throws retryable (a Resend 503), every later
 * send succeeds; `retrieveBroadcast` reports `draft`. One resource id per
 * `createBroadcast`, so a second mint would be visible as a second id.
 */
function makeGateway(tracker: Tracker): BroadcastsGatewayPort {
  return {
    async createAudience(name) {
      tracker.createAudienceCalls++;
      return { audienceId: `aud-live-${name.slice(-8)}-${randomUUID().slice(0, 8)}` };
    },
    async addContactsToAudience() {
      tracker.addContactsCalls++;
    },
    async createContactImport() {
      throw new Error('not used');
    },
    async getContactImport() {
      throw new Error('not used');
    },
    async createBroadcast() {
      tracker.createBroadcastCalls++;
      return { broadcastId: `bcast-live-${randomUUID().slice(0, 8)}` };
    },
    async sendBroadcast() {
      tracker.sendBroadcastCalls++;
      if (tracker.sendBroadcastCalls === 1) {
        throw new GatewayThrowable({
          kind: 'retryable',
          subKind: 'server_5xx',
          reason: 'resend 503 (test)',
        });
      }
    },
    async retrieveBroadcast(id) {
      tracker.retrieveCalls++;
      return { kind: 'present' as const, resource: { id, status: 'draft' as const, sentAt: null } };
    },
    async getAudienceContactCount() {
      return { count: 1, complete: true };
    },
    async removeContactFromAudience() {
      return { kind: 'detached' as const };
    },
    async deleteContactGlobally() {},
    async deleteAudience() {},
    async deleteBroadcast(id) {
      tracker.deleteBroadcastCalls.push(id);
    },
    async listAudiences() {
      return [];
    },
  };
}

async function seedApprovedBroadcast(tenant: TestTenant, broadcastId: string): Promise<void> {
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
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('a retryable send failure leaves the id COMMITTED on an approved row, and the next tick inherits it', async () => {
    const broadcastId = randomUUID();
    await seedApprovedBroadcast(tenant, broadcastId);

    const tracker: Tracker = {
      createAudienceCalls: 0,
      addContactsCalls: 0,
      createBroadcastCalls: 0,
      sendBroadcastCalls: 0,
      retrieveCalls: 0,
      deleteBroadcastCalls: [],
    };
    const gateway = makeGateway(tracker);
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
      audienceMode: 'primary_only' as const,
      audienceCeiling: 5000,
      broadcastsGateway: gateway,
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

    // ---- tick 1: the send fails AFTER createBroadcast + the persist ----------
    const first = await dispatchScheduledBroadcast(buildDeps(), {
      broadcastId: asBroadcastId(broadcastId),
    });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error('expected a retryable failure');
    expect(first.error.kind).toBe('gateway_retryable');

    const afterFirst = await readRow(tenant, broadcastId);
    expect(afterFirst).not.toBeNull();
    // The property: the id survived the error path because its tx had
    // already COMMITTED. A shared tx would have rolled it back with the tick.
    expect(afterFirst!.status).toBe('approved');
    expect(afterFirst!.resendBroadcastId).toMatch(/^bcast-live-/);
    expect(afterFirst!.resendAudienceId).toMatch(/^aud-live-/);
    const mintedId = afterFirst!.resendBroadcastId;
    expect(tracker.createBroadcastCalls).toBe(1);
    expect(tracker.addContactsCalls).toBe(1);
    expect(tracker.sendBroadcastCalls).toBe(1);
    // Nothing was reclaimed — the id is on the row, so it is not ours to delete.
    expect(tracker.deleteBroadcastCalls).toEqual([]);

    // ---- tick 2: inherits, asks Resend (draft), sends the SAME resource -----
    const second = await dispatchScheduledBroadcast(buildDeps(), {
      broadcastId: asBroadcastId(broadcastId),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected the retry to succeed');
    expect(second.value.resendBroadcastId).toBe(mintedId);

    // No second mint, no second push; one probe; the send retried once.
    expect(tracker.createBroadcastCalls).toBe(1);
    expect(tracker.addContactsCalls).toBe(1);
    expect(tracker.createAudienceCalls).toBe(1);
    expect(tracker.retrieveCalls).toBe(1);
    expect(tracker.sendBroadcastCalls).toBe(2);

    const afterSecond = await readRow(tenant, broadcastId);
    expect(afterSecond!.status).toBe('sending');
    expect(afterSecond!.resendBroadcastId).toBe(mintedId);
  });

  it('attachBroadcastId is a real compare-and-set: same id idempotent, different id refused by SQL', async () => {
    const broadcastId = randomUUID();
    await seedApprovedBroadcast(tenant, broadcastId);
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const bid = asBroadcastId(broadcastId);

    await repo.withTx((tx) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'bcast-cas-first'));
    // Same value again: idempotent, no throw.
    await expect(
      repo.withTx((tx) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'bcast-cas-first')),
    ).resolves.toBeUndefined();
    // A DIFFERENT value: the CAS matches zero rows and the repo probes the
    // real status to name it — this is what the dispatch arm's `attach_lost`
    // reclaim keys on, and it is enforced by the UPDATE's WHERE, not a double.
    await expect(
      repo.withTx((tx) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'bcast-cas-second')),
    ).rejects.toBeInstanceOf(BroadcastConcurrentMutationError);

    const row = await readRow(tenant, broadcastId);
    expect(row!.resendBroadcastId).toBe('bcast-cas-first');
  });
});
