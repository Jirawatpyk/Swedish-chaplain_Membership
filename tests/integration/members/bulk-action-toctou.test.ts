/**
 * Staff-review SB-1 regression test — TOCTOU row lock in bulkAction.
 *
 * Verifies that the batched `findManyByIdsInTx(... FOR UPDATE)` path
 * acquires a proper row-level lock so two concurrent bulk actions
 * targeting the same member serialize correctly:
 *
 *   • The first tx commits its archive + audit row.
 *   • The second tx, blocked at the SELECT FOR UPDATE, proceeds AFTER
 *     the first commits, observes the new status ('archived'), and
 *     its domain `archive()` returns `state_error` → entire 2nd tx
 *     rolls back.
 *   • Final DB state: 1 member_archived audit row, member.status =
 *     'archived'. No lost-update, no false old_status in any audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { bulkAction } from '@/modules/members/application/use-cases/bulk-action';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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

describe('bulk-action TOCTOU row lock (staff-review SB-1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-plan-toctou';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
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
        planId,
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: '' },
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
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  async function seedActiveMember() {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: `TOCTOU ${Date.now()}`,
        country: 'TH',
        planId,
        planYear: 2026,
        registrationDate: new Date().toISOString().slice(0, 10),
        registrationFeePaid: false,
        status: 'active',
        archivedAt: null,
      }),
    );
    return memberId;
  }

  it('concurrent bulk archive on same member → 2nd sees committed state, returns state_error', async () => {
    const memberId = await seedActiveMember();

    const full = buildMembersDeps(tenant.ctx);
    const deps = {
      tenant: full.tenant,
      memberRepo: full.memberRepo,
      audit: full.audit,
      clock: full.clock,
      plans: full.plans,
    };

    // Kick off BOTH bulk archive actions simultaneously. The batched
    // SELECT ... FOR UPDATE lock ensures they serialize; the second
    // must wait for the first to COMMIT before its lookup returns.
    const [first, second] = await Promise.all([
      bulkAction(
        { action: 'archive', member_ids: [memberId] },
        { actorUserId: user.userId, requestId: 'req-first' },
        deps,
      ),
      bulkAction(
        { action: 'archive', member_ids: [memberId] },
        { actorUserId: user.userId, requestId: 'req-second' },
        deps,
      ),
    ]);

    // Exactly one must succeed (archive active → archived).
    const okCount = [first, second].filter((r) => r.ok).length;
    const stateErrCount = [first, second].filter(
      (r) => !r.ok && r.error.type === 'state_error',
    ).length;

    expect(okCount).toBe(1);
    expect(stateErrCount).toBe(1);

    // DB verification: exactly one audit row, member.status = 'archived'.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    expect(rows[0]?.status).toBe('archived');
    expect(rows[0]?.archivedAt).not.toBeNull();

    // Count member_archived audit events for this member_id.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    const archivedEvents = auditRows.filter(
      (r) =>
        r.eventType === 'member_archived' &&
        (r.payload as { member_id?: string } | null)?.member_id === memberId,
    );
    // Staff-review SB-1 assertion: under the old (findById-in-separate-tx)
    // code path, two audit rows could be written (both tx read stale
    // 'active' status, both wrote successfully). With the new batched
    // FOR UPDATE path, exactly ONE audit row lands.
    expect(archivedEvents.length).toBe(1);
  }, 45_000);

  it('concurrent bulk archive on DIFFERENT members both succeed in parallel', async () => {
    // Sanity check: the row lock is per-row, not per-table.
    const memberA = await seedActiveMember();
    const memberB = await seedActiveMember();

    const full = buildMembersDeps(tenant.ctx);
    const deps = {
      tenant: full.tenant,
      memberRepo: full.memberRepo,
      audit: full.audit,
      clock: full.clock,
      plans: full.plans,
    };

    const [first, second] = await Promise.all([
      bulkAction(
        { action: 'archive', member_ids: [memberA] },
        { actorUserId: user.userId, requestId: 'req-parallel-a' },
        deps,
      ),
      bulkAction(
        { action: 'archive', member_ids: [memberB] },
        { actorUserId: user.userId, requestId: 'req-parallel-b' },
        deps,
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.tenantId, tenant.ctx.slug)),
    );
    const archivedIds = rows
      .filter((r) => r.status === 'archived')
      .map((r) => r.memberId);
    expect(archivedIds).toContain(memberA);
    expect(archivedIds).toContain(memberB);
  }, 45_000);
});
