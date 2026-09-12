/**
 * F114 T084 — the durable 10 / 24 h cap and the 1 h staff-email coalescing
 * on live Neon (dev branch) — FR-008, FR-011, SC-013, research R9 / R8.
 *
 * The cap is counted from `member_change_requests` itself (the
 * `(tenant_id, submitted_by_user_id, submitted_at)` index), never from a
 * rate-limiting service: `UPSTASH_REDIS_REST_URL` / `_TOKEN` are UNSET for
 * this file and the path never consults `rateLimiter`. Proven with the REAL
 * Drizzle repos, the real audit adapter and the real outbox adapter, the
 * clock injected:
 *   1. ten submits one minute apart (each replacing the previous) → all
 *      `submitted`; the 11th → `rate_limited` with `retryAfterSeconds` =
 *      the OLDEST row's age to 24 h, exactly 10 rows for the person (9
 *      `withdrawn/replaced` + 1 pending — replaced rows COUNT), one
 *      `member_change_request_rate_limited` audit row with ids only;
 *   2. within those ten minutes ONE staff outbox row exists (the nine
 *      resubmits coalesced — `staff_notified_at` inherited) — SC-013;
 *   3. the window rolls: at first + 24 h + 1 s the submit is accepted and,
 *      being > 1 h after the last notification, queues a SECOND outbox row;
 *   4. withdraw (US5 AS1): `withdrawChangeRequest` closes the pending row
 *      `withdrawn/member` with its audit row; a second withdraw →
 *      `no_pending_request`; the withdrawn row still counts in the window.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import {
  asContactId,
  asMemberId,
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  f3DrizzleAuditAdapter,
  submitChangeRequest,
  withdrawChangeRequest,
  SUBMISSIONS_PER_WINDOW_CAP,
  type ChangeRequestId,
  type SubmitChangeRequestDeps,
  type UserId,
} from '@/modules/members';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const mu = (id: string): UserId => id as unknown as UserId;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// a fixed base in the past so the seeded timestamps never land in the future
const T0 = new Date(Date.now() - 48 * HOUR);

let tenant: TestTenant;
let user: TestUser;
let memberId: string;
let contactId: string;
let now = T0;

const REVIEWERS = [{ userId: mu('00000000-0000-4000-8000-0000000000a1'), email: 'reviewer-cap@staff.example', locale: 'en' as const }];

function deps(): SubmitChangeRequestDeps {
  return {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    reviewers: { listReviewers: async () => REVIEWERS },
    clock: { now: () => now },
    newRequestId: () => randomUUID() as ChangeRequestId,
  };
}

function submit(phone: string) {
  return submitChangeRequest(deps(), {
    memberId: asMemberId(memberId),
    contactId: asContactId(contactId),
    rawBody: { contact: { phone } },
    actorUserId: mu(user.userId),
    actorRole: 'member',
    requestId: `req-${randomUUID().slice(0, 8)}`,
  });
}

async function myRows() {
  return db
    .select()
    .from(memberChangeRequests)
    .where(and(eq(memberChangeRequests.tenantId, tenant.ctx.slug), eq(memberChangeRequests.submittedByUserId, user.userId)));
}

async function staffOutboxRows() {
  return db
    .select()
    .from(notificationsOutbox)
    .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_submitted_staff')));
}

describe('durable submission cap + coalescing on live Neon (T084)', () => {
  beforeAll(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    tenant = await createTestTenant('test-swecham');
    user = await createActiveTestUser('member');
    const planId = `cr-cap-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, user.userId, planId);
    memberId = randomUUID();
    contactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Capped Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        addressLine1: '1 Main Rd',
        city: 'Bangkok',
        postalCode: '10110',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'Anna',
        lastName: 'Svensson',
        email: `cap-${contactId.slice(0, 8)}@example.com`,
        phone: '+66812345678',
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: user.userId,
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('holds the cap from the table count alone, coalesces the staff email inside 1 h, and rolls the window', async () => {
    expect(process.env.UPSTASH_REDIS_REST_URL).toBeUndefined();

    // 1. ten created requests, one minute apart
    for (let i = 0; i < SUBMISSIONS_PER_WINDOW_CAP; i += 1) {
      now = new Date(T0.getTime() + i * MINUTE);
      const r = await submit(`+6689999${String(1000 + i).slice(1)}`);
      expect(r.ok && r.value.outcome, `submit #${i + 1}`).toBe('submitted');
    }
    let rows = await myRows();
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.state === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.withdrawnReason === 'replaced')).toHaveLength(9);

    // 2. SC-013: one staff email queued for the ten submits; the pending row inherited the first timestamp
    expect(await staffOutboxRows()).toHaveLength(1);
    expect(rows.find((r) => r.state === 'pending')?.staffNotifiedAt?.getTime()).toBe(T0.getTime());

    // the 11th → refused from the durable count
    now = new Date(T0.getTime() + 10 * MINUTE);
    const eleventh = await submit('+66811111111');
    expect(eleventh.ok).toBe(false);
    if (eleventh.ok) return;
    expect(eleventh.error.type).toBe('rate_limited');
    if (eleventh.error.type !== 'rate_limited') return;
    expect(eleventh.error.windowCount).toBe(10);
    expect(eleventh.error.retryAfterSeconds).toBe(Math.ceil((T0.getTime() + 24 * HOUR - now.getTime()) / 1000));
    rows = await myRows();
    expect(rows).toHaveLength(10);
    const refusals = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_rate_limited')));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.payload).toMatchObject({ member_id: memberId, window_count: 10, actor_role: 'member' });
    expect(JSON.stringify(refusals[0]!.payload)).not.toContain('+668');

    // 3. the window rolls; > 1 h since the last notification → a second staff row
    now = new Date(T0.getTime() + 24 * HOUR + 1000);
    const twelfth = await submit('+66811111111');
    expect(twelfth.ok && twelfth.value.outcome).toBe('submitted');
    expect(twelfth.ok && twelfth.value.outcome === 'submitted' && twelfth.value.staffNotified).toBe(true);
    expect(await myRows()).toHaveLength(11);
    expect(await staffOutboxRows()).toHaveLength(2);

    // 4. withdraw closes the pending row; a second withdraw finds nothing; the row still counts
    const withdrawDeps = { tenant: tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, audit: f3DrizzleAuditAdapter, clock: { now: () => now } };
    const w = await withdrawChangeRequest(withdrawDeps, { actorUserId: mu(user.userId), actorRole: 'member', requestId: 'req-withdraw' });
    expect(w.ok && w.value.request.state).toBe('withdrawn');
    expect(w.ok && w.value.request.withdrawnReason).toBe('member');
    const again = await withdrawChangeRequest(withdrawDeps, { actorUserId: mu(user.userId), actorRole: 'member', requestId: 'req-withdraw-2' });
    expect(again).toEqual({ ok: false, error: { type: 'no_pending_request' } });
    const withdrawn = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_withdrawn')));
    expect(withdrawn.filter((a) => (a.payload as { withdrawn_reason?: string }).withdrawn_reason === 'member')).toHaveLength(1);
    expect(withdrawn.filter((a) => (a.payload as { withdrawn_reason?: string }).withdrawn_reason === 'replaced')).toHaveLength(9);
    rows = await myRows();
    expect(rows.filter((r) => r.state === 'pending')).toHaveLength(0);
    expect(rows).toHaveLength(11);
  });
});
