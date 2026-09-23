/**
 * F119 T076 (T082's RED) · T083 — erasure reaches every version, every
 * reason, every note, every image and every notification about an E-Blast
 * (spec § Personal data, research R17), against LIVE Postgres (Neon `dev`).
 *
 * The E-Blast is driven to "Awaiting member approval" in ROUND 2 through the
 * REAL use cases — submit → start → save (note) → send → the member requests
 * changes (reason) → start → save (note) → send — so it carries v0 (the
 * member's original), v1, v2, one reasoned decision, and the pending hand-off
 * rows the round enqueued (`eblast_version_sent_member` to the member,
 * `eblast_member_decided_marketing` to a marketing address). Two images are
 * recorded on it. Then the REAL member erasure (`eraseMember` over
 * `buildEraseMemberDeps`, the production composition root) runs, and:
 *
 *   - no non-sentinel value is left in `broadcast_versions` or
 *     `broadcast_member_decisions`, and every row is KEPT (SC-002's proof);
 *   - the E-Blast is cancelled (the in-flight cascade widened to the new
 *     stages by T080);
 *   - every image row is stamped `deleted_at`;
 *   - no pending `eblast_*` outbox row about the E-Blast survives — the
 *     marketing row goes to a STAFF address, which the email-keyed leg of the
 *     atomic erasure step can never find;
 *   - a peer member's E-Blast in the same tenant is untouched (the COMP-1
 *     cross-member rule);
 *   - a second run changes nothing and writes no second attestation.
 *
 * T083 — the member DSAR archive of the erased member carries only the
 * `[redacted]` sentinels in `broadcast-versions.json`.
 *
 * Two injections, both disclosed (as in T038): `memberApprovalEnabled: true`
 * on the start, and a one-recipient marketing roster on the decision.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import {
  makeRecordMemberDecisionDeps,
  makeSaveFormattedVersionDeps,
  makeSendVersionToMemberDeps,
  makeStartFormattedVersionDeps,
} from '@/lib/broadcast-approval-deps';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import { saveFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/save-formatted-version';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import { submitBroadcast } from '@/modules/broadcasts/application/use-cases/submit-broadcast';
import { makeSubmitBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { drizzleBroadcastImagesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-images-repo';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { gdprArchiveSourceAdapter } from '@/modules/insights/infrastructure/sources/gdpr-archive-source-adapter';
import { asMemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const SENTINEL = '[redacted]';
const MARKETER = { userId: randomUUID(), email: `marketing-erasure-${randomUUID().slice(0, 8)}@example.com`, locale: 'en' as const };
const IMAGE_HOST = 'assets.swecham.zyncdata.app';

interface VersionRow {
  id: string;
  version_no: number;
  subject: string;
  body_html: string;
  body_source: string;
  note_to_member: string | null;
}
interface DecisionRow {
  id: string;
  decision: string;
  reason: string | null;
}

describe('F119 T076 — a member erased at Awaiting member approval: nothing they wrote survives, the proof does (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let portalUser: TestUser;
  let peerUser: TestUser;
  let memberId: string;
  let broadcastId: BroadcastId;
  let peerBroadcastId: BroadcastId;
  const planId = `plan-f119-erase-${randomUUID().slice(0, 8)}`;
  const actor = { actorUserId: MARKETER.userId, actorRole: 'marketing' as const, requestId: null };
  const roster = { listRecipients: async () => [MARKETER] };

  async function versionsOf(id: BroadcastId): Promise<VersionRow[]> {
    return (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, version_no, subject, body_html, body_source, note_to_member
          FROM broadcast_versions WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${id as string}
         ORDER BY version_no`),
    )) as unknown as VersionRow[];
  }

  async function decisionsOf(id: BroadcastId): Promise<DecisionRow[]> {
    return (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, decision, reason
          FROM broadcast_member_decisions WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${id as string}
         ORDER BY decided_at`),
    )) as unknown as DecisionRow[];
  }

  async function pendingEblastOutbox(id: BroadcastId): Promise<Array<{ notification_type: string }>> {
    return (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT notification_type FROM notifications_outbox
         WHERE tenant_id = ${tenant.ctx.slug} AND status = 'pending'
           AND notification_type::text LIKE 'eblast_%'
           AND context_data->>'broadcastId' = ${id as string}
         ORDER BY notification_type`),
    )) as unknown as Array<{ notification_type: string }>;
  }

  async function imagesOf(id: BroadcastId): Promise<Array<{ id: string; deleted_at: Date | null }>> {
    return (await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        SELECT id::text AS id, deleted_at FROM broadcast_images
         WHERE tenant_id = ${tenant.ctx.slug} AND owner_kind = 'broadcast' AND owner_id = ${id as string}
         ORDER BY created_at, id`),
    )) as unknown as Array<{ id: string; deleted_at: Date | null }>;
  }

  async function redactionAttestations(): Promise<Array<{ payload: Record<string, unknown> }>> {
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'broadcast_content_redacted')));
    return rows
      .map((r) => ({ payload: r.payload as Record<string, unknown> }))
      .filter((r) => r.payload.member_id === memberId);
  }

  /** submit → start → save → send: the E-Blast is awaiting its member in round 1. */
  async function driveToRoundOne(forMember: string, submitter: TestUser, company: string): Promise<{ id: BroadcastId; versionId: string }> {
    const submitted = await submitBroadcast(makeSubmitBroadcastDeps(tenant.ctx.slug), {
      memberId: forMember,
      submittedByUserId: submitter.userId,
      actorRole: 'member_self_service',
      tenantDisplayName: 'Test Chamber',
      memberDisplayName: company,
      subject: `${company} — autumn mixer (member original)`,
      bodySource: 'plain',
      bodyHtml: `<p>${company} invites you in October — call Somchai on 081-234-5678.</p>`,
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });
    if (!submitted.ok) throw new Error(`submit refused: ${JSON.stringify(submitted.error)}`);
    const id = asBroadcastId(submitted.value.broadcastId);
    const started = await startFormattedVersion(
      { ...makeStartFormattedVersionDeps(tenant.ctx.slug), memberApprovalEnabled: true },
      { broadcastId: id, ...actor },
    );
    if (!started.ok) throw new Error(`start refused: ${JSON.stringify(started.error)}`);
    const saved = await saveFormattedVersion(makeSaveFormattedVersionDeps(tenant.ctx.slug), {
      broadcastId: id,
      actorUserId: MARKETER.userId,
      requestId: null,
      subject: `${company} — formatted round 1`,
      bodyHtml: `<p>${company}: formatted body, round 1.</p>`,
      bodySource: '{"type":"doc","content":[{"type":"paragraph"}]}',
      noteToMember: `Round 1 note for ${company} — we moved the date up top.`,
      expectedUpdatedAt: started.value.version.updatedAt,
    });
    if (!saved.ok) throw new Error(`save refused: ${JSON.stringify(saved.error)}`);
    const sent = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), { broadcastId: id, ...actor });
    if (!sent.ok) throw new Error(`send refused: ${JSON.stringify(sent.error)}`);
    return { id, versionId: sent.value.versionId };
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    admin = await createActiveTestUser('admin');
    portalUser = await createActiveTestUser('member');
    peerUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    // The F8 leg of the erasure cascade builds its deps from the renewal policies.
    await seedRenewalPolicies(tenant.ctx);
    const subject = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      companyName: 'Erasure Reach Co',
    });
    memberId = subject.memberId;
    const peer = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: peerUser.userId,
      companyName: 'Peer Co',
    });

    // The subject's E-Blast: round 1, a change request, round 2 — awaiting the member again.
    const round1 = await driveToRoundOne(memberId, portalUser, 'Erasure Reach Co');
    broadcastId = round1.id;
    const decided = await recordMemberDecision(
      { ...makeRecordMemberDecisionDeps(tenant.ctx.slug), marketingDirectory: roster },
      {
        broadcastId,
        memberId,
        actorUserId: portalUser.userId,
        actorRole: 'member',
        contactId: subject.contactId,
        versionId: round1.versionId,
        decision: 'changes_requested',
        reason: 'The date is wrong — ask Khun Somchai (somchai@erasure-reach.example).',
        requestId: null,
      },
    );
    if (!decided.ok) throw new Error(`decision refused: ${JSON.stringify(decided.error)}`);
    const restarted = await startFormattedVersion(
      { ...makeStartFormattedVersionDeps(tenant.ctx.slug), memberApprovalEnabled: true },
      { broadcastId, ...actor },
    );
    if (!restarted.ok) throw new Error(`restart refused: ${JSON.stringify(restarted.error)}`);
    const saved2 = await saveFormattedVersion(makeSaveFormattedVersionDeps(tenant.ctx.slug), {
      broadcastId,
      actorUserId: MARKETER.userId,
      requestId: null,
      subject: 'Erasure Reach Co — formatted round 2',
      bodyHtml: '<p>Erasure Reach Co: formatted body, round 2.</p>',
      bodySource: '{"type":"doc","content":[{"type":"paragraph"}]}',
      noteToMember: 'Round 2 note — the date is fixed.',
      expectedUpdatedAt: restarted.value.version.updatedAt,
    });
    if (!saved2.ok) throw new Error(`save 2 refused: ${JSON.stringify(saved2.error)}`);
    const sent2 = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), { broadcastId, ...actor });
    if (!sent2.ok) throw new Error(`send 2 refused: ${JSON.stringify(sent2.error)}`);

    // Two images uploaded for it.
    for (const hash of [`erase1${randomUUID().replace(/-/g, '')}`, `erase2${randomUUID().replace(/-/g, '')}`]) {
      const blobKey = `broadcasts/images/${tenant.ctx.slug}/${hash}.png`;
      await runInTenant(tenant.ctx, (tx) =>
        drizzleBroadcastImagesRepo.record(
          tenant.ctx.slug as never,
          {
            ownerKind: 'broadcast',
            ownerId: broadcastId as string,
            contentHash: hash,
            blobUrl: `https://${IMAGE_HOST}/${blobKey}`,
            blobKey,
            mimeType: 'image/png',
            byteSize: 2048,
            uploadedByUserId: portalUser.userId,
          },
          tx,
        ),
      );
    }

    // A peer member's E-Blast, awaiting them in round 1 — must survive untouched.
    peerBroadcastId = (await driveToRoundOne(peer.memberId, peerUser, 'Peer Co')).id;
  }, 300_000);

  afterAll(async () => {
    const slug = tenant?.ctx.slug;
    if (slug !== undefined) {
      await db.execute(sql`DELETE FROM broadcast_images WHERE tenant_id = ${slug}`).catch(() => {});
      await db.execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${slug}`).catch(() => {});
    }
    await tenant?.cleanup().catch(() => {});
    for (const u of [admin, portalUser, peerUser]) if (u) await deleteTestUser(u).catch(() => {});
  }, 120_000);

  it('a member erased at Awaiting member approval: no non-sentinel value in either child table, the broadcast cancelled, every image row stamped, pending outbox rows cancelled, and a second run changes nothing', async () => {
    // Preconditions — the round really left content, a reason and pending hand-offs behind.
    const [before] = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)));
    expect([before!.status, before!.currentRound]).toEqual(['awaiting_member_approval', 2]);
    expect((await versionsOf(broadcastId)).map((v) => v.version_no)).toEqual([0, 1, 2]);
    expect((await decisionsOf(broadcastId)).map((d) => d.decision)).toEqual(['changes_requested']);
    expect((await pendingEblastOutbox(broadcastId)).map((r) => r.notification_type)).toEqual([
      'eblast_member_decided_marketing',
      'eblast_version_sent_member',
      'eblast_version_sent_member',
    ]);
    const peerVersionsBefore = await versionsOf(peerBroadcastId);
    const peerOutboxBefore = await pendingEblastOutbox(peerBroadcastId);
    expect(peerOutboxBefore).toHaveLength(1);

    const result = await eraseMember(
      asMemberId(memberId),
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-eblast-erasure-${randomUUID()}` },
      buildEraseMemberDeps(tenant.ctx),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    // The E-Blast is cancelled (T080 — the in-flight set is every stage before `sending`).
    const [after] = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)));
    expect(after!.status).toBe('cancelled');
    expect(after!.subject).toBe(SENTINEL);

    // Every version KEPT, every content column and every note a sentinel (a note never written stays NULL).
    const versions = await versionsOf(broadcastId);
    expect(versions.map((v) => v.version_no)).toEqual([0, 1, 2]);
    for (const v of versions) {
      expect([v.subject, v.body_html, v.body_source], `v${v.version_no}`).toEqual([SENTINEL, SENTINEL, SENTINEL]);
      expect([null, SENTINEL], `v${v.version_no} note`).toContain(v.note_to_member);
    }
    expect(versions.filter((v) => v.note_to_member === SENTINEL).map((v) => v.version_no)).toEqual([1, 2]);

    // Every decision KEPT (SC-002), the reason a sentinel.
    expect(await decisionsOf(broadcastId)).toEqual([expect.objectContaining({ decision: 'changes_requested', reason: SENTINEL })]);

    // Every image row stamped.
    const images = await imagesOf(broadcastId);
    expect(images).toHaveLength(2);
    for (const image of images) expect(image.deleted_at).not.toBeNull();

    // No pending notification about the E-Blast survives — staff-addressed ones included.
    expect(await pendingEblastOutbox(broadcastId)).toEqual([]);

    // The attestation records the new axes.
    const attestations = await redactionAttestations();
    expect(attestations).toHaveLength(1);
    expect(attestations[0]!.payload).toMatchObject({
      versions_redacted: 3,
      decision_reasons_redacted: 1,
      notifications_cancelled: 1,
      images_marked: 2,
    });

    // COMP-1 — the peer's E-Blast is untouched.
    expect(await versionsOf(peerBroadcastId)).toEqual(peerVersionsBefore);
    expect(await pendingEblastOutbox(peerBroadcastId)).toEqual(peerOutboxBefore);

    // A second run (the US2d reconciler's re-drive) changes nothing and attests nothing new.
    const snapshot = {
      versions: await versionsOf(broadcastId),
      decisions: await decisionsOf(broadcastId),
      images: await imagesOf(broadcastId),
      outbox: await pendingEblastOutbox(broadcastId),
    };
    const again = await eraseMember(
      asMemberId(memberId),
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-eblast-erasure-redrive-${randomUUID()}` },
      buildEraseMemberDeps(tenant.ctx),
    );
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect({
      versions: await versionsOf(broadcastId),
      decisions: await decisionsOf(broadcastId),
      images: await imagesOf(broadcastId),
      outbox: await pendingEblastOutbox(broadcastId),
    }).toEqual(snapshot);
    expect(await redactionAttestations()).toHaveLength(1);
  }, 180_000);

  it('T083: the DSAR archive of an erased member contains only sentinels in broadcast-versions.json', async () => {
    const data = await gdprArchiveSourceAdapter.gather(tenant.ctx, { subjectMemberId: memberId });
    expect(data).not.toBeNull();
    const threads = data!.broadcastVersions as ReadonlyArray<{
      broadcastId: string;
      versions: ReadonlyArray<Record<string, unknown>>;
      decisions: ReadonlyArray<Record<string, unknown>>;
    }>;
    // Scoped to the member's own E-Blast — the peer's is not in it.
    expect(threads.map((t) => t.broadcastId)).toEqual([broadcastId]);
    const [thread] = threads;
    // The two SENT versions and the member's original; content and notes are sentinels.
    expect(thread!.versions.map((v) => v.versionNo)).toEqual([0, 1, 2]);
    for (const v of thread!.versions) {
      expect([v.subject, v.bodyHtml]).toEqual([SENTINEL, SENTINEL]);
      expect([null, SENTINEL]).toContain(v.noteToMember);
    }
    expect(thread!.decisions.map((d) => [d.decision, d.reason])).toEqual([['changes_requested', SENTINEL]]);
    // Nothing the member wrote, nothing marketing wrote, no staff identity.
    const text = JSON.stringify(threads);
    for (const leaked of ['Somchai', 'somchai@', 'formatted round', 'Round 1 note', 'Round 2 note', MARKETER.userId]) {
      expect(text).not.toContain(leaked);
    }
  }, 120_000);
});
