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
 *
 * Two further cases run against the same fixture afterwards:
 *   - the scrub adapter's LOCK ORDER — it takes the request rows `FOR UPDATE`
 *     FIRST and holds no field row while it waits (the AB-BA guard vs
 *     `decideInTx`), with a positive control for the NOWAIT probe itself;
 *   - the F114 audit events reach `member_timeline_v` under BOTH payload
 *     keys the view accepts (`member_id` / `related_member_id`) — the
 *     #336/#337 payload-key class, which PR-2 moved twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { changeRequestScrubAdapter } from '@/modules/members/infrastructure/adapters/change-request-scrub-adapter';
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
    decidedId = await submit({
      contact: { phone: PROPOSED_PHONE },
      company: {
        company_name: PROPOSED_NAME,
        // an address GROUP — the sentinel must read back for a jsonb object column too
        billing_address: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
      },
    });
    const decided = await decideChangeRequest(
      { tenant: tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, memberRepo: drizzleMemberRepo, contactRepo: drizzleContactRepo, audit: f3DrizzleAuditAdapter, emails: resendEmailPort, clock },
      {
        changeRequestId: decidedId,
        decisions: [
          { key: 'phone', outcome: 'rejected' },
          { key: 'company_name', outcome: 'rejected' },
          { key: 'billing_address', outcome: 'rejected' },
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
    expect(fields).toHaveLength(4);
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
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain('Box 9');

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
      ['billing_address', ERASED_SENTINEL, ERASED_SENTINEL, 'rejected'],
    ]);
    const list = await drizzleChangeRequestRepo.listByMember(tenant.ctx, asMemberId(memberId), { cursor: null, limit: 10 });
    expect(list.ok && list.value.items).toHaveLength(2);

    // a RE-DRIVE (the reconciler re-running the erasure) is idempotent: no new
    // closure, the withdrawn row keeps its first `withdrawn_at`, values stay sentinel
    const withdrawnAtFirst = pending.withdrawnAt;
    const again = await eraseMember(asMemberId(memberId), { reason: 'gdpr_erasure_request' }, { actorUserId: admin.userId, requestId: 'req-erase-cr-redrive' }, buildEraseMemberDeps(tenant.ctx));
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const closuresAfter = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.eventType, 'member_change_request_withdrawn')));
    expect(closuresAfter.filter((a) => (a.payload as { withdrawn_reason?: string }).withdrawn_reason === 'erasure')).toHaveLength(1);
    const [pendingAgain] = await db.select().from(memberChangeRequests).where(eq(memberChangeRequests.id, pendingId));
    expect(pendingAgain?.withdrawnAt?.getTime()).toBe(withdrawnAtFirst?.getTime());
  }, 180_000);

  it('scrubForMemberInTx takes the REQUEST rows first (`SELECT … FOR UPDATE`): it blocks behind a holder of one of them and holds NO field row while it waits — the AB-BA guard against decideInTx (seam review of PR-2, #1)', async () => {
    const blocked = (ms: number) => new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), ms));
    /** `FOR UPDATE NOWAIT` over the member's field rows: 'free', or 'locked' (SQLSTATE 55P03). */
    const probeFieldRows = () =>
      runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`SELECT "id" FROM "member_change_request_fields" WHERE "request_id" IN (${decidedId}::uuid, ${pendingId}::uuid) FOR UPDATE NOWAIT`),
      ).then(
        () => 'free' as const,
        (e: unknown) => {
          const code = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
          return code === '55P03' ? ('locked' as const) : Promise.reject(e);
        },
      );

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // tx A holds ONE of the member's REQUEST rows — and nothing of the field table
    const holder = runInTenant(tenant.ctx, async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT "id" FROM "member_change_requests" WHERE "member_id" = ${memberId}::uuid ORDER BY "id" LIMIT 1 FOR UPDATE`,
      )) as unknown as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 300));
    try {
      const scrub = runInTenant(tenant.ctx, (tx) =>
        changeRequestScrubAdapter.scrubForMemberInTx(tx, asMemberId(memberId), new Date('2026-09-13T00:00:00Z')),
      );
      expect(await Promise.race([scrub, blocked(1_500)])).toBe('blocked');
      // WHERE it waits is the whole point. Drop `.for('update')` from the
      // adapter's id read and that read returns instantly, statement 1
      // rewrites EVERY field row (taking their row locks for the rest of the
      // tx) and only statement 2 queues on the request row — field-rows-then-
      // request-row, the exact lock order that deadlocks against decideInTx
      // (which locks the request row first and writes the field rows last).
      expect(await probeFieldRows()).toBe('free');
      release();
      await holder;
      const done = await scrub;
      expect(done.ok && done.value.scrubbedRequestIds).toHaveLength(2);
    } finally {
      release();
      await holder.catch(() => {});
    }

    // positive control for the probe itself: with a field row deliberately
    // held, the SAME call reports 'locked'. Without this, a probe that could
    // never say anything but 'free' would look like proof (memory:
    // a check that cannot tell "nothing to find" from "not looking").
    let releaseField!: () => void;
    const fieldGate = new Promise<void>((r) => {
      releaseField = r;
    });
    const fieldHolder = runInTenant(tenant.ctx, async (tx) => {
      await tx.execute(sql`SELECT "id" FROM "member_change_request_fields" WHERE "request_id" = ${pendingId}::uuid FOR UPDATE`);
      await fieldGate;
    });
    await new Promise((r) => setTimeout(r, 300));
    try {
      expect(await probeFieldRows()).toBe('locked');
    } finally {
      releaseField();
      await fieldHolder.catch(() => {});
    }
  }, 60_000);

  it('the F114 audit events reach member_timeline_v — the view keys on payload `member_id` OR `related_member_id` (migration 0196; the #336/#337 payload-key class)', async () => {
    // `member_change_request_submitted` keys on `member_id` (it IS member
    // activity — the 0009 `last_activity_at` trigger reads that key);
    // `_decided` and `_withdrawn` key on `related_member_id` (a staff action
    // is not the member's own activity). The view's audit arm accepts BOTH
    // (`payload ? 'member_id' OR payload ? 'related_member_id'`, member_id =
    // COALESCE of the two), so a rename on EITHER side silently drops the
    // member's change-request history off their timeline.
    const rows = await runInTenant(
      tenant.ctx,
      async (tx) =>
        (await tx.execute(sql`
          SELECT DISTINCT "payload"->>'event_type' AS event_type
          FROM "member_timeline_v"
          WHERE "tenant_id" = ${tenant.ctx.slug} AND "member_id" = ${memberId} AND "source" = 'audit'
        `)) as unknown as Array<{ event_type: string }>,
    );
    const types = rows.map((r) => r.event_type);
    expect(types, JSON.stringify(types)).toContain('member_change_request_submitted');
    expect(types, JSON.stringify(types)).toContain('member_change_request_decided');
    expect(types, JSON.stringify(types)).toContain('member_change_request_withdrawn');
  }, 60_000);
});
