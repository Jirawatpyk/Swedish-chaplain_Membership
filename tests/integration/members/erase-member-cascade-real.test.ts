/**
 * COMP-1 US1 (Member Erasure) — M3 coverage-gap closure: end-to-end
 * `eraseMember` over the REAL F7/F8 CANCELLATION path against live Neon.
 *
 * The existing `eraseMember` integration tests either inject the no-op
 * cascade adapters (`erase-member-cascade.test.ts`) or drive the REAL
 * `buildEraseMemberDeps` on a member with NO in-flight broadcasts/renewals
 * (`erase-member.test.ts`) — for which the real cascades return
 * `outcome: 'ok'` with zero counts WITHOUT actually cancelling anything.
 * So the genuine cascade cancellation (F7 broadcast + F8 renewal cycle →
 * `cancelled` with `cancellationReason: 'gdpr_erasure_request'`) and the
 * `toF8Reason()`/F7 reason passthrough mapping were never exercised: a
 * broken mapping or a cascade-adapter regression would pass every test.
 *
 * This test seeds a member that GENUINELY has both:
 *   - one IN-FLIGHT F7 broadcast (`status='submitted'`, owned via
 *     `requested_by_member_id`) — qualifies for the F7 cascade's
 *     `listInFlightOwnedByMember` filter (`status IN ('submitted',
 *     'approved')`); AND
 *   - one IN-FLIGHT F8 renewal cycle (`status='awaiting_payment'`,
 *     non-terminal) — qualifies for the F8 cascade's `findActiveForMember`
 *     filter (`status NOT IN ('lapsed','cancelled','completed')`).
 *
 * It then runs `eraseMember` with the PRODUCTION composition root
 * `buildEraseMemberDeps(ctx.tenant)` (the same builder the erase route
 * wires, with the REAL F7/F8 cascade adapters), and asserts via BYPASSRLS
 * raw selects that:
 *   - `result.ok` and `result.value.cascadesComplete === true` (both cascades
 *     reported clean → `member_erased` emitted);
 *   - the F7 broadcast row is now `cancelled` with `cancellation_reason =
 *     'gdpr_erasure_request'` and `cancelled_by_user_id = NULL`
 *     (system-initiated), proving the F7 reason passthrough;
 *   - the F8 renewal cycle row is now `cancelled` with `closed_reason =
 *     'cancelled'`, and the `renewal_cycle_cancelled` audit carries
 *     `payload.reason = 'gdpr_erasure_request'`, proving `toF8Reason()`
 *     maps the erasure reason correctly;
 *   - the `member_erased` (+ durable `member_erasure_requested`) audit
 *     rows exist;
 *   - the member + contact rows are scrubbed.
 *
 * A SECOND `eraseMember` call on the same (already-erased) member then
 * asserts the pre-flight already-erased guard (M2 fix) does NOT write a
 * second `member_erasure_requested` audit row, while still returning ok —
 * locked in against live Neon.
 *
 * Reuses the live-Neon harness shared by `erase-member.test.ts` (tenant +
 * fee/plan seed + BYPASSRLS raw select + `nextSeedMemberNumber`), the F7
 * broadcast seed shape from `broadcasts/immutable-after-submit.test.ts`,
 * and the F8 cycle seed shape from `renewals/f3-archival-cascade.test.ts`.
 * No mocks — the production builder + real cascades are the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
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
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erase-cascade-real-plan';

// In-flight F8 cycle period anchors — pin a future expires_at so the cycle
// is genuinely in-flight (not lapsed by clock at test time).
const PERIOD_FROM = new Date('2025-09-15T00:00:00.000Z');
const EXPIRES_AT = new Date('2030-09-15T00:00:00.000Z');

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
      planName: { en: 'Erase Cascade Real Plan' },
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

/**
 * Seed a member (rich PII) + one contact + one IN-FLIGHT F7 broadcast
 * (status='submitted', owned via requested_by_member_id) + one IN-FLIGHT
 * F8 renewal cycle (status='awaiting_payment', non-terminal). Each of the
 * two in-flight rows is what makes the REAL F7/F8 cascade actually CANCEL
 * something during erasure (vs returning ok-with-zero for a member with
 * none).
 */
