/**
 * F119 T038 — the end-to-end acceptance path (US1-AS1..AS6, SC-002), against
 * LIVE Postgres (Neon `dev`), every step through the REAL use case and the
 * REAL composition root:
 *
 *   submit (member) → start a formatted version → save it → send it to the
 *   member → the member approves → marketing confirms the send time
 *
 * and then the row is DISPATCHABLE — it matches the dispatch cron's own
 * eligibility predicate — and `broadcasts.subject` / `body_html` /
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
import { makeSubmitBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
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
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  });

  it('the delivered content equals the version the member approved', async () => {
    // 1. The member submits (the real submit: membership access, quota, rate limit, audience).
    const submitted = await submitBroadcast(makeSubmitBroadcastDeps(tenant.ctx.slug), {
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
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: { listRecipients: async () => [MARKETER] } },
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
    expect(confirmed.ok ? confirmed.value.stage : confirmed.error).toBe('approved');

    // The row is dispatchable: the dispatch cron's own eligibility predicate selects it.
    const eligible = await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT broadcast_id::text AS broadcast_id FROM broadcasts
        WHERE tenant_id = ${tenant.ctx.slug} AND status = 'approved'
          AND scheduled_for IS NOT NULL AND scheduled_for <= now()
          AND broadcast_id = ${broadcastId as string}
      `),
    );
    expect((eligible as unknown as Array<{ broadcast_id: string }>).map((r) => r.broadcast_id)).toEqual([broadcastId]);

    // …and it carries the approved version byte-for-byte.
    const [row] = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)));
    const [approved] = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(broadcastVersions).where(eq(broadcastVersions.id, row!.approvedVersionId!)),
    );
    expect(approved!.id).toBe(sent.value.versionId);
    expect([row!.subject, row!.bodyHtml, row!.bodySource]).toEqual([approved!.subject, approved!.bodyHtml, approved!.bodySource]);
    expect([row!.subject, row!.bodyHtml, row!.bodySource]).toEqual([APPROVED_SUBJECT, APPROVED_BODY, APPROVED_SOURCE]);

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
  });
});
