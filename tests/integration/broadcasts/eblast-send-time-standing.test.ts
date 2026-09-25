/**
 * F119 T166 S-H1 — "the existing rules that block sending still apply at send
 * time" (spec § Edge Cases; `src/lib/lapsed-portal-scope.ts`), on LIVE
 * Postgres (Neon `dev`) through the REAL composition roots — the real halt
 * read (F3 members barrel) and the real F8 membership-access bridge, no
 * stubbed port.
 *
 * Only `submitBroadcast` read those rules. Approve-as-submitted (the live,
 * unflagged path) and the approval-round promotion (`confirmSchedule` from
 * `member_approved`) read neither, so a member halted — or whose membership
 * lapsed — after submitting had the E-Blast approved and sent. Both now
 * refuse with 409: a terminated member → `member_not_in_good_standing`, a
 * halted member → `member_halted`; the row is left exactly as it was.
 *
 * T166 follow-up — each refusal also writes submit's own refusal audit row
 * (`broadcast_member_halted_pending_review` / `…_membership_suspended_blocked`).
 * The promotion's row is written on AUTOCOMMIT after its tx rolled back
 * (tx null → the pool-global `db`), so only a read-back on live Postgres
 * proves it lands under RLS + FORCE; it is read here inside the tenant's own
 * RLS slice.
 *
 * F119 PR-A — the SAME reads at SEND time, on both dispatch legs: a halted and
 * a suspended member each end `failed_to_dispatch` with their reason, the quota
 * slot is released, Resend (a recording fake) is never called, and on the
 * import leg a tick-2 refusal leaves the tick-1 audience where
 * `cleanup-audiences` reaps it.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { makeConfirmScheduleDeps } from '@/lib/broadcast-approval-deps';
import { asBroadcastId, makeApproveBroadcastDeps } from '@/modules/broadcasts';
import { approveBroadcast } from '@/modules/broadcasts/application/use-cases/approve-broadcast';
import { confirmSchedule } from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { dispatchScheduledBroadcast } from '@/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import {
  currentQuotaYear,
  makeBuildAudienceTickDeps,
  makeDispatchScheduledBroadcastDeps,
  makeDrizzleBroadcastsRepo,
} from '@/modules/broadcasts';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { asMemberId } from '@/modules/members';
import { broadcasts, broadcastVersions, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MARKETER = randomUUID();

describe('F119 T166 S-H1 — approve-as-submitted and the promotion re-read member standing (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    planId = `f119-standing-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Send-time Standing Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (user) await deleteTestUser(user).catch(() => {});
  }, 120_000);

  /**
   * A member who is `terminated` (a lapsed latest cycle), `suspended` (an
   * `awaiting_payment` latest cycle: F8 access `suspended`) or `halted` (the
   * F7 halt flag).
   */
  async function seedMember(standing: 'terminated' | 'halted' | 'suspended'): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Standing ${standing} Co`,
        country: 'TH',
        planId,
        planYear: 2026,
        broadcastsHaltedUntilAdminReview: standing === 'halted',
      });
      if (standing === 'suspended') {
        const periodTo = new Date('2027-01-01T00:00:00Z');
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: 'awaiting_payment',
          periodFrom: new Date('2026-01-01T00:00:00Z'),
          periodTo,
          expiresAt: periodTo,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planId,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        });
      }
      if (standing === 'terminated') {
        const periodFrom = new Date('2024-01-01T00:00:00Z');
        const periodTo = new Date('2025-01-01T00:00:00Z');
        await tx.insert(renewalCycles).values({
          tenantId: tenant.ctx.slug,
          cycleId: randomUUID(),
          memberId,
          status: 'lapsed',
          periodFrom,
          periodTo,
          expiresAt: periodTo,
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: planId,
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          closedAt: periodTo,
          closedReason: 'lapsed',
        });
      }
    });
    return memberId;
  }

  const baseRow = (memberId: string, patch: Partial<NewBroadcastRow>): NewBroadcastRow => ({
    tenantId: tenant.ctx.slug,
    broadcastId: randomUUID(),
    requestedByMemberId: memberId,
    requestedByMemberPlanIdSnapshot: planId,
    submittedByUserId: randomUUID(),
    actorRole: 'member_self_service',
    subject: 'Standing check',
    bodyHtml: '<p>Standing check</p>',
    bodySource: 'plain',
    fromName: 'Standing Co via Test Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 1,
    status: 'submitted',
    submittedAt: new Date(Date.now() - 86_400_000),
    scheduledFor: new Date(Date.now() + 86_400_000),
    proposedSendAt: new Date(Date.now() + 86_400_000),
    ...patch,
  });

  /** The audit rows this call wrote, read inside the tenant's RLS slice. */
  const readAudits = (requestId: string) =>
    runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, actorUserId: auditLog.actorUserId, payload: auditLog.payload })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId))),
    );

  const EVENT_OF = {
    member_halted: 'broadcast_member_halted_pending_review',
    member_not_in_good_standing: 'broadcast_membership_suspended_blocked',
  } as const;

  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) =>
      (await tx.select().from(broadcasts).where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, id))))[0]!,
    );

  /** A `member_approved` round-1 row with its approved version. */
  async function seedMemberApproved(memberId: string): Promise<string> {
    const row = baseRow(memberId, { status: 'member_approved', currentRound: 1 });
    const v1 = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values(row);
      await tx.insert(broadcastVersions).values({
        tenantId: tenant.ctx.slug,
        id: v1,
        broadcastId: row.broadcastId!,
        versionNo: 1,
        subject: 'Approved by the member',
        bodyHtml: '<p>Approved</p>',
        bodySource: 'approved',
        authoredByUserId: MARKETER,
        authoredByRole: 'admin_proxy',
        sentToMemberAt: new Date(Date.now() - 3_600_000),
      });
      await tx.update(broadcasts).set({ approvedVersionId: v1 }).where(eq(broadcasts.broadcastId, row.broadcastId!));
    });
    return row.broadcastId!;
  }

  it.each([
    { standing: 'terminated' as const, kind: 'member_not_in_good_standing' as const },
    { standing: 'halted' as const, kind: 'member_halted' as const },
  ])('the promotion (member_approved → approved) for a $standing member → $kind, the row untouched, the refusal audited', async ({ standing, kind }) => {
    const memberId = await seedMember(standing);
    const id = await seedMemberApproved(memberId);
    const before = await readRow(id);
    const requestId = `standing-confirm-${randomUUID()}`;
    const r = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), {
      broadcastId: asBroadcastId(id),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      requestId,
      mode: { mode: 'send_now' },
    });
    expect(r.ok ? r.value.status : r.error).toEqual({ kind, memberId });
    expect(await readRow(id)).toEqual(before);
    expect(await readAudits(requestId)).toEqual([
      {
        eventType: EVENT_OF[kind],
        actorUserId: MARKETER,
        payload: { related_member_id: memberId, broadcast_id: id, surface: 'schedule_confirm', actor_role: 'marketing' },
      },
    ]);
  });

  it.each([
    { standing: 'terminated' as const, kind: 'member_not_in_good_standing' as const },
    { standing: 'halted' as const, kind: 'member_halted' as const },
  ])('approve-as-submitted (submitted → approved) for a $standing member → $kind, the row untouched, the refusal audited', async ({ standing, kind }) => {
    const memberId = await seedMember(standing);
    const row = baseRow(memberId, {});
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const before = await readRow(row.broadcastId!);
    const requestId = `standing-approve-${randomUUID()}`;
    const r = await approveBroadcast(makeApproveBroadcastDeps(tenant.ctx.slug), {
      broadcastId: asBroadcastId(row.broadcastId!),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      decision: { mode: 'send_now' },
      requestId,
    });
    expect(r.ok ? r.value.status : r.error).toEqual({ kind, memberId });
    expect(await readRow(row.broadcastId!)).toEqual(before);
    expect(await readAudits(requestId)).toEqual([
      {
        eventType: EVENT_OF[kind],
        actorUserId: MARKETER,
        payload: { related_member_id: memberId, broadcast_id: row.broadcastId, surface: 'approve_as_submitted', actor_role: 'marketing' },
      },
    ]);
  });

  // ---- F119 PR-A — the SEND-time gate, on both dispatch legs -----------------
  //
  // The three edges above make a row dispatchable; nothing re-read standing
  // after them, so an E-Blast approved days ahead went out after its member was
  // halted or suspended. Driven through the REAL composition roots (the real
  // halt read and the real F8 access bridge); only Resend is a fake, and it
  // RECORDS every call — a refusal must make none.

  const NO_BRAND = { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) };

  /** A Resend double that records every call and refuses all of them. */
  function recordingGateway(): { calls: string[]; port: BroadcastsGatewayPort } {
    const calls: string[] = [];
    const port = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? undefined
            : async () => {
                calls.push(String(prop));
                throw new Error(`gateway.${String(prop)} must not be called on a standing refusal`);
              },
      },
    ) as BroadcastsGatewayPort;
    return { calls, port };
  }

  /** The member's reserved (submitted / approved) count for this quota year. */
  const reserved = async (memberId: string) =>
    (
      await makeDrizzleBroadcastsRepo(tenant.ctx.slug).countForMemberQuota(
        tenant.ctx.slug,
        asMemberId(memberId),
        currentQuotaYear(new Date(), 'Asia/Bangkok'),
      )
    ).submittedOrApproved;

  /** The dispatch audit rows for one broadcast (the cron writes them with no request id). */
  const dispatchAudits = async (id: string) =>
    (
      await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ eventType: auditLog.eventType, actorUserId: auditLog.actorUserId, payload: auditLog.payload })
          .from(auditLog)
          .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.actorUserId, 'system:cron'))),
      )
    ).filter((a) => {
      const p = a.payload as Record<string, unknown>;
      return p['broadcastId'] === id || p['broadcast_id'] === id;
    });

  const approvedRow = (memberId: string, patch: Partial<NewBroadcastRow> = {}): NewBroadcastRow =>
    baseRow(memberId, {
      status: 'approved',
      approvedAt: new Date(Date.now() - 3_600_000),
      scheduledFor: new Date(Date.now() - 60_000),
      ...patch,
    });

  it.each([
    { standing: 'halted' as const, reason: 'member_halted' as const },
    { standing: 'suspended' as const, reason: 'member_not_in_good_standing' as const },
  ])('legacy dispatch for a $standing member → failed_to_dispatch ($reason), the slot freed, no Resend call', async ({ standing, reason }) => {
    const memberId = await seedMember(standing);
    const row = approvedRow(memberId);
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    expect(await reserved(memberId)).toBe(1);
    const gw = recordingGateway();
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: false, error: { kind: 'broadcast_failed_to_dispatch', reason } });
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('failed_to_dispatch');
    expect(after.failureReason).toBe(reason);
    expect(await reserved(memberId)).toBe(0);
    expect(gw.calls).toEqual([]);
    const audits = await dispatchAudits(row.broadcastId!);
    // The seeded member has no primary contact, so the FR-021 notice is skipped
    // and audited as such (`…_notif_skipped_no_email`) — the member-notice leg
    // is unchanged here; the two rows this gate writes are the other two.
    expect(audits.map((a) => a.eventType).sort()).toEqual(
      ['broadcast_failed_to_dispatch', 'broadcast_dispatch_failure_notif_skipped_no_email', EVENT_OF[reason]].sort(),
    );
    // Landed under RLS + FORCE, and keyed `related_member_id` — the cron's act
    // must not fire the 0009 `last_activity_at` trigger (`member_id`).
    expect(audits.find((a) => a.eventType === EVENT_OF[reason])?.payload).toEqual({
      related_member_id: memberId,
      broadcast_id: row.broadcastId,
      surface: 'dispatch',
      actor_role: null,
    });
  });

  it('import leg, tick 2, a member halted after the import was submitted → failed_to_dispatch, no Resend call, and the tick-1 audience is a cleanup candidate', async () => {
    const memberId = await seedMember('halted');
    const audienceId = `aud-standing-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: audienceId,
      audienceImportId: `imp-standing-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = recordingGateway();
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r.ok ? r.value : r.error).toMatchObject({ kind: 'audience_import_failed', reason: 'member_halted' });
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('failed_to_dispatch');
    expect(after.failureReason).toBe('member_halted');
    expect(after.resendAudienceId).toBe(audienceId);
    expect(await reserved(memberId)).toBe(0);
    expect(gw.calls).toEqual([]);
    // The reaper's own query sees it: terminal, with a live audience. A
    // shortcut that left the row `approved` would orphan the audience (the
    // Resend Free plan holds three).
    const candidates = await makeDrizzleBroadcastsRepo(tenant.ctx.slug).listTerminalBroadcastsWithLiveAudience(
      tenant.ctx.slug,
      new Date(Date.now() + 3_600_000),
      500,
    );
    expect(candidates).toContainEqual({ broadcastId: row.broadcastId, resendAudienceId: audienceId });
  });
});
