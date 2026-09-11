/**
 * F114 T048 — decide atomicity on live Neon (FR-015, Constitution VIII).
 *
 * `decideChangeRequest` opens ONE `runInTenant`: the contact patch, the member
 * patch, the per-field outcomes + decision columns, the
 * `member_change_request_decided` audit row and the
 * `member_change_request_decided_member` outbox row commit together — or
 * nothing does. Proven with the REAL Drizzle repos, audit adapter and outbox
 * adapter: a fault injected on the member write AFTER the contact write has
 * run leaves the contact row unchanged, no decision, no audit, no outbox row,
 * and the request still `pending`; the happy path then commits all of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
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
  type DecideChangeRequestDeps,
  type UserId,
} from '@/modules/members';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { memberChangeRequestFields, memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const mu = (id: string): UserId => id as unknown as UserId;

let tenant: TestTenant;
let member: TestUser;
let reviewer: TestUser;
let memberId: string;
let contactId: string;
let requestId: ChangeRequestId;

function decideDeps(memberRepo: DecideChangeRequestDeps['memberRepo'] = drizzleMemberRepo): DecideChangeRequestDeps {
  return {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    clock: { now: () => new Date() },
  };
}

const APPROVE_ALL = {
  decisions: [
    { key: 'phone', outcome: 'approved' as const },
    { key: 'description', outcome: 'approved' as const },
  ],
  reason: null,
  note: null,
  actorRole: 'admin',
};

async function snapshot() {
  const [[c], [m], [r], fields, audits, outbox] = await Promise.all([
    db.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.contactId, contactId)),
    db.select({ description: members.description }).from(members).where(eq(members.memberId, memberId)),
    db.select().from(memberChangeRequests).where(eq(memberChangeRequests.id, requestId)),
    db.select().from(memberChangeRequestFields).where(eq(memberChangeRequestFields.requestId, requestId)),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_decided'))),
    db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_decided_member'))),
  ]);
  return { contactPhone: c?.phone, memberDescription: m?.description, request: r, fields, audits, outbox };
}

describe('decideChangeRequest — throw-to-rollback on live Neon (T048)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    member = await createActiveTestUser('member');
    reviewer = await createActiveTestUser('admin');
    const planId = `cr-dec-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, member.userId, planId);
    memberId = randomUUID();
    contactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Rollback Co',
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
        email: `rollback-${contactId.slice(0, 8)}@example.com`,
        phone: '+66812345678',
        preferredLanguage: 'sv',
        isPrimary: true,
        linkedUserId: member.userId,
      });
    });
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
        rawBody: { contact: { phone: '+66899999999' }, company: { description: 'A new description' } },
        actorUserId: mu(member.userId),
        actorRole: 'member',
        requestId: `req-${randomUUID().slice(0, 8)}`,
      },
    );
    if (!submitted.ok || submitted.value.outcome !== 'submitted') throw new Error(`seed submit failed: ${JSON.stringify(submitted)}`);
    requestId = submitted.value.request.id;
  });

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(member).catch(() => {});
    await deleteTestUser(reviewer).catch(() => {});
  });

  it('a member write fault AFTER the contact write rolls everything back — request still pending, nothing applied', async () => {
    const before = await snapshot();
    expect(before.request?.state).toBe('pending');
    const faulty: DecideChangeRequestDeps['memberRepo'] = {
      findByIdInTx: drizzleMemberRepo.findByIdInTx,
      findErasedAtById: drizzleMemberRepo.findErasedAtById,
      async updateFieldsInTx() {
        throw new Error('injected member write failure');
      },
    };
    const r = await decideChangeRequest(decideDeps(faulty), {
      ...APPROVE_ALL,
      changeRequestId: requestId,
      actorUserId: mu(reviewer.userId),
      requestId: 'req-rollback-1',
    });
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });

    const after = await snapshot();
    expect(after.contactPhone).toBe('+66812345678'); // the contact write inside the tx was rolled back
    expect(after.memberDescription).toBeNull();
    expect(after.request?.state).toBe('pending');
    expect(after.request?.decidedAt).toBeNull();
    expect(after.fields.every((f) => f.outcome === null && f.appliedAt === null)).toBe(true);
    expect(after.audits).toHaveLength(0);
    expect(after.outbox).toHaveLength(0);
  });

  it('the same decision then commits: values applied, decision + audit + outbox row together', async () => {
    const r = await decideChangeRequest(decideDeps(), {
      ...APPROVE_ALL,
      changeRequestId: requestId,
      actorUserId: mu(reviewer.userId),
      requestId: 'req-rollback-2',
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await snapshot();
    expect(after.contactPhone).toBe('+66899999999');
    expect(after.memberDescription).toBe('A new description');
    expect(after.request).toMatchObject({ state: 'decided', outcome: 'approved', decidedByUserId: reviewer.userId });
    expect(after.fields.map((f) => f.outcome)).toEqual(['approved', 'approved']);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]?.actorUserId).toBe(reviewer.userId);
    expect(after.audits[0]?.payload).toMatchObject({ related_member_id: memberId, request_id: requestId, outcome: 'approved', actor_role: 'admin' });
    expect(after.audits[0]?.payload).not.toHaveProperty('member_id');
    expect(after.outbox).toHaveLength(1);
    expect(after.outbox[0]).toMatchObject({ toEmail: `rollback-${contactId.slice(0, 8)}@example.com`, locale: 'sv', status: 'pending' });
    expect(after.outbox[0]?.contextData).toEqual({ tenantId: tenant.ctx.slug, requestId, memberId, submitterUserId: member.userId });
  });
});
