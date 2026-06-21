/**
 * COMP-1 US3-A (Member Erasure, admin trigger — Task 7) — Integration:
 * Art.12 attestation payload + cross-tenant isolation, against live Neon.
 *
 * Two assertions, both driving the PRODUCTION `eraseMember` via the real
 * `buildEraseMemberDeps` composition root (no mocks):
 *
 *   Case 1 — attestation payload recorded. The admin route attaches the
 *     Art.12 accountability fields (identityVerified + verificationMethod +
 *     note) to the erase request; the use-case threads them, in snake_case,
 *     into the durable `member_erasure_requested` audit (the DPO log + Art.12
 *     one-month-clock start). The unit test (Task 1) asserted this against a
 *     stub and the contract test (Task 3) against mocks; this asserts the SAME
 *     against the row that actually lands in `audit_log`.
 *
 *   Case 2 — cross-tenant erase is BLOCKED (Principle I Review-Gate blocker,
 *     constitution §I two-layer tenant isolation). Tenant A's admin drives
 *     `eraseMember` (via `buildEraseMemberDeps(tenantA.ctx)`) against a member
 *     that lives in tenant B. The pre-flight `findErasedAtById` read runs under
 *     tenant A's `app.current_tenant`, so RLS hides B's row → `repo.not_found`
 *     → `err({ type: 'not_found' })` BEFORE any scrub or plan lookup. Tenant B's
 *     member MUST be left fully untouched (`erased_at` null). Because the erase
 *     short-circuits at the pre-flight, tenant B needs NO plan/member seed of
 *     its own beyond the victim member — only its tenant context must exist.
 *
 * Reuses the live-Neon harness shared by the sibling erase tests
 * (`createTestTenant` + plan/settings seed + `nextSeedMemberNumber` +
 * production `buildEraseMemberDeps`). The BYPASSRLS `db` singleton (owner role)
 * reads `audit_log` directly with an explicit `WHERE tenant_id = …` filter —
 * the established convention for audit-payload assertions (this project's
 * `db.execute(sql`…`)` returns the rows array directly, no `.rows` wrapper).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erase-attestation-plan';

async function seedPlan(tenant: TestTenant, userId: string) {
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
      planName: { en: 'Erase Attestation Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      createdBy: userId,
      updatedBy: userId,
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
  });
}

/** Seed a plain active member (no contacts needed for these assertions). */
async function seedMember(tenant: TestTenant): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Erase Attestation Co., Ltd.',
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
  });
  return memberId;
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — attestation payload + cross-tenant isolation (COMP-1 US3-A)', () => {
  let tenantA: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    await seedPlan(tenantA, admin.userId);
  }, 30_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('Case 1: records the Art.12 attestation payload in member_erasure_requested', async () => {
    const memberId = await seedMember(tenantA);
    const requestId = `req-it-attest-${randomUUID()}`;

    const res = await eraseMember(
      asMemberId(memberId) as MemberId,
      {
        reason: 'gdpr_erasure_request',
        identityVerified: true,
        verificationMethod: 'official_document',
        note: 'DPO-2026-014',
      },
      { actorUserId: admin.userId, requestId },
      buildEraseMemberDeps(tenantA.ctx),
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);

    // The durable `member_erasure_requested` row carries the snake_case Art.12
    // accountability fields (see erase-member.ts payload construction). Read it
    // via the BYPASSRLS owner-role `db` singleton with an explicit tenant
    // filter (the established audit-payload assertion convention).
    // The unique `request_id` pins exactly one row, so no ORDER BY / LIMIT is
    // needed (audit_log's timestamp column is `timestamp`, not `created_at`).
    const rows = (await db.execute(sql`
      SELECT payload FROM audit_log
      WHERE tenant_id = ${tenantA.ctx.slug}
        AND event_type = 'member_erasure_requested'
        AND request_id = ${requestId}
        AND payload->>'member_id' = ${memberId}
    `)) as unknown as Array<{ payload: Record<string, unknown> }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      member_id: memberId,
      reason: 'gdpr_erasure_request',
      identity_verified: true,
      verification_method: 'official_document',
      note: 'DPO-2026-014',
    });
  }, 30_000);

  it('Case 2: cross-tenant erase returns not_found and leaves tenant A intact (Principle I)', async () => {
    // Victim member lives in tenant A.
    const memberInA = await seedMember(tenantA);

    // Tenant B exists as a context only — the erase short-circuits at the
    // pre-flight `findErasedAtById` (RLS-scoped to B) before any plan is
    // needed, so B needs no plan/member seed of its own.
    const tenantB = await createTestTenant('test-chamber');
    try {
      // Drive erase with TENANT B's deps against TENANT A's member id.
      const res = await eraseMember(
        asMemberId(memberInA) as MemberId,
        { reason: 'gdpr_erasure_request', identityVerified: true, verificationMethod: 'in_person' },
        { actorUserId: 'admin-b', requestId: `req-it-xtenant-${randomUUID()}` },
        buildEraseMemberDeps(tenantB.ctx),
      );

      // RLS hides tenant A's row from tenant B → pre-flight not_found →
      // err({ type: 'not_found' }).
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.type).toBe('not_found');

      // FIRM assertion: tenant A's member is fully untouched (never scrubbed).
      const after = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select({ erasedAt: members.erasedAt })
          .from(members)
          .where(eq(members.memberId, memberInA))
          .limit(1),
      );
      expect(after).toHaveLength(1);
      expect(after[0]?.erasedAt).toBeNull();
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  }, 30_000);
});
