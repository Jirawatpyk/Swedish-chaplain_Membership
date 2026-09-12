/**
 * F114 T115 — approving tax-affecting fields never rewrites an issued
 * document (FR-022, SC-012), on live Neon.
 *
 * The buyer block (`member_identity_snapshot`: legal_name, address,
 * primary_contact_name) is frozen at ISSUE time. So:
 *   - invoice A, issued BEFORE the approval, keeps a byte-identical snapshot
 *     after a request changing the company name + billing address + the
 *     primary contact's first name is approved;
 *   - draft B, created before the approval and issued AFTER it, carries the
 *     approved values.
 * Real repos, real use cases (submit → decide → issue); the PDF renderer and
 * the blob store are the only doubles.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { createInvoiceDraft } from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { issueInvoice, type IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { makeCreateInvoiceDraftDeps, makeIssueInvoiceDeps } from '@/modules/invoicing/application/invoicing-deps';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import {
  asContactId,
  asMemberId,
  decideChangeRequest,
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  f3DrizzleAuditAdapter,
  submitChangeRequest,
  type ChangeRequestId,
  type UserId,
} from '@/modules/members';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const mu = (id: string): UserId => id as unknown as UserId;
/** Invoice results carry BigInt satang amounts, which JSON.stringify refuses. */
const show = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const FIXED_NOW = '2026-07-01T09:00:00Z';

function mockPdfBlob() {
  return {
    pdfRender: {
      render: vi.fn(async (_renderInput: PdfRenderInput) => ({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
      })),
    },
    blob: {
      uploadPdf: vi.fn(async ({ key }: { key: string }) => ({ key, url: `https://blob.test/${key}` })),
      uploadLogo: vi.fn(),
      signDownloadUrl: vi.fn(),
      downloadBytes: vi.fn(),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
    },
  };
}

function issueDepsFlagOn(slug: string): IssueInvoiceDeps {
  return { ...makeIssueInvoiceDeps(slug), ...mockPdfBlob(), clock: { nowIso: () => FIXED_NOW }, taxAtPayment: 'on' };
}

let tenant: TestTenant;
let admin: TestUser;
let memberUser: TestUser;
let memberId: string;
let contactId: string;
const planId = `cr-tax-${randomUUID().slice(0, 8)}`;
const planYear = 2026;

async function snapshotOf(invoiceId: string): Promise<MemberIdentitySnapshot> {
  const [row] = await db
    .select({ snap: invoices.memberIdentitySnapshot })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, invoiceId)));
  return row!.snap as MemberIdentitySnapshot;
}

async function draftAndMaybeIssue(issue: boolean): Promise<string> {
  const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(tenant.ctx.slug), {
    tenantId: tenant.ctx.slug,
    actorUserId: admin.userId,
    requestId: `tax-draft-${randomUUID().slice(0, 8)}`,
    memberId,
    planId,
    planYear,
  });
  if (!draft.ok) throw new Error(`draft failed: ${show(draft)}`);
  if (issue) {
    const issued = await issueInvoice(issueDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: admin.userId,
      requestId: `tax-issue-${draft.value.invoiceId}`,
      invoiceId: draft.value.invoiceId,
    });
    if (!issued.ok) throw new Error(`issue failed: ${show(issued)}`);
  }
  return draft.value.invoiceId;
}

