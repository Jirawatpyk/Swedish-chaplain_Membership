/**
 * F119 T038 — the end-to-end acceptance path (US1-AS1..AS6, SC-002), against
 * LIVE Postgres (Neon `dev`), every step through the REAL use case and the
 * REAL composition root:
 *
 *   submit (member) → start a formatted version → save it → send it to the
 *   member → the member approves → marketing confirms the send time
 *
 * and then the row is DISPATCHED — the REAL `dispatchScheduledBroadcast`, with
 * only the Resend gateway faked, hands Resend the approved subject and body
 * (US1-AS6) — and `broadcasts.subject` / `body_html` /
 * `body_source` equal the approved version byte-for-byte (FR-012a: the
 * promotion is the only write of content after submit, and it copies from
 * `approved_version_id`). SC-002's audit chain is walked too: the approved
 * version ← the member's `approved` decision ← `broadcast_schedule_confirmed`.
 *
 * Two injections, both disclosed: `memberApprovalEnabled: true` on the start
 * (the flag is `.env.local`-dependent and gates only that edge — the flag
 * matrix owns both states), and a one-recipient marketing roster on the
 * decision (the live roster is cross-tenant and shared on the dev branch —
 * the outbox INSERT itself is real).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFakeMarketingDirectory } from '../../helpers/eblast-approval-fakes';
import { db, runInTenant } from '@/lib/db';
import {
  makeConfirmScheduleDeps,
  makeRecordMemberDecisionDeps,
  makeSaveFormattedVersionDeps,
  makeSendVersionToMemberDeps,
  makeStartFormattedVersionDeps,
} from '@/lib/broadcast-approval-deps';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { confirmSchedule } from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import { saveFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/save-formatted-version';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import { submitBroadcast } from '@/modules/broadcasts/application/use-cases/submit-broadcast';
import { dispatchScheduledBroadcast } from '@/modules/broadcasts';
import type {
  BroadcastsGatewayPort,
  CreateBroadcastInput,
} from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeSubmitBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { emailTransactionalBridge } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { broadcastMemberDecisions, broadcasts, broadcastVersions } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const MARKETER = { userId: randomUUID(), email: 'marketing-happy@example.com', locale: 'en' as const };
const APPROVED_SUBJECT = 'Autumn mixer — งานพบปะฤดูใบไม้ร่วง ✓';
const APPROVED_BODY = '<p>Join us on <strong>1 October</strong> at the Residence.</p>';
const APPROVED_SOURCE = '{"type":"doc","content":[{"type":"paragraph"}]}';

describe('F119 T038 — submit → format → send → approve → confirm, the delivered content is the approved version (live Neon)', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  let memberId: string;
  let contactId: string;
  let broadcastId: BroadcastId;
  const planId = `plan-f119-happy-${randomUUID().slice(0, 8)}`;
  const actor = { actorUserId: MARKETER.userId, actorRole: 'marketing' as const, requestId: null };

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    ({ memberId, contactId } = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      companyName: 'Happy Path Co',
    }));
    // A second member so the all-members segment has a recipient.
    await seedPortalMemberWithContact(tenant, planId, { companyName: 'Recipient Co' });
  }, 120_000);

  afterAll(async () => {
    // The decision's hand-off rows (FR-016 describe precedent): the tenant helper does not sweep the outbox.
    const slug = tenant?.ctx.slug;
    if (slug !== undefined) await db.execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${slug}`).catch(() => {});
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  }, 120_000);

  it('the delivered content equals the version the member approved', async () => {
    // 1. The member submits (the real submit: membership access, quota, rate limit, audience).
    const submitted = await submitBroadcast(makeSubmitBroadcastDeps(tenant.ctx.slug, makeFakeMarketingDirectory([])), {
      memberId,
      submittedByUserId: portalUser.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Happy Path Co',
      subject: 'Autumn mixer',
      bodySource: 'plain',
      bodyHtml: '<p>Join us in October.</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });
    expect(submitted.ok ? submitted.value.broadcast.status : submitted.error).toBe('submitted');
    if (!submitted.ok) return;
    broadcastId = asBroadcastId(submitted.value.broadcastId);

    // 2. Marketing starts a formatted version.
    const started = await startFormattedVersion(
      { ...makeStartFormattedVersionDeps(tenant.ctx.slug), memberApprovalEnabled: true },
      { broadcastId, ...actor },
    );
    expect(started.ok ? started.value.stage : started.error).toBe('in_design');
    if (!started.ok) return;

    // 3. …saves it…
    const saved = await saveFormattedVersion(makeSaveFormattedVersionDeps(tenant.ctx.slug), {
      broadcastId,
      actorUserId: MARKETER.userId,
      requestId: null,
      subject: APPROVED_SUBJECT,
      bodyHtml: APPROVED_BODY,
      bodySource: APPROVED_SOURCE,
      noteToMember: 'We moved the date up top.',
      expectedUpdatedAt: started.value.version.updatedAt,
    });
    expect(saved.ok ? 'saved' : saved.error).toBe('saved');
    if (!saved.ok) return;

    // 4. …and sends it to the member.
    const sent = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), { broadcastId, ...actor });
    expect(sent.ok ? sent.value.round : sent.error).toBe(1);
    if (!sent.ok) return;

    // 5. The member approves the version they were shown.
    const decided = await recordMemberDecision(
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: makeFakeMarketingDirectory([MARKETER]) },
      {
        broadcastId,
        memberId,
        actorUserId: portalUser.userId,
        actorRole: 'member',
        contactId,
        versionId: sent.value.versionId,
        decision: 'approved',
        reason: 'Looks right.',
        requestId: null,
      },
    );
    expect(decided.ok ? decided.value.stage : decided.error).toBe('member_approved');

    // 6. Marketing confirms the send time — the promotion.
    const confirmed = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), { broadcastId, ...actor, mode: { mode: 'send_now' } });
    expect(confirmed.ok ? confirmed.value.status : confirmed.error).toBe('approved');

    // The row carries the approved version byte-for-byte.
    const [row] = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)));
    const [approved] = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(broadcastVersions).where(eq(broadcastVersions.id, row!.approvedVersionId!)),
    );
    expect(approved!.id).toBe(sent.value.versionId);
    expect([row!.subject, row!.bodyHtml, row!.bodySource]).toEqual([approved!.subject, approved!.bodyHtml, approved!.bodySource]);
    // T166 S-LOW — the save stores the SANITISED body as `body_source` too, never the raw source the workspace sent.
    expect([row!.subject, row!.bodyHtml, row!.bodySource]).toEqual([APPROVED_SUBJECT, APPROVED_BODY, APPROVED_BODY]);

    // SC-002 — the chain a reviewer walks without reading content.
    const decisions = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(broadcastMemberDecisions).where(eq(broadcastMemberDecisions.broadcastId, broadcastId)),
    );
    expect(decisions.map((d) => [d.decision, d.versionId, d.decidedByContactId])).toEqual([['approved', approved!.id, contactId]]);
    const promoted = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'broadcast_schedule_confirmed')));
    expect(promoted.map((a) => (a.payload as { version_id: string }).version_id)).toEqual([approved!.id]);

    // US1-AS6 — what DISPATCH hands Resend is the approved version. The cron's
    // eligibility SELECT is inline in `dispatch-scheduled/route.ts` (not
    // exported), so the row is checked against its two conditions and then
    // driven through the REAL `dispatchScheduledBroadcast` — real repo, real
    // members bridge (both seeded members), real audit — with only the Resend
    // gateway faked. `htmlBody` is the use case's argument, BEFORE the adapter
    // wraps the brand chrome.
    expect(row!.status).toBe('approved');
    expect(row!.scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now());
    const created: CreateBroadcastInput[] = [];
    let added = 0;
    let sends = 0;
    const gateway: BroadcastsGatewayPort = {
      async createAudience() {
        return { audienceId: `aud-happy-${randomUUID().slice(0, 8)}` };
      },
      async addContactsToAudience(_audienceId, contacts) {
        added += contacts.length;
      },
      async createContactImport() {
        throw new Error('not used on the primary_only leg');
      },
      async getContactImport() {
        throw new Error('not used on the primary_only leg');
      },
      async createBroadcast(input) {
        created.push(input);
        return { broadcastId: `rb-happy-${randomUUID().slice(0, 8)}` };
      },
      async sendBroadcast() {
        sends += 1;
      },
      async retrieveBroadcast() {
        return { kind: 'not_found' as const };
      },
      async getAudienceContactCount() {
        return { count: added, complete: true };
      },
      async removeContactFromAudience() {
        return { kind: 'detached' as const };
      },
      async deleteContactGlobally() {},
      async deleteAudience() {},
      async deleteBroadcast() {},
      async listAudiences() {
        return [];
      },
    };
    const dispatched = await dispatchScheduledBroadcast(
      {
        tenant: tenant.ctx,
        broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gateway,
        membersBridge,
        marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
        eventAttendees: eventAttendeesStub,
        audit: f7AuditAdapter,
        clock: { now: () => new Date() },
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge,
        emailTransactional: emailTransactionalBridge,
        brandChrome: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
      },
      { broadcastId },
    );
    expect(dispatched.ok ? 'dispatched' : dispatched.error).toBe('dispatched');
    expect(created.map((c) => [c.subject, c.htmlBody])).toEqual([[APPROVED_SUBJECT, APPROVED_BODY]]);
    expect(sends).toBe(1);
    const [afterDispatch] = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)));
    expect(afterDispatch!.status).not.toBe('approved');
  });
});

/**
 * FR-016 / FR-018 — the member's proposed time is WRITTEN AT SUBMIT and frozen.
 * The suite above submits with no time and confirms `send_now`, so it could not
 * see that nothing wrote `proposed_send_at` after the 0308 backfill: every new
 * E-Blast then refused `keep_proposal` with 409 `no_proposal` and the "not the
 * time you proposed" line never fired. This one submits WITH a time, keeps it,
 * then moves it — and the proposal survives the move (the F1 freeze).
 */
