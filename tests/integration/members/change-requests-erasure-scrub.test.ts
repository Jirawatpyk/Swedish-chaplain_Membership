/**
 * F114 T070 — the FR-030 erasure scrub of a member's change requests on live
 * Neon (US4 AS6; research R10; GDPR Art. 17 / PDPA § 33).
 *
 * Drives the WHOLE `eraseMember` use case through the production composition
 * root `buildEraseMemberDeps(tenant)` on a freshly-seeded member that holds
 * one DECIDED request (rejected, with a reason + a staff note) and one PENDING
 * request, both created through the real submit / decide use cases so their
 * outbox rows exist. Asserts via owner-role raw selects that:
 *   - every `seen_value` / `proposed_value` of the member's field rows is the
 *     `[erased]` sentinel; `decision_reason` / `decision_note` are the sentinel
 *     (never NULL — `reason_iff_rejected_ck` stays satisfied);
 *   - the pending request is `withdrawn / erasure` with `withdrawn_at`; the
 *     decided one keeps its state + outcome (a decision is final);
 *   - row counts are unchanged (existence + outcome remain countable);
 *   - ONE `member_change_request_withdrawn` audit row per closed request with
 *     `{ related_member_id, withdrawn_reason: 'erasure', actor_role: 'system' }`
 *     attributed to the erasure's actor, carrying no value;
 *   - the pending outbox rows of the two F114 types keyed on
 *     `context_data->>'memberId'` are cancelled (quickstart § 3 pre-flip gate);
 *   - the scrubbed rows still READ BACK through the Drizzle repo (the DB →
 *     Domain seam accepts the sentinel — an erased request must not become a
 *     corrupt row that 500s the queue).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
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
  type UserId,
} from '@/modules/members';
import { ERASED_SENTINEL } from '@/modules/members/domain/erasure-sentinels';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { memberChangeRequestFields, memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const mu = (id: string): UserId => id as unknown as UserId;
const PLAN_ID = 'test-cr-erase-plan';
const PROPOSED_PHONE = '+66899999999';
const PROPOSED_NAME = 'Nordic Erasure Company';
const REASON = 'Use the registered phone number';
const NOTE = 'checked DBD — no such rename';

let tenant: TestTenant;
let user: TestUser;
let admin: TestUser;
let memberId: string;
let contactId: string;
let decidedId: ChangeRequestId;
let pendingId: ChangeRequestId;

const REVIEWERS = [{ userId: mu('00000000-0000-4000-8000-0000000000e1'), email: 'reviewer-erase@staff.example', locale: 'en' as const }];
const clock = { now: () => new Date() };

function submitDeps() {
  return {
    tenant: tenant.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    reviewers: { listReviewers: async () => REVIEWERS },
    clock,
    newRequestId: () => randomUUID() as ChangeRequestId,
  };
}

async function submit(rawBody: unknown): Promise<ChangeRequestId> {
  const r = await submitChangeRequest(submitDeps(), {
    memberId: asMemberId(memberId),
    contactId: asContactId(contactId),
    rawBody,
    actorUserId: mu(user.userId),
    actorRole: 'member',
    requestId: `req-${randomUUID().slice(0, 8)}`,
  });
  if (!r.ok || r.value.outcome !== 'submitted') throw new Error(`submit failed: ${JSON.stringify(r)}`);
  return r.value.request.id;
}

describe('eraseMember scrubs the change requests (T070, live Neon)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    user = await createActiveTestUser('member');
    admin = await createActiveTestUser('admin');
    memberId = randomUUID();
    contactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: 2026,
        planName: { en: 'CR Erase Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
          eblast_per_year: 1,
          website_page_type: 'member_news_update',
          homepage_logo_category: 'regular',
          directory_listing_size: 'half_page',
          event_discount_scope: 'all_employees',
          events_cobranded_access: false,
          cultural_tickets_per_year: 0,
          m2m_benefits_access: true,
          business_referrals: true,
          tailor_made_services: false,
          partnership: null,
        },
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Nordic Erasure Co',
        country: 'TH',
        planId: PLAN_ID,
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
        email: `cr-erase-${contactId.slice(0, 8)}@example.com`,
        phone: '+66812345678',
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: user.userId,
      });
    });

    // one decided request (rejected with a reason + a note) …
    decidedId = await submit({ contact: { phone: PROPOSED_PHONE }, company: { company_name: PROPOSED_NAME } });
    const decided = await decideChangeRequest(
      { tenant: tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, memberRepo: drizzleMemberRepo, contactRepo: drizzleContactRepo, audit: f3DrizzleAuditAdapter, emails: resendEmailPort, clock },
      {
        changeRequestId: decidedId,
        decisions: [
          { key: 'phone', outcome: 'rejected' },
          { key: 'company_name', outcome: 'rejected' },
        ],
        reason: REASON,
        note: NOTE,
        actorUserId: mu(admin.userId),
        actorRole: 'admin',
        requestId: 'req-erase-decide',
      },
    );
    if (!decided.ok) throw new Error(`decide failed: ${JSON.stringify(decided)}`);
    // … and one pending request
    pendingId = await submit({ contact: { phone: '+66877777777' } });
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('scrubs every value, closes the pending request as withdrawn/erasure with a system-attributed audit row, cancels the queued mails, keeps the rows readable', async () => {
    const outboxBefore = await db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), inArray(notificationsOutbox.notificationType, ['member_change_request_submitted_staff', 'member_change_request_decided_member'])));
    expect(outboxBefore.filter((r) => r.status === 'pending').length).toBeGreaterThan(0);

    const res = await eraseMember(asMemberId(memberId), { reason: 'gdpr_erasure_request' }, { actorUserId: admin.userId, requestId: 'req-erase-cr' }, buildEraseMemberDeps(tenant.ctx));
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const requests = await db.select().from(memberChangeRequests).where(eq(memberChangeRequests.memberId, memberId));
    expect(requests).toHaveLength(2);
    const decided = requests.find((r) => r.id === decidedId)!;
    const pending = requests.find((r) => r.id === pendingId)!;
    expect(decided).toMatchObject({ state: 'decided', outcome: 'rejected', decisionReason: ERASED_SENTINEL, decisionNote: ERASED_SENTINEL });
    expect(pending).toMatchObject({ state: 'withdrawn', withdrawnReason: 'erasure', decisionReason: null, decisionNote: null });
    expect(pending.withdrawnAt).not.toBeNull();

    const fields = await db.select().from(memberChangeRequestFields).where(inArray(memberChangeRequestFields.requestId, [decidedId, pendingId]));
    expect(fields).toHaveLength(3);
    for (const f of fields) {
      expect(f.seenValue, f.fieldKey).toBe(ERASED_SENTINEL);
      expect(f.proposedValue, f.fieldKey).toBe(ERASED_SENTINEL);
    }
    // outcomes survive (existence + outcome remain countable)
    expect(fields.filter((f) => f.requestId === decidedId).every((f) => f.outcome === 'rejected')).toBe(true);

    const closures = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_withdrawn')));
    const erasureClosures = closures.filter((a) => (a.payload as { withdrawn_reason?: string }).withdrawn_reason === 'erasure');
    expect(erasureClosures).toHaveLength(1);
    expect(erasureClosures[0]!.actorUserId).toBe(admin.userId);
    expect(erasureClosures[0]!.payload).toMatchObject({ related_member_id: memberId, request_id: pendingId, contact_id: contactId, scope: 'own_contact', withdrawn_reason: 'erasure', actor_role: 'system' });
    expect(erasureClosures[0]!.payload).not.toHaveProperty('member_id');
    const erasureAudits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.actorUserId, admin.userId)));
    const text = JSON.stringify(erasureAudits.map((a) => a.payload));
    expect(text).not.toContain(PROPOSED_PHONE);
    expect(text).not.toContain(PROPOSED_NAME);
    expect(text).not.toContain(REASON);

    const outboxAfter = await db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.tenantId, tenant.ctx.slug), inArray(notificationsOutbox.notificationType, ['member_change_request_submitted_staff', 'member_change_request_decided_member'])));
    expect(outboxAfter.filter((r) => r.status === 'pending' && (r.contextData as { memberId?: string }).memberId === memberId)).toHaveLength(0);

    // the scrubbed rows still read back through the repo — the seam accepts the sentinel
    const readBack = await drizzleChangeRequestRepo.findById(tenant.ctx, decidedId);
    expect(readBack.ok, JSON.stringify(readBack)).toBe(true);
    if (!readBack.ok) return;
    expect(readBack.value.fields.map((f) => [f.key, f.seen, f.proposed, f.outcome])).toEqual([
      ['phone', ERASED_SENTINEL, ERASED_SENTINEL, 'rejected'],
      ['company_name', ERASED_SENTINEL, ERASED_SENTINEL, 'rejected'],
    ]);
    const list = await drizzleChangeRequestRepo.listByMember(tenant.ctx, asMemberId(memberId), { cursor: null, limit: 10 });
    expect(list.ok && list.value.items).toHaveLength(2);
  }, 120_000);
});
