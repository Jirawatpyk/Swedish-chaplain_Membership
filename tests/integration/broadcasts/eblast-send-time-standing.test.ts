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
 * a terminated (lapsed) member each end `failed_to_dispatch` with their reason,
 * the quota slot is released, Resend (a recording fake) is never called, and on
 * the import leg a tick-2 refusal leaves the tick-1 audience where
 * `cleanup-audiences` reaps it. A SUSPENDED member (an `awaiting_payment` cycle
 * whose paid period has not ended) is HELD on both legs (R1): the slot stays
 * reserved and no refusal row is written. The legacy row is left exactly as it
 * was; an import-leg row on tick 2 abandons its pending import (the tick-1
 * audience deleted, the columns detached) and resumes with a fresh tick 1.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { ok } from '@/lib/result';
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
   * `awaiting_payment` latest cycle: F8 access `suspended`), `halted` (the
   * F7 halt flag) or `erased` (spec 139: `erased_at` set, no cycle — so F8
   * access answers `full` and the halt list, which filters erased members,
   * does not name them: only the erasure read refuses).
   */
  async function seedMember(standing: 'terminated' | 'halted' | 'suspended' | 'erased'): Promise<string> {
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
        ...(standing === 'erased' ? { erasedAt: new Date(Date.now() - 3_600_000) } : {}),
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
    { standing: 'terminated' as const, kind: 'member_not_in_good_standing' as const, access: { access: 'terminated' as const } },
    { standing: 'halted' as const, kind: 'member_halted' as const, access: {} },
  ])('the promotion (member_approved → approved) for a $standing member → $kind, the row untouched, the refusal audited', async ({ standing, kind, access }) => {
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
    expect(r.ok ? r.value.status : r.error).toEqual({ kind, memberId, ...access });
    expect(await readRow(id)).toEqual(before);
    expect(await readAudits(requestId)).toEqual([
      {
        eventType: EVENT_OF[kind],
        actorUserId: MARKETER,
        payload: { related_member_id: memberId, broadcast_id: id, surface: 'schedule_confirm', ...access, actor_role: 'marketing' },
      },
    ]);
  });

  it.each([
    { standing: 'terminated' as const, kind: 'member_not_in_good_standing' as const, access: { access: 'terminated' as const } },
    { standing: 'halted' as const, kind: 'member_halted' as const, access: {} },
  ])('approve-as-submitted (submitted → approved) for a $standing member → $kind, the row untouched, the refusal audited', async ({ standing, kind, access }) => {
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
        payload: { related_member_id: memberId, broadcast_id: row.broadcastId, surface: 'approve_as_submitted', ...access, actor_role: 'marketing' },
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
    { standing: 'halted' as const, reason: 'member_halted' as const, access: {} },
    { standing: 'terminated' as const, reason: 'member_not_in_good_standing' as const, access: { access: 'terminated' as const } },
  ])('legacy dispatch for a $standing member → failed_to_dispatch ($reason), the slot freed, no Resend call', async ({ standing, reason, access }) => {
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
      ...access,
      actor_role: null,
    });
  });

  // ---- Spec 140 s1 ED4 (review round 2, code-review #8) — on real Postgres ----
  //
  // A halted refusal deletes the row's never-handed draft before its terminal
  // write and records `resendDraftOutcome`; a 403 whose one GET reads handed is
  // a sibling tick's send — no terminal write, no member notice (not even the
  // `…_notif_skipped_no_email` row), the row left `approved`.

  it('ED4 legacy: a halted refusal deletes the draft on the row first; broadcast_failed_to_dispatch carries resendDraftOutcome deleted', async () => {
    const memberId = await seedMember('halted');
    const resendBroadcastId = `rb-ed4-${randomUUID()}`;
    const row = approvedRow(memberId, { resendAudienceId: `aud-ed4-${randomUUID()}`, resendBroadcastId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'deleted' },
    });
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: false, error: { kind: 'broadcast_failed_to_dispatch', reason: 'member_halted' } });
    expect(gw.calls.map((c) => c.method)).toEqual(['retrieveBroadcast', 'deleteBroadcastOnce']);
    expect((await readRow(row.broadcastId!)).status).toBe('failed_to_dispatch');
    const failed = (await dispatchAudits(row.broadcastId!)).find((a) => (a.eventType as string) === 'broadcast_failed_to_dispatch');
    expect(failed?.payload).toMatchObject({ reason: 'member_halted', resendDraftOutcome: 'deleted' });
  });

  it('ED4 legacy: a 403 whose probe reads sent (a sibling sent it) → no terminal write, no member notice, the row stays approved', async () => {
    const memberId = await seedMember('halted');
    const resendBroadcastId = `rb-ed4-${randomUUID()}`;
    const row = approvedRow(memberId, { resendAudienceId: `aud-ed4-${randomUUID()}`, resendBroadcastId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'forbidden' },
      retrieveBroadcastOnce: { kind: 'present', status: 'sent' },
    });
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' } });
    expect((await readRow(row.broadcastId!)).status).toBe('approved');
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  it('ED4 import: a halted refusal deletes the draft on the row first; broadcast_failed_to_dispatch carries resendDraftOutcome deleted', async () => {
    const memberId = await seedMember('halted');
    const resendBroadcastId = `rb-ed4-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: `aud-ed4-${randomUUID()}`,
      resendBroadcastId,
      audienceImportId: `imp-ed4-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'deleted' },
    });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r.ok ? r.value : r.error).toMatchObject({ kind: 'audience_import_failed', reason: 'member_halted' });
    expect(gw.calls.map((c) => c.method)).toEqual(['retrieveBroadcast', 'deleteBroadcastOnce']);
    expect((await readRow(row.broadcastId!)).status).toBe('failed_to_dispatch');
    const failed = (await dispatchAudits(row.broadcastId!)).find((a) => (a.eventType as string) === 'broadcast_failed_to_dispatch');
    expect(failed?.payload).toMatchObject({ reason: 'member_halted', resendDraftOutcome: 'deleted' });
  });

  it('ED4 import: a 403 whose probe reads queued (a sibling sent it) → no terminal write, no member notice, the row stays approved', async () => {
    const memberId = await seedMember('halted');
    const resendBroadcastId = `rb-ed4-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: `aud-ed4-${randomUUID()}`,
      resendBroadcastId,
      audienceImportId: `imp-ed4-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'forbidden' },
      retrieveBroadcastOnce: { kind: 'present', status: 'queued' },
    });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' } });
    expect((await readRow(row.broadcastId!)).status).toBe('approved');
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  // ---- R1 — a SUSPENDED membership is HELD, never refused ------------------
  //
  // The seeded `suspended` member's latest cycle is `awaiting_payment` with a
  // FUTURE `expires_at` — the renewal bill is out and the paid period has not
  // ended, which F8 already reports as `suspended`. Refusing there killed the
  // E-Blast of a member in good faith. Held: nothing sent, nothing written,
  // the row stays `approved` with its slot reserved, and no refusal row exists.

  it('legacy dispatch for a SUSPENDED member (awaiting_payment, future expiry) → held: row approved, slot kept, nothing audited, no Resend call', async () => {
    const memberId = await seedMember('suspended');
    const row = approvedRow(memberId);
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const before = await readRow(row.broadcastId!);
    const gw = recordingGateway();
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: true, value: { kind: 'dispatch_held_member_suspended' } });
    expect(await readRow(row.broadcastId!)).toEqual(before);
    expect(await reserved(memberId)).toBe(1);
    expect(gw.calls).toEqual([]);
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  /**
   * A Resend double that answers the named methods and records every call; any
   * other method throws. `recordingGateway` refuses everything, which a hold
   * that abandons its import (one `deleteAudience`) cannot use.
   */
  function allowingGateway(answers: Partial<Record<keyof BroadcastsGatewayPort, unknown>>): {
    calls: Array<{ method: string; args: unknown[] }>;
    port: BroadcastsGatewayPort;
  } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const port = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? undefined
            : async (...args: unknown[]) => {
                calls.push({ method: String(prop), args });
                if (!(String(prop) in answers)) throw new Error(`gateway.${String(prop)} must not be called here`);
                return answers[String(prop) as keyof BroadcastsGatewayPort];
              },
      },
    ) as BroadcastsGatewayPort;
    return { calls, port };
  }

  /** The `audience_import_stuck_count` gauge's own predicate (broadcasts-gauges route). */
  const stuckGaugeMatches = async (id: string) =>
    (
      (await runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          SELECT broadcast_id::text AS id
          FROM broadcasts
          WHERE audience_import_id IS NOT NULL
            AND audience_import_completed_at IS NULL
            AND status::text = 'approved'
            AND audience_import_submitted_at < now() - interval '30 minutes'
            AND tenant_id = ${tenant.ctx.slug}
            AND broadcast_id = ${id}::uuid`),
      )) as unknown as Array<{ id: string }>
    ).length > 0;

  it('import leg, tick 2, a SUSPENDED member → held: the tick-1 audience is deleted and the import detached, nothing audited, nothing sent; once access is back a FRESH tick 1 runs', async () => {
    const memberId = await seedMember('suspended');
    const audienceId = `aud-held-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: audienceId,
      audienceImportId: `imp-held-${randomUUID()}`,
      // Older than the 30-minute stuck window, so the gauge DID match before.
      audienceImportSubmittedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    expect(await stuckGaugeMatches(row.broadcastId!)).toBe(true);
    const gw = allowingGateway({ deleteAudience: undefined });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: true, value: { kind: 'dispatch_held_member_suspended' } });
    expect(gw.calls).toEqual([{ method: 'deleteAudience', args: [audienceId] }]);
    const held = await readRow(row.broadcastId!);
    expect(held.status).toBe('approved');
    expect(held.resendAudienceId).toBeNull();
    expect(held.audienceImportId).toBeNull();
    expect(held.audienceImportSubmittedAt).toBeNull();
    expect(held.audienceImportCompletedAt).toBeNull();
    expect(held.resendBroadcastId).toBeNull();
    expect(await stuckGaugeMatches(row.broadcastId!)).toBe(false);
    expect(await reserved(memberId)).toBe(1);
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);

    // Access back to `full` (0309: an early bill on a paid period keeps access).
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(renewalCycles)
        .set({ awaitingEnteredAt: new Date() })
        .where(and(eq(renewalCycles.tenantId, tenant.ctx.slug), eq(renewalCycles.memberId, memberId))),
    );
    const resumedGw = allowingGateway({
      createAudience: { audienceId: 'aud-fresh' },
      createContactImport: { importId: 'imp-fresh' },
    });
    const resumed = await buildAudienceTick(
      {
        ...(await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge)),
        broadcastsGateway: resumedGw.port,
        brandChrome: NO_BRAND,
        resolveRecipients: async () =>
          ok({ recipients: ['fresh@example.com'], estimatedCount: 1, orphans: [], droppedByPreference: 0 }),
      },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(resumed).toEqual({ ok: true, value: { kind: 'import_submitted', importId: 'imp-fresh', recipientCount: 1 } });
    expect(resumedGw.calls.map((c) => c.method)).toEqual(['createAudience', 'createContactImport']);
    const after = await readRow(row.broadcastId!);
    expect(after.resendAudienceId).toBe('aud-fresh');
    expect(after.audienceImportId).toBe('imp-fresh');
    expect(after.audienceImportSubmittedAt).not.toBeNull();
  });

  /**
   * The same hold on a row that also carries a pre-send `resend_broadcast_id`
   * (an earlier tick minted and persisted it, then died before the send). The
   * probe answers `draft`, so nothing was handed to `/send`: the hold claims the
   * row (the import columns), reclaims the draft resource, deletes the
   * audience, and the release then NULLs the broadcast and audience ids
   * together — a row left pointing at a deleted draft would otherwise be sent
   * on a dead id.
   */
  it('import leg, tick 2, a SUSPENDED member with a pre-send broadcast id whose probe answers draft → held: the draft reclaimed, the audience deleted, all three ids detached', async () => {
    const memberId = await seedMember('suspended');
    const audienceId = `aud-held-${randomUUID()}`;
    const resendBroadcastId = `rb-held-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: audienceId,
      resendBroadcastId,
      audienceImportId: `imp-held-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    expect(await stuckGaugeMatches(row.broadcastId!)).toBe(true);
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcast: undefined,
      deleteAudience: undefined,
    });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: true, value: { kind: 'dispatch_held_member_suspended' } });
    expect(gw.calls).toEqual([
      { method: 'retrieveBroadcast', args: [resendBroadcastId] },
      { method: 'deleteBroadcast', args: [resendBroadcastId] },
      { method: 'deleteAudience', args: [audienceId] },
    ]);
    const held = await readRow(row.broadcastId!);
    expect(held.status).toBe('approved');
    expect(held.resendBroadcastId).toBeNull();
    expect(held.resendAudienceId).toBeNull();
    expect(held.audienceImportId).toBeNull();
    expect(held.audienceImportSubmittedAt).toBeNull();
    expect(held.audienceImportCompletedAt).toBeNull();
    expect(await stuckGaugeMatches(row.broadcastId!)).toBe(false);
    expect(await reserved(memberId)).toBe(1);
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  it('import leg, tick 1, a TERMINATED (lapsed) member → failed_to_dispatch (member_not_in_good_standing), permanently, no Resend call', async () => {
    const memberId = await seedMember('terminated');
    const row = approvedRow(memberId);
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = recordingGateway();
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r.ok ? r.value : r.error).toMatchObject({ kind: 'audience_import_failed', reason: 'member_not_in_good_standing' });
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('failed_to_dispatch');
    expect(after.failureReason).toBe('member_not_in_good_standing');
    expect(await reserved(memberId)).toBe(0);
    expect(gw.calls).toEqual([]);
    expect((await dispatchAudits(row.broadcastId!)).map((a) => a.eventType)).toContain(EVENT_OF.member_not_in_good_standing);
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

  // ---- Spec 139 DE1 — an ERASED member's E-Blast is refused at send time ----
  //
  // The erased member below has no renewal cycle, so F8 access answers `full`,
  // and the halt list filters erased members out — before 139 both reads said
  // "send", and the pre-scrub Resend draft went out. The refusal is terminal,
  // `/send` is never called, the only audit row is `broadcast_failed_to_dispatch`
  // with `standing: 'erased'` (P3: no "membership suspended" row, and no member
  // email — so not even the `…_notif_skipped_no_email` row), and a draft the
  // row still carries is DELETED at Resend first (P2): refused only once the
  // DELETE answers `deleted` / `absent`, else nothing is decided.

  /** The one row an erased refusal writes, and its payload. */
  async function expectErasedRefusalAudit(id: string): Promise<void> {
    const audits = await dispatchAudits(id);
    expect(audits.map((a) => a.eventType)).toEqual(['broadcast_failed_to_dispatch']);
    expect(audits[0]!.payload).toMatchObject({ reason: 'member_not_in_good_standing', standing: 'erased' });
  }

  it('legacy dispatch for an ERASED member (no Resend id yet) → failed_to_dispatch (member_not_in_good_standing), the slot freed, no Resend call, one audit row with standing erased', async () => {
    const memberId = await seedMember('erased');
    const row = approvedRow(memberId);
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = recordingGateway();
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: false, error: { kind: 'broadcast_failed_to_dispatch', reason: 'member_not_in_good_standing' } });
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('failed_to_dispatch');
    expect(after.failureReason).toBe('member_not_in_good_standing');
    expect(await reserved(memberId)).toBe(0);
    expect(gw.calls).toEqual([]);
    await expectErasedRefusalAudit(row.broadcastId!);
  });

  it('legacy dispatch for an ERASED member whose row carries a never-sent draft → the draft is DELETED first, then refused (P2)', async () => {
    const memberId = await seedMember('erased');
    const resendBroadcastId = `rb-erased-${randomUUID()}`;
    const row = approvedRow(memberId, { resendAudienceId: `aud-erased-${randomUUID()}`, resendBroadcastId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'deleted' },
    });
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({ ok: false, error: { kind: 'broadcast_failed_to_dispatch', reason: 'member_not_in_good_standing' } });
    expect(gw.calls).toEqual([
      { method: 'retrieveBroadcast', args: [resendBroadcastId] },
      { method: 'deleteBroadcastOnce', args: [resendBroadcastId] },
    ]);
    expect((await readRow(row.broadcastId!)).status).toBe('failed_to_dispatch');
    await expectErasedRefusalAudit(row.broadcastId!);
  });

  it('legacy dispatch for an ERASED member whose draft DELETE fails retryably → undecided: nothing sent, the row stays approved, nothing written', async () => {
    const memberId = await seedMember('erased');
    const resendBroadcastId = `rb-erased-${randomUUID()}`;
    const row = approvedRow(memberId, { resendAudienceId: `aud-erased-${randomUUID()}`, resendBroadcastId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const before = await readRow(row.broadcastId!);
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'retryable' },
    });
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);

    const r = await dispatchScheduledBroadcast(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r).toEqual({
      ok: false,
      error: { kind: 'dispatch.server_error', message: 'member_erased_draft_not_deleted', errClass: 'retryable', phase: 'standing' },
    });
    expect(gw.calls.map((c) => c.method)).toEqual(['retrieveBroadcast', 'deleteBroadcastOnce']);
    expect(await readRow(row.broadcastId!)).toEqual(before);
    expect(await reserved(memberId)).toBe(1);
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  it('import leg, tick 1, an ERASED member → failed_to_dispatch (member_not_in_good_standing), no Resend call, one audit row with standing erased', async () => {
    const memberId = await seedMember('erased');
    const row = approvedRow(memberId);
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = recordingGateway();
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r.ok ? r.value : r.error).toMatchObject({ kind: 'audience_import_failed', reason: 'member_not_in_good_standing' });
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('failed_to_dispatch');
    expect(after.failureReason).toBe('member_not_in_good_standing');
    expect(await reserved(memberId)).toBe(0);
    expect(gw.calls).toEqual([]);
    await expectErasedRefusalAudit(row.broadcastId!);
  });

  it('import leg, tick 2, an ERASED member whose row carries a never-sent draft → the draft is DELETED first, then refused; the tick-1 audience is a cleanup candidate (P2)', async () => {
    const memberId = await seedMember('erased');
    const audienceId = `aud-erased-${randomUUID()}`;
    const resendBroadcastId = `rb-erased-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: audienceId,
      resendBroadcastId,
      audienceImportId: `imp-erased-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'deleted' },
    });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r.ok ? r.value : r.error).toMatchObject({ kind: 'audience_import_failed', reason: 'member_not_in_good_standing' });
    expect(gw.calls).toEqual([
      { method: 'retrieveBroadcast', args: [resendBroadcastId] },
      { method: 'deleteBroadcastOnce', args: [resendBroadcastId] },
    ]);
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('failed_to_dispatch');
    expect(after.resendAudienceId).toBe(audienceId);
    await expectErasedRefusalAudit(row.broadcastId!);
    const candidates = await makeDrizzleBroadcastsRepo(tenant.ctx.slug).listTerminalBroadcastsWithLiveAudience(
      tenant.ctx.slug,
      new Date(Date.now() + 3_600_000),
      500,
    );
    expect(candidates).toContainEqual({ broadcastId: row.broadcastId, resendAudienceId: audienceId });
  });

  it('import leg, an ERASED member whose inherited id the probe calls cancelled → a 403 on the DELETE is not a stall: a cancelled broadcast can never be sent, so it is refused', async () => {
    const memberId = await seedMember('erased');
    const resendBroadcastId = `rb-erased-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: `aud-erased-${randomUUID()}`,
      resendBroadcastId,
      audienceImportId: `imp-erased-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'cancelled', sentAt: null } },
      deleteBroadcastOnce: { kind: 'forbidden' },
    });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);

    const r = await buildAudienceTick(
      { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
      { broadcastId: asBroadcastId(row.broadcastId!) },
    );

    expect(r.ok ? r.value : r.error).toMatchObject({ kind: 'audience_import_failed', reason: 'member_not_in_good_standing' });
    expect(gw.calls.map((c) => c.method)).toEqual(['retrieveBroadcast', 'deleteBroadcastOnce']);
    expect((await readRow(row.broadcastId!)).status).toBe('failed_to_dispatch');
  });
  /**
   * Review round 1 CR#4 — the erased refusal's terminal write loses its CAS
   * because the erasure cascade cancelled the row in between (here: while the
   * leg was deleting the draft). That is a concurrent skip at info level, not
   * `cleanup_failed` / a server error, on both legs.
   */
  function cancelledDuringDelete(answers: Partial<Record<keyof BroadcastsGatewayPort, unknown>>, broadcastId: string) {
    const inner = allowingGateway(answers);
    const port = new Proxy(inner.port, {
      get: (target, prop, receiver) =>
        prop === 'deleteBroadcastOnce'
          ? async (id: string) => {
              const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
              await repo.withTx((tx) =>
                repo.applyTransition(
                  tx,
                  tenant.ctx.slug,
                  asBroadcastId(broadcastId),
                  'cancelled',
                  { cancelledAt: new Date(), cancelledByUserId: null, cancellationReason: 'gdpr_erasure_request' },
                  'approved',
                ),
              );
              return (Reflect.get(target, prop, receiver) as (rid: string) => Promise<unknown>)(id);
            }
          : Reflect.get(target, prop, receiver),
    }) as BroadcastsGatewayPort;
    return { calls: inner.calls, port };
  }

  const cleanupFailedLogged = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.some((c) => typeof c[1] === 'string' && c[1].endsWith('.cleanup_failed'));

  it('CR#4 legacy: the erased refusal loses its CAS to the cascade cancel → a concurrent skip, no cleanup_failed, nothing written', async () => {
    const memberId = await seedMember('erased');
    const resendBroadcastId = `rb-erased-${randomUUID()}`;
    const row = approvedRow(memberId, { resendAudienceId: `aud-erased-${randomUUID()}`, resendBroadcastId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = cancelledDuringDelete(
      {
        retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
        deleteBroadcastOnce: { kind: 'deleted' },
      },
      row.broadcastId!,
    );
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      const r = await dispatchScheduledBroadcast(
        { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
        { broadcastId: asBroadcastId(row.broadcastId!) },
      );

      expect(r).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' } });
      expect(cleanupFailedLogged(errorSpy)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
    expect((await readRow(row.broadcastId!)).status).toBe('cancelled');
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  it('CR#4 import: the erased refusal loses its CAS to the cascade cancel → a concurrent skip, no cleanup_failed, nothing written', async () => {
    const memberId = await seedMember('erased');
    const resendBroadcastId = `rb-erased-${randomUUID()}`;
    const row = approvedRow(memberId, {
      resendAudienceId: `aud-erased-${randomUUID()}`,
      resendBroadcastId,
      audienceImportId: `imp-erased-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const gw = cancelledDuringDelete(
      {
        retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
        deleteBroadcastOnce: { kind: 'deleted' },
      },
      row.broadcastId!,
    );
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      const r = await buildAudienceTick(
        { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
        { broadcastId: asBroadcastId(row.broadcastId!) },
      );

      expect(r).toEqual({ ok: false, error: { kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' } });
      expect(cleanupFailedLogged(errorSpy)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
    expect((await readRow(row.broadcastId!)).status).toBe('cancelled');
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  /**
   * Review round 2 (P4, maintainer 30 Oct 2026) — a requester who is NOT FOUND
   * is no longer refused as erased at dispatch. Erasure never deletes a member
   * row, so a missing one is not evidence of an erasure, and refusing would
   * delete the draft and make the row terminal on a guess. `requested_by_member_id`
   * has no FK to `members`, so such a row is reachable (the dev branch holds
   * six). Both legs answer undecided: nothing sent, the draft NOT deleted, the
   * row left exactly as it was, nothing audited, one warn line (ids only).
   */
  const requesterNotFound = {
    ok: false,
    error: {
      kind: 'dispatch.server_error',
      message: 'member_standing_requester_not_found',
      errClass: 'requester_not_found',
      phase: 'standing',
    },
  };

  it('P4 legacy: a requester not found → undecided: the draft is not deleted, the row stays approved, nothing written', async () => {
    const missingMemberId = randomUUID();
    const resendBroadcastId = `rb-orphan-${randomUUID()}`;
    const row = approvedRow(missingMemberId, { resendAudienceId: `aud-orphan-${randomUUID()}`, resendBroadcastId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const before = await readRow(row.broadcastId!);
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'deleted' },
    });
    const base = await makeDispatchScheduledBroadcastDeps(tenant.ctx.slug);
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const r = await dispatchScheduledBroadcast(
        { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
        { broadcastId: asBroadcastId(row.broadcastId!) },
      );

      expect(r).toEqual(requesterNotFound);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ broadcastId: row.broadcastId, leg: 'live' }),
        'broadcasts.dispatch.requester_not_found',
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(gw.calls.map((c) => c.method)).toEqual(['retrieveBroadcast']);
    expect(await readRow(row.broadcastId!)).toEqual(before);
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });

  it('P4 import: a requester not found → undecided: the draft is not deleted, the row stays approved, nothing written', async () => {
    const missingMemberId = randomUUID();
    const resendBroadcastId = `rb-orphan-${randomUUID()}`;
    const row = approvedRow(missingMemberId, {
      resendAudienceId: `aud-orphan-${randomUUID()}`,
      resendBroadcastId,
      audienceImportId: `imp-orphan-${randomUUID()}`,
      audienceImportSubmittedAt: new Date(Date.now() - 300_000),
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const before = await readRow(row.broadcastId!);
    const gw = allowingGateway({
      retrieveBroadcast: { kind: 'present', resource: { id: resendBroadcastId, status: 'draft', sentAt: null } },
      deleteBroadcastOnce: { kind: 'deleted' },
    });
    const base = await makeBuildAudienceTickDeps(tenant.ctx.slug, membersBridge);
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const r = await buildAudienceTick(
        { ...base, broadcastsGateway: gw.port, brandChrome: NO_BRAND },
        { broadcastId: asBroadcastId(row.broadcastId!) },
      );

      expect(r).toEqual(requesterNotFound);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ broadcastId: row.broadcastId, leg: 'import' }),
        'broadcasts.dispatch.requester_not_found',
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(gw.calls.map((c) => c.method)).toEqual(['retrieveBroadcast']);
    expect(await readRow(row.broadcastId!)).toEqual(before);
    expect(await dispatchAudits(row.broadcastId!)).toEqual([]);
  });
});