describe('F119 FR-016 — the proposal written at submit is kept, then survives a reschedule (live Neon)', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  let memberId: string;
  let contactId: string;
  let broadcastId: BroadcastId;
  const planId = `plan-f119-proposal-${randomUUID().slice(0, 8)}`;
  const actor = { actorUserId: MARKETER.userId, actorRole: 'marketing' as const, requestId: null };
  // Well past the 5-minute floor, whole seconds so the timestamptz round trip is exact.
  const proposal = new Date(Math.floor((Date.now() + 86_400_000) / 1000) * 1000);
  const moved = new Date(proposal.getTime() + 3_600_000);

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    ({ memberId, contactId } = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      companyName: 'Proposal Co',
    }));
    await seedPortalMemberWithContact(tenant, planId, { companyName: 'Recipient Co' });
  }, 120_000);

  afterAll(async () => {
    const slug = tenant?.ctx.slug;
    if (slug !== undefined) await db.execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${slug}`).catch(() => {});
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  }, 120_000);

  const readRow = async () => {
    const [row] = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)));
    return row!;
  };

  it('keep_proposal confirms the submitted time (differs: false); a different time then reports differs: true and leaves the proposal untouched', async () => {
    const submitted = await submitBroadcast(makeSubmitBroadcastDeps(tenant.ctx.slug, makeFakeMarketingDirectory([])), {
      memberId,
      submittedByUserId: portalUser.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Proposal Co',
      subject: 'Winter gala',
      bodySource: 'plain',
      bodyHtml: '<p>Save the date.</p>',
      segment: { kind: 'all_members' },
      scheduledFor: proposal,
      requestId: null,
    });
    if (!submitted.ok) throw new Error(`submit refused: ${JSON.stringify(submitted.error)}`);
    broadcastId = asBroadcastId(submitted.value.broadcastId);

    // Written at submit: on a submitted row `scheduled_for` IS the proposal (data-model § 3).
    const atSubmit = await readRow();
    expect(atSubmit.status).toBe('submitted');
    expect(atSubmit.proposedSendAt?.toISOString()).toBe(proposal.toISOString());
    expect(atSubmit.scheduledFor?.toISOString()).toBe(proposal.toISOString());

    const started = await startFormattedVersion(
      { ...makeStartFormattedVersionDeps(tenant.ctx.slug), memberApprovalEnabled: true },
      { broadcastId, ...actor },
    );
    if (!started.ok) throw new Error(`start refused: ${JSON.stringify(started.error)}`);
    const saved = await saveFormattedVersion(makeSaveFormattedVersionDeps(tenant.ctx.slug), {
      broadcastId,
      actorUserId: MARKETER.userId,
      requestId: null,
      subject: APPROVED_SUBJECT,
      bodyHtml: APPROVED_BODY,
      bodySource: APPROVED_SOURCE,
      noteToMember: null,
      expectedUpdatedAt: started.value.version.updatedAt,
    });
    if (!saved.ok) throw new Error(`save refused: ${JSON.stringify(saved.error)}`);
    const sent = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), { broadcastId, ...actor });
    if (!sent.ok) throw new Error(`send refused: ${JSON.stringify(sent.error)}`);
    const decided = await recordMemberDecision(
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: makeFakeMarketingDirectory([MARKETER]) },
      {
        broadcastId,
        memberId,
        actorUserId: portalUser.userId,
        actorRole: 'member',
        contactId,
        versionId: sent.value.versionId,
        decision: 'approved',
        reason: null,
        requestId: null,
      },
    );
    expect(decided.ok ? decided.value.stage : decided.error).toBe('member_approved');

    // 1. Keep the member's time — the promotion.
    const kept = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), { broadcastId, ...actor, mode: { mode: 'keep_proposal' } });
    expect(kept.ok ? { status: kept.value.status, differs: kept.value.differs } : kept.error).toEqual({ status: 'approved', differs: false });
    const afterKeep = await readRow();
    expect(afterKeep.scheduledFor?.toISOString()).toBe(proposal.toISOString());
    expect(afterKeep.proposedSendAt?.toISOString()).toBe(proposal.toISOString());

    // 2. Move it — `approved → approved` releases `scheduled_for` (E2), never the proposal (F1).
    const rescheduled = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), {
      broadcastId,
      ...actor,
      mode: { mode: 'schedule', scheduledFor: moved },
    });
    expect(rescheduled.ok ? { status: rescheduled.value.status, differs: rescheduled.value.differs } : rescheduled.error).toEqual({
      status: 'approved',
      differs: true,
    });
    const afterMove = await readRow();
    expect(afterMove.scheduledFor?.toISOString()).toBe(moved.toISOString());
    expect(afterMove.proposedSendAt?.toISOString()).toBe(proposal.toISOString());

    // The audit trail states both confirmations against the same frozen proposal.
    const confirmations = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'broadcast_schedule_confirmed')))
      .orderBy(auditLog.timestamp);
    type Payload = { mode: string; proposed_send_at: string | null; confirmed_send_at: string | null; differs: boolean };
    expect(
      confirmations.map((a) => {
        const p = a.payload as Payload;
        return [p.mode, p.proposed_send_at, p.confirmed_send_at, p.differs];
      }),
    ).toEqual([
      ['keep_proposal', proposal.toISOString(), proposal.toISOString(), false],
      ['schedule', proposal.toISOString(), moved.toISOString(), true],
    ]);
  });
});
