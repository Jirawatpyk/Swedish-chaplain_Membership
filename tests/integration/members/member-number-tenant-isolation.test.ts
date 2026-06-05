/**
 * T-MN-01 — Member-number tenant isolation (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3.
 *
 * Asserts:
 *   (a) tenant A cannot SELECT / UPDATE / INSERT tenant B's
 *       tenant_member_sequences rows via runInTenant.
 *   (b) tenant A cannot SELECT / UPDATE / INSERT tenant B's
 *       tenant_member_settings rows via runInTenant.
 *   (c) directory search exposes member_number only for the session
 *       tenant (RLS hides B members from A context entirely).
 *   (d) formatted string `formatMemberNumber(prefix, n)` equals the
 *       stored integer for the same member row.
 *   (e) INSERT with mismatched tenant_id on tenant_member_sequences /
 *       tenant_member_settings is rejected by RLS WITH CHECK.
 *   (f) unset app.current_tenant → 0 rows on both new tables.
 *
 * Uses createTwoTestTenants() (mirrors tenant-isolation.test.ts).
 * The two new tables must exist before this test can run — migration
 * 0209 is the prerequisite.
 *
 * SCHEMA-FILE RECONCILIATION (vs plan draft): the MIG group named the
 * Drizzle schema files per-table, so `tenantMemberSequences` lives in
 * `schema-member-sequences.ts` and `tenantMemberSettings` in
 * `schema-member-settings.ts` (the plan's single-file import was a draft
 * assumption). Both DB identifiers are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantMemberSequences } from '@/modules/members/infrastructure/db/schema-member-sequences';
import { tenantMemberSettings } from '@/modules/members/infrastructure/db/schema-member-settings';
import {
  formatMemberNumber,
  asMemberNumber,
} from '@/modules/members/domain/value-objects/member-number';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

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

describe('Member-number tenant isolation — T-MN-01 (REVIEW-GATE BLOCKER)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aMemberId: string;
  let bMemberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed prerequisite rows for both tenants.
    for (const { tenant, prefix } of [
      { tenant: tenantA, prefix: 'mniso-alpha' },
      { tenant: tenantB, prefix: 'mniso-beta' },
    ]) {
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
          planId: `${prefix}-plan`,
          planYear: 2026,
          planName: { en: `${prefix} Plan` },
          description: { en: 'Test' },
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

    // Seed one member per tenant with a known member_number.
    aMemberId = randomUUID();
    bMemberId = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: aMemberId,
        companyName: 'Alpha Co',
        country: 'TH',
        planId: 'mniso-alpha-plan',
        planYear: 2026,
        memberNumber: 1,
      });
      // Seed the sequence counter for tenant A.
      await tx.insert(tenantMemberSequences).values({
        tenantId: tenantA.ctx.slug,
        lastNumber: 1,
      });
      await tx.insert(tenantMemberSettings).values({
        tenantId: tenantA.ctx.slug,
        memberNumberPrefix: 'ALPHA',
      });
    });

    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: bMemberId,
        companyName: 'Beta Co',
        country: 'TH',
        planId: 'mniso-beta-plan',
        planYear: 2026,
        memberNumber: 1,
      });
      await tx.insert(tenantMemberSequences).values({
        tenantId: tenantB.ctx.slug,
        lastNumber: 1,
      });
      await tx.insert(tenantMemberSettings).values({
        tenantId: tenantB.ctx.slug,
        memberNumberPrefix: 'BETA',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // ── (a) tenant_member_sequences SELECT isolation ─────────────────────────

  it('(a1) A context sees only A tenant_member_sequences row', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(tenantMemberSequences),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
  });

  it('(a2) A context: SELECT by B tenant_id on tenant_member_sequences → 0 rows', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  it('(a3) A context: UPDATE on B tenant_member_sequences → 0 rows affected', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(tenantMemberSequences)
        .set({ lastNumber: 9999 })
        .where(eq(tenantMemberSequences.tenantId, tenantB.ctx.slug))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    // Verify B's counter was NOT modified.
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, tenantB.ctx.slug)),
    );
    expect(check[0]!.lastNumber).toBe(1);
  });

  // ── (b) tenant_member_settings SELECT isolation ──────────────────────────

  it('(b1) A context sees only A tenant_member_settings row', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(tenantMemberSettings),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
  });

  it('(b2) A context: SELECT by B tenant_id on tenant_member_settings → 0 rows', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(tenantMemberSettings)
        .where(eq(tenantMemberSettings.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  // ── (c) directory: member_number visible only within own tenant ──────────

  it('(c) A directory SELECT returns A member_number, hides B member entirely', async () => {
    const aRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ memberId: members.memberId, memberNumber: members.memberNumber })
        .from(members),
    );
    const bRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.memberId, bMemberId)),
    );

    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.memberId).toBe(aMemberId);
    expect(aRows[0]!.memberNumber).toBe(1);
    expect(bRows).toHaveLength(0); // B's member is hidden by RLS
  });

  // ── (d) formatted string equals stored integer ───────────────────────────

  it('(d) formatMemberNumber(prefix, storedInt) round-trips via stored member_number', async () => {
    const [row] = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ memberNumber: members.memberNumber })
        .from(members)
        .where(eq(members.memberId, aMemberId)),
    );
    expect(row).toBeDefined();
    const storedInt = row!.memberNumber;
    const formatted = formatMemberNumber('ALPHA', asMemberNumber(storedInt));
    expect(formatted).toBe('ALPHA-0001');
    // The integer inside the formatted string equals the stored value.
    const parsed = parseInt(formatted.split('-')[1]!, 10);
    expect(parsed).toBe(storedInt);
  });

  // ── (e) INSERT with mismatched tenant_id rejected by RLS WITH CHECK ──────

  it('(e) A context: INSERT tenant_member_sequences with tenant_id=B rejected by RLS WITH CHECK', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(tenantMemberSequences).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED
          lastNumber: 0,
        }),
      ),
    ).rejects.toThrow();
  });

  it('(e2) A context: INSERT tenant_member_settings with tenant_id=B rejected by RLS WITH CHECK', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(tenantMemberSettings).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED
          memberNumberPrefix: 'FORGED',
        }),
      ),
    ).rejects.toThrow();
  });

  // ── (f) unset app.current_tenant → zero rows ────────────────────────────

  it('(f) unset app.current_tenant returns 0 rows on tenant_member_sequences', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      return tx.select().from(tenantMemberSequences);
    });
    expect(rows).toHaveLength(0);
  });

  it('(f2) unset app.current_tenant returns 0 rows on tenant_member_settings', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      return tx.select().from(tenantMemberSettings);
    });
    expect(rows).toHaveLength(0);
  });
});
