/**
 * F114 T049 — the two races, on live Neon (FR-008, FR-017, FR-018; research
 * R3 / R4).
 *
 *   1. two reviewers decide the SAME pending request concurrently → the
 *      `SELECT … FOR UPDATE` serialises them: exactly one decision row, one
 *      `member_change_request_decided` audit row and one member outbox row;
 *      the loser re-reads the row as decided and gets `already_decided`
 *      (a different decision) — never a second application;
 *   2. many concurrent IDENTICAL submits by one person → exactly one pending
 *      row: the partial unique index `member_change_requests_one_pending_per_
 *      submitter` refuses every insert that races the first commit, and the
 *      `FOR UPDATE` read turns the rest into `already_pending`.
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
const CONCURRENT_SUBMITS = 50;

let tenant: TestTenant;
let member: TestUser;
let reviewerA: TestUser;
let reviewerB: TestUser;
let memberId: string;
let contactId: string;

function submitDeps(): SubmitChangeRequestDeps {
  return {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    reviewers: { listReviewers: async () => [] },
    clock: { now: () => new Date() },
    newRequestId: () => randomUUID() as ChangeRequestId,
  };
}

function decideDeps(): DecideChangeRequestDeps {
  return {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    clock: { now: () => new Date() },
  };
}

function submit(rawBody: unknown) {
  return submitChangeRequest(submitDeps(), {
    memberId: asMemberId(memberId),
    contactId: asContactId(contactId),
    rawBody,
    actorUserId: mu(member.userId),
    actorRole: 'member',
    requestId: `req-${randomUUID().slice(0, 8)}`,
  });
}

async function pendingRows() {
  return db
    .select()
    .from(memberChangeRequests)
    .where(and(eq(memberChangeRequests.tenantId, tenant.ctx.slug), eq(memberChangeRequests.state, 'pending')));
}

describe('change requests — concurrency on live Neon (T049)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    member = await createActiveTestUser('member');
    reviewerA = await createActiveTestUser('admin');
    reviewerB = await createActiveTestUser('admin');
    const planId = `cr-conc-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, member.userId, planId);
    memberId = randomUUID();
    contactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Race Co',
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
        email: `race-${contactId.slice(0, 8)}@example.com`,
        phone: '+66812345678',
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: member.userId,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await Promise.all([member, reviewerA, reviewerB].map((u) => deleteTestUser(u).catch(() => {})));
  });

  it('two concurrent decides → exactly one decision + one audit + one email; the loser gets already_decided', async () => {
    const submitted = await submit({ contact: { phone: '+66899999999' }, company: { description: 'Race description' } });
    if (!submitted.ok || submitted.value.outcome !== 'submitted') throw new Error(`seed submit failed: ${JSON.stringify(submitted)}`);
    const requestId = submitted.value.request.id;

    const [a, b] = await Promise.all([
      decideChangeRequest(decideDeps(), {
        changeRequestId: requestId,
        decisions: [
          { key: 'phone', outcome: 'approved' },
          { key: 'description', outcome: 'approved' },
        ],
        reason: null,
        note: null,
        actorUserId: mu(reviewerA.userId),
        actorRole: 'admin',
        requestId: 'req-race-a',
      }),
      decideChangeRequest(decideDeps(), {
        changeRequestId: requestId,
        decisions: [
          { key: 'phone', outcome: 'approved' },
          { key: 'description', outcome: 'rejected' },
        ],
        reason: 'Please keep the registered description',
        note: null,
        actorUserId: mu(reviewerB.userId),
        actorRole: 'admin',
        requestId: 'req-race-b',
      }),
    ]);

    const outcomes = [a, b];
    const winners = outcomes.filter((r) => r.ok);
    const losers = outcomes.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, error: { type: 'already_decided' } });
    if (losers[0] && !losers[0].ok && losers[0].error.type === 'already_decided') {
      // FR-018 — the loser is told who decided and how
      expect([reviewerA.userId, reviewerB.userId]).toContain(losers[0].error.decidedByUserId);
      expect(losers[0].error.outcome).not.toBeNull();
    }

    const [row] = await db.select().from(memberChangeRequests).where(eq(memberChangeRequests.id, requestId));
    expect(row?.state).toBe('decided');
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_decided')));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(row?.decidedByUserId);
    const outbox = await db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_decided_member')));
    expect(outbox).toHaveLength(1);
    // the record reflects exactly the winner's decision
    const [c] = await db.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.contactId, contactId));
    expect(c?.phone).toBe('+66899999999');
    const [m] = await db.select({ description: members.description }).from(members).where(eq(members.memberId, memberId));
    expect(m?.description).toBe(row?.outcome === 'approved' ? 'Race description' : null);
  }, 60_000);

  it(`${CONCURRENT_SUBMITS} concurrent identical submits by one person → exactly one pending row`, async () => {
    expect(await pendingRows()).toHaveLength(0);
    const body = { contact: { phone: '+66811111111' } };
    const results = await Promise.allSettled(Array.from({ length: CONCURRENT_SUBMITS }, () => submit(body)));
    // every call settled (a refused insert is a typed result, never an unhandled throw)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
    const submitted = values.filter((v) => v?.ok && v.value.outcome === 'submitted');
    const alreadyPending = values.filter((v) => v?.ok && v.value.outcome === 'already_pending');
    // exactly one created it; the rest either saw it pending (FOR UPDATE) or
    // lost the unique-index race (server_error) — never a second pending row
    expect(submitted).toHaveLength(1);
    expect(submitted.length + alreadyPending.length + values.filter((v) => v && !v.ok).length).toBe(CONCURRENT_SUBMITS);
    const pending = await pendingRows();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.submittedByUserId).toBe(member.userId);
  }, 120_000);
});
