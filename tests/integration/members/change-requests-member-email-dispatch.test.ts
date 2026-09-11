/**
 * F114 T053 — the outbox dispatcher renders the member decision email AT
 * SEND TIME from the request rows (research R8 / § V3) on live Neon.
 *
 *   1. a `member_change_request_decided_member` row whose context_data holds
 *      ids only → the tick reads the decided request + fields + the
 *      submitting contact under the row's tenant, renders the outcome, the
 *      applied / not-applied sections, the reason (escaped) and the resubmit
 *      link, sends to the contact's CURRENT address, marks the row `sent`;
 *   2. the submitting contact was removed since the decision → the row
 *      permanently fails on the FIRST tick with `last_error = 'recipient_gone'`
 *      and an `email_dispatch_failed { reason: 'recipient_gone' }` audit row.
 *
 * The Resend client is mocked (captures the message); everything else is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

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
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';
import {
  asContactId,
  asMemberId,
  decideChangeRequest,
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  f3DrizzleAuditAdapter,
  submitChangeRequest,
  type ChangeRequestId,
  type FieldDecision,
  type UserId,
} from '@/modules/members';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const mu = (id: string): UserId => id as unknown as UserId;

let tenant: TestTenant;
let memberUser: TestUser;
let reviewer: TestUser;
let memberId: string;
let contactId: string;
let contactEmail: string;

async function tick(): Promise<void> {
  const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const res = await outboxDispatch(req);
  expect(res.status).toBe(200);
}

/** The shared dev outbox carries other suites' rows; tick until OUR row leaves `pending` (bounded). */
async function tickUntilSettled(requestId: string, maxTicks = 8) {
  for (let i = 0; i < maxTicks; i += 1) {
    await tick();
    const rows = await db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_decided_member')));
    const mine = rows.find((x) => (x.contextData as { requestId?: string }).requestId === requestId);
    if (mine && mine.status !== 'pending') return mine;
  }
  return null;
}

async function submitAndDecide(rawBody: unknown, decisions: readonly FieldDecision[], reason: string | null): Promise<ChangeRequestId> {
  const submitted = await submitChangeRequest(
    {
      tenant: tenant.ctx,
      changeRequestRepo: drizzleChangeRequestRepo,
      memberRepo: drizzleMemberRepo,
      contactRepo: drizzleContactRepo,
      audit: f3DrizzleAuditAdapter,
      emails: resendEmailPort,
      reviewers: { listReviewers: async () => [] },
      clock: { now: () => new Date() },
      newRequestId: () => randomUUID() as ChangeRequestId,
    },
    {
      memberId: asMemberId(memberId),
      contactId: asContactId(contactId),
      rawBody,
      actorUserId: mu(memberUser.userId),
      actorRole: 'member',
      requestId: `req-${randomUUID().slice(0, 8)}`,
    },
  );
  if (!submitted.ok || submitted.value.outcome !== 'submitted') throw new Error(`submit failed: ${JSON.stringify(submitted)}`);
  const decided = await decideChangeRequest(
    {
      tenant: tenant.ctx,
      changeRequestRepo: drizzleChangeRequestRepo,
      memberRepo: drizzleMemberRepo,
      contactRepo: drizzleContactRepo,
      audit: f3DrizzleAuditAdapter,
      emails: resendEmailPort,
      clock: { now: () => new Date() },
    },
    {
      changeRequestId: submitted.value.request.id,
      decisions,
      reason,
      note: null,
      actorUserId: mu(reviewer.userId),
      actorRole: 'admin',
      requestId: `req-${randomUUID().slice(0, 8)}`,
    },
  );
  if (!decided.ok) throw new Error(`decide failed: ${JSON.stringify(decided)}`);
  return submitted.value.request.id;
}

describe('outbox dispatcher — member_change_request_decided_member arm (T053)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    memberUser = await createActiveTestUser('member');
    reviewer = await createActiveTestUser('admin');
    const planId = `cr-mdisp-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, memberUser.userId, planId);
    memberId = randomUUID();
    contactId = randomUUID();
    contactEmail = `member-dispatch-${contactId.slice(0, 8)}@example.com`;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Decided & Co',
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
        email: contactEmail,
        phone: '+66812345678',
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: memberUser.userId,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(memberUser).catch(() => {});
    await deleteTestUser(reviewer).catch(() => {});
  });

  it('renders the decision from the request rows, sends to the contact, marks the row sent', async () => {
    const requestId = await submitAndDecide(
      { contact: { phone: '+66899999999' }, company: { description: 'A <new> description' } },
      [
        { key: 'phone', outcome: 'approved' },
        { key: 'description', outcome: 'rejected' },
      ],
      'Please keep the <registered> description',
    );
    const row = await tickUntilSettled(requestId);
    expect(row?.status, JSON.stringify({ attempts: row?.attempts, lastError: row?.lastError, sentCount: sent.length })).toBe('sent');
    const msg = sent.find((m) => m.to === contactEmail);
    expect(msg).toBeDefined();
    expect(msg?.subject).toMatch(/partially approved/i);
    expect(msg?.text).toContain('Phone: +66899999999');
    expect(msg?.text).toContain('Description: A <new> description');
    expect(msg?.text).toContain('Please keep the <registered> description');
    expect(msg?.html).toContain('Please keep the &lt;registered&gt; description');
    expect(msg?.text).toContain(`/portal/edit?resubmit=${requestId}`);
    expect(msg?.text).not.toContain(reviewer.email);
    // ids-only outbox row: no value / reason ever sat in context_data
    expect(JSON.stringify(row?.contextData)).not.toContain('registered');
    expect(row?.contextData).toEqual({ tenantId: tenant.ctx.slug, requestId, memberId, submitterUserId: memberUser.userId });
  }, 120_000);

  it('a contact removed after the decision permanently fails the row on the first tick with reason recipient_gone', async () => {
    const requestId = await submitAndDecide({ contact: { role_title: 'CFO' } }, [{ key: 'role_title', outcome: 'approved' }], null);
    // owner-role writes, ONE tx: a replacement primary is inserted and the
    // submitting contact is soft-removed together — the 108 exactly-one-live-
    // primary constraint trigger is DEFERRABLE INITIALLY DEFERRED, so the pair
    // passes at commit where a lone removal would be refused.
    // Order matters: the `contacts_one_primary_per_member` partial unique
    // index is checked per statement, so the old primary is demoted before
    // the replacement is inserted; the deferred trigger then sees one live
    // primary at commit.
    await db.transaction(async (tx) => {
      await tx.update(contacts).set({ removedAt: new Date(), isPrimary: false }).where(eq(contacts.contactId, contactId));
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Replacement',
        lastName: 'Primary',
        email: `replacement-${memberId.slice(0, 8)}@example.com`,
        preferredLanguage: 'en',
        isPrimary: true,
      });
    });
    const gone = await tickUntilSettled(requestId);
    expect(gone?.status).toBe('permanently_failed');
    expect(gone?.attempts).toBe(1);
    expect(gone?.lastError).toBe('recipient_gone');
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'email_dispatch_failed')));
    expect(
      audits.some((a) => (a.payload as { reason?: string; outbox_row_id?: string }).reason === 'recipient_gone' && (a.payload as { outbox_row_id?: string }).outbox_row_id === gone?.id),
    ).toBe(true);
    expect(sent.some((m) => m.text.includes('CFO'))).toBe(false);
  }, 120_000);
});
