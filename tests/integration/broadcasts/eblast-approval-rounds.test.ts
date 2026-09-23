/**
 * F119 T069 — round 2 works, both rounds stay visible to BOTH sides in order,
 * and the hand-off notification fires on every round (US2-AS2, AS3, AS4,
 * FR-011, FR-032, FR-021), against LIVE Postgres (Neon `dev`), every step
 * through the REAL use case and the REAL composition root:
 *
 *   submit → start → save (note 1) → send → the member requests changes
 *   (feedback) → start → save (note 2) → send → the member approves
 *
 * The history is its own record (versions + decisions, never the audit
 * trail): the staff thread (`listBroadcastVersions`) and the member thread
 * (`getMemberVersionThread`) both show v1 and v2 with their notes, and the
 * feedback attached to ROUND 1's version, oldest first. The outbox carries
 * one member row per send and one marketing row per recipient per decision
 * (two recipients, two decisions → four).
 *
 * Two injections, both disclosed (as in T038): `memberApprovalEnabled: true`
 * on the start (the flag gates only that edge) and a two-recipient marketing
 * roster on the decision (the live roster is cross-tenant on the dev branch —
 * the outbox INSERTs themselves are real).
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import {
  makeGetMemberVersionThreadDeps,
  makeListBroadcastVersionsDeps,
  makeRecordMemberDecisionDeps,
  makeSaveFormattedVersionDeps,
  makeSendVersionToMemberDeps,
  makeStartFormattedVersionDeps,
} from '@/lib/broadcast-approval-deps';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { getMemberVersionThread } from '@/modules/broadcasts/application/use-cases/approval/get-member-version-thread';
import { listBroadcastVersions } from '@/modules/broadcasts/application/use-cases/approval/list-broadcast-versions';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import { saveFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/save-formatted-version';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import { submitBroadcast } from '@/modules/broadcasts/application/use-cases/submit-broadcast';
import { makeSubmitBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const MARKETERS = [
  { userId: randomUUID(), email: `marketing-rounds-a-${randomUUID().slice(0, 8)}@example.com`, locale: 'en' as const },
  { userId: randomUUID(), email: `marketing-rounds-b-${randomUUID().slice(0, 8)}@example.com`, locale: 'sv' as const },
];
const NOTE_1 = 'Round 1 — we moved the date up top.';
const NOTE_2 = 'Round 2 — the date is now 12 October.';
const FEEDBACK = 'The date is wrong: it is the 12th, not the 21st.';

interface OutboxRow {
  notification_type: string;
  to_email: string;
  context_data: Record<string, unknown>;
}

describe('F119 T069 — two rounds, both visible to both sides in order, a hand-off on every round (live Neon)', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  let memberId: string;
  let contactId: string;
  let broadcastId: BroadcastId;
  const planId = `plan-f119-rounds-${randomUUID().slice(0, 8)}`;
  const actor = { actorUserId: MARKETERS[0]!.userId, actorRole: 'marketing' as const, requestId: null };
  const roster = { listRecipients: async () => MARKETERS };

  async function outboxRows(): Promise<OutboxRow[]> {
    return (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT notification_type::text AS notification_type, to_email, context_data
          FROM notifications_outbox
         WHERE tenant_id = ${tenant.ctx.slug} AND context_data->>'broadcastId' = ${broadcastId as string}
         ORDER BY created_at, id`),
    )) as unknown as OutboxRow[];
  }

  /** start → save (with a note) → send; returns the sent version's id. */
  async function formatAndSend(round: number, note: string): Promise<string> {
    const started = await startFormattedVersion(
      { ...makeStartFormattedVersionDeps(tenant.ctx.slug), memberApprovalEnabled: true },
      { broadcastId, ...actor },
    );
    if (!started.ok) throw new Error(`start ${round} refused: ${JSON.stringify(started.error)}`);
    const saved = await saveFormattedVersion(makeSaveFormattedVersionDeps(tenant.ctx.slug), {
      broadcastId,
      actorUserId: actor.actorUserId,
      requestId: null,
      subject: `Autumn mixer — round ${round}`,
      bodyHtml: `<p>Round ${round} body.</p>`,
      bodySource: '{"type":"doc","content":[{"type":"paragraph"}]}',
      noteToMember: note,
      expectedUpdatedAt: started.value.version.updatedAt,
    });
    if (!saved.ok) throw new Error(`save ${round} refused: ${JSON.stringify(saved.error)}`);
    const sent = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), { broadcastId, ...actor });
    if (!sent.ok) throw new Error(`send ${round} refused: ${JSON.stringify(sent.error)}`);
    expect(sent.value.round).toBe(round);
    return sent.value.versionId;
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    ({ memberId, contactId } = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      companyName: 'Two Rounds Co',
    }));
    await seedPortalMemberWithContact(tenant, planId, { companyName: 'Recipient Co' });
  }, 120_000);

  afterAll(async () => {
    const slug = tenant?.ctx.slug;
    if (slug !== undefined) await db.execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${slug}`).catch(() => {});
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  }, 120_000);

  it('after a change request and a second version, the thread shows both versions, both notes and the feedback attached to round 1, oldest first', async () => {
    const submitted = await submitBroadcast(makeSubmitBroadcastDeps(tenant.ctx.slug), {
      memberId,
      submittedByUserId: portalUser.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: 'Two Rounds Co',
      subject: 'Autumn mixer',
      bodySource: 'plain',
      bodyHtml: '<p>Join us in October.</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });
    if (!submitted.ok) throw new Error(`submit refused: ${JSON.stringify(submitted.error)}`);
    broadcastId = asBroadcastId(submitted.value.broadcastId);

    // Round 1, then the member's feedback on it.
    const v1 = await formatAndSend(1, NOTE_1);
    const changes = await recordMemberDecision(
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: roster },
      {
        broadcastId,
        memberId,
        actorUserId: portalUser.userId,
        actorRole: 'member',
        contactId,
        versionId: v1,
        decision: 'changes_requested',
        reason: FEEDBACK,
        requestId: null,
      },
    );
    expect(changes.ok ? changes.value.stage : changes.error).toBe('changes_requested');

    // Round 2.
    const v2 = await formatAndSend(2, NOTE_2);

    // The STAFF side — its own record, not the audit trail.
    const staff = await listBroadcastVersions(makeListBroadcastVersionsDeps(tenant.ctx.slug), {
      broadcastId,
      actorUserId: actor.actorUserId,
      requestId: null,
    });
    if (!staff.ok) throw new Error(`staff thread refused: ${JSON.stringify(staff.error)}`);
    expect(staff.value.round).toBe(2);
    expect(staff.value.memberOriginal?.version.versionNo).toBe(0);
    expect(staff.value.sentVersions.map((e) => [e.version.id, e.version.versionNo, e.version.noteToMember])).toEqual([
      [v1, 1, NOTE_1],
      [v2, 2, NOTE_2],
    ]);
    expect(staff.value.workingCopy).toBeNull();
    expect(staff.value.decisions.map((d) => [d.versionId, d.round, d.decision, d.reason])).toEqual([
      [v1, 1, 'changes_requested', FEEDBACK],
    ]);

    // The MEMBER side — the same history, in the same order, authors named only as member / organisation.
    const member = await getMemberVersionThread(makeGetMemberVersionThreadDeps(tenant.ctx.slug), {
      broadcastId,
      memberId,
      actorUserId: portalUser.userId,
      requestId: null,
    });
    if (!member.ok) throw new Error(`member thread refused: ${JSON.stringify(member.error)}`);
    expect(member.value.summary).toMatchObject({ stage: 'awaiting_member_approval', whoseTurn: 'member', round: 2 });
    expect(member.value.versions.map((v) => [v.versionNo, v.authoredBy, v.noteToMember])).toEqual([
      [0, 'member', null],
      [1, 'organisation', NOTE_1],
      [2, 'organisation', NOTE_2],
    ]);
    expect(member.value.decisions.map((d) => [d.versionId, d.round, d.decision, d.reason, d.decidedByMe])).toEqual([
      [v1, 1, 'changes_requested', FEEDBACK, true],
    ]);

    // The member approves round 2 — the second decision of the E-Blast.
    const approved = await recordMemberDecision(
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: roster },
      {
        broadcastId,
        memberId,
        actorUserId: portalUser.userId,
        actorRole: 'member',
        contactId,
        versionId: v2,
        decision: 'approved',
        reason: null,
        requestId: null,
      },
    );
    expect(approved.ok ? approved.value.stage : approved.error).toBe('member_approved');
    const after = await getMemberVersionThread(makeGetMemberVersionThreadDeps(tenant.ctx.slug), {
      broadcastId,
      memberId,
      actorUserId: portalUser.userId,
      requestId: null,
    });
    expect(after.ok && after.value.decisions.map((d) => [d.round, d.decision])).toEqual([
      [1, 'changes_requested'],
      [2, 'approved'],
    ]);
    expect(after.ok && after.value.summary.approvedVersionId).toBe(v2);

    // The hand-off fires on every round: one member row per send, one
    // marketing row per recipient per decision — ids only, never the text.
    const rows = await outboxRows();
    const sentToMember = rows.filter((r) => r.notification_type === 'eblast_version_sent_member');
    expect(sentToMember.map((r) => [r.context_data.versionId, r.context_data.round])).toEqual([
      [v1, 1],
      [v2, 2],
    ]);
    // Rows of one transaction share `created_at`, so compare them as a set.
    const toMarketing = rows.filter((r) => r.notification_type === 'eblast_member_decided_marketing');
    const byKey = (t: readonly unknown[]) => JSON.stringify(t);
    expect(toMarketing.map((r) => [r.to_email, r.context_data.versionId, r.context_data.decision]).map(byKey).sort()).toEqual(
      [
        [MARKETERS[0]!.email, v1, 'changes_requested'],
        [MARKETERS[1]!.email, v1, 'changes_requested'],
        [MARKETERS[0]!.email, v2, 'approved'],
        [MARKETERS[1]!.email, v2, 'approved'],
      ]
        .map(byKey)
        .sort(),
    );
    expect(JSON.stringify(rows.map((r) => r.context_data))).not.toContain('date');
  }, 240_000);
});
