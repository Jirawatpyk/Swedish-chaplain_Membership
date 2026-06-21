/**
 * COMP-1 US2d (Task 2) — Integration: `MemberRepo.findStuckErasuresInTx`,
 * the reconciler candidate query. Live Neon Singapore, throwaway tenant.
 *
 * The reconciler (US2d Task 3) re-drives members whose erasure COMMITTED
 * (`members.erased_at` set) but whose `member_erased` completion audit never
 * landed (a post-commit F1/F6/F7/F8 cascade failed AFTER the durable scrub tx
 * committed). This query finds those stuck members. It must:
 *   - return an erased member that LACKS a `member_erased` audit (stuck);
 *   - NOT return an erased member that HAS a `member_erased` audit (complete);
 *   - NOT return a non-erased (live) member;
 *   - surface the erasure `reason` from the member's `member_erasure_requested`
 *     audit (so the reconciler re-drives with the original Art.17/PDPA reason).
 *
 * #1 CORRECTNESS GUARD (the US2b `recipient_member_id` class): the audit rows
 * below are seeded in the EXACT production shape the real `eraseMember` emit
 * writes — `payload: { member_id: <uuid>, reason }` (snake_case `member_id`),
 * `event_type` the `member_erasure_requested` / `member_erased` enum value,
 * `tenant_id` the slug — mirroring `audit.recordInTx` in
 * `erase-member.ts` (the `member_erasure_requested` emit at the durable-request
 * step + the `member_erased` completion emit). A wrong payload key here OR in
 * the SQL would make the query 0-match in production while the test false-
 * greens; seeding the real shape is what makes a key drift fail loudly.
 *
 * Reuses the live-Neon harness shared by the other erasure tests (tenant +
 * fee/plan seed + `nextSeedMemberNumber`). No mocks — the production query is
 * the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_ID = 'test-stuck-erasure-plan';

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
      planName: { en: 'Stuck Erasure Plan' },
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

/** Seed a member row; `erasedAt` null = live, non-null = erased. */
async function seedMember(
  tenant: TestTenant,
  opts: { erasedAt: Date | null },
): Promise<MemberId> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `StuckCo ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
      erasedAt: opts.erasedAt,
    });
  });
  return asMemberId(memberId);
}

/**
 * Insert an audit row in the EXACT production shape `audit.recordInTx` writes
 * for the erasure events (see `erase-member.ts`): snake_case `member_id` +
 * `reason` payload, the erasure enum `event_type`, tenant-slug `tenant_id`.
 */
async function seedErasureAudit(
  tenant: TestTenant,
  admin: TestUser,
  args: {
    eventType: 'member_erasure_requested' | 'member_erased';
    memberId: MemberId;
    reason: 'gdpr_erasure_request' | 'pdpa_deletion_request';
    // Optional explicit audit timestamp. Omitted ⇒ the DB `defaultNow()`. Set
    // it to deterministically order two `member_erasure_requested` rows (the
    // EARLIEST one wins the re-drive reason — FIX #8) without a flaky sleep.
    timestamp?: Date;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    eventType: args.eventType,
    actorUserId: admin.userId,
    summary: `${args.eventType} ${args.memberId}`,
    requestId: `stuck-${randomUUID()}`,
    tenantId: tenant.ctx.slug,
    payload: { member_id: args.memberId as string, reason: args.reason },
    ...(args.timestamp ? { timestamp: args.timestamp } : {}),
  });
}

describe('MemberRepo.findStuckErasuresInTx — live Neon reconciler candidate query', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  // (a) erased + member_erased audit present → COMPLETE → must NOT be returned.
  let complete: MemberId;
  // (b) erased + member_erasure_requested (pdpa) but NO member_erased → STUCK.
  let stuck: MemberId;
  // (c) live member → must NOT be returned.
  let live: MemberId;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);

    const erasedAt = new Date();

    complete = await seedMember(tenant, { erasedAt });
    await seedErasureAudit(tenant, admin, {
      eventType: 'member_erasure_requested',
      memberId: complete,
      reason: 'gdpr_erasure_request',
    });
    await seedErasureAudit(tenant, admin, {
      eventType: 'member_erased',
      memberId: complete,
      reason: 'gdpr_erasure_request',
    });

    stuck = await seedMember(tenant, { erasedAt });
    await seedErasureAudit(tenant, admin, {
      eventType: 'member_erasure_requested',
      memberId: stuck,
      reason: 'pdpa_deletion_request',
    });
    // deliberately NO member_erased audit for `stuck`.

    live = await seedMember(tenant, { erasedAt: null });
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('returns only the stuck member, with its erasure reason', async () => {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.ctx.slug, 50),
    );

    const ids = rows.map((r) => r.memberId);
    expect(ids).toContain(stuck);
    expect(ids).not.toContain(complete);
    expect(ids).not.toContain(live);
    expect(rows.find((r) => r.memberId === stuck)?.reason).toBe(
      'pdpa_deletion_request',
    );
  }, 30_000);

  // COMP-1 review FIX #8 — under the documented concurrent-double-request edge
  // (two `member_erasure_requested` rows with different reasons), the reconciler
  // must re-drive with the EARLIEST reason — matching the insights DPO evidence
  // fold (erasure-evidence.ts `earliest()`) and the Art.12-clock invariant
  // (erase-member.ts: "the earliest timestamp wins"). Otherwise the
  // reconciler-emitted member_erased/cascade audits would carry a DIFFERENT
  // legal basis than the DPO page shows.
  it('resolves the EARLIEST member_erasure_requested reason on a double-request', async () => {
    const doubled = await seedMember(tenant, { erasedAt: new Date() });
    // EARLIEST request (pdpa) — the authoritative legal basis.
    await seedErasureAudit(tenant, admin, {
      eventType: 'member_erasure_requested',
      memberId: doubled,
      reason: 'pdpa_deletion_request',
      timestamp: new Date('2026-06-10T00:00:00.000Z'),
    });
    // LATER, conflicting request (gdpr) — must NOT win.
    await seedErasureAudit(tenant, admin, {
      eventType: 'member_erasure_requested',
      memberId: doubled,
      reason: 'gdpr_erasure_request',
      timestamp: new Date('2026-06-18T00:00:00.000Z'),
    });
    // deliberately NO member_erased audit for `doubled` (stuck).

    const rows = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.ctx.slug, 50),
    );

    expect(rows.find((r) => r.memberId === doubled)?.reason).toBe(
      'pdpa_deletion_request',
    );
  }, 30_000);
});