describe('FR-022 — approved tax-affecting fields never alter an issued document (T115)', () => {
  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    memberUser = await createActiveTestUser('member');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    contactId = randomUUID();
    await seedTenantFiscal({
      tenant,
      legalNameTh: 'หอการค้าไทย-สวีเดน',
      legalNameEn: 'Thailand-Swedish Chamber of Commerce',
      registeredAddressTh: 'กรุงเทพฯ',
      registeredAddressEn: 'Bangkok',
      invoiceNumberPrefix: 'SC',
      receiptNumberPrefix: 'RC',
    });
    // `seedTenantFiscal` owns tenant_invoice_settings, so the plan is inserted
    // directly (the portal seed helper would insert a second settings row).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear,
        planName: { en: 'Tax Immutability Plan' },
        description: { en: 'Plan for the F114 T115 FR-022 integration test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_200_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Immutable Co Ltd',
        country: 'TH',
        taxId: '9999999999999',
        addressLine1: '99 Rama IV Road',
        city: 'Sathon',
        province: 'Bangkok',
        postalCode: '10120',
        billingAddressLine1: '1 Old Billing St',
        billingCity: 'Bangkok',
        billingPostalCode: '10110',
        billingCountry: 'TH',
        planId,
        planYear,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'Anna',
        lastName: 'Svensson',
        email: `tax-${contactId.slice(0, 8)}@example.com`,
        phone: '+66812345678',
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: memberUser.userId,
      });
    });
  }, 90_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
    await deleteTestUser(memberUser).catch(() => {});
  });

  it('issued-before stays byte-identical; drafted-before-issued-after carries the approved values', async () => {
    const issuedBefore = await draftAndMaybeIssue(true);
    const before = await snapshotOf(issuedBefore);
    const beforeJson = JSON.stringify(before);
    expect(before.legal_name).toBe('Immutable Co Ltd');
    const draftedBefore = await draftAndMaybeIssue(false);

    const submitted = await submitChangeRequest(
      {
        tenant: tenant.ctx,
        changeRequestRepo: drizzleChangeRequestRepo,
        memberRepo: drizzleMemberRepo,
        contactRepo: drizzleContactRepo,
        audit: f3DrizzleAuditAdapter,
        emails: resendEmailPort,
        reviewers: { listReviewers: async () => [] },
        clock: { now: () => new Date() },
        newRequestId: () => randomUUID() as ChangeRequestId,
      },
      {
        memberId: asMemberId(memberId),
        contactId: asContactId(contactId),
        rawBody: {
          contact: { first_name: 'Annika' },
          company: {
            company_name: 'Immutable Company AB',
            billing_address: { line1: '9 New Billing Rd', line2: null, sub_district: null, city: 'Chiang Mai', province: null, postal_code: '50000', country: 'TH' },
          },
        },
        actorUserId: mu(memberUser.userId),
        actorRole: 'member',
        requestId: 'req-tax-submit',
      },
    );
    if (!submitted.ok || submitted.value.outcome !== 'submitted') throw new Error(`submit failed: ${show(submitted)}`);
    expect(submitted.value.request.fields.every((f) => f.affectsTaxDocuments)).toBe(true);

    const decided = await decideChangeRequest(
      {
        tenant: tenant.ctx,
        changeRequestRepo: drizzleChangeRequestRepo,
        memberRepo: drizzleMemberRepo,
        contactRepo: drizzleContactRepo,
        audit: f3DrizzleAuditAdapter,
        emails: resendEmailPort,
        clock: { now: () => new Date() },
      },
      {
        changeRequestId: submitted.value.request.id,
        decisions: [
          { key: 'first_name', outcome: 'approved' },
          { key: 'company_name', outcome: 'approved' },
          { key: 'billing_address', outcome: 'approved' },
        ],
        reason: null,
        note: null,
        actorUserId: mu(admin.userId),
        actorRole: 'admin',
        requestId: 'req-tax-decide',
      },
    );
    expect(decided.ok, show(decided)).toBe(true);

    // the record changed …
    const [m] = await db.select({ companyName: members.companyName, billingAddressLine1: members.billingAddressLine1 }).from(members).where(eq(members.memberId, memberId));
    expect(m).toEqual({ companyName: 'Immutable Company AB', billingAddressLine1: '9 New Billing Rd' });
    // … the issued document did not
    expect(JSON.stringify(await snapshotOf(issuedBefore))).toBe(beforeJson);

    // the draft created before the approval, issued after it, carries the approved values
    const issued = await issueInvoice(issueDepsFlagOn(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: admin.userId,
      requestId: `tax-issue-after-${draftedBefore}`,
      invoiceId: draftedBefore,
    });
    expect(issued.ok, show(issued)).toBe(true);
    const after = await snapshotOf(draftedBefore);
    expect(after.legal_name).toBe('Immutable Company AB');
    expect(after.address).toContain('9 New Billing Rd');
    expect(after.address).not.toContain('1 Old Billing St');
    expect(after.primary_contact_name).toContain('Annika');
    // and the earlier document is still what it was
    expect(JSON.stringify(await snapshotOf(issuedBefore))).toBe(beforeJson);
  }, 180_000);
});
