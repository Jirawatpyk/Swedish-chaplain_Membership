/**
 * 059 / PR-A Task 5 — verifies migration 0248 (`members_branch_pairing_ck`
 * tightened to require `is_vat_registered = true` on the branch leg) applied
 * correctly against live Neon. Run AFTER `pnpm db:migrate`.
 *
 * Before 0248, `(is_head_office = false, is_vat_registered = false,
 * branch_code = '00001')` passed every DB check and rendered NO §86/4
 * head-office/branch line at all (invoice-template.tsx gates the line on the
 * registrant flag) — a silent under-print. The rule lived only in the client
 * (`member-form/schema.ts`), so a direct SQL write or a future importer bug
 * could already store it. This proves the DB itself is now the backstop.
 *
 * Drives the CHECK via a raw `UPDATE ... SET` against a real seeded member —
 * bypassing the Application layer entirely (updateMember's own resulting-
 * state guard, see update-member-branch-registrant.test.ts) — so the
 * assertion is specifically about the DATABASE constraint, not app-layer
 * validation. `members.tenant_id/plan_id/plan_year` carries an enforced FK
 * to `membership_plans`, so a real plan (and its `created_by` user) is
 * seeded first; a raw INSERT with a throwaway plan_id would fail on the FK
 * before ever reaching the CHECK under test.
 *
 * Runs against the live Neon Singapore DB via tests/integration-setup.ts.
 * The module-level `db` singleton connects as the Neon owner role
 * (rolbypassrls = TRUE) — direct writes to the seeded row succeed without a
 * runInTenant wrapper.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_ID = 'test-branch-ck-plan';

describe('migration 0248 — members_branch_pairing_ck now requires is_vat_registered on a branch', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: PLAN_ID,
        planYear: 2026,
        planName: { en: 'Branch CK Test Plan' },
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

      memberId = randomUUID();
      // Head office / not-a-registrant — a CHECK-consistent starting row.
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Branch CK Test Co',
        country: 'TH',
        isHeadOffice: true,
        branchCode: null,
        isVatRegistered: false,
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
      });
    });
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('DB backstop: UPDATE to (is_head_office=false, is_vat_registered=false, branch_code=00001) is REJECTED', async () => {
    await expect(
      db.execute(sql`
        UPDATE members
        SET is_head_office = false, is_vat_registered = false, branch_code = '00001'
        WHERE member_id = ${memberId}
      `),
    ).rejects.toThrow();

    // The forbidden write must never have landed — the row is unchanged.
    const rows = await db.execute(sql`
      SELECT is_head_office, is_vat_registered, branch_code
      FROM members WHERE member_id = ${memberId}
    `);
    const r = rows[0] as {
      is_head_office: boolean;
      is_vat_registered: boolean;
      branch_code: string | null;
    };
    expect(r.is_head_office).toBe(true);
    expect(r.is_vat_registered).toBe(false);
    expect(r.branch_code).toBeNull();
  });

  it('positive control: UPDATE to (is_head_office=false, is_vat_registered=TRUE, branch_code=00001) is ACCEPTED', async () => {
    // Proves the CHECK isn't rejecting every branch row — a VAT-registrant
    // branch is a legal combination the DB must still allow.
    await db.execute(sql`
      UPDATE members
      SET is_head_office = false, is_vat_registered = true, branch_code = '00001'
      WHERE member_id = ${memberId}
    `);
    const rows = await db.execute(sql`
      SELECT is_head_office, is_vat_registered, branch_code
      FROM members WHERE member_id = ${memberId}
    `);
    const r = rows[0] as {
      is_head_office: boolean;
      is_vat_registered: boolean;
      branch_code: string | null;
    };
    expect(r.is_head_office).toBe(false);
    expect(r.is_vat_registered).toBe(true);
    expect(r.branch_code).toBe('00001');

    // Reset to a CHECK-consistent head-office row so the NEXT test (and any
    // re-run) starts from a known-good state.
    await db.execute(sql`
      UPDATE members
      SET is_head_office = true, is_vat_registered = false, branch_code = NULL
      WHERE member_id = ${memberId}
    `);
  });

  it('members_branch_pairing_ck CHECK constraint exists with the tightened predicate', async () => {
    const rows = await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'members'::regclass
        AND conname = 'members_branch_pairing_ck'
    `);
    expect(rows).toHaveLength(1);
    const def = (rows[0] as { def: string }).def;
    expect(def).toContain('is_vat_registered');
  });
});
