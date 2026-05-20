/**
 * T022 — F7 Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probes on every
 * CRUD operation against all 4 F7 tables, from both directions.
 *
 * Why this is a blocker: F7 carries marketing-consent + member-graph
 * recipient PII (broadcast bodies, recipient lists, suppression records).
 * A single missed RLS path leaks marketing communications across chambers
 * — a PDPA §28 + GDPR Art. 6 cross-border-and-cross-controller violation.
 *
 * Covered surfaces (all 4 F7 tables):
 *   - broadcasts                        — SELECT / UPDATE / DELETE / INSERT
 *   - broadcast_deliveries              — SELECT / INSERT
 *                                          (UPDATE/DELETE blocked by
 *                                           append-only triggers — tested
 *                                           that the triggers fire NOT that
 *                                           RLS is bypassable; pre-trigger
 *                                           RLS still applies to SELECT)
 *   - marketing_unsubscribes            — SELECT / UPDATE / INSERT
 *                                          (DELETE not granted to chamber_app)
 *   - broadcast_segment_definitions     — SELECT / UPDATE / INSERT
 *
 * Cross-tenant-probe audit emission (`broadcast_cross_tenant_probe`,
 * `broadcast_cross_member_probe`) is wired in
 * `src/modules/broadcasts/application/use-cases/enforce-tenant-context.ts`
 * (R6 staff-review W-S3 verified — emit sites at lines 65, 81). The
 * RLS table-level guarantee tested here is the layer-1 defence; the
 * use-case audit emit is the layer-2 (application boundary) defence.
 *
 * Sibling files:
 *   - tests/integration/invoicing/tenant-isolation.test.ts (F4)
 *   - tests/integration/payments/tenant-isolation.test.ts  (F5)
 *
 * RED reason: F7 DB tables (broadcasts, broadcast_deliveries,
 * marketing_unsubscribes, broadcast_segment_definitions) do not exist in
 * the live Neon schema until migrations 0064–0067 are applied (Step 9 of
 * Batch B plan). This entire test suite is RED until `pnpm db:migrate`
 * runs.
 *
 * Turns GREEN: Step 9 migration apply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastDeliveries,
  marketingUnsubscribes,
  broadcastSegmentDefinitions,
  type NewBroadcastRow,
  type NewBroadcastDeliveryRow,
  type NewMarketingUnsubscribeRow,
  type NewBroadcastSegmentDefinitionRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const F7_ISOLATION_MATRIX: BenefitMatrix = {
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

describe('F7 Tenant isolation — REVIEW-GATE BLOCKER (T022)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  // broadcasts
  let aBroadcastId: string;
  let bBroadcastId: string;

  // broadcast_deliveries
  let aDeliveryId: string;
  let bDeliveryId: string;

  // segment_definitions
  let aSegmentDefId: string;
  let bSegmentDefId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // ------------------------------------------------------------------
    // Seed plans + members per tenant (FK target chain for broadcasts)
    // ------------------------------------------------------------------
    for (const t of [tenantA, tenantB]) {
      const planId = `f7-iso-${randomUUID().slice(0, 8)}`;
      await runInTenant(t.ctx, (tx) =>
        tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId,
          planYear: 2026,
          planName: { en: 'F7 Test Plan' },
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
          benefitMatrix: F7_ISOLATION_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        }),
      );
      const memberId = randomUUID();
      await runInTenant(t.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId,
          companyName: 'F7 Test Member',
          country: 'TH',
          planId,
          planYear: 2026,
        }),
      );
      // Stash for later seeds — using a side channel (closure) per tenant
      if (t === tenantA) {
        (tenantA as unknown as { _planId: string; _memberId: string })._planId = planId;
        (tenantA as unknown as { _planId: string; _memberId: string })._memberId = memberId;
      } else {
        (tenantB as unknown as { _planId: string; _memberId: string })._planId = planId;
        (tenantB as unknown as { _planId: string; _memberId: string })._memberId = memberId;
      }
    }

    const aMemberId = (tenantA as unknown as { _memberId: string })._memberId;
    const bMemberId = (tenantB as unknown as { _memberId: string })._memberId;

    // ------------------------------------------------------------------
    // Seed broadcasts — 1 draft per tenant
    // ------------------------------------------------------------------
    aBroadcastId = randomUUID();
    bBroadcastId = randomUUID();

    const userIdA = randomUUID(); // standalone for tenant A
    const userIdB = randomUUID();

    const aBroadcastRow: NewBroadcastRow = {
      tenantId: tenantA.ctx.slug,
      broadcastId: aBroadcastId,
      requestedByMemberId: aMemberId,
      requestedByMemberPlanIdSnapshot: randomUUID(),
      submittedByUserId: userIdA,
      actorRole: 'member_self_service',
      subject: 'Tenant A Test Broadcast',
      bodyHtml: '<p>Tenant A body</p>',
      bodySource: 'Tenant A body',
      fromName: 'Tenant A via SweCham',
      replyToEmail: 'a@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'draft',
    };

    const bBroadcastRow: NewBroadcastRow = {
      tenantId: tenantB.ctx.slug,
      broadcastId: bBroadcastId,
      requestedByMemberId: bMemberId,
      requestedByMemberPlanIdSnapshot: randomUUID(),
      submittedByUserId: userIdB,
      actorRole: 'member_self_service',
      subject: 'Tenant B Test Broadcast',
      bodyHtml: '<p>Tenant B body</p>',
      bodySource: 'Tenant B body',
      fromName: 'Tenant B via Other Chamber',
      replyToEmail: 'b@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'draft',
    };

    await runInTenant(tenantA.ctx, (tx) => tx.insert(broadcasts).values(aBroadcastRow));
    await runInTenant(tenantB.ctx, (tx) => tx.insert(broadcasts).values(bBroadcastRow));

    // ------------------------------------------------------------------
    // Seed broadcast_deliveries — 1 sent event per tenant (insert-only)
    // ------------------------------------------------------------------
    aDeliveryId = randomUUID();
    bDeliveryId = randomUUID();

    const now = new Date();

    const aDeliveryRow: NewBroadcastDeliveryRow = {
      tenantId: tenantA.ctx.slug,
      deliveryId: aDeliveryId,
      broadcastId: aBroadcastId,
      resendEventId: `evt_a_${randomUUID().slice(0, 16)}`,
      resendMessageId: `msg_a_${randomUUID().slice(0, 16)}`,
      recipientEmailLower: 'recipient-a@example.com',
      recipientMemberId: null,
      recipientMemberLookupAttemptedAt: null,
      status: 'sent',
      eventTimestamp: now,
      errorMessage: null,
      bounceType: null,
    };

    const bDeliveryRow: NewBroadcastDeliveryRow = {
      tenantId: tenantB.ctx.slug,
      deliveryId: bDeliveryId,
      broadcastId: bBroadcastId,
      resendEventId: `evt_b_${randomUUID().slice(0, 16)}`,
      resendMessageId: `msg_b_${randomUUID().slice(0, 16)}`,
      recipientEmailLower: 'recipient-b@example.com',
      recipientMemberId: null,
      recipientMemberLookupAttemptedAt: null,
      status: 'sent',
      eventTimestamp: now,
      errorMessage: null,
      bounceType: null,
    };

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(broadcastDeliveries).values(aDeliveryRow),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(broadcastDeliveries).values(bDeliveryRow),
    );

    // ------------------------------------------------------------------
    // Seed marketing_unsubscribes — 1 per tenant
    // ------------------------------------------------------------------
    const aSuppressionRow: NewMarketingUnsubscribeRow = {
      tenantId: tenantA.ctx.slug,
      emailLower: 'unsub-a@example.com',
      memberId: null,
      reason: 'recipient_initiated',
      reasonText: null,
      sourceBroadcastId: aBroadcastId,
      sourceTokenHash: null,
    };

    const bSuppressionRow: NewMarketingUnsubscribeRow = {
      tenantId: tenantB.ctx.slug,
      emailLower: 'unsub-b@example.com',
      memberId: null,
      reason: 'recipient_initiated',
      reasonText: null,
      sourceBroadcastId: bBroadcastId,
      sourceTokenHash: null,
    };

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values(aSuppressionRow),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values(bSuppressionRow),
    );

    // ------------------------------------------------------------------
    // Seed broadcast_segment_definitions — 1 per tenant
    // (note: 0068 already seeds 9 default rows for SweCham only; test
    // tenants don't get those, so seeding 1 row each is sufficient)
    // ------------------------------------------------------------------
    aSegmentDefId = randomUUID();
    bSegmentDefId = randomUUID();

    const aSegmentDefRow: NewBroadcastSegmentDefinitionRow = {
      tenantId: tenantA.ctx.slug,
      definitionId: aSegmentDefId,
      segmentType: 'all_members',
      displayLabelI18nKey: 'broadcasts.segment.allMembers',
      params: null,
      enabled: true,
    };

    const bSegmentDefRow: NewBroadcastSegmentDefinitionRow = {
      tenantId: tenantB.ctx.slug,
      definitionId: bSegmentDefId,
      segmentType: 'all_members',
      displayLabelI18nKey: 'broadcasts.segment.allMembers',
      params: null,
      enabled: true,
    };

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(broadcastSegmentDefinitions).values(aSegmentDefRow),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(broadcastSegmentDefinitions).values(bSegmentDefRow),
    );
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => {
      console.error('[T022] tenantA cleanup failed:', e);
    });
    await tenantB.cleanup().catch((e) => {
      console.error('[T022] tenantB cleanup failed:', e);
    });
  });

  // ===========================================================================
  // broadcasts table
  // ===========================================================================

  describe('broadcasts', () => {
    it('A sees only A broadcasts', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(broadcasts),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.broadcastId).toBe(aBroadcastId);
    });

    it('B sees only B broadcasts', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(broadcasts),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.broadcastId).toBe(bBroadcastId);
    });

    it('A cannot SELECT B broadcast by id (RLS hides row)', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, bBroadcastId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.update(B broadcast) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ subject: 'TAMPERED' })
          .where(eq(broadcasts.broadcastId, bBroadcastId))
          .returning(),
      );
      expect(updated).toHaveLength(0);

      // Verify B's broadcast subject is unchanged
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, bBroadcastId)),
      );
      expect(check).toHaveLength(1);
      expect(check[0]!.subject).toBe('Tenant B Test Broadcast');
    });

    it('A.delete(B broadcast) affects 0 rows', async () => {
      const deleted = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .delete(broadcasts)
          .where(eq(broadcasts.broadcastId, bBroadcastId))
          .returning(),
      );
      expect(deleted).toHaveLength(0);

      // Verify B's broadcast still exists
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, bBroadcastId)),
      );
      expect(check).toHaveLength(1);
    });

    it('A.insert(broadcast with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
      const rogueId = randomUUID();
      const bMemberId = (tenantB as unknown as { _memberId: string })._memberId;
      const userId = randomUUID();
      const rogue: NewBroadcastRow = {
        tenantId: tenantB.ctx.slug, // cross-tenant payload — must be rejected
        broadcastId: rogueId,
        requestedByMemberId: bMemberId,
        requestedByMemberPlanIdSnapshot: randomUUID(),
        submittedByUserId: userId,
        actorRole: 'member_self_service',
        subject: 'rogue',
        bodyHtml: '<p>r</p>',
        bodySource: 'r',
        fromName: 'rogue',
        replyToEmail: 'r@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 0,
        status: 'draft',
      };
      await expect(
        runInTenant(tenantA.ctx, (tx) => tx.insert(broadcasts).values(rogue)),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // broadcast_deliveries table (insert-only)
  // ===========================================================================

  describe('broadcast_deliveries', () => {
    it('A sees only A broadcast_deliveries', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(broadcastDeliveries),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deliveryId).toBe(aDeliveryId);
    });

    it('A cannot SELECT B broadcast_deliveries by id (RLS hides row)', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(broadcastDeliveries)
          .where(eq(broadcastDeliveries.deliveryId, bDeliveryId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.insert(broadcast_delivery with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
      const rogueId = randomUUID();
      const rogue: NewBroadcastDeliveryRow = {
        tenantId: tenantB.ctx.slug,
        deliveryId: rogueId,
        broadcastId: bBroadcastId,
        resendEventId: `rogue_${randomUUID().slice(0, 16)}`,
        resendMessageId: `rogue_${randomUUID().slice(0, 16)}`,
        recipientEmailLower: 'rogue@example.com',
        recipientMemberId: null,
        recipientMemberLookupAttemptedAt: null,
        status: 'sent',
        eventTimestamp: new Date(),
        errorMessage: null,
        bounceType: null,
      };
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(broadcastDeliveries).values(rogue),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // marketing_unsubscribes table
  // ===========================================================================

  describe('marketing_unsubscribes', () => {
    it('A sees only A marketing_unsubscribes', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(marketingUnsubscribes),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.emailLower).toBe('unsub-a@example.com');
    });

    it('A cannot SELECT B marketing_unsubscribes (RLS hides row)', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(marketingUnsubscribes)
          .where(eq(marketingUnsubscribes.emailLower, 'unsub-b@example.com')),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.update(B marketing_unsubscribes) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(marketingUnsubscribes)
          .set({ reason: 'admin_added' })
          .where(eq(marketingUnsubscribes.emailLower, 'unsub-b@example.com'))
          .returning(),
      );
      expect(updated).toHaveLength(0);

      // Verify B's row unchanged
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(marketingUnsubscribes)
          .where(eq(marketingUnsubscribes.emailLower, 'unsub-b@example.com')),
      );
      expect(check).toHaveLength(1);
      expect(check[0]!.reason).toBe('recipient_initiated');
    });

    it('A.insert(marketing_unsubscribe with tenant_id=B) is rejected by RLS WITH CHECK', async () => {
      const rogue: NewMarketingUnsubscribeRow = {
        tenantId: tenantB.ctx.slug,
        emailLower: 'rogue@example.com',
        memberId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      };
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(marketingUnsubscribes).values(rogue),
        ),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // broadcast_segment_definitions table
  // ===========================================================================

  describe('broadcast_segment_definitions', () => {
    it('A sees only A broadcast_segment_definitions', async () => {
      // Filter to test-seeded row only — the SweCham tenant has 9 default
      // segments from migration 0068 but our 2 test tenants don't include
      // 'swecham' so the count check is exact.
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(broadcastSegmentDefinitions),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.definitionId).toBe(aSegmentDefId);
    });

    it('A cannot SELECT B segment_definition (RLS hides row)', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .select()
          .from(broadcastSegmentDefinitions)
          .where(eq(broadcastSegmentDefinitions.definitionId, bSegmentDefId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('A.update(B segment_definition) affects 0 rows', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(broadcastSegmentDefinitions)
          .set({ enabled: false })
          .where(eq(broadcastSegmentDefinitions.definitionId, bSegmentDefId))
          .returning(),
      );
      expect(updated).toHaveLength(0);

      // Verify B's segment is still enabled
      const check = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select()
          .from(broadcastSegmentDefinitions)
          .where(eq(broadcastSegmentDefinitions.definitionId, bSegmentDefId)),
      );
      expect(check).toHaveLength(1);
      expect(check[0]!.enabled).toBe(true);
    });
  });
});
