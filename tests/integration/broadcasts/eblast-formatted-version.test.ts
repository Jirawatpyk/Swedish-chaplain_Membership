/**
 * F119 T055 / T056 / T057 / T058 / T061 — the formatting round against LIVE
 * Postgres (Neon `dev`), through the real Drizzle repos and the real audit
 * adapter. What the in-memory fakes cannot prove, this does:
 *
 *   - version 0 stamped `sent_to_member_at` coexists with the working copy
 *     under `broadcast_versions_one_unsent_idx`, and the trigger keeps it
 *     read-only;
 *   - `applyTransition` really writes `stage_entered_at`,
 *     `approved_version_id = NULL` and `scheduled_for = NULL` (a key missing
 *     from its passthrough list is dropped SILENTLY), and the voiding
 *     `member_approved → in_design` edge clears `scheduled_for` through the
 *     immutability trigger's E2 exemption;
 *   - the optimistic-concurrency token survives the µs (column) / ms (JS)
 *     round-trip;
 *   - the audit rows land with `related_member_id` and no content.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import { saveFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/save-formatted-version';
import { listBroadcastVersions } from '@/modules/broadcasts/application/use-cases/approval/list-broadcast-versions';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { drizzleBroadcastVersionsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-versions-repo';
import { drizzleBroadcastDecisionsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-decisions-repo';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import { broadcasts, broadcastVersions, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { errorChainMessage } from '@/lib/db-errors';
import { makeFakeImageAllowlist } from '../../helpers/eblast-approval-fakes';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const SUBMITTED_AT = new Date('2026-09-20T08:00:00.000Z');
const SCHEDULED = new Date('2026-10-01T03:00:00.000Z');
const NOW = new Date('2026-09-24T09:00:00.000Z');
const MARKETER = randomUUID();

describe('F119 formatting round — real repos on live Postgres', () => {
  let tenant: TestTenant;
  const memberId = randomUUID();
  const clock = { now: () => NOW };

  const seed = (patch: Partial<NewBroadcastRow>): NewBroadcastRow => ({
    tenantId: tenant.ctx.slug,
    broadcastId: randomUUID(),
    requestedByMemberId: memberId,
    requestedByMemberPlanIdSnapshot: 'plan-f119',
    submittedByUserId: randomUUID(),
    actorRole: 'member_self_service',
    subject: 'Member original subject',
    bodyHtml: '<p>Member original</p>',
    bodySource: 'original-source',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 10,
    status: 'submitted',
    submittedAt: SUBMITTED_AT,
    scheduledFor: SCHEDULED,
    proposedSendAt: SCHEDULED,
    ...patch,
  });
  const startDeps = () => ({
    tenant: tenant.ctx,
    broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
    versionsRepo: drizzleBroadcastVersionsRepo,
    audit: f7AuditAdapter,
    clock,
    memberApprovalEnabled: true,
  });
  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) => (await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, id)))[0]!);
  const readVersions = (id: string) =>
    runInTenant(tenant.ctx, (tx) => tx.select().from(broadcastVersions).where(eq(broadcastVersions.broadcastId, id)));

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });
  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('start from submitted: v0 frozen beside the working copy, the row in_design with a fresh stage clock, the original untouched', async () => {
    const row = seed({});
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const requestId = `f119-start-${randomUUID()}`;

    const r = await startFormattedVersion(startDeps(), {
      broadcastId: asBroadcastId(row.broadcastId!),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      requestId,
    });
    expect(r.ok).toBe(true);

    const after = await readRow(row.broadcastId!);
    expect(after).toMatchObject({ status: 'in_design', subject: row.subject, bodyHtml: row.bodyHtml, bodySource: row.bodySource });
    expect(after.stageEnteredAt).toEqual(NOW);
    const versions = (await readVersions(row.broadcastId!)).sort((a, b) => a.versionNo - b.versionNo);
    expect(versions.map((v) => [v.versionNo, v.sentToMemberAt])).toEqual([[0, SUBMITTED_AT], [1, null]]);

    // v0 is read-only from the moment it is written.
    const edit = await runInTenant(tenant.ctx, (tx) =>
      tx.update(broadcastVersions).set({ subject: 'tampered' }).where(eq(broadcastVersions.id, versions[0]!.id)),
    ).then(() => 'ok', (e: unknown) => errorChainMessage(e));
    expect(edit).toContain('broadcast_version_immutable_after_send');

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)));
    expect(audits.map((a) => a.eventType)).toEqual(['broadcast_version_started']);
    expect(audits[0]!.payload).toEqual({
      related_member_id: memberId,
      broadcast_id: row.broadcastId,
      version_id: versions[1]!.id,
      round: 1,
      from_stage: 'submitted',
      actor_role: 'marketing',
    });

    // The token round-trips (µs column, ms client): the save lands, a stale one loses.
    const token = r.ok ? r.value.version.updatedAt : NOW;
    const saveDeps = {
      tenant: tenant.ctx,
      broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
      versionsRepo: drizzleBroadcastVersionsRepo,
      sanitizer: dompurifySanitizer,
      imageAllowlist: makeFakeImageAllowlist([]), // the body carries no image
      audit: f7AuditAdapter,
      clock,
    };
    const save = (subject: string, expectedUpdatedAt: Date) =>
      saveFormattedVersion(saveDeps, {
        broadcastId: asBroadcastId(row.broadcastId!),
        actorUserId: MARKETER,
        requestId: null,
        subject,
        bodyHtml: `<p>${subject}</p>`,
        bodySource: 'formatted',
        noteToMember: 'A covering note.',
        expectedUpdatedAt: new Date(expectedUpdatedAt.toISOString()),
      });
    const first = await save('Formatted once', token);
    expect(first.ok).toBe(true);
    const stale = await save('Formatted twice', token);
    expect(stale.ok ? null : stale.error.kind).toBe('version_changed');
  });

  it('start from member_approved voids the approval: approved_version_id and scheduled_for cleared through the E2 exemption', async () => {
    const row = seed({ status: 'member_approved', currentRound: 1 });
    const v0Id = randomUUID();
    const v1Id = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values(row);
      await tx.insert(broadcastVersions).values([
        { tenantId: tenant.ctx.slug, id: v0Id, broadcastId: row.broadcastId!, versionNo: 0, subject: 'orig', bodyHtml: '<p>o</p>', bodySource: 'o', authoredByUserId: row.submittedByUserId!, authoredByRole: 'member_self_service', sentToMemberAt: SUBMITTED_AT },
        { tenantId: tenant.ctx.slug, id: v1Id, broadcastId: row.broadcastId!, versionNo: 1, subject: 'approved one', bodyHtml: '<p>a</p>', bodySource: 'a', authoredByUserId: MARKETER, authoredByRole: 'admin_proxy', sentToMemberAt: new Date('2026-09-21T08:00:00.000Z') },
      ]);
      await tx.update(broadcasts).set({ approvedVersionId: v1Id }).where(eq(broadcasts.broadcastId, row.broadcastId!));
    });

    const r = await startFormattedVersion(startDeps(), {
      broadcastId: asBroadcastId(row.broadcastId!),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      requestId: `f119-void-${randomUUID()}`,
    });
    expect(r.ok).toBe(true);
    const after = await readRow(row.broadcastId!);
    expect(after).toMatchObject({ status: 'in_design', approvedVersionId: null, scheduledFor: null, proposedSendAt: SCHEDULED });
    const v2 = (await readVersions(row.broadcastId!)).find((v) => v.versionNo === 2);
    expect(v2).toMatchObject({ subject: 'approved one', sentToMemberAt: null });

    // The thread reads the same rows back through the decisions repo too.
    await runInTenant(tenant.ctx, (tx) =>
      drizzleBroadcastDecisionsRepo.insert(
        tenant.ctx.slug,
        { broadcastId: asBroadcastId(row.broadcastId!), versionId: v1Id, round: 1, decision: 'approved', reason: null, decidedByUserId: randomUUID(), decidedByContactId: randomUUID() },
        tx,
      ),
    );
    const thread = await listBroadcastVersions(
      {
        tenant: tenant.ctx,
        broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
        versionsRepo: drizzleBroadcastVersionsRepo,
        decisionsRepo: drizzleBroadcastDecisionsRepo,
        names: { resolveNames: async () => new Map() },
        audit: f7AuditAdapter,
      },
      { broadcastId: asBroadcastId(row.broadcastId!), actorUserId: MARKETER, requestId: null },
    );
    expect(thread.ok && thread.value.sentVersions.map((e) => e.version.versionNo)).toEqual([1]);
    expect(thread.ok && thread.value.decisions.map((d) => [d.versionId, d.decision])).toEqual([[v1Id, 'approved']]);
    expect(thread.ok && thread.value.workingCopy?.version.versionNo).toBe(2);
  });
});
