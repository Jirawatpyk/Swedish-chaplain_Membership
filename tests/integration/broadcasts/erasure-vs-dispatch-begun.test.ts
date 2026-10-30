/**
 * Spec 139 DE3 — a dispatch tick racing the erasure cascade sends NOTHING, on
 * live Postgres (Neon `dev`) through the real repo, the real cascade and both
 * real dispatch legs. Only Resend is a fake, and it models the arbitration
 * MEASURED on the live account (2026-10-29, spec 138):
 *
 *   - `DELETE /broadcasts/{id}` succeeds only on a DRAFT (a queued or sent
 *     broadcast answers 403);
 *   - `/send` works only on a draft; after a DELETE it answers 404, and so
 *     does GET.
 *
 * Both legs persist `resend_broadcast_id` BEFORE `/send`, so the cascade can
 * meet an `approved` row whose draft is minted but not yet sent. Until 139 it
 * skipped that row and the tick sent the erased member's pre-scrub E-Blast.
 * Now, under the row lock, it DELETEs the draft once and cancels the row:
 *
 *   1. legacy leg — the tick is parked between its persist and `/send`; the
 *      cascade deletes and cancels; the released `/send` 404s, the tick's
 *      re-read sees `cancelled` and answers a concurrent skip (P8). Nothing
 *      was accepted for sending.
 *   2. import leg, tick 2 — the same race through `confirmImport`'s mint,
 *      persist and send: the 404 is `sendLostToHold`'s concurrent skip.
 *   3. import leg, the RE-MINT window — the cascade holds the row lock while
 *      the tick probes the inherited id it has just deleted (`not_found`
 *      twice), mints a fresh broadcast from the row and tries to persist it.
 *      That CAS waits on the cascade's lock, then sees `cancelled`, so the
 *      fresh resource is reclaimed and nothing is sent.
 *
 * The cascade is called directly in its erasure mode (`onDispatchBegun:
 * 'delete_then_cancel'`) — the member-side composition is proven in the
 * members unit suite; the standing gate here reads a LIVE member, which is the
 * window this file is about (the erasure lands after the gate passed).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { ok } from '@/lib/result';
import {
  asBroadcastId,
  buildAudienceTick,
  cancelInFlightBroadcastsForMember,
  dispatchScheduledBroadcast,
  makeCancelInFlightBroadcastsForMemberDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { emailTransactionalBridge } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { membershipAccessBridge } from '@/modules/broadcasts/infrastructure/membership-access-bridge';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const LIVE_STANDING = { membersBridge, membershipAccess: membershipAccessBridge };
const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };
const RECIPIENT = 'de3-recipient@example.com';

/** A gate a test opens by hand. */
function gate(): { readonly reached: Promise<void>; readonly open: () => void; readonly wait: () => Promise<void> } {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const opened = new Promise<void>((r) => (open = r));
  return {
    reached,
    open,
    wait: async () => {
      reach();
      await opened;
    },
  };
}

/**
 * Resend, as MEASURED: a draft can be deleted or sent; a deleted resource 404s
 * on `/send` and GET; a sent one answers 403 to DELETE. `parkSend` / `parkDelete`
 * / `parkFirstProbe` hold the named call open until the test releases it.
 */
