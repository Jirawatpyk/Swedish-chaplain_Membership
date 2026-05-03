/**
 * R6 staff-review W-T1 fix — integration test for the
 * `broadcasts_immutable_after_submit_fn` DB trigger (migration 0064).
 *
 * The trigger raises a `check_violation` exception when an UPDATE on
 * the `broadcasts` table mutates content fields (subject, body_html,
 * body_source, segment_type, segment_params, custom_recipient_emails,
 * scheduled_for) on a row whose `OLD.status != 'draft'`. Pre-fix
 * coverage was unit-only (Application-layer guard) + contract-mock
 * (route handler) — neither would catch a regression that drops the
 * trigger or weakens its predicate.
 *
 * This test seeds a real broadcast through `draft → submitted` then
 * issues raw UPDATE statements through Drizzle to verify each
 * forbidden mutation surfaces the trigger's exception. Lifecycle
 * column mutations (status, submittedAt, approvedAt, etc.) MUST still
 * succeed — those are the legitimate use-case-driven transitions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';

/**
 * QA fix (2026-05-03) — Drizzle 0.45+ wraps the Postgres trigger
 * exception so `rejects.toThrow(/broadcast_immutable_after_submit/)`
 * does not match the top-level message. Use `errorChainMessage`
 * (existing helper in `src/lib/db-errors.ts`) to walk the `cause`
 * chain and substring-match against the trigger's RAISE EXCEPTION
 * text.
 */
async function expectImmutableAfterSubmitTrigger(
  fn: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  if (caught === null) {
    throw new Error(
      'Expected trigger to raise but UPDATE succeeded silently',
    );
  }
  const chain = errorChainMessage(caught);
  if (!/broadcast_immutable_after_submit/.test(chain)) {
    throw new Error(
      `Expected trigger message in cause chain but got: ${chain}`,
    );
  }
}
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

describe('F7 immutable-after-submit DB trigger (R6 W-T1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let broadcastId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const planId = `wt1-plan-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'WT1 Plan' },
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
        benefitMatrix: F7_MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      }),
    );

    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'WT1 Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    broadcastId = randomUUID();
    // Seed at status='submitted' to put the row past the
    // `OLD.status != 'draft'` predicate so any further content
    // mutation will raise.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'WT1 original subject',
        bodyHtml: '<p>original body</p>',
        bodySource: 'original body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 100,
        status: 'submitted',
        submittedAt: new Date(),
      }),
    );
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('UPDATE subject after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ subject: 'TAMPERED SUBJECT' })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  it('UPDATE body_html after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ bodyHtml: '<p>TAMPERED BODY</p>' })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  it('UPDATE body_source after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ bodySource: 'TAMPERED SOURCE' })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  it('UPDATE custom_recipient_emails after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ customRecipientEmails: ['extra@example.com'] })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  it('UPDATE scheduled_for after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ scheduledFor: new Date('2099-01-01T00:00:00Z') })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  // R7 staff-review MED-T1 fix — segment_type + segment_params
  // closure. The trigger guards 7 fields total
  // (subject, body_html, body_source, segment_type, segment_params,
  // custom_recipient_emails, scheduled_for); the prior 5 cases left
  // segment_type + segment_params untested.
  it('UPDATE segment_type after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ segmentType: 'tier' })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  it('UPDATE segment_params after submitted → raises check_violation', async () => {
    await expectImmutableAfterSubmitTrigger(() =>
      runInTenant(tenant.ctx, (tx) =>
        tx
          .update(broadcasts)
          .set({ segmentParams: { tierCodes: ['premium'] } })
          .where(eq(broadcasts.broadcastId, broadcastId)),
      ),
    );
  });

  it('UPDATE status (legitimate lifecycle transition) → succeeds', async () => {
    // Status is NOT in the trigger's guarded-fields list. The
    // legitimate use-case flow (submit → approved by admin) MUST
    // still succeed — the trigger only blocks content drift, not
    // state machine progress.
    const before = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ status: broadcasts.status })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0]?.status;
    });
    expect(before).toBe('submitted');

    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(broadcasts)
        .set({ status: 'approved', approvedAt: new Date(), approvedByUserId: user.userId })
        .where(eq(broadcasts.broadcastId, broadcastId)),
    );

    const after = await runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ status: broadcasts.status })
        .from(broadcasts)
        .where(eq(broadcasts.broadcastId, broadcastId));
      return rows[0]?.status;
    });
    expect(after).toBe('approved');
  });
});
