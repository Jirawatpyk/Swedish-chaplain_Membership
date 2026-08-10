/**
 * 107-auto-invoice Task 10 — live-Neon proof of the ACTUAL COMPOSITION, not
 * just its parts.
 *
 * Round-2 review (financial-integrity) held the line on the implementer's own
 * flagged concern: every mocked contract test replaces BOTH
 * `guardGenericRouteIssueOrigin` AND `makeGuardGenericRouteIssueOriginDeps`
 * wholesale, so the literal expression that runs in production —
 *
 *   guardGenericRouteIssueOrigin(makeGuardGenericRouteIssueOriginDeps(tenantId), {...})
 *
 * — is never executed end-to-end by any test. Each layer is proven in
 * isolation (guard branch logic at 100% unit coverage; `InvoiceRepo.getOrigin`
 * against live Neon in `get-origin-repo.test.ts`), but a miswiring BETWEEN
 * them — the deps factory resolving the wrong repo/tenant, the barrel
 * silently dropping the `getOrigin` re-export, or `getOrigin` returning the
 * wrong value for a real `auto_renewal` row under an untested RLS edge —
 * would pass every one of those tests and only surface the first time a real
 * auto-renewal draft hit the real route in prod. This file closes that gap.
 *
 * Two levels, both against a real `origin='auto_renewal'` row and a real
 * `origin='manual'` row seeded via the SAME schema Task 1 pinned:
 *
 *   (1) Composition-level — call the barrel's `guardGenericRouteIssueOrigin`
 *       + `makeGuardGenericRouteIssueOriginDeps` directly, fully unmocked.
 *   (2) Route-level — import the REAL route handler and POST to it with a
 *       real `NextRequest`. Only `requireApiPermission` is mocked (the SAME,
 *       and only, mock every other "hit a real route" integration test in
 *       this repo accepts — e.g. tests/integration/members/
 *       bulk-action-rate-limit.test.ts — because this repo has no harness
 *       for minting a real Lucia session cookie outside Playwright E2E;
 *       building one from scratch for this task would add unproven new
 *       surface rather than close the gap the reviewer flagged). Tenant
 *       resolution (`X-Tenant` header + `E2E_X_TENANT_HEADER_ENABLED=1`, same
 *       mechanism tests/integration/members/reconcile-erasures.test.ts uses
 *       to drive a real route at a throwaway tenant), the rate limiter, the
 *       guard, its deps factory, AND `issueInvoice` itself are ALL real and
 *       unmocked — if the guard call were silently missing or misordered,
 *       this test would mint a REAL §87/bill number, which the
 *       post-condition assertion below would catch by re-querying the row.
 *
 * Deliberately does NOT attempt a full real PDF-render + Blob-upload
 * `issueInvoice` happy path for the manual case through the route — that
 * machinery is already proven end-to-end by
 * tests/e2e/invoice-draft-issue.spec.ts and duplicating it here would be
 * slow and orthogonal to what this file exists to prove (the guard's
 * wiring). The manual-draft "does not over-block" proof stays at the
 * composition level (guard returns ok(undefined) against a real row).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  guardGenericRouteIssueOrigin,
  makeGuardGenericRouteIssueOriginDeps,
} from '@/modules/invoicing';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Only auth is mocked (see file header). Everything downstream of it —
// tenant resolution, rate limiting, the guard, its deps factory, and
// issueInvoice — runs for real against live Neon.
const requireApiPermissionMock = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));

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

describe('issue route + guard — COMPOSED, live Neon (107-auto-invoice Task 10)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'issue-route-auto-renewal-refusal-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({
      tenant,
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Issue Route Auto-Renewal Refusal Plan' },
        description: { en: 'Task 10 composed pin' },
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
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function insertDraft(origin: 'manual' | 'auto_renewal' | undefined): Promise<string> {
    const memberId = randomUUID();
    const invoiceId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Issue Route Composed Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        ...(origin !== undefined ? { origin } : {}),
      });
    });
    return invoiceId;
  }

  async function readInvoiceRow(invoiceId: string) {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({
          status: invoices.status,
          origin: invoices.origin,
          documentNumber: invoices.documentNumber,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
        })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId))),
    );
    return row;
  }

  // ---------------------------------------------------------------------
  // (1) Composition-level — the exact expression the route runs, unmocked.
  // ---------------------------------------------------------------------

  it('composition: guardGenericRouteIssueOrigin(makeGuardGenericRouteIssueOriginDeps(tenantId), ...) refuses a real auto_renewal draft', async () => {
    const invoiceId = await insertDraft('auto_renewal');

    const result = await guardGenericRouteIssueOrigin(
      makeGuardGenericRouteIssueOriginDeps(tenant.ctx.slug),
      { tenantId: tenant.ctx.slug, invoiceId },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'origin_auto_renewal_use_queue' },
    });
  }, 60_000);

  it('composition: the SAME unmocked composition passes a real manual draft through', async () => {
    const invoiceId = await insertDraft('manual');

    const result = await guardGenericRouteIssueOrigin(
      makeGuardGenericRouteIssueOriginDeps(tenant.ctx.slug),
      { tenantId: tenant.ctx.slug, invoiceId },
    );

    expect(result).toEqual({ ok: true, value: undefined });
  }, 60_000);

  // ---------------------------------------------------------------------
  // (2) Route-level — the REAL POST handler. Only requireApiPermission is
  // mocked (module-level, see top of file); everything else — tenant
  // resolution, rate limiter, guard, deps factory, issueInvoice — is real.
  // ---------------------------------------------------------------------

  function adminContextFor(u: TestUser) {
    return {
      current: {
        user: {
          id: u.userId,
          email: u.rawEmail,
          role: 'admin' as const,
          status: 'active' as const,
          displayName: 'Task 10 Test Admin',
        },
        session: { id: `sess-${randomUUID()}` },
      },
      sourceIp: '203.0.113.5',
      requestId: `req-${randomUUID()}`,
    };
  }

  it('POSTs an auto_renewal draft to the real route -> 422, and NOTHING was minted on the real row', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContextFor(user));
    const invoiceId = await insertDraft('auto_renewal');

    const { POST } = await import('@/app/api/invoices/[invoiceId]/issue/route');
    const req = new NextRequest(
      `http://localhost:3100/api/invoices/${invoiceId}/issue`,
      { method: 'POST', headers: { 'x-tenant': tenant.ctx.slug } },
    );
    const res = await POST(req, { params: Promise.resolve({ invoiceId }) });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toEqual({ code: 'origin_auto_renewal_use_queue' });

    // The rigorous, real-row proof: issueInvoice was NOT mocked in this
    // test — if the route's guard call were missing, silently dropped, or
    // reordered after issueInvoice, this request would have minted a real
    // §87/bill number. Re-querying the row directly proves it did not.
    const row = await readInvoiceRow(invoiceId);
    expect(row?.status).toBe('draft');
    expect(row?.documentNumber).toBeNull();
    expect(row?.billDocumentNumberRaw).toBeNull();
  }, 60_000);
});
