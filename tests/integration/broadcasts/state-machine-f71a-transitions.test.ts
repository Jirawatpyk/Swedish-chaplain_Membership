/**
 * H-1 — integration test for the `broadcasts_state_machine_fn` DB trigger
 * + the `broadcasts_quota_year_only_on_sent` CHECK, both updated for the
 * F7.1a US1 lifecycle states (`partially_sent`, `partial_delivery_accepted`).
 *
 * Migration 0064 defined the trigger for the 8-state F7-MVP machine and a
 * quota CHECK that only permits quota_year_consumed when status='sent'.
 * Migration 0169 added the two F7.1a enum VALUES but never updated the
 * trigger CASE or the CHECK — so every F7.1a UPDATE transition raised at
 * the DB layer the moment the flags flipped:
 *   - sending → partially_sent / sending → cancelled (batch cancel) →
 *     RAISE broadcast_invalid_state_transition (the `sending` arm only
 *     allowed sent/failed_to_dispatch)
 *   - partially_sent → partial_delivery_accepted / partially_sent →
 *     sending (retry) → CASE_NOT_FOUND (no `partially_sent` WHEN arm)
 *   - partial_delivery_accepted + quota_year_consumed → CHECK violation
 *     (the quota CHECK keyed quota to status='sent' only)
 *
 * The only F7.1a row in the existing suite is an INSERT
 * (pagination-cross-tenant-probe.test.ts), and the trigger is
 * BEFORE UPDATE OF status — so INSERT never fired it and the gap stayed
 * hidden (matches the CLAUDE.md F4-R8 "mocks/INSERT hide schema gaps"
 * gotcha). These tests seed each starting status via INSERT (no UPDATE
 * trigger) then issue raw UPDATE statements through Drizzle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const F7_MATRIX: BenefitMatrix = {
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

describe('H-1 — F7.1a state-machine trigger + quota CHECK (broadcasts)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let memberId: string;

  /** Seed one broadcast at a given starting status via INSERT (no trigger). */
  async function seedBroadcast(
    status:
      | 'draft'
      | 'approved'
      | 'sending'
      | 'partially_sent'
      | 'partial_delivery_accepted',
  ): Promise<string> {
    const broadcastId = randomUUID();
    const now = new Date();
    // partial_delivery_accepted is a quota-consuming terminal state — the
    // (now-widened) broadcasts_quota_year_only_on_sent CHECK REQUIRES the
    // quota columns on this status, so a seed without them would violate it.
    const quotaFields =
      status === 'partial_delivery_accepted'
        ? {
            quotaYearConsumed: 2026,
            quotaConsumedAt: now,
            partialDeliveryAcceptedAt: now,
            partialDeliveryAcceptedByUserId: user.userId,
          }
        : {};
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: `H1 ${status}`,
        bodyHtml: '<p>body</p>',
        bodySource: 'body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 100,
        status,
        submittedAt: now,
        approvedAt: now,
        sendingStartedAt: now,
        ...quotaFields,
      }),
    );
    return broadcastId;
  }

  async function expectStateMachineRaise(
    fn: () => Promise<unknown>,
  ): Promise<void> {
    let caught: unknown = null;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    if (caught === null) {
      throw new Error('Expected trigger to raise but UPDATE succeeded');
    }
    const chain = errorChainMessage(caught);
    if (!/broadcast_invalid_state_transition/.test(chain)) {
      throw new Error(`Expected invalid-transition raise but got: ${chain}`);
    }
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    planId = `h1-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'H1 Plan' },
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
        benefitMatrix: F7_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );

    memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'H1 Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  // ---- F7.1a transitions that MUST now succeed ----------------------

  it('sending → partially_sent succeeds (FR-008a)', async () => {
    const id = await seedBroadcast('sending');
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({ status: 'partially_sent' })
        .where(eq(broadcasts.broadcastId, id)),
    );
    const after = await runInTenant(tenant.ctx, async (tx) =>
      (
        await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(eq(broadcasts.broadcastId, id))
      )[0]?.status,
    );
    expect(after).toBe('partially_sent');
  });

  it('sending → cancelled succeeds (FR-004a batch cancel)', async () => {
    const id = await seedBroadcast('sending');
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledByUserId: user.userId,
        })
        .where(eq(broadcasts.broadcastId, id)),
    );
    const after = await runInTenant(tenant.ctx, async (tx) =>
      (
        await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(eq(broadcasts.broadcastId, id))
      )[0]?.status,
    );
    expect(after).toBe('cancelled');
  });

  it('partially_sent → sending succeeds (FR-008b admin retry)', async () => {
    const id = await seedBroadcast('partially_sent');
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({ status: 'sending' })
        .where(eq(broadcasts.broadcastId, id)),
    );
    const after = await runInTenant(tenant.ctx, async (tx) =>
      (
        await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(eq(broadcasts.broadcastId, id))
      )[0]?.status,
    );
    expect(after).toBe('sending');
  });

  it('partially_sent → partial_delivery_accepted WITH quota consumed succeeds (FR-008c + quota CHECK)', async () => {
    const id = await seedBroadcast('partially_sent');
    // This exercises BOTH gates: the state-machine trigger (partially_sent
    // arm) AND the broadcasts_quota_year_only_on_sent CHECK (which must now
    // permit quota on partial_delivery_accepted, not just sent).
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({
          status: 'partial_delivery_accepted',
          partialDeliveryAcceptedAt: new Date(),
          partialDeliveryAcceptedByUserId: user.userId,
          quotaYearConsumed: 2026,
          quotaConsumedAt: new Date(),
        })
        .where(eq(broadcasts.broadcastId, id)),
    );
    const after = await runInTenant(tenant.ctx, async (tx) =>
      (
        await tx
          .select({
            status: broadcasts.status,
            quota: broadcasts.quotaYearConsumed,
          })
          .from(broadcasts)
          .where(eq(broadcasts.broadcastId, id))
      )[0],
    );
    expect(after?.status).toBe('partial_delivery_accepted');
    expect(after?.quota).toBe(2026);
  });

  // ---- Regression guard: illegal moves still raise ------------------

  it('partial_delivery_accepted → sending still raises (terminal state)', async () => {
    const id = await seedBroadcast('partial_delivery_accepted');
    await expectStateMachineRaise(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ status: 'sending' })
          .where(eq(broadcasts.broadcastId, id)),
      ),
    );
  });

  it('sending → draft still raises (illegal backward transition)', async () => {
    const id = await seedBroadcast('sending');
    await expectStateMachineRaise(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ status: 'draft' })
          .where(eq(broadcasts.broadcastId, id)),
      ),
    );
  });

  // ---- Superset edges the trigger allows but the Domain table does not --
  // (cancel-broadcast / failure paths use raw CAS that bypasses Domain
  // transition(); these lock the deliberate superset so a future "make the
  // trigger match Domain" refactor can't silently break them.)

  it('draft → cancelled succeeds (superset edge)', async () => {
    const id = await seedBroadcast('draft');
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledByUserId: user.userId,
        })
        .where(eq(broadcasts.broadcastId, id)),
    );
    const after = await runInTenant(tenant.ctx, async (tx) =>
      (
        await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(eq(broadcasts.broadcastId, id))
      )[0]?.status,
    );
    expect(after).toBe('cancelled');
  });

  it('approved → failed_to_dispatch succeeds (superset edge)', async () => {
    const id = await seedBroadcast('approved');
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({
          status: 'failed_to_dispatch',
          failedToDispatchAt: new Date(),
          failureReason: 'test',
        })
        .where(eq(broadcasts.broadcastId, id)),
    );
    const after = await runInTenant(tenant.ctx, async (tx) =>
      (
        await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(eq(broadcasts.broadcastId, id))
      )[0]?.status,
    );
    expect(after).toBe('failed_to_dispatch');
  });

  // ---- Quota CHECK reverse invariant ---------------------------------

  it('partial_delivery_accepted WITHOUT quota violates the quota CHECK (FR-008c)', async () => {
    let caught: unknown = null;
    try {
      await runInTenant(tenant.ctx, (tx) =>
        tx.insert(broadcasts).values({
          tenantId: tenant.ctx.slug,
          broadcastId: randomUUID(),
          requestedByMemberId: memberId,
          requestedByMemberPlanIdSnapshot: planId,
          submittedByUserId: user.userId,
          actorRole: 'member_self_service',
          subject: 'no-quota',
          bodyHtml: '<p>b</p>',
          bodySource: 'b',
          fromName: 'Chamber',
          replyToEmail: 'reply@example.com',
          segmentType: 'all_members',
          estimatedRecipientCount: 100,
          status: 'partial_delivery_accepted',
          // quota columns intentionally omitted — CHECK must reject
        }),
      );
    } catch (e) {
      caught = e;
    }
    if (caught === null) {
      throw new Error(
        'Expected the quota CHECK to reject partial_delivery_accepted without quota',
      );
    }
    expect(errorChainMessage(caught)).toContain(
      'broadcasts_quota_year_only_on_sent',
    );
  });
});
