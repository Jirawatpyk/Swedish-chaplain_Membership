/**
 * Spec 140 slice 3, DT6 — Integration: `MemberRepo.findStuckErasuresInTx`
 * rotates its queue by the latest `subprocessor_erasure_propagated` attempt.
 * Live Neon dev, throwaway tenants.
 *
 * The reconciler route passes a fixed limit per tick. Ordered by `erased_at`
 * alone, the same oldest heads come back every tick, and a stuck member past
 * the limit is never re-driven. The key is now the member's latest
 * propagation marker (falling back to `erased_at` when it has none), so a
 * head that was just attempted moves behind one whose attempt is older or
 * absent.
 *
 * Every marker comes from the REAL emit path: `eraseMember` with the
 * production deps bag, only the F6 cascade stubbed to `failed` so
 * `member_erased` is withheld and the member stays stuck. Each call commits a
 * scrub tx and writes `subprocessor_erasure_propagated` with the DB's own
 * `timestamp` default; a second call on the same member is a re-drive and
 * writes a newer marker. No audit row in this file is hand-inserted, so a
 * drift in the emit's payload key (`member_id`) cannot pass.
 *
 * Sequence, with limit 3:
 *   1. erase M1, M2, M3 (oldest `erased_at`);
 *   2. erase X (later `erased_at`, one marker);
 *   3. seed Y erased with no marker, `erased_at` just after X's marker;
 *   4. re-drive M1, M2, M3 (markers newer than X's and Y's keys).
 * Ordered by `erased_at`, the batch is M1..M3 and X, Y starve. Rotated, the
 * batch is X, Y, M1.
 *
 * Cross-tenant (Principle I): tenant B holds a member whose `member_id`
 * equals X's (the members PK is `(tenant_id, member_id)`), erased after A's
 * re-drives, so B's marker is the newest row for that id. The integration
 * role has BYPASSRLS and `audit_log`'s policy is permissive, so only the
 * subquery's explicit tenant filter keeps B's row out of A's sort.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import {
  eraseMember,
  type EraseMemberDeps,
} from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const PLAN_ID = 'test-stuck-erasure-rotation-plan';
const LIMIT = 3;

async function seedPlan(tenant: TestTenant, userId: string): Promise<void> {
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
      planName: { en: 'Stuck Erasure Rotation Plan' },
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

/** Seed a member with no contacts and no in-flight F6/F7/F8 state. */
async function seedMember(
  tenant: TestTenant,
  opts: { memberId?: string; erasedAt?: Date } = {},
): Promise<MemberId> {
  const memberId = opts.memberId ?? randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `RotationCo ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
      ...(opts.erasedAt !== undefined ? { erasedAt: opts.erasedAt } : {}),
    });
  });
  return asMemberId(memberId);
}

/**
 * Run the REAL `eraseMember` with the production deps, only F6 failing: the
 * scrub commits and writes `subprocessor_erasure_propagated`, `member_erased`
 * is withheld, so the member is (still) stuck. A first call erases; a later
 * call on the same member is a re-drive.
 */
async function eraseStuck(
  tenant: TestTenant,
  admin: TestUser,
  memberId: MemberId,
): Promise<void> {
  const deps: EraseMemberDeps = {
    ...buildEraseMemberDeps(tenant.ctx),
    eventRegistrationErasure: {
      async eraseAllForMember() {
        return { outcome: 'failed' };
      },
    },
  };
  const result = await eraseMember(
    memberId,
    { reason: 'gdpr_erasure_request' },
    { actorUserId: admin.userId, requestId: `rq-rotation-${randomUUID()}` },
    deps,
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) expect(result.value.cascadesComplete).toBe(false);
}

/** BYPASSRLS read of a member's propagation markers in one tenant, newest first. */
async function markerTimestamps(
  tenantSlug: string,
  memberId: MemberId,
): Promise<Date[]> {
  const rows = await db
    .select({ timestamp: auditLog.timestamp })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantSlug),
        eq(auditLog.eventType, 'subprocessor_erasure_propagated'),
        sql`${auditLog.payload}->>'member_id' = ${memberId as string}`,
      ),
    )
    .orderBy(sql`${auditLog.timestamp} DESC`);
  return rows.map((r) => r.timestamp);
}

async function findStuck(tenant: TestTenant): Promise<MemberId[]> {
  const rows = await runInTenant(tenant.ctx, (tx) =>
    drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.ctx.slug, LIMIT),
  );
  return rows.map((r) => r.memberId);
}

describe('MemberRepo.findStuckErasuresInTx — rotation by the latest propagation attempt (140 DT6)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const heads: MemberId[] = [];
  let older: MemberId;
  let absent: MemberId;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    await seedPlan(tenantA, admin.userId);
    await seedPlan(tenantB, admin.userId);
    // buildEraseMemberDeps wires the real F8 cascade, which needs the renewal
    // config in each tenant even for a member with no cycle.
    await seedRenewalPolicies(tenantA.ctx);
    await seedRenewalPolicies(tenantB.ctx);
  });

  // Steps 1 and 2: three heads, then the member with the older attempt.
  beforeAll(async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      const id = await seedMember(tenantA);
      await eraseStuck(tenantA, admin, id);
      heads.push(id);
    }
    older = await seedMember(tenantA);
    await eraseStuck(tenantA, admin, older);
  });

  // Steps 3 and 4: the member with no attempt, then the heads' re-drives.
  beforeAll(async () => {
    const olderMarker = (await markerTimestamps(tenantA.ctx.slug, older))[0];
    if (olderMarker === undefined) throw new Error('no propagation marker for the older member');
    absent = await seedMember(tenantA, {
      erasedAt: new Date(olderMarker.getTime() + 1),
    });
    for (const id of heads) await eraseStuck(tenantA, admin, id);
  });

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
    if (admin) await deleteTestUser(admin).catch(() => {});
  });

  it('a full batch of recently attempted heads does not starve the older and the absent attempt', async () => {
    // Preconditions: each head carries two markers (the erase and the
    // re-drive), the older member one, the absent member none.
    for (const id of heads) {
      expect(await markerTimestamps(tenantA.ctx.slug, id)).toHaveLength(2);
    }
    expect(await markerTimestamps(tenantA.ctx.slug, older)).toHaveLength(1);
    expect(await markerTimestamps(tenantA.ctx.slug, absent)).toHaveLength(0);

    const batch = await findStuck(tenantA);
    expect(batch).toEqual([older, absent, heads[0]]);
  });

  it("tenant B's propagation rows for the same member_id do not change tenant A's order", async () => {
    // Tenant B: a member with X's member_id, erased now, so its marker is
    // the newest `subprocessor_erasure_propagated` row for that id anywhere.
    const twin = await seedMember(tenantB, { memberId: older as string });
    await eraseStuck(tenantB, admin, twin);
    const [twinMarker] = await markerTimestamps(tenantB.ctx.slug, twin);
    const [lastHeadMarker] = await markerTimestamps(tenantA.ctx.slug, heads[LIMIT - 1]!);
    expect(twinMarker!.getTime()).toBeGreaterThan(lastHeadMarker!.getTime());

    expect(await findStuck(tenantA)).toEqual([older, absent, heads[0]]);
    // Tenant B sees only its own member.
    expect(await findStuck(tenantB)).toEqual([twin]);
  });
});
