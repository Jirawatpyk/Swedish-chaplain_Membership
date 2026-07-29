/**
 * Round-3 wipe — live-Neon integration (Part 3 of the Round-3 import;
 * docs/import/ROUND3_PLAN.md § Wipe).
 *
 * Drives `wipeTenantBusinessData` (scripts/import-round3/wipe-core.ts) — the
 * SAME core the operator CLI wraps — against a THROWAWAY test tenant on the
 * dev Neon branch. Fixture: member + contacts + linked member-portal user
 * (session + invitation) + PENDING member user (email-matched) + issued
 * invoice(+line) + a FULLY-LINKED money chain payment → succeeded refund
 * (credit_note_id set) → credit note (source_refund_id set) — the mutual
 * ON-DELETE-RESTRICT refunds ↔ credit_notes cycle that deadlocked the
 * pre-R3-1 delete order (0034 + 0038; broken by the unlink pre-step) —
 * + awaiting_payment renewal cycle(+reminder event) + F9 dashboard cache row
 * + document/member sequences + outbox + email-change token + audit row.
 *
 * Discriminators deliberately seeded so exclusion logic is what saves them:
 *   - a '00000000-…' system-actor-STYLE user linked via a tenant contact
 *     (id-prefix exclusion must save it),
 *   - a role='member' user whose email matches a tenant contact BUT who is
 *     linked from ANOTHER tenant's contact (cross-tenant guard must save it),
 *   - the admin user + its session + an admin-invitee invitation,
 *   - membership_plans / tenant_* config / audit_log rows.
 *
 * Run this ONE file positionally (never the bare suite):
 *   pnpm test:integration tests/integration/scripts/wipe-tenant-business-data.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  auditLog,
  invitations,
  notificationsOutbox,
  emailChangeTokens,
  sessions,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { tenantMemberSequences } from '@/modules/members/infrastructure/db/schema-member-sequences';
import { tenantMemberSettings } from '@/modules/members/infrastructure/db/schema-member-settings';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { payments, refunds } from '@/modules/payments/infrastructure/schema';
import { dashboardMetricsCache } from '@/modules/insights/infrastructure/db/schema-insights';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { renewalReminderEvents } from '@/modules/renewals/infrastructure/schema-renewal-reminder-events';
import { asSatang } from '@/lib/money';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { wipeTenantBusinessData } from '@/../scripts/import-round3/wipe-core';

const MATRIX: BenefitMatrix = {
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
};

const PLAN_ID = 'wipe-test-plan';

const count = async (query: ReturnType<typeof sql>): Promise<number> => {
  const r = await db.execute(query);
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as { n: number } | undefined)?.n ?? 0;
};

const rowsOf = (report: { counts: readonly { table: string; rows: number }[] }) =>
  new Map(report.counts.map((c) => [c.table, c.rows]));

describe('wipeTenantBusinessData — live Neon', () => {
  let tenantA: TestTenant; // the wiped tenant
  let tenantB: TestTenant; // peer tenant (cross-tenant guard)
  let admin: TestUser;
  let memberUser: TestUser; // linked member-portal account — must be DELETED
  let pendingUserId: string; // pending invitee (email-matched) — must be DELETED
  let sysStyleUserId: string; // '00000000-…' — must SURVIVE
  let peerUserId: string; // linked from tenant B — must SURVIVE
  let slugA: string;
  const member1Id = randomUUID();
  const member2Id = randomUUID();
  const invoiceId = randomUUID();
  const cycleId = randomUUID();
  const paymentId = `pay_wipe_${randomBytes(8).toString('hex')}`;
  const refundId = `re_wipe_${randomBytes(8).toString('hex')}`;
  const creditNoteId = randomUUID();
  const adminSessionId = randomBytes(32).toString('hex');
  const memberSessionId = randomBytes(32).toString('hex');
  const adminInvitationId = `wipe-admin-inv-${randomBytes(16).toString('hex')}`;
  const memberInvitationId = `wipe-member-inv-${randomBytes(16).toString('hex')}`;
  const tokenId = `wipe-ect-${randomBytes(16).toString('hex')}`;

  beforeAll(async () => {
    delete process.env.CONFIRM_WIPE; // never inherit ambient confirmation

    admin = await createActiveTestUser('admin');
    memberUser = await createActiveTestUser('member');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    slugA = tenantA.ctx.slug;

    const pendingEmail = `wipe-pending-${randomUUID().slice(0, 8)}@wipe.test`;
    const peerEmail = `wipe-peer-${randomUUID().slice(0, 8)}@wipe.test`;
    const sysEmail = `wipe-sys-${randomUUID().slice(0, 8)}@wipe.test`;
    sysStyleUserId = `00000000-0000-0000-0000-${randomBytes(6).toString('hex')}`;

    // Pending member user (email-matched arm) + peer-linked user + system-style user.
    const pendingRows = await db
      .insert(users)
      .values({ email: pendingEmail, role: 'member', status: 'pending', passwordHash: null })
      .returning();
    pendingUserId = pendingRows[0]!.id;
    const peerRows = await db
      .insert(users)
      .values({ email: peerEmail, role: 'member', status: 'active', passwordHash: null })
      .returning();
    peerUserId = peerRows[0]!.id;
    await db.insert(users).values({
      id: sysStyleUserId,
      email: sysEmail,
      role: 'member',
      status: 'disabled',
      passwordHash: null,
    });

    // Sessions: one for the member user (must go), one for the admin (must stay).
    const in12h = new Date(Date.now() + 12 * 3600_000);
    await db.insert(sessions).values([
      { id: memberSessionId, userId: memberUser.userId, expiresAt: in12h, sourceIp: '127.0.0.1' },
      { id: adminSessionId, userId: admin.userId, expiresAt: in12h, sourceIp: '127.0.0.1' },
    ]);

    // Invitations: member invitee (must go) + admin invitee (must stay).
    const in7d = new Date(Date.now() + 7 * 24 * 3600_000);
    await db.insert(invitations).values([
      {
        id: memberInvitationId,
        userId: memberUser.userId,
        invitedByUserId: admin.userId,
        intendedRole: 'member',
        expiresAt: in7d,
      },
      {
        id: adminInvitationId,
        userId: admin.userId,
        invitedByUserId: admin.userId,
        intendedRole: 'admin',
        expiresAt: in7d,
      },
    ]);

    // Tenant A: fiscal config + plan + 2 members + 4 contacts.
    await seedTenantFiscal({ tenant: tenantA });
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: slugA,
        planId: PLAN_ID,
        planYear: 2026,
        planName: { en: 'Wipe Test Plan' },
        description: { en: 'wipe integration plan' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_600_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      });
      await tx.insert(members).values([
        {
          tenantId: slugA,
          memberId: member1Id,
          memberNumber: 1,
          companyName: `Wipe Synth One Co ${Date.now()}`,
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          registrationDate: '2026-01-15',
          status: 'active',
        },
        {
          tenantId: slugA,
          memberId: member2Id,
          memberNumber: 2,
          companyName: `Wipe Synth Two Co ${Date.now()}`,
          country: 'SE',
          planId: PLAN_ID,
          planYear: 2026,
          registrationDate: '2026-02-01',
          status: 'inactive',
        },
      ]);
      await tx.insert(contacts).values([
        {
          tenantId: slugA,
          contactId: randomUUID(),
          memberId: member1Id,
          firstName: 'Wipe',
          lastName: 'Linked',
          email: memberUser.rawEmail,
          isPrimary: true,
          linkedUserId: memberUser.userId,
        },
        {
          tenantId: slugA,
          contactId: randomUUID(),
          memberId: member1Id,
          firstName: 'Wipe',
          lastName: 'Pending',
          email: pendingEmail, // pending invitee — email-matched arm
          isPrimary: false,
        },
        {
          tenantId: slugA,
          contactId: randomUUID(),
          memberId: member1Id,
          firstName: 'Wipe',
          lastName: 'System',
          email: sysEmail,
          isPrimary: false,
          linkedUserId: sysStyleUserId, // id-prefix exclusion must save the user
        },
        {
          tenantId: slugA,
          contactId: randomUUID(),
          memberId: member2Id,
          firstName: 'Wipe',
          lastName: 'Peer',
          email: peerEmail, // matches peer user — cross-tenant guard must save it
          isPrimary: true,
        },
      ]);
      // Issued invoice (full non-draft snapshot per invoices_non_draft_has_snapshots).
      await tx.insert(invoices).values({
        tenantId: slugA,
        invoiceId,
        memberId: member1Id,
        planYear: 2026,
        planId: PLAN_ID,
        status: 'issued',
        pdfDocKind: 'invoice',
        draftByUserId: admin.userId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'INV-2026-000001',
        issueDate: '2026-05-15',
        dueDate: '2026-06-14',
        currency: 'THB',
        subtotalSatang: asSatang(1_600_000n),
        vatRateSnapshot: '0.0700',
        vatSatang: asSatang(112_000n),
        totalSatang: asSatang(1_712_000n),
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legalNameEn: 'Test', taxId: '0' } as unknown,
        memberIdentitySnapshot: {
          companyName: 'Wipe Synth One Co',
          country: 'TH',
          legal_name: 'Wipe Synth One Co Ltd',
          address: '1 Test Rd, Bangkok 10110',
          primary_contact_name: 'Wipe Linked',
          primary_contact_email: memberUser.rawEmail,
        } as unknown,
        pdfBlobKey: `invoicing/${slugA}/2026/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      });
      await tx.insert(invoiceLines).values({
        tenantId: slugA,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก (ทดสอบ)',
        descriptionEn: 'Membership fee (test)',
        unitPriceSatang: 1_600_000n,
        totalSatang: 1_600_000n,
        position: 1,
      });
      // FULLY-LINKED money chain (R3-1): payment → refund → credit note, with
      // BOTH cycle edges populated (refunds.credit_note_id AND
      // credit_notes.source_refund_id). This is the exact shape that
      // deadlocked the old refunds → payments → credit_notes delete order —
      // the commit-wipe test below is the regression proof for the unlink
      // pre-step. Inserted the way production does (refund starts 'pending',
      // flips 'succeeded' AFTER the credit note exists — the 0034/0268
      // refund CHECKs forbid any other insert order).
      await tx.insert(payments).values({
        id: paymentId,
        tenantId: slugA,
        invoiceId,
        memberId: member1Id,
        method: 'promptpay',
        status: 'succeeded',
        amountSatang: 1_712_000n,
        currency: 'THB',
        processorPaymentIntentId: `pi_wipe_${randomBytes(10).toString('hex')}`,
        processorEnvironment: 'test',
        initiatedAt: new Date('2026-06-01T03:00:00Z'),
        completedAt: new Date('2026-06-01T03:05:00Z'),
        actorUserId: admin.userId,
        correlationId: `wipe-test-${randomUUID()}`,
      });
      await tx.insert(refunds).values({
        id: refundId,
        tenantId: slugA,
        paymentId,
        invoiceId,
        amountSatang: 100_000n,
        reason: 'wipe integration fixture — refund-origin credit note (synthetic)',
        status: 'pending',
        initiatedAt: new Date('2026-06-02T03:00:00Z'),
        initiatorUserId: admin.userId,
        correlationId: `wipe-test-${randomUUID()}`,
      });
      await tx.insert(creditNotes).values({
        tenantId: slugA,
        creditNoteId,
        originalInvoiceId: invoiceId,
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'CN-2026-000001',
        issueDate: '2026-06-02',
        issuedByUserId: admin.userId,
        reason: 'wipe integration fixture (synthetic)',
        creditAmountSatang: 100_000n,
        vatSatang: 7_000n,
        totalSatang: 107_000n,
        tenantIdentitySnapshot: { legalNameEn: 'Test' } as unknown,
        memberIdentitySnapshot: { companyName: 'Wipe Synth One Co' } as unknown,
        pdfBlobKey: `invoicing/${slugA}/2026/cn-${creditNoteId}.pdf`,
        pdfSha256: 'b'.repeat(64),
        pdfTemplateVersion: 1,
        sourceRefundId: refundId,
      });
      await tx
        .update(refunds)
        .set({
          status: 'succeeded',
          processorRefundId: `re_stripe_wipe_${randomBytes(10).toString('hex')}`,
          creditNoteId,
          completedAt: new Date('2026-06-02T04:00:00Z'),
        })
        .where(and(eq(refunds.tenantId, slugA), eq(refunds.id, refundId)));
      // F9 derived cache row — stale after a wipe, must be deleted (R3-8).
      await tx.insert(dashboardMetricsCache).values({
        tenantId: slugA,
        metrics: {},
        computedAt: new Date('2026-06-03T00:00:00Z'),
      });
      // awaiting_payment cycle linking the issued bill + one reminder event.
      await tx.insert(renewalCycles).values({
        tenantId: slugA,
        cycleId,
        memberId: member1Id,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-05-15T00:00:00Z'),
        periodTo: new Date('2027-05-15T00:00:00Z'),
        expiresAt: new Date('2027-05-15T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: PLAN_ID,
        frozenPlanPriceThb: '16000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        linkedInvoiceId: invoiceId,
      });
      await tx.insert(renewalReminderEvents).values({
        tenantId: slugA,
        reminderEventId: randomUUID(),
        cycleId,
        stepId: 'offset_-30d',
        channel: 'email',
        templateId: 'tmpl-wipe-test',
        status: 'pending',
        yearInCycle: 1,
      });
      // Numbering state + outbox + email-change token.
      await tx.insert(tenantDocumentSequences).values({
        tenantId: slugA,
        documentType: 'invoice',
        fiscalYear: 2026,
        nextSequenceNumber: 2,
      });
      await tx.insert(tenantMemberSequences).values({ tenantId: slugA, lastNumber: 2 });
      await tx.insert(tenantMemberSettings).values({
        tenantId: slugA,
        memberNumberPrefix: 'WIPE',
      });
      await tx.insert(notificationsOutbox).values({
        tenantId: slugA,
        notificationType: 'member_invitation',
        toEmail: memberUser.rawEmail,
        locale: 'en',
        contextData: {},
      });
      await tx.insert(emailChangeTokens).values({
        id: tokenId,
        tenantId: slugA,
        contactId: randomUUID(),
        userId: memberUser.userId,
        type: 'verification',
        oldEmail: memberUser.rawEmail,
        newEmail: `new-${memberUser.rawEmail}`,
        activatedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3600_000),
      });
    });

    // Audit row for tenant A — append-only, MUST survive the wipe.
    await db.insert(auditLog).values({
      eventType: 'member_created',
      actorUserId: admin.userId,
      summary: 'wipe integration fixture (synthetic)',
      requestId: `wipe-test-${randomUUID()}`,
      tenantId: slugA,
    });

    // Tenant B: plan + member + contact linking the PEER user (cross-tenant guard).
    await runInTenant(tenantB.ctx, async (tx) => {
      const memberBId = randomUUID();
      await tx.insert(membershipPlans).values({
        tenantId: tenantB.ctx.slug,
        planId: PLAN_ID,
        planYear: 2026,
        planName: { en: 'Wipe Peer Plan' },
        description: { en: 'peer tenant plan' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_600_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: memberBId,
        memberNumber: 1,
        companyName: `Wipe Peer Co ${Date.now()}`,
        country: 'SE',
        planId: PLAN_ID,
        planYear: 2026,
        registrationDate: '2026-01-01',
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenantB.ctx.slug,
        contactId: randomUUID(),
        memberId: memberBId,
        firstName: 'Peer',
        lastName: 'Holder',
        email: peerEmail,
        isPrimary: true,
        linkedUserId: peerUserId, // the peer link that must SAVE the user
      });
    });
  }, 120_000);

  afterAll(async () => {
    delete process.env.CONFIRM_WIPE;
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    // Users the wipe should have removed (defensive) + the survivors.
    await db.execute(sql`DELETE FROM invitations WHERE invited_by_user_id = ${admin.userId}::uuid`).catch(() => {});
    for (const id of [pendingUserId, sysStyleUserId, peerUserId]) {
      await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`).catch(() => {});
    }
    await deleteTestUser(memberUser).catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 60_000);

  it('dry-run reports the full deletion plan and writes NOTHING', async () => {
    const report = await wipeTenantBusinessData(slugA, { commit: false });
    expect(report.mode).toBe('dry-run');
    expect(report.memberPortalUsers).toBe(2); // linked + pending (peer + system excluded)

    const rows = rowsOf(report);
    expect(rows.get('renewal_reminder_events')).toBe(1);
    expect(rows.get('renewal_cycles')).toBe(1);
    expect(rows.get('refunds.credit_note_id_unlink')).toBe(1); // cycle-breaker pre-step
    expect(rows.get('credit_notes')).toBe(1);
    expect(rows.get('refunds')).toBe(1);
    expect(rows.get('payments')).toBe(1);
    expect(rows.get('invoice_lines')).toBe(1);
    expect(rows.get('invoices')).toBe(1);
    expect(rows.get('dashboard_metrics_cache')).toBe(1);
    expect(rows.get('email_change_tokens')).toBe(1);
    expect(rows.get('notifications_outbox')).toBe(1);
    expect(rows.get('sessions')).toBe(1); // member session only — never the admin's
    expect(rows.get('invitations')).toBe(1); // member invitee only
    expect(rows.get('users')).toBe(2);
    expect(rows.get('contacts')).toBe(4);
    expect(rows.get('members')).toBe(2);
    expect(rows.get('tenant_document_sequences')).toBe(1);
    expect(rows.get('tenant_member_sequences')).toBe(1);

    // ZERO writes — everything still present, and the refund is STILL linked
    // to its credit note (the dry-run must not perform the unlink UPDATE).
    expect(await count(sql`SELECT count(*)::int AS n FROM members WHERE tenant_id = ${slugA}`)).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${slugA}`)).toBe(4);
    expect(await count(sql`SELECT count(*)::int AS n FROM invoices WHERE tenant_id = ${slugA}`)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM refunds WHERE id = ${refundId} AND credit_note_id = ${creditNoteId}::uuid`,
      ),
    ).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${memberUser.userId}::uuid`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${pendingUserId}::uuid`)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM tenant_member_sequences WHERE tenant_id = ${slugA} AND last_number = 2`,
      ),
    ).toBe(1);
  }, 60_000);

  it('refuses --commit without an EXACT CONFIRM_WIPE match', async () => {
    delete process.env.CONFIRM_WIPE;
    await expect(wipeTenantBusinessData(slugA, { commit: true })).rejects.toThrow(/CONFIRM_WIPE/);

    process.env.CONFIRM_WIPE = 'swecham'; // right shape, WRONG tenant
    await expect(wipeTenantBusinessData(slugA, { commit: true })).rejects.toThrow(/CONFIRM_WIPE/);
    delete process.env.CONFIRM_WIPE;

    // Nothing was deleted by the refused attempts.
    expect(await count(sql`SELECT count(*)::int AS n FROM members WHERE tenant_id = ${slugA}`)).toBe(2);
  }, 60_000);

  it('commit wipes business data, resets numbering, preserves protected rows', async () => {
    process.env.CONFIRM_WIPE = slugA;
    const report = await wipeTenantBusinessData(slugA, { commit: true });
    delete process.env.CONFIRM_WIPE;

    expect(report.mode).toBe('commit');
    expect(report.memberPortalUsers).toBe(2);
    const rows = rowsOf(report);
    expect(rows.get('renewal_reminder_events')).toBe(1);
    expect(rows.get('renewal_cycles')).toBe(1);
    // The mutual-RESTRICT cycle survived the delete ONLY because the unlink
    // pre-step ran — this line is the R3-1 regression anchor.
    expect(rows.get('refunds.credit_note_id_unlink')).toBe(1);
    expect(rows.get('credit_notes')).toBe(1);
    expect(rows.get('refunds')).toBe(1);
    expect(rows.get('payments')).toBe(1);
    expect(rows.get('invoice_lines')).toBe(1);
    expect(rows.get('invoices')).toBe(1);
    expect(rows.get('dashboard_metrics_cache')).toBe(1);
    expect(rows.get('sessions')).toBe(1);
    expect(rows.get('invitations')).toBe(1);
    expect(rows.get('users')).toBe(2);
    expect(rows.get('contacts')).toBe(4);
    expect(rows.get('members')).toBe(2);
    expect(rows.get('tenant_document_sequences')).toBe(1);
    expect(rows.get('tenant_member_sequences')).toBe(1);

    // Business data gone.
    for (const table of [
      'renewal_reminder_events',
      'renewal_cycles',
      'credit_notes',
      'refunds',
      'payments',
      'invoice_lines',
      'invoices',
      'dashboard_metrics_cache',
      'email_change_tokens',
      'notifications_outbox',
      'contacts',
      'members',
      'tenant_document_sequences',
    ]) {
      expect(
        await count(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE tenant_id = ${slugA}`),
        `${table} should be empty`,
      ).toBe(0);
    }

    // Member-portal accounts gone (linked + pending) — with their session/invitation.
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${memberUser.userId}::uuid`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${pendingUserId}::uuid`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM sessions WHERE id = ${memberSessionId}`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM invitations WHERE id = ${memberInvitationId}`)).toBe(0);

    // Survivors: admin (+ session + invitation), system-style user, peer-linked
    // user, plans, tenant config, member-number prefix row, audit row.
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${admin.userId}::uuid`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM sessions WHERE id = ${adminSessionId}`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM invitations WHERE id = ${adminInvitationId}`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${sysStyleUserId}::uuid`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM users WHERE id = ${peerUserId}::uuid`)).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM membership_plans WHERE tenant_id = ${slugA}`),
    ).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM tenant_invoice_settings WHERE tenant_id = ${slugA}`),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM tenant_member_settings WHERE tenant_id = ${slugA} AND member_number_prefix = 'WIPE'`,
      ),
    ).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = ${slugA}`)).toBeGreaterThanOrEqual(1);

    // Member-number counter: row KEPT, zeroed.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM tenant_member_sequences WHERE tenant_id = ${slugA} AND last_number = 0`,
      ),
    ).toBe(1);

    // Tenant B untouched.
    expect(
      await count(sql`SELECT count(*)::int AS n FROM members WHERE tenant_id = ${tenantB.ctx.slug}`),
    ).toBe(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = ${tenantB.ctx.slug}`),
    ).toBe(1);
  }, 60_000);

  it('re-run deletes 0 rows everywhere (idempotent)', async () => {
    process.env.CONFIRM_WIPE = slugA;
    const report = await wipeTenantBusinessData(slugA, { commit: true });
    delete process.env.CONFIRM_WIPE;

    expect(report.memberPortalUsers).toBe(0);
    for (const c of report.counts) {
      expect(c.rows, `${c.table} should re-delete 0`).toBe(0);
    }
  }, 60_000);
});
