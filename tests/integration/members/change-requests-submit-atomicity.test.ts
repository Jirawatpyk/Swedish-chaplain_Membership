/**
 * F114 T034 — submit atomicity on live Neon (FR-012, Constitution VIII).
 *
 * `submitChangeRequest` opens ONE `runInTenant`: the request row, its field
 * rows, the `member_change_request_submitted` audit row and one
 * `member_change_request_submitted_staff` outbox row PER REVIEWER commit
 * together — or nothing does. Proven here with the REAL Drizzle repos, the
 * real audit adapter and the real outbox adapter:
 *   1. the happy path leaves exactly 1 request + N field rows + 1 audit row +
 *      R outbox rows (ids-only context_data, the reviewer's locale);
 *   2. an audit write failure (fault-injected on the submitted event) rolls
 *      the request AND the outbox rows back — the tx is aborted, not committed
 *      half-way.
 * Reviewers come from a fake directory (two test addresses) so the test never
 * depends on the shared branch's real staff roster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { ok, err } from '@/lib/result';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
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
import type { AuditPort } from '@/modules/members/application/ports/audit-port';
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
let user: TestUser;
let memberId: string;
let contactId: string;

const REVIEWERS = [
  { userId: mu('00000000-0000-4000-8000-0000000000a1'), email: 'reviewer-a@staff.example', locale: 'sv' as const },
  { userId: mu('00000000-0000-4000-8000-0000000000a2'), email: 'reviewer-b@staff.example', locale: 'en' as const },
];

function makeDeps(audit: AuditPort = f3DrizzleAuditAdapter): SubmitChangeRequestDeps {
  return {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit,
    emails: resendEmailPort,
    reviewers: { listReviewers: async () => REVIEWERS },
    clock: { now: () => new Date() },
    newRequestId: () => randomUUID() as ChangeRequestId,
  };
}

const input = (rawBody: unknown) => ({
  memberId: asMemberId(memberId),
  contactId: asContactId(contactId),
  rawBody,
  actorUserId: mu(user.userId),
  actorRole: 'member',
  requestId: `req-${randomUUID().slice(0, 8)}`,
});

async function countRows() {
  const [reqs, fields, outbox, audits] = await Promise.all([
    db.select().from(memberChangeRequests).where(eq(memberChangeRequests.tenantId, tenant.ctx.slug)),
    db.select().from(memberChangeRequestFields).where(eq(memberChangeRequestFields.tenantId, tenant.ctx.slug)),
    db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), eq(notificationsOutbox.notificationType, 'member_change_request_submitted_staff'))),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_submitted'))),
  ]);
  return { reqs, fields, outbox, audits };
}

describe('submitChangeRequest — atomicity on live Neon (T034)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    user = await createActiveTestUser('member');
    const planId = `cr-atom-${randomUUID().slice(0, 8)}`;
    await seedPortalPlan(tenant.ctx.slug, user.userId, planId);
    memberId = randomUUID();
    contactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Atomic Co',
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
        email: `atomic-${contactId.slice(0, 8)}@example.com`,
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

  it('commits the request + field rows + the audit row + one outbox row per reviewer together', async () => {
    const r = await submitChangeRequest(
      makeDeps(),
      input({
        contact: { phone: '+66899999999' },
        company: {
          billing_address: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.outcome !== 'submitted') return;
    const { reqs, fields, outbox, audits } = await countRows();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.state).toBe('pending');
    expect(fields.map((f) => f.fieldKey).sort()).toEqual(['billing_address', 'phone']);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({
      member_id: memberId,
      request_id: r.value.request.id,
      scope: 'mixed',
      field_keys: ['phone', 'billing_address'],
      actor_role: 'member',
    });
    expect(JSON.stringify(audits[0]?.payload)).not.toContain('Stockholm');
    expect(outbox).toHaveLength(2);
    expect(outbox.map((o) => [o.toEmail, o.locale]).sort()).toEqual([
      ['reviewer-a@staff.example', 'sv'],
      ['reviewer-b@staff.example', 'en'],
    ]);
    for (const o of outbox) {
      expect(o.status).toBe('pending');
      const reviewer = REVIEWERS.find((x) => x.email === o.toEmail);
      expect(reviewer).toBeDefined();
      expect(o.contextData).toEqual({
        tenantId: tenant.ctx.slug,
        requestId: r.value.request.id,
        memberId,
        submitterUserId: user.userId,
        reviewerUserId: reviewer!.userId,
        fieldKeys: ['phone', 'billing_address'],
      });
    }
    // the member record itself is untouched (FR-001)
    const [m] = await db.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.contactId, contactId));
    expect(m?.phone).toBe('+66812345678');
    // …except its RECENCY: migration 0009's trigger fires on the snake_case
    // `member_id` key the submitted event carries (round 7, tests N7 — the
    // #336/#337 class), so the member's own action bumps last_activity_at
    const [recency] = await db.select({ lastActivityAt: members.lastActivityAt }).from(members).where(eq(members.memberId, memberId));
    expect(recency?.lastActivityAt).not.toBeNull();
    expect((recency!.lastActivityAt as Date).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
  });

  it('an audit write failure rolls back the request AND the outbox rows (nothing half-committed)', async () => {
    const before = await countRows();
    const faultyAudit: AuditPort = {
      record: f3DrizzleAuditAdapter.record,
      async recordInTx(tx, ctx, event) {
        if (event.type === 'member_change_request_submitted') {
          return err({ code: 'repo.unexpected', cause: new Error('injected audit failure') });
        }
        return f3DrizzleAuditAdapter.recordInTx(tx, ctx, event);
      },
    };
    // a DIFFERENT proposal than the pending one, so the replace path runs
    // (withdraw + insert + audit + outbox) and the failure lands mid-way.
    const r = await submitChangeRequest(makeDeps(faultyAudit), input({ contact: { phone: '+66877777777' } }));
    expect(r).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const after = await countRows();
    expect(after.reqs.map((x) => [x.id, x.state])).toEqual(before.reqs.map((x) => [x.id, x.state]));
    expect(after.fields).toHaveLength(before.fields.length);
    expect(after.outbox).toHaveLength(before.outbox.length);
    expect(after.audits).toHaveLength(before.audits.length);
    // the previous pending request was NOT withdrawn by the aborted replace
    expect(after.reqs[0]?.state).toBe('pending');
    expect(after.reqs[0]?.withdrawnReason).toBeNull();
    void ok;
  });
});