async function seedMemberWithInFlightCascades(
  tenant: TestTenant,
  submittedByUserId: string,
): Promise<{
  memberId: string;
  contactId: string;
  broadcastId: string;
  cycleId: string;
}> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  const broadcastId = randomUUID();
  const cycleId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Cascade Real Co (Thailand) Ltd.',
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Erik',
      lastName: 'Eriksson',
      email: `erik-cascade-${randomUUID().slice(0, 8)}@example.com`,
      phone: '+66812345678',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: '1980-01-01',
      removedAt: null,
    });
    // IN-FLIGHT F7 broadcast — status='submitted' + owned via
    // requested_by_member_id so listInFlightOwnedByMember selects it.
    // (Seed shape mirrors broadcasts/immutable-after-submit.test.ts.)
    await tx.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: memberId,
      requestedByMemberPlanIdSnapshot: PLAN_ID,
      submittedByUserId,
      actorRole: 'member_self_service',
      subject: 'Cascade real in-flight broadcast',
      bodyHtml: '<p>in-flight</p>',
      bodySource: 'in-flight',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 100,
      status: 'submitted',
      submittedAt: new Date(),
    });
    // IN-FLIGHT F8 renewal cycle — status='awaiting_payment' (non-terminal)
    // so findActiveForMember selects it. (Seed shape mirrors
    // renewals/f3-archival-cascade.test.ts.)
    await tx.insert(renewalCycles).values({
      tenantId: tenant.ctx.slug,
      cycleId,
      memberId,
      status: 'awaiting_payment',
      periodFrom: PERIOD_FROM,
      periodTo: EXPIRES_AT,
      expiresAt: EXPIRES_AT,
      cycleLengthMonths: 12,
      tierAtCycleStart: 'regular',
      planIdAtCycleStart: PLAN_ID,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });
  return { memberId, contactId, broadcastId, cycleId };
}

