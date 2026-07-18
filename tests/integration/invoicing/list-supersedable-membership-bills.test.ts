/**
 * Task 2 (106-void-on-reissue) — `InvoiceRepo.listSupersedableMembershipBills`
 * integration test.
 *
 * Live Neon Singapore via `runInTenant`. Proves the three guarantees a mock
 * cannot prove:
 *  - shape filter: only `status='issued' AND bill_document_number_raw IS NOT
 *    NULL AND document_number IS NULL` new-flow MEMBERSHIP bills — excludes
 *    paid bills (status), legacy §86/4 bills (document_number set), and
 *    event invoices (invoice_subject).
 *  - asymmetric `(created_at, invoice_id) < bound` ordering — the bound
 *    (newest) bill itself is never returned, only strictly-older rows.
 *  - tenant scoping — a peer tenant's matching-shape row never leaks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

const SNAP_TENANT = {
  legal_name_th: 'ทดสอบ',
  legal_name_en: 'Test',
  tax_id: '0000000000000',
  address_th: 'Bangkok',
  address_en: 'Bangkok',
  logo_blob_key: null,
};
const SNAP_MEMBER = {
  legal_name: 'Supersede Test Co',
  tax_id: '1234567890123',
  address: 'Bangkok',
  primary_contact_name: 'n',
  primary_contact_email: 'test@example.com',
};

/** Seed a membership plan + tenant invoice settings so member/invoice FKs resolve. */
async function seedPlanFixture(tenant: TestTenant, user: TestUser, planId: string): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Supersede Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

async function seedMember(tenant: TestTenant, planId: string): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Supersede Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });
  return memberId;
}

/**
 * Seed a MEMBERSHIP invoice row (`invoice_subject` defaults to
 * 'membership') with an explicit `createdAt` so ordering is deterministic,
 * and either a new-flow (bill number, no document number) or legacy (§87
 * document number) numbering shape.
 */
async function seedBill(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  memberId: string,
  opts: {
    status: 'issued' | 'paid';
    numbering:
      | { kind: 'new_flow'; billNumber: string }
      | { kind: 'legacy'; sequenceNumber: number; documentNumber: string };
    createdAt: Date;
    /** Explicit primary key — used by the tie-break test to control
     *  `invoice_id` ordering deterministically instead of relying on
     *  `randomUUID()` to land on the right side of a hand-picked bound. */
    invoiceId?: string;
  },
): Promise<{ invoiceId: string; createdAt: Date }> {
  const invoiceId = opts.invoiceId ?? randomUUID();
  const isPaid = opts.status === 'paid';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: user.userId,
      status: opts.status,
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: opts.numbering.kind === 'legacy' ? opts.numbering.sequenceNumber : null,
      documentNumber: opts.numbering.kind === 'legacy' ? opts.numbering.documentNumber : null,
      billDocumentNumberRaw: opts.numbering.kind === 'new_flow' ? opts.numbering.billNumber : null,
      receiptDocumentNumberRaw:
        isPaid && opts.numbering.kind === 'new_flow'
          ? `RC-2026-${opts.numbering.billNumber.slice(-6)}`
          : null,
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: true,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paymentMethod: isPaid ? 'bank_transfer' : null,
      paymentReference: isPaid ? 'seed-ref' : null,
      paymentRecordedByUserId: isPaid ? user.userId : null,
      paymentDate: isPaid ? '2026-02-01' : null,
      paidAt: isPaid ? new Date('2026-02-01T03:00:00Z') : null,
      receiptPdfStatus: isPaid ? 'rendered' : null,
      createdAt: opts.createdAt,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPriceSatang: 100_000n,
      totalSatang: 100_000n,
      position: 1,
    });
  });
  return { invoiceId, createdAt: opts.createdAt };
}

/**
 * Seed an ISSUED, new-flow-shaped EVENT invoice (invoice_subject='event')
 * for the SAME member — proves the read excludes it by `invoice_subject`,
 * not merely by member/shape mismatch. Requires a real events +
 * event_registrations row for the hand-authored composite FK.
 */
