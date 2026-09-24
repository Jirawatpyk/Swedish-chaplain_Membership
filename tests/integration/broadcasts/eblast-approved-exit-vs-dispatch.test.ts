/**
 * F119 T166 R-H1 — an exit from `approved` against the lock-free dispatch leg,
 * on LIVE Postgres (Neon `dev`), through the real repo and the real use cases.
 *
 * `dispatchScheduledBroadcast` locks the row in Step 1 and COMMITS, then calls
 * Resend with no lock held. F119 added three NON-terminal exits from
 * `approved` — the member's withdrawal, `confirmSchedule`'s cancel, and the
 * voiding start of a new working copy — plus the re-time `approved →
 * approved`. Before this fix none of them looked at what the dispatcher had
 * already done, and `attachAudienceId` / `attachBroadcastId` /
 * `attachAudienceImport` compared on the id column only. So:
 *
 *   - a withdrawal landing between Step 1 and the attach let the dispatcher
 *     attach its id to a `changes_requested` row and SEND version 1, which
 *     the member had just been told was withdrawn;
 *   - the id then stayed on the row, and the next round's dispatch inherited
 *     it, probed "sent", skipped `sendBroadcast` and recorded version 2 as
 *     sent although it never went out.
 *
 * Two halves of the fix, both proven here:
 *   (a) the attach CAS carries `status = 'approved'`, so a lost race takes the
 *       dispatcher's existing `reclaimMintedBroadcast` arm (the resource it
 *       minted is deleted, nothing is sent);
 *   (b) each exit refuses `sending_started` once the dispatcher has handed the
 *       row over (`resend_broadcast_id` or `audience_import_id` set).
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import {
  makeConfirmScheduleDeps,
  makeRecordMemberDecisionDeps,
  makeStartFormattedVersionDeps,
} from '@/lib/broadcast-approval-deps';
import { asBroadcastId, dispatchScheduledBroadcast } from '@/modules/broadcasts';
import { confirmSchedule } from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { emailTransactionalBridge } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { broadcasts, broadcastVersions, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { makeFakeMarketingDirectory } from '../../helpers/eblast-approval-fakes';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const MARKETER = randomUUID();
const SUBMITTED_AT = new Date('2026-09-20T08:00:00.000Z');
const V1_SENT_AT = new Date('2026-09-21T08:00:00.000Z');
const NO_BRAND_CHROME = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

describe('F119 T166 R-H1 — an exit from approved vs the lock-free dispatch leg (live Neon)', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  let memberId: string;
  let contactId: string;
  const planId = `plan-f119-exit-race-${randomUUID().slice(0, 8)}`;
  const roster = makeFakeMarketingDirectory([]);

  /** An `approved` round-1 row with v0 + v1 (v1 sent and approved); `patch` sets the dispatch ids at INSERT time. */
  async function seedApprovedRound(patch: Partial<NewBroadcastRow> = {}): Promise<{ id: string; v1: string }> {
    const id = randomUUID();
    const v1 = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: id,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: portalUser.userId,
        actorRole: 'member_self_service',
        subject: 'Approved version one',
        bodyHtml: '<p>Version one</p>',
        bodySource: 'v1',
        fromName: 'Exit Race Co via Test Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'approved',
        submittedAt: SUBMITTED_AT,
        approvedAt: V1_SENT_AT,
        approvedByUserId: MARKETER,
        scheduledFor: new Date(Date.now() + 3_600_000),
        proposedSendAt: new Date(Date.now() + 3_600_000),
        currentRound: 1,
        ...patch,
      });
      await tx.insert(broadcastVersions).values([
        { tenantId: tenant.ctx.slug, broadcastId: id, versionNo: 0, subject: 'orig', bodyHtml: '<p>o</p>', bodySource: 'o', authoredByUserId: portalUser.userId, authoredByRole: 'member_self_service', sentToMemberAt: SUBMITTED_AT },
        { tenantId: tenant.ctx.slug, id: v1, broadcastId: id, versionNo: 1, subject: 'Approved version one', bodyHtml: '<p>Version one</p>', bodySource: 'v1', authoredByUserId: MARKETER, authoredByRole: 'admin_proxy', sentToMemberAt: V1_SENT_AT },
      ]);
      await tx.update(broadcasts).set({ approvedVersionId: v1 }).where(eq(broadcasts.broadcastId, id));
    });
    return { id, v1 };
  }

  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  const withdraw = (id: string, versionId: string) =>
    recordMemberDecision(
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: roster },
      {
        broadcastId: asBroadcastId(id),
        memberId,
        actorUserId: portalUser.userId,
        actorRole: 'member',
        contactId,
        versionId,
        decision: 'approval_withdrawn',
        reason: 'The venue changed — please hold this.',
        requestId: null,
      },
    );

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    ({ memberId, contactId } = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      companyName: 'Exit Race Co',
    }));
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  }, 120_000);

  describe('(b) once the dispatcher has handed the row over, every exit from approved refuses sending_started', () => {
    it.each([
      { leg: 'legacy leg — resend_broadcast_id set', ids: { resendAudienceId: 'aud-exit-1', resendBroadcastId: `rb-exit-${randomUUID().slice(0, 8)}` } },
      { leg: 'import leg — audience_import_id set', ids: { resendAudienceId: 'aud-exit-2', audienceImportId: `imp-exit-${randomUUID().slice(0, 8)}`, audienceImportSubmittedAt: new Date() } },
    ])('$leg: withdraw, cancel, re-time and a new working copy are all refused; the row is untouched', async ({ ids }) => {
      const { id, v1 } = await seedApprovedRound(ids);
      const before = await readRow(id);

      const withdrawn = await withdraw(id, v1);
      expect(withdrawn.ok ? withdrawn.value.stage : withdrawn.error).toEqual({ kind: 'sending_started', status: 'approved' });

      const staff = { broadcastId: asBroadcastId(id), actorUserId: MARKETER, actorRole: 'marketing', requestId: null };
      const cancelled = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), { ...staff, mode: { mode: 'cancel' } });
      expect(cancelled.ok ? cancelled.value.stage : cancelled.error).toEqual({ kind: 'sending_started', status: 'approved' });
      const retimed = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), {
        ...staff,
        mode: { mode: 'schedule', scheduledFor: new Date(Date.now() + 2 * 3_600_000) },
      });
      expect(retimed.ok ? retimed.value.stage : retimed.error).toEqual({ kind: 'sending_started', status: 'approved' });

      const restarted = await startFormattedVersion(
        { ...makeStartFormattedVersionDeps(tenant.ctx.slug), memberApprovalEnabled: true },
        staff,
      );
      expect(restarted.ok ? restarted.value.stage : restarted.error).toEqual({ kind: 'sending_started', status: 'approved' });

      expect(await readRow(id)).toEqual(before);
    });
  });

  describe('(a) the attach CAS carries status = approved', () => {
    it('attachAudienceId, attachBroadcastId and attachAudienceImport on a row that left approved → BroadcastConcurrentMutationError naming the real status; nothing lands', async () => {
      const { id } = await seedApprovedRound({ status: 'changes_requested', approvedVersionId: null, scheduledFor: null });
      const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
      const bid = asBroadcastId(id);

      for (const attach of [
        (tx: unknown) => repo.attachAudienceId(tx, tenant.ctx.slug, bid, 'aud-late'),
        (tx: unknown) => repo.attachBroadcastId(tx, tenant.ctx.slug, bid, 'rb-late'),
        (tx: unknown) => repo.attachAudienceImport(tx, tenant.ctx.slug, bid, 'imp-late'),
      ]) {
        const thrown = await repo.withTx(attach).then(
          () => null,
          (e: unknown) => e,
        );
        expect(thrown).toBeInstanceOf(BroadcastConcurrentMutationError);
        expect((thrown as BroadcastConcurrentMutationError).observedStatus).toBe('changes_requested');
      }
      expect(await readRow(id)).toMatchObject({ resendAudienceId: null, resendBroadcastId: null, audienceImportId: null });
    });

    it('the race end to end: a withdrawal lands while the dispatcher is minting — nothing is sent, the minted resource is reclaimed, and no id is left for the next round to inherit', async () => {
      const { id, v1 } = await seedApprovedRound();
      const calls = { send: 0, deleted: [] as string[], withdrawal: null as unknown };
      const gateway: BroadcastsGatewayPort = {
        async createAudience() {
          return { audienceId: `aud-race-${randomUUID().slice(0, 8)}` };
        },
        async addContactsToAudience() {},
        async createContactImport() {
          throw new Error('not used');
        },
        async getContactImport() {
          throw new Error('not used');
        },
        async createBroadcast() {
          // The member withdraws WHILE the dispatcher is inside Resend — after
          // Step 1's lock committed, before the id is attached.
          calls.withdrawal = await withdraw(id, v1);
          return { broadcastId: `rb-race-${randomUUID().slice(0, 8)}` };
        },
        async sendBroadcast() {
          calls.send += 1;
        },
        async retrieveBroadcast() {
          return { kind: 'not_found' as const };
        },
        async getAudienceContactCount() {
          return { count: 1, complete: true };
        },
        async removeContactFromAudience() {
          return { kind: 'detached' as const };
        },
        async deleteContactGlobally() {},
        async deleteAudience() {},
        async deleteBroadcast(resourceId) {
          calls.deleted.push(resourceId);
        },
        async listAudiences() {
          return [];
        },
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
              displayName: 'Recipient Co',
              primaryContactEmail: 'recipient@test-tenant.example' as never,
              tierCode: null,
              broadcastsHaltedUntilAdminReview: false,
            },
          ];
        },
      };

      const result = await dispatchScheduledBroadcast(
        {
          tenant: tenant.ctx,
          broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
          audienceMode: 'primary_only' as const,
          audienceCeiling: 5000,
          broadcastsGateway: gateway,
          membersBridge: stubMembersBridge,
          marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
          eventAttendees: eventAttendeesStub,
          audit: f7AuditAdapter,
          clock: { now: () => new Date() },
          fromEmail: 'noreply@test.invalid-but-test-only',
          tenantDisplayName: 'Test Chamber',
          locale: 'en' as const,
          plansBridge,
          emailTransactional: emailTransactionalBridge,
          brandChrome: NO_BRAND_CHROME,
        },
        { broadcastId: asBroadcastId(id) },
      );

      // The withdrawal itself succeeded: nothing had been handed over yet.
      expect((calls.withdrawal as { ok: boolean }).ok).toBe(true);
      // The dispatcher lost the CAS: no send, its own mint reclaimed.
      expect(result.ok ? 'dispatched' : result.error).toEqual({
        kind: 'broadcast_invalid_state_transition',
        observedStatus: 'changes_requested',
      });
      expect(calls.send).toBe(0);
      expect(calls.deleted).toHaveLength(1);
      expect(await readRow(id)).toMatchObject({ status: 'changes_requested', resendBroadcastId: null, approvedVersionId: null });
    });
  });
});
