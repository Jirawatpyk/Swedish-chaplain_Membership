/**
 * COMP-1 US2d (Task 4) — Integration e2e: the reconciliation sweep completes a
 * PARTIAL member erasure, and is tenant-isolated. Live Neon Singapore.
 *
 * GDPR Art.17 / PDPA §33 member erasure is two-phase: a durable atomic scrub tx
 * (which sets `members.erased_at`) followed by best-effort POST-COMMIT cascades
 * (F1 login erasure, F7 broadcast cancel/content-scrub, F8 renewal cancel, F6
 * event-registration erasure). `member_erased` is the completion proof — emitted
 * ONLY when every cascade reports clean. If a cascade fails after the scrub
 * committed, the member is "stuck": `erased_at` is set but `member_erased` never
 * landed. The reconciler (`POST /api/cron/members/reconcile-erasures`, US2d
 * Task 3) finds those stuck members (`findStuckErasuresInTx`, US2d Task 2) and
 * re-drives the idempotent `eraseMember` — re-attempting only the incomplete
 * cascades and emitting `member_erased` when they finally clear.
 *
 * How we FORCE a stuck erasure (no mocks of the use-case): we run the REAL
 * `eraseMember` with the PRODUCTION deps bag (`buildEraseMemberDeps(ctx)`) but
 * override ONLY the post-commit `eventRegistrationErasure` cascade with a stub
 * returning `{ outcome: 'failed' }`. The atomic scrub still commits (`erased_at`
 * set, member + contacts scrubbed, durable `member_erasure_requested` emitted),
 * but `allCascadesClean=false` → `member_erased` is withheld → the member is
 * stuck. The seeded member has NO in-flight broadcasts / renewal cycles / event
 * registrations and no linked login, so EVERY other real cascade is a clean
 * no-op — meaning a re-drive with the UNMODIFIED `buildEraseMemberDeps(ctx)`
 * (where the real F6 adapter returns `{ outcome: 'ok', erasedCount: 0 }` for a
 * member with zero registrations) completes cleanly and emits `member_erased`.
 *
 * Test 1 drives the reconciler by POSTing the REAL Task-3 route (Bearer
 * `CRON_SECRET` + an `X-Tenant` header so `resolveTenantFromRequest` routes to
 * the throwaway test tenant under `E2E_X_TENANT_HEADER_ENABLED=1`) — proving the
 * WHOLE route, including the `reconciled` summary count + the metric path. Test 2
 * (the MANDATORY Principle-I cross-tenant isolation test, a Review-Gate blocker)
 * runs the tenant-A reconciler and proves a tenant-B stuck member is UNTOUCHED.
 *
 * Reuses the live-Neon harness shared by the sibling erase tests (tenant +
 * fee/plan seed + `nextSeedMemberNumber` + BYPASSRLS raw selects). The route +
 * the production builder + the real reconciler query are the point — no mocks of
 * the use-case, the route, or the query.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
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
import { POST as reconcileRoute } from '@/app/api/cron/members/reconcile-erasures/route';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import {
  createTestTenant,
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const PLAN_ID = 'test-reconcile-erasure-plan';

// ---- Seed helpers ----------------------------------------------------------

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
      planName: { en: 'Reconcile Erasure Plan' },
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

/** Seed a live member with NO contacts / no in-flight F6/F7/F8 state. */
async function seedMember(tenant: TestTenant): Promise<MemberId> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `ReconcileCo ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
  });
  return asMemberId(memberId);
}

/**
 * Force a STUCK erasure: run the REAL `eraseMember` with the production deps
 * bag, but override ONLY the post-commit `eventRegistrationErasure` cascade to
 * report `{ outcome: 'failed' }`. The atomic scrub commits (`erased_at` set),
 * but `member_erased` is withheld (allCascadesClean=false). Asserts the run
 * returned `cascadesComplete === false` so the partial state is real.
 */
async function seedPartialErasure(
  tenant: TestTenant,
  admin: TestUser,
): Promise<{ memberId: MemberId }> {
  const memberId = await seedMember(tenant);

  const failingEventErasure: EraseMemberDeps['eventRegistrationErasure'] = {
    // Stand-in for a genuinely-failing F6 fan-out (returns the discriminated
    // 'failed' arm). erase-member flips allCascadesClean=false → withholds
    // member_erased → the member is stuck.
    async eraseAllForMember() {
      return { outcome: 'failed' };
    },
  };
  const deps: EraseMemberDeps = {
    ...buildEraseMemberDeps(tenant.ctx),
    eventRegistrationErasure: failingEventErasure,
  };

  const result = await eraseMember(
    memberId,
    { reason: 'gdpr_erasure_request' },
    { actorUserId: admin.userId, requestId: `rq-partial-${randomUUID()}` },
    deps,
  );
  // The scrub committed but a cascade failed → cascadesComplete must be false.
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) {
    expect(result.value.cascadesComplete).toBe(false);
  }
  return { memberId };
}

/**
 * Drive the reconciler ONCE by POSTing the REAL Task-3 route. Bearer
 * `CRON_SECRET` (from `.env.local`) + an `X-Tenant` header so the route's
 * `resolveTenantFromRequest` routes to the throwaway tenant
 * (`E2E_X_TENANT_HEADER_ENABLED=1`, set in `.env.local`). Returns the parsed
 * summary so the caller can assert `reconciled` / `still_pending` / `error`.
 */
async function driveReconcileOnce(
  tenant: TestTenant,
): Promise<{ processed: number; reconciled: number; still_pending: number; error: number }> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) throw new Error('CRON_SECRET must be set in .env.local for this test');

  const req = new NextRequest(
    'http://localhost/api/cron/members/reconcile-erasures',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cronSecret}`,
        'x-tenant': tenant.ctx.slug,
      },
    },
  );
  const res = await reconcileRoute(req);
  const body = (await res.json()) as {
    processed?: number;
    reconciled?: number;
    still_pending?: number;
    error?: number;
    skipped?: boolean;
    reason?: string;
  };
  // Guard against a silent kill-switch / auth misconfig giving a false GREEN.
  expect(body.skipped, JSON.stringify(body)).not.toBe(true);
  expect([200, 500]).toContain(res.status);
  return {
    processed: body.processed ?? 0,
    reconciled: body.reconciled ?? 0,
    still_pending: body.still_pending ?? 0,
    error: body.error ?? 0,
  };
}