async function seedEventBill(
  tenant: TestTenant,
  user: TestUser,
  memberId: string,
  createdAt: Date,
): Promise<{ invoiceId: string }> {
  const eventId = randomUUID();
  const regId = randomUUID();
  const invoiceId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `evt-supersede-${regId.slice(0, 8)}`,
      name: 'Supersede Test Gala',
      startDate: new Date('2026-01-10T11:00:00Z'),
    } satisfies NewEventRow);
    await tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId: regId,
      eventId,
      externalId: `att-supersede-${regId.slice(0, 8)}`,
      attendeeEmail: 'matched.member@supersede.test',
      attendeeName: 'Matched Member',
      attendeeCompany: null,
      // `match_type` is a text column with a DB CHECK restricting it to
      // 'member_contact'|'member_domain'|'member_fuzzy'|'non_member'|
      // 'unmatched' (migration 0128) — this is the event_registrations
      // row's own resolution field, independent of `invoices.member_id`
      // above (no FK ties the two), so 'non_member' is valid here even
      // though the invoice itself carries a real member_id.
      matchType: 'non_member',
      ticketType: 'Standard',
      ticketPriceThb: 1070,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-01-05T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
    await tx.insert(invoices).values({
      tenantId: tenant.ctx.slug,
      invoiceId,
      invoiceSubject: 'event',
      eventId,
      eventRegistrationId: regId,
      vatInclusive: true,
      memberId,
      planYear: null,
      planId: null,
      draftByUserId: user.userId,
      status: 'issued',
      pdfDocKind: 'invoice',
      fiscalYear: 2026,
      sequenceNumber: null,
      documentNumber: null,
      // Same "new-flow membership bill" SHAPE (bill number set, document
      // number null) — only invoice_subject distinguishes it. This proves
      // the repo's subject filter, not an accidental shape/status exclusion.
      billDocumentNumberRaw: 'SC-2026-900001',
      issueDate: '2026-01-15',
      dueDate: '2026-02-14',
      subtotalSatang: 100_000n,
      vatRateSnapshot: '0.0700',
      vatSatang: 7_000n,
      totalSatang: 107_000n,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: null,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      autoEmailOnIssue: true,
      pdfBlobKey: `invoicing/${tenant.ctx.slug}/2026/${invoiceId}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      createdAt,
    });
    await tx.insert(invoiceLines).values({
      tenantId: tenant.ctx.slug,
      lineId: randomUUID(),
      invoiceId,
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Supersede Test Gala',
      descriptionEn: 'Event: Supersede Test Gala',
      unitPriceSatang: 107_000n,
      totalSatang: 107_000n,
      position: 1,
    });
  });
  return { invoiceId };
}

describe('InvoiceRepo.listSupersedableMembershipBills — integration (Task 2, 106-void-on-reissue)', () => {
  describe('shape + status + subject filtering, asymmetric ordering', () => {
    let tenant: TestTenant;
    let user: TestUser;
    const planId = 'supersede-plan';

    beforeAll(async () => {
      user = await createActiveTestUser('admin');
      tenant = await createTestTenant('test-chamber');
      await seedPlanFixture(tenant, user, planId);
    }, 60_000);

    afterAll(async () => {
      await tenant.cleanup().catch(() => {});
    });

    beforeEach(async () => {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.delete(invoiceLines).where(eq(invoiceLines.tenantId, tenant.ctx.slug));
        await tx.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug));
        await tx.delete(eventRegistrations).where(eq(eventRegistrations.tenantId, tenant.ctx.slug));
        await tx.delete(events).where(eq(events.tenantId, tenant.ctx.slug));
        await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug));
      });
    });

    it('returns only strictly-older issued new-flow MEMBERSHIP bills for the member', async () => {
      const memberId = await seedMember(tenant, planId);

      // B_old and B_new deliberately far apart in createdAt so the ordering
      // assertion cannot depend on invoice_id tie-breaking.
      const bOld = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000100' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const bNew = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000101' },
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });
      // Same (early) createdAt as B_old — if the shape/status/subject
      // filters were broken, these would slip through on ordering alone.
      const bPaid = await seedBill(tenant, user, planId, memberId, {
        status: 'paid',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000102' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const bLegacy = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'legacy', sequenceNumber: 1, documentNumber: 'VDIT-2026-000001' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const bEvent = await seedEventBill(
        tenant,
        user,
        memberId,
        new Date('2026-01-01T00:00:00Z'),
      );

      const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
      const rows = await repo.listSupersedableMembershipBills(tenant.ctx.slug, memberId, {
        excludeInvoiceId: bNew.invoiceId,
        createdAt: bNew.createdAt,
        invoiceId: bNew.invoiceId,
      });
      const ids = rows.map((r) => r.invoiceId);

      expect(ids).toEqual([bOld.invoiceId]); // ONLY the older issued new-flow bill
      expect(ids).not.toContain(bNew.invoiceId); // exclude-self / not-strictly-older
      expect(ids).not.toContain(bPaid.invoiceId); // paid excluded by status
      expect(ids).not.toContain(bLegacy.invoiceId); // legacy §86/4 excluded by shape
      expect(ids).not.toContain(bEvent.invoiceId); // event excluded by subject
    }, 60_000);

    // Fix 1 (Task 3 hardening, 106-void-on-reissue): in the test above,
    // `excludeInvoiceId === bound.invoiceId`, so the redundant
    // `invoice_id <> excludeInvoiceId` filter masks the tuple `<` — a
    // regression weakening `<` to `<=` would still pass. This test decouples
    // the two filters (`excludeInvoiceId` is a DIFFERENT, unrelated id) to
    // prove the tuple `<` self-excludes the bound row on its own.
    it('self-excludes the bound row via the tuple `<`, independent of the exclude-id filter', async () => {
      const memberId = await seedMember(tenant, planId);

      const bOld = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000110' },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const bBound = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000111' },
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });

      const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
      const rows = await repo.listSupersedableMembershipBills(tenant.ctx.slug, memberId, {
        excludeInvoiceId: randomUUID(), // deliberately NOT bBound.invoiceId
        createdAt: bBound.createdAt,
        invoiceId: bBound.invoiceId,
      });
      const ids = rows.map((r) => r.invoiceId);

      expect(ids).toContain(bOld.invoiceId); // strictly-older row still returned
      expect(ids).not.toContain(bBound.invoiceId); // tuple `<` self-excludes the bound row
    }, 60_000);

    // Fix 2 (Task 3 hardening, 106-void-on-reissue): proves the tie-break
    // direction the docstring rests on — when two bills share the exact
    // same `created_at`, only the sibling whose `invoice_id` is strictly
    // less than the bound's `invoice_id` is returned (deterministic single
    // survivor under concurrent same-`created_at` issue).
    it('tie-breaks by invoice_id when created_at is identical to the bound', async () => {
      const memberId = await seedMember(tenant, planId);
      const sharedCreatedAt = new Date('2026-01-05T00:00:00Z');

      // Hand-authored UUIDs so `siblingLowId < boundId < siblingHighId`
      // ordering is deterministic. Postgres `uuid` comparison is byte-wise,
      // which for same-length hex groups agrees with lexicographic string
      // order — more reliable here than hoping `randomUUID()` lands on the
      // right side of a bound picked after the fact.
      const siblingLowId = '00000000-0000-4000-8000-000000000001';
      const boundId = '00000000-0000-4000-8000-000000000002';
      const siblingHighId = '00000000-0000-4000-8000-000000000003';

      const siblingLow = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000120' },
        createdAt: sharedCreatedAt,
        invoiceId: siblingLowId,
      });
      const siblingHigh = await seedBill(tenant, user, planId, memberId, {
        status: 'issued',
        numbering: { kind: 'new_flow', billNumber: 'SC-2026-000121' },
        createdAt: sharedCreatedAt,
        invoiceId: siblingHighId,
      });

      const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
      const rows = await repo.listSupersedableMembershipBills(tenant.ctx.slug, memberId, {
        excludeInvoiceId: randomUUID(),
        createdAt: sharedCreatedAt,
        invoiceId: boundId,
      });
      const ids = rows.map((r) => r.invoiceId);

      expect(ids).toContain(siblingLow.invoiceId); // (createdAt, low) < (createdAt, bound)
      expect(ids).not.toContain(siblingHigh.invoiceId); // (createdAt, high) NOT < (createdAt, bound)
    }, 60_000);
  });

  describe('tenant scoping', () => {
    it("is tenant-scoped (a peer tenant's bills are never returned)", async () => {
      const { a: tenantA, b: tenantB } = await createTwoTestTenants();
      const userA = await createActiveTestUser('admin');
      const userB = await createActiveTestUser('admin');
      const planIdA = 'supersede-plan-a';
      const planIdB = 'supersede-plan-b';
      try {
        await seedPlanFixture(tenantA, userA, planIdA);
        await seedPlanFixture(tenantB, userB, planIdB);
        const memberId = randomUUID();
        await runInTenant(tenantA.ctx, async (tx) => {
          await tx.insert(members).values({
            tenantId: tenantA.ctx.slug,
            memberId,
            memberNumber: nextSeedMemberNumber(),
            companyName: 'Tenant A Co',
            country: 'TH',
            planId: planIdA,
            planYear: 2026,
          });
        });
        await runInTenant(tenantB.ctx, async (tx) => {
          await tx.insert(members).values({
            tenantId: tenantB.ctx.slug,
            memberId, // same UUID reused across tenants on purpose
            memberNumber: nextSeedMemberNumber(),
            companyName: 'Tenant B Co',
            country: 'TH',
            planId: planIdB,
            planYear: 2026,
          });
        });

        // tenantA: the bound (newest) bill.
        const boundBill = await seedBill(tenantA, userA, planIdA, memberId, {
          status: 'issued',
          numbering: { kind: 'new_flow', billNumber: 'SC-2026-000200' },
          createdAt: new Date('2026-01-02T00:00:00Z'),
        });
        // tenantB: an OLDER, otherwise-perfectly-matching bill for the SAME
        // member_id. Must NEVER appear in tenantA's read.
        const crossTenantBill = await seedBill(tenantB, userB, planIdB, memberId, {
          status: 'issued',
          numbering: { kind: 'new_flow', billNumber: 'SC-2026-000201' },
          createdAt: new Date('2026-01-01T00:00:00Z'),
        });

        const repoA = makeDrizzleInvoiceRepo(tenantA.ctx.slug);
        const rowsA = await repoA.listSupersedableMembershipBills(tenantA.ctx.slug, memberId, {
          excludeInvoiceId: boundBill.invoiceId,
          createdAt: boundBill.createdAt,
          invoiceId: boundBill.invoiceId,
        });
        expect(rowsA.map((r) => r.invoiceId)).not.toContain(crossTenantBill.invoiceId);
        expect(rowsA).toHaveLength(0);

        // tenantB sees its own (older-than-nothing-in-B, so an empty bound
        // still proves the row is reachable from B's own tenant context).
        const repoB = makeDrizzleInvoiceRepo(tenantB.ctx.slug);
        const rowsB = await repoB.listSupersedableMembershipBills(tenantB.ctx.slug, memberId, {
          excludeInvoiceId: randomUUID(),
          createdAt: new Date('2026-01-03T00:00:00Z'),
          invoiceId: randomUUID(),
        });
        expect(rowsB.map((r) => r.invoiceId)).toContain(crossTenantBill.invoiceId);
      } finally {
        await tenantA.cleanup().catch(() => {});
        await tenantB.cleanup().catch(() => {});
      }
    }, 60_000);
  });
});
