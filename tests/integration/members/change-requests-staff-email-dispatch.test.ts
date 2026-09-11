/**
 * F114 T037 — the outbox dispatcher renders the staff email AT SEND TIME from
 * the request rows (research R8 / § V3) on live Neon.
 *
 *   1. a `member_change_request_submitted_staff` row whose context_data holds
 *      ids only → the tick reads the request + fields + member + submitter
 *      under the row's tenant, renders the diff (old → new, company name,
 *      member number, review link) and marks the row `sent`;
 *   2. the request row is gone (hard-deleted) → the row permanently fails on
 *      the FIRST tick with `last_error = 'request_gone'` and an
 *      `email_dispatch_failed { reason: 'request_gone' }` audit row — never a
 *      silent 5-attempt retry ladder.
 *
 * The Resend client is mocked (captures the message, answers ok); everything
 * else is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

// The dispatcher filters the two F114 arms at query time while the platform
// flag is OFF (whole-branch review F-1: kill-switch containment, the F4 R7-B4
// precedent). `.env.local` does not carry the flag, so the suite pins it ON
// and flips it OFF for the containment case.
let changeApprovalFlag = true;
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      features: {
        ...actual.env.features,
        get memberChangeApproval() {
          return changeApprovalFlag;
        },
      },
    },
  };
});

const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
vi.mock('@/modules/auth/infrastructure/email/resend-client', () => ({
  emailSender: {
    send: vi.fn(async (message: { to: string; subject: string; html: string; text: string }) => {
      sent.push(message);
      return { ok: true, value: { messageId: `msg-${sent.length}` } };
    }),
  },
}));

import { db, runInTenant } from '@/lib/db';
import { auditLog, notificationsOutbox, users } from '@/modules/auth/infrastructure/db/schema';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';
import {
  asContactId,
  asMemberId,
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  f3DrizzleAuditAdapter,
  submitChangeRequest,
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

let tenant: TestTenant;
let user: TestUser;
let reviewer: TestUser;
let memberId: string;
let contactId: string;
let memberNumber: number;

async function tick(): Promise<void> {
  const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const res = await outboxDispatch(req);
  expect(res.status).toBe(200);
}

/**
 * The SHARED dev branch's outbox carries stale pending rows from other
 * suites; one tick drains at most BATCH_SIZE (50) of them, oldest first, so
 * our row may sit behind them. Tick until the row leaves `pending` (bounded).
 */
async function tickUntilSettled(requestId: string, maxTicks = 8) {
  for (let i = 0; i < maxTicks; i += 1) {
    await tick();
    const rows = await db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_submitted_staff')));
    const mine = rows.find((x) => (x.contextData as { requestId?: string }).requestId === requestId);
    if (mine && mine.status !== 'pending') return mine;
  }
  return null;
}

async function submit(rawBody: unknown) {
  const deps: SubmitChangeRequestDeps = {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    // review round 1 (security I-4): the dispatcher re-checks the recipient
    // against the ACTIVE reviewer roster at send time, so the reviewer is a
    // real active admin, not a fake address
    reviewers: { listReviewers: async () => [{ userId: mu(reviewer.userId), email: reviewer.email, locale: 'en' }] },
    clock: { now: () => new Date() },
    newRequestId: () => randomUUID() as ChangeRequestId,
  };
  return submitChangeRequest(deps, {
    memberId: asMemberId(memberId),
    contactId: asContactId(contactId),
    rawBody,
    actorUserId: mu(user.userId),
    actorRole: 'member',
    requestId: `req-${randomUUID().slice(0, 8)}`,
  });
}