/** BYPASSRLS raw select of the `member_erased` audit event_types for a member. */
async function rawSelectMemberErasedAudits(
  tenantSlug: string,
  memberId: MemberId,
): Promise<string[]> {
  const rows = await db
    .select({ eventType: auditLog.eventType, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantSlug),
        eq(auditLog.eventType, 'member_erased'),
      ),
    );
  return rows
    .filter(
      (r) =>
        (r.payload as { member_id?: string } | null)?.member_id ===
        (memberId as string),
    )
    .map((r) => String(r.eventType));
}

// ---- Test 1: reconciler completes a partial erasure ------------------------

describe('reconcile-erasures — completes a partial member erasure (COMP-1 US2d, live Neon, real route)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    // The production builder wires the REAL F8 cascade (makeRenewalsDeps) — seed
    // the renewal policies/settings fixture so that composition root is
    // well-formed even though this member has no in-flight cycle.
    await seedRenewalPolicies(tenant.ctx);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('reconciler completes a partial erasure (member_erased emitted, then no longer stuck, no double)', async () => {
    const { memberId } = await seedPartialErasure(tenant, admin);

    // Pre-condition: the member IS stuck (erased_at set, no member_erased).
    const before = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.ctx.slug, 50),
    );
    expect(before.map((r) => r.memberId)).toContain(memberId);
    // And no member_erased exists yet.
    expect(await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId)).toHaveLength(0);

    // Drive the reconciler once — the REAL route, REAL deps → the F6 cascade now
    // returns ok (zero registrations) → member_erased emitted → reconciled.
    const summary = await driveReconcileOnce(tenant);
    expect(summary.reconciled).toBe(1);
    expect(summary.error).toBe(0);

    // member_erased now exists — exactly ONE for this member.
    const audits = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(audits.filter((t) => t === 'member_erased')).toHaveLength(1);

    // The member is no longer stuck (complete).
    const after = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.findStuckErasuresInTx(tx, tenant.ctx.slug, 50),
    );
    expect(after.map((r) => r.memberId)).not.toContain(memberId);

    // Idempotent second tick: the now-complete member is no longer stuck → not
    // re-driven → STILL exactly one member_erased (no double).
    const summary2 = await driveReconcileOnce(tenant);
    // This member contributed 0 to the second tick (it isn't enumerated).
    expect(summary2.reconciled).toBe(0);
    const audits2 = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(audits2.filter((t) => t === 'member_erased')).toHaveLength(1);
  }, 120_000);
});