/** All audit rows for this tenant of a given event type. */
async function rawSelectAuditsByType(tenantSlug: string, eventType: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  return rows.filter((r) => r.eventType === eventType);
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — live-Neon REAL F7/F8 cascade cancellation (production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    // F8 cascade builds deps via makeRenewalsDeps — seed the renewal
    // policies/settings fixture so that composition root is well-formed.
    await seedRenewalPolicies(tenant.ctx);
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(broadcasts)
      .where(eq(broadcasts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('cancels the in-flight F7 broadcast + F8 cycle with the erasure reason, scrubs PII, completes', async () => {
    const { memberId, contactId, broadcastId, cycleId } =
      await seedMemberWithInFlightCascades(tenant, admin.userId);

    // Sanity: both cascade targets are in-flight BEFORE erasure.
    const beforeBroadcast = await db
      .select({ status: broadcasts.status })
      .from(broadcasts)
      .where(eq(broadcasts.broadcastId, broadcastId));
    expect(beforeBroadcast[0]?.status).toBe('submitted');
    const beforeCycle = await db
      .select({ status: renewalCycles.status })
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId));
    expect(beforeCycle[0]?.status).toBe('awaiting_payment');

    // PRODUCTION composition root — REAL F7/F8 cascade adapters.
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-cascade-real-${Date.now()}` },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // Both real cascades cancelled their in-flight row + reported clean →
    // member_erased emitted → cascadesComplete true. (Against a broken
    // toF8Reason / cascade-adapter regression that returns a not-clean
    // outcome, cascadesComplete would be false.)
    expect(result.value.cascadesComplete).toBe(true);

    // --- F7 broadcast cancelled, attributable to the erasure ---
    const broadcastRows = await db
      .select({
        status: broadcasts.status,
        cancellationReason: broadcasts.cancellationReason,
        cancelledByUserId: broadcasts.cancelledByUserId,
        cancelledAt: broadcasts.cancelledAt,
      })
      .from(broadcasts)
      .where(eq(broadcasts.broadcastId, broadcastId));
    expect(broadcastRows).toHaveLength(1);
    expect(broadcastRows[0]!.status).toBe('cancelled');
    // F7 cascade threads the erasure reason straight through (no remap).
    expect(broadcastRows[0]!.cancellationReason).toBe('gdpr_erasure_request');
    // System-initiated — the member is the subject, not the actor.
    expect(broadcastRows[0]!.cancelledByUserId).toBeNull();
    expect(broadcastRows[0]!.cancelledAt).not.toBeNull();

    // The broadcast_cancelled audit carries the same reason + cascade tag.
    const broadcastCancelledAudits = await rawSelectAuditsByType(
      tenant.ctx.slug,
      'broadcast_cancelled',
    );
    const bcAudit = broadcastCancelledAudits.find((r) => {
      const p = r.payload as {
        broadcastId?: string;
        cancellationReason?: string;
        cascade?: string;
      } | null;
      return p?.broadcastId === broadcastId;
    });
    expect(
      bcAudit,
      'expected a broadcast_cancelled audit for the erased member broadcast',
    ).toBeDefined();
    {
      const p = bcAudit!.payload as {
        cancellationReason?: string;
        actorRole?: string;
        cascade?: string;
      };
      expect(p.cancellationReason).toBe('gdpr_erasure_request');
      expect(p.actorRole).toBe('system');
      expect(p.cascade).toBe('f3_member_archival_or_erasure');
    }

    // --- F8 renewal cycle cancelled, reason reflects the erasure mapping ---
    const cycleRows = await db
      .select({
        status: renewalCycles.status,
        closedReason: renewalCycles.closedReason,
        closedAt: renewalCycles.closedAt,
      })
      .from(renewalCycles)
      .where(eq(renewalCycles.cycleId, cycleId));
    expect(cycleRows).toHaveLength(1);
    expect(cycleRows[0]!.status).toBe('cancelled');
    expect(cycleRows[0]!.closedReason).toBe('cancelled');
    expect(cycleRows[0]!.closedAt).not.toBeNull();

    // The renewal_cycle_cancelled audit's payload.reason carries the
    // cascade discriminator — proves toF8Reason('gdpr_erasure_request')
    // maps the erasure reason through to the F8 cascade audit (NOT the
    // default 'originator_member_archived').
    const cycleCancelledAudits = await rawSelectAuditsByType(
      tenant.ctx.slug,
      'renewal_cycle_cancelled',
    );
    const cycleAudit = cycleCancelledAudits.find((r) => {
      const p = r.payload as { cycle_id?: string } | null;
      return p?.cycle_id === cycleId;
    });
    expect(
      cycleAudit,
      'expected a renewal_cycle_cancelled audit for the erased member cycle',
    ).toBeDefined();
    {
      const p = cycleAudit!.payload as {
        reason?: string;
        member_id?: string;
        previous_status?: string;
      };
      expect(p.reason).toBe('gdpr_erasure_request');
      expect(p.member_id).toBe(memberId);
      expect(p.previous_status).toBe('awaiting_payment');
    }
    expect(cycleAudit!.actorUserId).toBe(admin.userId);

    // --- member_erasure_requested + member_erased both present ---
    const requestedAudits = await rawSelectAuditsByType(
      tenant.ctx.slug,
      'member_erasure_requested',
    );
    const erasedAudits = await rawSelectAuditsByType(
      tenant.ctx.slug,
      'member_erased',
    );
    expect(
      requestedAudits.some(
        (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
      ),
    ).toBe(true);
    expect(
      erasedAudits.some(
        (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
      ),
    ).toBe(true);

    // --- member + contact scrubbed ---
    const memberRows = await db
      .select({
        companyName: members.companyName,
        taxId: members.taxId,
        erasedAt: members.erasedAt,
      })
      .from(members)
      .where(eq(members.memberId, memberId));
    expect(memberRows[0]?.companyName).toBe('[erased]');
    expect(memberRows[0]?.taxId).toBeNull();
    expect(memberRows[0]?.erasedAt).not.toBeNull();

    const contactRows = await db
      .select({
        firstName: contacts.firstName,
        email: contacts.email,
        removedAt: contacts.removedAt,
      })
      .from(contacts)
      .where(eq(contacts.contactId, contactId));
    expect(contactRows[0]?.firstName).toBe('[erased]');
    expect(contactRows[0]?.email).toMatch(/^erased\+.*@erased\.invalid$/);
    expect(contactRows[0]?.removedAt).not.toBeNull();
  }, 120_000);

  it('already-erased re-drive does NOT write a second member_erasure_requested audit (M2 guard), still ok', async () => {
    const { memberId } = await seedMemberWithInFlightCascades(
      tenant,
      admin.userId,
    );

    const deps = buildEraseMemberDeps(tenant.ctx);

    const first = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-redrive-1-${Date.now()}` },
      deps,
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);

    // Count member_erasure_requested rows for THIS member after the first
    // (first-time) call — must be exactly one (the durable Art.12 clock
    // start).
    const afterFirst = (
      await rawSelectAuditsByType(tenant.ctx.slug, 'member_erasure_requested')
    ).filter(
      (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
    );
    expect(afterFirst).toHaveLength(1);

    // Re-drive: a SECOND erase on the same (already-erased) member. The
    // pre-flight already-erased guard (erased_at set) skips the durable
    // requested-audit emit so the Art.12 one-month clock is not restarted
    // — while STILL returning ok (idempotent).
    const second = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-redrive-2-${Date.now()}` },
      deps,
    );
    expect(second.ok, JSON.stringify(second)).toBe(true);

    // Still exactly one member_erasure_requested row — the guard held.
    const afterSecond = (
      await rawSelectAuditsByType(tenant.ctx.slug, 'member_erasure_requested')
    ).filter(
      (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
    );
    expect(afterSecond).toHaveLength(1);
  }, 120_000);
});