describe('outbox dispatcher — member_change_request_submitted_staff (T037)', () => {
  beforeAll(async () => {
    vi.stubEnv('CRON_SECRET', process.env.CRON_SECRET ?? 'test-f114-dispatch-secret');
    tenant = await createTestTenant('test-swecham');
    user = await createActiveTestUser('member');
    reviewer = await createActiveTestUser('admin');
    const planId = `cr-dispatch-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, user.userId, planId);
    memberId = randomUUID();
    contactId = randomUUID();
    memberNumber = nextSeedMemberNumber();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber,
        companyName: 'Dispatch & Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'Anna',
        lastName: 'Svensson',
        email: `dispatch-${contactId.slice(0, 8)}@example.com`,
        phone: '+66812345678',
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: user.userId,
      });
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
    await deleteTestUser(reviewer).catch(() => {});
  });

  it('renders the diff from the request rows and marks the outbox row sent', async () => {
    const r = await submit({ contact: { phone: '+66899999999' }, company: { description: 'A <new> description' } });
    expect(r.ok && r.value.outcome).toBe('submitted');
    const row = await tickUntilSettled(r.ok && r.value.outcome === 'submitted' ? r.value.request.id : '');
    expect(row?.status, JSON.stringify({ attempts: row?.attempts, lastError: row?.lastError, sentCount: sent.length })).toBe('sent');
    expect(row?.sentMessageId).toMatch(/^msg-/);
    const msg = sent.find((m) => m.to === reviewer.email);
    expect(msg).toBeDefined();
    expect(msg?.subject).toContain('Dispatch & Co');
    expect(msg?.subject).toContain(`-${String(memberNumber).padStart(4, '0')}`);
    expect(msg?.text).toContain('Phone: +66812345678 → +66899999999');
    expect(msg?.text).toContain('Description: (empty) → A <new> description');
    expect(msg?.html).toContain('A &lt;new&gt; description');
    expect(msg?.text).toContain(`/admin/change-requests?submitter=${user.userId}&state=pending`);
    expect(msg?.text).toContain('Anna Svensson');
    // ids-only outbox row: no value ever sat in context_data
    expect(JSON.stringify(row?.contextData)).not.toContain('+668');
  });

  it('a request REPLACED before its staff row was sent permanently fails that row as request_superseded; the replacement is sent (review reliability I-4)', async () => {
    const first = await submit({ contact: { phone: '+66855555555' } });
    expect(first.ok && first.value.outcome).toBe('submitted');
    const firstId = first.ok && first.value.outcome === 'submitted' ? first.value.request.id : '';
    const second = await submit({ contact: { phone: '+66866666666' } });
    expect(second.ok && second.value.outcome).toBe('submitted');
    const secondId = second.ok && second.value.outcome === 'submitted' ? second.value.request.id : '';
    const superseded = await tickUntilSettled(firstId);
    expect(superseded?.status).toBe('permanently_failed');
    expect(superseded?.lastError).toBe('request_superseded');
    // whole-branch review F-4: a resubmit is a NORMAL flow (US5 coalescing is
    // PR-2) — the superseded row is a silent skip: no `email_dispatch_failed`
    // audit (the replacement is already audited as `withdrawn{replaced}`) and
    // NOT counted on `outbox_permanent_failures_total`, which pages on-call.
    const failedAudits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'email_dispatch_failed')));
    expect(failedAudits.some((a) => (a.payload as { outbox_row_id?: string }).outbox_row_id === superseded?.id)).toBe(false);
    const sentRow = await tickUntilSettled(secondId);
    expect(sentRow?.status).toBe('sent');
    expect(sent.some((m) => m.text.includes('+66866666666'))).toBe(true);
    expect(sent.some((m) => m.text.includes('+66855555555'))).toBe(false);
  });

  it('platform flag OFF: the staff row is NOT picked up — it stays pending, attempts 0, nothing sent (kill-switch containment, whole-branch F-1)', async () => {
    const r = await submit({ contact: { phone: '+66811111111' } });
    expect(r.ok && r.value.outcome).toBe('submitted');
    const requestId = r.ok && r.value.outcome === 'submitted' ? r.value.request.id : '';
    changeApprovalFlag = false;
    try {
      await tick();
      await tick();
      const rows = await db
        .select()
        .from(notificationsOutbox)
        .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_submitted_staff')));
      const mine = rows.find((x) => (x.contextData as { requestId?: string }).requestId === requestId);
      expect(mine?.status).toBe('pending');
      expect(mine?.attempts).toBe(0);
      expect(sent.some((m) => m.text.includes('+66811111111'))).toBe(false);
    } finally {
      changeApprovalFlag = true;
    }
    // the row is untouched, so it drains once the flag returns
    const drained = await tickUntilSettled(requestId);
    expect(drained?.status).toBe('sent');
  });

  it('a reviewer DISABLED between enqueue and send gets nothing: the row permanently fails as recipient_gone (review security I-4 / round 2 R-1)', async () => {
    const r = await submit({ contact: { phone: '+66888888888' } });
    expect(r.ok && r.value.outcome).toBe('submitted');
    const requestId = r.ok && r.value.outcome === 'submitted' ? r.value.request.id : '';
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, reviewer.userId));
    try {
      const gone = await tickUntilSettled(requestId);
      expect(gone?.status).toBe('permanently_failed');
      expect(gone?.lastError).toBe('recipient_gone');
      expect(sent.some((m) => m.text.includes('+66888888888'))).toBe(false);
    } finally {
      await db.update(users).set({ status: 'active' }).where(eq(users.id, reviewer.userId));
    }
  });

  it('a hard-deleted request row permanently fails the outbox row on the first tick with reason request_gone', async () => {
    // Withdraw the pending one first so a fresh request can be created, then
    // delete that fresh request's row before the dispatcher sees its outbox row.
    const r = await submit({ contact: { phone: '+66877777777' } });
    expect(r.ok && r.value.outcome).toBe('submitted');
    const requestId = r.ok && r.value.outcome === 'submitted' ? r.value.request.id : '';
    const replacedId = r.ok && r.value.outcome === 'submitted' ? r.value.replaced : null;
    // owner-role delete (the app never hard-deletes; fields cascade). The
    // request from the first test was withdrawn/replaced and POINTS at this
    // one (`replaced_by_request_id`), so it goes first.
    // the replace chain (A→B→C→D) is one self-FK per hop: delete the whole
    // member's requests in ONE statement (RI is checked at statement end)
    void replacedId;
    await db.delete(memberChangeRequests).where(eq(memberChangeRequests.memberId, memberId));
    const gone = await tickUntilSettled(requestId);
    expect(gone?.status).toBe('permanently_failed');
    expect(gone?.attempts).toBe(1);
    expect(gone?.lastError).toBe('request_gone');
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'email_dispatch_failed')));
    expect(audits.some((a) => (a.payload as { reason?: string; outbox_row_id?: string }).reason === 'request_gone' && (a.payload as { outbox_row_id?: string }).outbox_row_id === gone?.id)).toBe(true);
  });
});
