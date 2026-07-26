/**
 * Task 4 (107-auto-invoice, "auto-invoice #2") — `autoEmailOverride` param
 * on the issue path.
 *
 * The renewal queue's "Issue + Send" action needs to force an auto-email on
 * a SPECIFIC issue call without persisting that choice on the draft row —
 * a persisted `autoEmailOnIssue=true` patch would leak onto a LATER "Issue
 * silently" retry of the same draft (e.g. after a failed first attempt),
 * silently emailing the member when the operator explicitly chose not to.
 * `autoEmailOverride` is therefore a per-CALL parameter on `IssueInvoiceInput`,
 * resolved with the exact precedence
 * `input.autoEmailOverride ?? draft.autoEmailOnIssue ?? settings.autoEmailEnabled`
 * — see `issue-invoice.ts` step L.
 *
 * This is the first LIVE-NEON proof of that resolution order:
 *   - draft persisted with `autoEmailOnIssue: false` (an explicit per-draft
 *     opt-out), tenant `auto_email_enabled: true` (the DEFAULT column value
 *     — `seedTenantFiscal` does not override it, see
 *     `schema-tenant-invoice-settings.ts:80`).
 *   - issuing with `autoEmailOverride: undefined` must NOT enqueue an
 *     auto-email — the explicit draft `false` wins over the tenant default,
 *     proving the override is opt-in only (no regression on existing
 *     callers that never pass it).
 *   - issuing with `autoEmailOverride: true` MUST enqueue exactly one
 *     auto-email — the override outranks both the draft flag and the
 *     tenant default.
 *
 * Mirrors the "real `makeIssueInvoiceDeps`, mock only the network-touching
 * PDF/Blob/outbox adapters INLINE on the deps object" idiom from
 * `bill-to-receipt.integration.test.ts` (rather than a module-level
 * `vi.mock`, which `issue-membership-bill.test.ts` needs only because it
 * exercises the `issueMembershipBill` / bridge composition that imports
 * those adapters transitively). Calling `issueInvoice` directly here, a
 * per-call deps override is simpler and avoids `vi.mock` hoisting concerns.
 * The outbox port is mocked with a `vi.fn()` so the test counts `enqueue`
 * invocations directly (the "outbox-count harness") instead of querying
 * `notifications_outbox` — cheaper and just as conclusive for a boolean
 * enqueue/no-enqueue contract.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

async function seedPlanFixture(tenant: TestTenant, user: TestUser, planId: string): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Auto-Email Override Test Plan' },
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
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

/** Member + a primary contact with a deliverable email — required so
 * `shouldAutoEmail=true` actually reaches `outbox.enqueue` instead of
 * short-circuiting on the empty-recipient guard (`enqueue-invoice-
 * email.ts`), which would make the "override:true -> 1 row" assertion
 * pass for the wrong reason. */
async function seedMemberWithContact(
  tenant: TestTenant,
  planId: string,
  email: string,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Auto-Email Override Test Co',
      country: 'TH',
      planId,
      planYear: 2026,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Override',
      lastName: 'Contact',
      email,
      isPrimary: true,
    });
  });
  return memberId;
}

/** Real `makeIssueInvoiceDeps` (real repo/settings/audit/allocator/member-
 * identity), with only the network-touching PDF/Blob adapters swapped for
 * deterministic in-memory fakes and the outbox swapped for a counting
 * `vi.fn()` spy. */
function issueDepsWithMockedOutbox(
  slug: string,
  enqueue: ReturnType<typeof vi.fn>,
): IssueInvoiceDeps {
  return {
    ...makeIssueInvoiceDeps(slug),
    pdfRender: {
      render: vi.fn(async () => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      uploadLogo: vi.fn(async ({ key }: { key: string }) => ({
        key,
        url: `https://blob.test/${key}`,
      })),
      signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
      downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    outbox: { enqueue },
  };
}

describe('issueInvoice — autoEmailOverride param (Task 4, 107-auto-invoice)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'auto-email-override-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-chamber');
    // `autoEmailEnabled` is left at its column DEFAULT (true) — the
    // scenario needs the TENANT default to be true so the draft's
    // explicit `false` (not the tenant default) is what's under test.
    await seedTenantFiscal({ tenant });
    await seedPlanFixture(tenant, user, planId);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('autoEmailOverride: undefined respects the draft\'s persisted autoEmailOnIssue=false (no enqueue) even though the tenant default is true', async () => {
    const memberId = await seedMemberWithContact(
      tenant,
      planId,
      'override-undefined@example.com',
    );
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 'task4-override-undefined-draft',
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) return;

    const enqueue = vi.fn(async () => {});
    const result = await issueInvoice(issueDepsWithMockedOutbox(tenant.ctx.slug, enqueue), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 'task4-override-undefined-issue',
      invoiceId: draft.value.invoiceId,
      // Explicitly undefined — mirrors every existing caller that has
      // never heard of this field, proving no regression.
      autoEmailOverride: undefined,
    });

    expect(result.ok, result.ok ? 'ok' : `issue err: ${JSON.stringify(!result.ok && result.error)}`).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.value.emailDispatch).toBe('disabled');
    expect(enqueue).not.toHaveBeenCalled();
  }, 60_000);

  it('autoEmailOverride: true forces exactly one enqueue even though the draft persisted autoEmailOnIssue=false', async () => {
    const memberId = await seedMemberWithContact(
      tenant,
      planId,
      'override-true@example.com',
    );
    const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 'task4-override-true-draft',
      memberId,
      planId,
      planYear: 2026,
      autoEmailOnIssue: false,
    });
    expect(draft.ok, draft.ok ? 'ok' : `draft err: ${JSON.stringify(draft)}`).toBe(true);
    if (!draft.ok) return;

    const enqueue = vi.fn(async () => {});
    const result = await issueInvoice(issueDepsWithMockedOutbox(tenant.ctx.slug, enqueue), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: 'task4-override-true-issue',
      invoiceId: draft.value.invoiceId,
      autoEmailOverride: true,
    });

    expect(result.ok, result.ok ? 'ok' : `issue err: ${JSON.stringify(!result.ok && result.error)}`).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.value.emailDispatch).toBe('sent');
    expect(enqueue).toHaveBeenCalledTimes(1);
  }, 60_000);
});