// ---- Test 2: MANDATORY cross-tenant isolation (Principle I) -----------------

describe('reconcile-erasures — cross-tenant isolation (Principle I Review-Gate blocker, COMP-1 US2d)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
    // A stuck member is seeded in tenant B; its plan + renewal config must
    // exist in B for the FK + the production F8 cascade composition root.
    await seedPlan(tenantB, admin.userId);
    await seedRenewalPolicies(tenantB.ctx);
    // Tenant A needs renewal config too — the reconciler builds
    // `buildEraseMemberDeps(tenantA)` (real F8 cascade) when it runs for A.
    await seedRenewalPolicies(tenantA.ctx);
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('a tenant-A reconciler run NEVER touches a tenant-B stuck member', async () => {
    // Seed the stuck erasure in tenant B.
    const { memberId: bMemberId } = await seedPartialErasure(tenantB, admin);

    // Sanity: tenant B's member IS stuck under tenant B's context.
    const bStuckBefore = await runInTenant(tenantB.ctx, (tx) =>
      drizzleMemberRepo.findStuckErasuresInTx(tx, tenantB.ctx.slug, 50),
    );
    expect(bStuckBefore.map((r) => r.memberId)).toContain(bMemberId);
    // And no member_erased for B's member yet.
    expect(
      await rawSelectMemberErasedAudits(tenantB.ctx.slug, bMemberId),
    ).toHaveLength(0);

    // Drive the reconciler for TENANT A (X-Tenant routes to A; A has no stuck
    // members). `members` strict-RLS + the audit subqueries' explicit tenant
    // filter mean A's run cannot enumerate or erase B's member.
    const summaryA = await driveReconcileOnce(tenantA);
    expect(summaryA.processed).toBe(0); // A enumerated zero stuck members.
    expect(summaryA.reconciled).toBe(0);
    expect(summaryA.error).toBe(0);

    // FIRM Principle-I assertion: tenant B's stuck member is UNTOUCHED —
    // still stuck under B's context, and NO member_erased was emitted for it.
    const bStuckAfter = await runInTenant(tenantB.ctx, (tx) =>
      drizzleMemberRepo.findStuckErasuresInTx(tx, tenantB.ctx.slug, 50),
    );
    expect(bStuckAfter.map((r) => r.memberId)).toContain(bMemberId);
    expect(
      await rawSelectMemberErasedAudits(tenantB.ctx.slug, bMemberId),
    ).toHaveLength(0);

    // Belt-and-suspenders: driving the reconciler for tenant B DOES complete it
    // (proving B's member was genuinely re-drivable — the A run skipped it by
    // isolation, NOT because it was un-reconcilable).
    const summaryB = await driveReconcileOnce(tenantB);
    expect(summaryB.reconciled).toBe(1);
    expect(
      (await rawSelectMemberErasedAudits(tenantB.ctx.slug, bMemberId)).filter(
        (t) => t === 'member_erased',
      ),
    ).toHaveLength(1);
  }, 120_000);
});