function fakeResend(opts: { parkSend?: ReturnType<typeof gate>; parkDelete?: ReturnType<typeof gate>; parkFirstProbe?: ReturnType<typeof gate> } = {}) {
  const state = new Map<string, 'draft' | 'queued' | 'deleted'>();
  const accepted: string[] = [];
  const reclaimed: string[] = [];
  const calls: string[] = [];
  let probes = 0;
  const port = {
    async createAudience() {
      calls.push('createAudience');
      return { audienceId: `aud-de3-${randomUUID().slice(0, 8)}` };
    },
    async addContactsToAudience() {
      calls.push('addContactsToAudience');
    },
    async createContactImport() {
      calls.push('createContactImport');
      return { importId: `imp-de3-${randomUUID().slice(0, 8)}` };
    },
    async getContactImport() {
      calls.push('getContactImport');
      return { status: 'completed', counts: { total: 1, created: 1, updated: 0, skipped: 0, failed: 0 } };
    },
    async getAudienceContactCount() {
      calls.push('getAudienceContactCount');
      return { count: 1, complete: true };
    },
    async createBroadcast() {
      calls.push('createBroadcast');
      const id = `rb-de3-${randomUUID()}`;
      state.set(id, 'draft');
      return { broadcastId: id };
    },
    async sendBroadcast(id: string) {
      calls.push('sendBroadcast');
      if (opts.parkSend !== undefined) await opts.parkSend.wait();
      const s = state.get(id);
      if (s === 'deleted' || s === undefined) {
        throw new GatewayThrowable({ kind: 'resource_missing', resourceType: 'broadcast', resourceId: id, reason: 'Broadcast not found' });
      }
      if (s !== 'draft') {
        throw new GatewayThrowable({ kind: 'permanent', code: 'validation_error', reason: 'Only draft broadcasts can be sent or scheduled' });
      }
      state.set(id, 'queued');
      accepted.push(id);
    },
    async retrieveBroadcast(id: string) {
      calls.push('retrieveBroadcast');
      probes += 1;
      if (probes === 1 && opts.parkFirstProbe !== undefined) await opts.parkFirstProbe.wait();
      const s = state.get(id);
      if (s === undefined || s === 'deleted') return { kind: 'not_found' as const };
      return { kind: 'present' as const, resource: { id, status: s, sentAt: null } };
    },
    // The cascade's bounded probe under the row lock: the same state.
    async retrieveBroadcastOnce(id: string) {
      calls.push('retrieveBroadcastOnce');
      const s = state.get(id);
      if (s === undefined || s === 'deleted') return { kind: 'not_found' as const };
      return { kind: 'present' as const, status: s };
    },
    async deleteBroadcastOnce(id: string) {
      calls.push('deleteBroadcastOnce');
      const s = state.get(id);
      if (s === 'queued') return { kind: 'forbidden' as const };
      if (s === undefined || s === 'deleted') return { kind: 'absent' as const };
      state.set(id, 'deleted');
      if (opts.parkDelete !== undefined) await opts.parkDelete.wait();
      return { kind: 'deleted' as const };
    },
    async deleteBroadcast(id: string) {
      calls.push('deleteBroadcast');
      reclaimed.push(id);
      state.set(id, 'deleted');
    },
    async deleteAudience() {
      calls.push('deleteAudience');
    },
    async removeContactFromAudience() {
      return { kind: 'detached' as const };
    },
    async deleteContactGlobally() {},
    async listAudiences() {
      return [];
    },
  } satisfies BroadcastsGatewayPort;
  return { port, state, accepted, reclaimed, calls };
}

