/**
 * Round 5 — race-fix integration test for `updateBroadcastsAcknowledgedAtInTx`.
 *
 * Round 4 replaced the read-then-write pattern with an atomic
 * `UPDATE … WHERE broadcasts_acknowledged_at IS NULL` so concurrent
 * acks no longer both observe `null` and both report `previouslyNull=true`
 * (which would emit duplicate `member_acknowledged_broadcasts_terms`
 * audits — corrupting the GDPR Art. 7 consent trail).
 *
 * This test PROVES the fix on live Neon by firing two concurrent
 * `markBroadcastsAcknowledged` calls against the same member via
 * `Promise.all`. Postgres MVCC + the `WHERE … IS NULL` predicate must
 * make exactly one caller see `previouslyNull=true` and the other
 * `previouslyNull=false`. Without the fix the test would flake under
 * concurrency (sometimes both true, sometimes one true).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { asMemberId } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 6,
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

const planId = 'test-ack-race-plan';

async function seedPlan(tenantSlug: string, userId: string) {
  await runInTenant({ slug: tenantSlug } as never, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenantSlug,
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
      tenantId: tenantSlug,
      planId,
      planYear: 2026,
      planName: { en: 'Ack Race Plan' },
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
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

async function seedFreshMember(tenant: TestTenant): Promise<string> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: `Ack Race Co ${Date.now()}`,
      country: 'TH',
      planId,
      planYear: 2026,
      registrationDate: new Date().toISOString().slice(0, 10),
      registrationFeePaid: false,
      status: 'active',
      archivedAt: null,
      // broadcastsAcknowledgedAt defaults to NULL — the canonical
      // unacked-banner-eligible state.
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Race',
      lastName: 'Tester',
      email: `race-${randomUUID().slice(0, 8)}@example.com`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: true,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
    });
  });
  return memberId;
}

describe('updateBroadcastsAcknowledgedAtInTx — concurrent ack race fix (Round 5)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    await seedPlan(tenant.ctx.slug, user.userId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('two concurrent calls — exactly one sees previouslyNull=true; the other sees previouslyNull=false', async () => {
    const memberId = await seedFreshMember(tenant);
    const branded = asMemberId(memberId);
    const t1 = new Date('2026-05-01T05:00:00Z');
    const t2 = new Date('2026-05-01T05:00:00.001Z');

    // Fire both calls in their own transactions so the atomic
    // UPDATE's WHERE-IS-NULL predicate can serialize properly.
    const [r1, r2] = await Promise.all([
      runInTenant(tenant.ctx, async (tx) =>
        drizzleMemberRepo.updateBroadcastsAcknowledgedAtInTx(tx, branded, t1),
      ),
      runInTenant(tenant.ctx, async (tx) =>
        drizzleMemberRepo.updateBroadcastsAcknowledgedAtInTx(tx, branded, t2),
      ),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // Exactly one fresh-ack signal — the second caller must observe
    // the column already populated and report previouslyNull=false.
    const previouslyNullValues = [
      r1.value.previouslyNull,
      r2.value.previouslyNull,
    ];
    const trueCount = previouslyNullValues.filter((v) => v === true).length;
    const falseCount = previouslyNullValues.filter((v) => v === false).length;
    expect(trueCount).toBe(1);
    expect(falseCount).toBe(1);

    // Both callers see affected=1 (the row exists either way).
    expect(r1.value.affected).toBe(1);
    expect(r2.value.affected).toBe(1);

    // GDPR Art. 7 — the persisted timestamp is whichever caller's
    // UPDATE matched the IS NULL predicate first. The OTHER caller's
    // timestamp MUST NOT have overwritten it (round 4 changed re-ack
    // to preserve the original consent anchor).
    const persisted = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ ackAt: members.broadcastsAcknowledgedAt })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1),
    );
    const ackAt = persisted[0]?.ackAt;
    expect(ackAt).toBeInstanceOf(Date);
    // Timestamp matches one of t1 / t2 — whichever won the race.
    const ackIso = (ackAt as Date).toISOString();
    expect([t1.toISOString(), t2.toISOString()]).toContain(ackIso);
  }, 20_000);

  it('member missing — returns affected=0, previouslyNull=false', async () => {
    const ghostId = asMemberId(randomUUID());
    const r = await runInTenant(tenant.ctx, async (tx) =>
      drizzleMemberRepo.updateBroadcastsAcknowledgedAtInTx(tx, ghostId, new Date()),
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.affected).toBe(0);
      expect(r.value.previouslyNull).toBe(false);
    }
  });

  it('idempotent re-ack — preserves the original consent timestamp (GDPR Art. 7)', async () => {
    const memberId = await seedFreshMember(tenant);
    const branded = asMemberId(memberId);
    const original = new Date('2026-05-01T05:00:00Z');

    // First ack — establishes the consent anchor.
    const r1 = await runInTenant(tenant.ctx, async (tx) =>
      drizzleMemberRepo.updateBroadcastsAcknowledgedAtInTx(tx, branded, original),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.previouslyNull).toBe(true);

    // Second ack with a different timestamp — MUST be idempotent + MUST
    // NOT overwrite. Round 4 explicitly removed the second-update
    // statement because GDPR Art. 7 demonstrable consent treats the
    // first acknowledgement as the legal anchor.
    const later = new Date('2026-06-01T10:00:00Z');
    const r2 = await runInTenant(tenant.ctx, async (tx) =>
      drizzleMemberRepo.updateBroadcastsAcknowledgedAtInTx(tx, branded, later),
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.affected).toBe(1);
      expect(r2.value.previouslyNull).toBe(false);
    }

    const persisted = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ ackAt: members.broadcastsAcknowledgedAt })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1),
    );
    expect((persisted[0]?.ackAt as Date).toISOString()).toBe(original.toISOString());
  });
});