describe('spec 139 DE3 — the erasure cascade vs a dispatch tick past its persist (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `p139-de3-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'DE3 Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (user) await deleteTestUser(user).catch(() => {});
  }, 120_000);

  /** A live member (no cycle: F8 access `full`, not halted) and an `approved` row of theirs. */
  async function seed(patch: Partial<NewBroadcastRow> = {}): Promise<{ memberId: string; broadcastId: string }> {
    const memberId = randomUUID();
    const broadcastId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'DE3 Race Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'Pre-scrub subject',
        bodyHtml: '<p>Pre-scrub body</p>',
        bodySource: 'plain',
        fromName: 'DE3 Race Co via Test Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'approved',
        submittedAt: new Date(Date.now() - 86_400_000),
        approvedAt: new Date(Date.now() - 3_600_000),
        scheduledFor: new Date(Date.now() - 60_000),
        ...patch,
      });
    });
    return { memberId, broadcastId };
  }

  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  const eraseCascade = (memberId: string, gateway: BroadcastsGatewayPort) =>
    cancelInFlightBroadcastsForMember(
      { ...makeCancelInFlightBroadcastsForMemberDeps(tenant.ctx.slug), broadcastsGateway: gateway },
      {
        tenant: tenant.ctx,
        memberId: asMemberId(memberId),
        cancellationReason: 'gdpr_erasure_request',
        requestId: null,
        onDispatchBegun: 'delete_then_cancel',
      },
    );

  const legacyDeps = (gateway: BroadcastsGatewayPort) => ({
    tenant: tenant.ctx,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
    audienceMode: 'primary_only' as const,
    audienceCeiling: 5000,
    broadcastsGateway: gateway,
    // The audience is stubbed (this file is about the race, not the query); the
    // standing reads below are the REAL bridges.
    membersBridge: {
      ...membersBridge,
      async getMemberPrimaryContact() {
        return 'sender@example.com' as never;
      },
      async getMembersBySegment() {
        return [
          {
            memberId: randomUUID(),
            displayName: 'Recipient Co',
            primaryContactEmail: RECIPIENT as never,
            tierCode: null,
            broadcastsHaltedUntilAdminReview: false,
          },
        ];
      },
    },
    marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
    eventAttendees: eventAttendeesStub,
    audit: f7AuditAdapter,
    clock: { now: () => new Date() },
    fromEmail: 'noreply@test.invalid-but-test-only',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    plansBridge,
    emailTransactional: emailTransactionalBridge,
    sendStanding: LIVE_STANDING,
    brandChrome: NO_BRAND,
  });

  const importDeps = (gateway: BroadcastsGatewayPort, reprobePauses: number[]) => ({
    tenant: tenant.ctx,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
    broadcastsGateway: gateway,
    audit: f7AuditAdapter,
    clock: { now: () => new Date() },
    fromEmail: 'noreply@test.invalid-but-test-only',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    resolveRecipients: async () => ok({ recipients: [RECIPIENT], estimatedCount: 1, orphans: [], droppedByPreference: 0 }),
    membersBridge: { ...membersBridge, getMemberPrimaryContact: async () => null, getMemberPreferredLocale: async () => 'en' as const },
    emailTransactional: { sendMemberEmail: async () => undefined },
    plansBridge: { getPlanForMember: async () => ok({ planId, planCode: 'REG', eblastPerYear: 4 }) },
    sendStanding: LIVE_STANDING,
    brandChrome: NO_BRAND,
    pauseBeforeReprobe: async (ms: number) => {
      reprobePauses.push(ms);
    },
  });

  it('legacy leg: the cascade deletes the persisted draft and cancels the row; the released /send 404s into a concurrent skip — nothing is sent', async () => {
    const { memberId, broadcastId } = await seed();
    const parkSend = gate();
    const resend = fakeResend({ parkSend });

    const tickP = dispatchScheduledBroadcast(legacyDeps(resend.port) as never, { broadcastId: asBroadcastId(broadcastId) });
    await parkSend.reached;
    // The tick has persisted its draft and is at `/send`, holding no lock.
    const persisted = (await readRow(broadcastId)).resendBroadcastId!;
    expect(resend.state.get(persisted)).toBe('draft');

    const cascaded = await eraseCascade(memberId, resend.port);
    parkSend.open();
    const tick = await tickP;

    expect(cascaded).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
    expect(tick).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' } });
    expect(resend.accepted).toEqual([]);
    expect(resend.state.get(persisted)).toBe('deleted');
    expect(await readRow(broadcastId)).toMatchObject({ status: 'cancelled', cancellationReason: 'gdpr_erasure_request' });
  });

  it('import leg, tick 2: the cascade deletes the freshly persisted draft and cancels; the /send 404 is a concurrent skip — nothing is sent', async () => {
    const { memberId, broadcastId } = await seed({
      resendAudienceId: `aud-de3-${randomUUID().slice(0, 8)}`,
      audienceImportId: `imp-de3-${randomUUID().slice(0, 8)}`,
      audienceImportSubmittedAt: new Date(Date.now() - 120_000),
    });
    const parkSend = gate();
    const resend = fakeResend({ parkSend });

    const tickP = buildAudienceTick(importDeps(resend.port, []) as never, { broadcastId: asBroadcastId(broadcastId) });
    await parkSend.reached;
    const persisted = (await readRow(broadcastId)).resendBroadcastId!;
    expect(resend.state.get(persisted)).toBe('draft');

    const cascaded = await eraseCascade(memberId, resend.port);
    parkSend.open();
    const tick = await tickP;

    expect(cascaded).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
    expect(tick).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' } });
    expect(resend.accepted).toEqual([]);
    expect((await readRow(broadcastId)).status).toBe('cancelled');
  });

  it('import leg, the re-mint window: the tick re-mints over the id the cascade just deleted, its persist CAS waits on the cascade lock, sees cancelled, and the fresh draft is reclaimed — nothing is sent', async () => {
    const inherited = `rb-de3-inherited-${randomUUID()}`;
    const { memberId, broadcastId } = await seed({
      resendAudienceId: `aud-de3-${randomUUID().slice(0, 8)}`,
      audienceImportId: `imp-de3-${randomUUID().slice(0, 8)}`,
      audienceImportSubmittedAt: new Date(Date.now() - 120_000),
      resendBroadcastId: inherited,
    });
    const parkFirstProbe = gate();
    const parkDelete = gate();
    const resend = fakeResend({ parkFirstProbe, parkDelete });
    resend.state.set(inherited, 'draft');
    const pauses: number[] = [];

    // The tick passes its Step-1 lock and parks on its first probe.
    const tickP = buildAudienceTick(importDeps(resend.port, pauses) as never, { broadcastId: asBroadcastId(broadcastId) });
    await parkFirstProbe.reached;
    // The cascade locks the row, deletes the inherited draft, and parks there
    // — still holding the row lock.
    const cascadeP = eraseCascade(memberId, resend.port);
    // A cascade that never DELETEs (the pre-139 skip) finishes instead.
    const deletedUnderLock = await Promise.race([parkDelete.reached.then(() => true), cascadeP.then(() => false)]);
    if (!deletedUnderLock) {
      parkFirstProbe.open();
      await tickP;
    }
    expect(deletedUnderLock).toBe(true);
    // The tick now probes `not_found` twice, mints afresh and tries to persist:
    // that UPDATE waits on the cascade's lock.
    parkFirstProbe.open();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(resend.calls).toContain('createBroadcast');
    parkDelete.open();
    const [cascaded, tick] = await Promise.all([cascadeP, tickP]);

    expect(cascaded).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
    expect(tick.ok).toBe(false);
    expect(resend.accepted).toEqual([]);
    expect(resend.calls).not.toContain('sendBroadcast');
    const minted = [...resend.state.keys()].filter((id) => id !== inherited);
    expect(minted).toHaveLength(1);
    expect(resend.reclaimed).toEqual(minted);
    expect(await readRow(broadcastId)).toMatchObject({ status: 'cancelled', resendBroadcastId: inherited });
  });
});
