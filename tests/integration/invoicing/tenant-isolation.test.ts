/**
 * T015 — F4 Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probes on every
 * CRUD operation against all 5 F4 tables, from both directions.
 *
 * Why this is a blocker: F4 is the first F-stream feature carrying
 * financial PII (member tax IDs, legal names, addresses copied into
 * invoice snapshots). A single missed RLS path leaks tax documents
 * across chambers.
 *
 * Covered surfaces (all 5 F4 tables, R7-W2 extends coverage to lines +
 * credit_notes — previously covered only implicitly via FK cascade):
 *   - invoices — SELECT / UPDATE / DELETE
 *   - invoice_lines — SELECT / UPDATE / DELETE
 *   - credit_notes — SELECT / UPDATE / DELETE
 *   - tenant_invoice_settings — SELECT / UPDATE
 *   - tenant_document_sequences — SELECT / UPDATE
 *
 * Cross-tenant probe audit emission (`invoice_cross_tenant_probe`,
 * `credit_note_cross_tenant_probe`) is tested once the use cases that
 * emit them land in US1 (T037 issueInvoice / T038 listInvoices with
 * ownership guard) — the Review-Gate blocker here is the RLS table-level
 * guarantee, which we verify now so schema regressions can never
 * silently pass CI.
 *
 * Sibling file: tests/integration/members/tenant-isolation.test.ts (F3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const CORPORATE_MATRIX: BenefitMatrix = {
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

describe('F4 Tenant isolation — REVIEW-GATE BLOCKER (T015)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aInvoiceId: string;
  let bInvoiceId: string;
  let aMemberId: string;
  let bMemberId: string;
  // R7-W2 — seed invoice_lines + credit_notes per tenant so the
  // isolation matrix covers all 5 F4 tables (Constitution v1.4.0
  // Principle I clause 3). Previously only 3 tables were probed; the
  // comment "invoice_lines — SELECT (isolation via composite FK)"
  // relied on implicit FK-cascade which is NOT an access-control
  // mechanism. RLS is — so we probe it directly.
  let aLineId: string;
  let bLineId: string;
  let aCreditNoteId: string;
  let bCreditNoteId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed plans + members per tenant (invoice_settings seeded below).
    for (const [t, prefix] of [[tenantA, 'alpha'], [tenantB, 'beta']] as const) {
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: `${prefix}-plan`,
          planYear: 2026,
          planName: { en: `${prefix} Plan` },
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
          benefitMatrix: CORPORATE_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
      });
    }

    aMemberId = randomUUID();
    bMemberId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: aMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Alpha Co',
        country: 'TH',
        planId: 'alpha-plan',
        planYear: 2026,
      }),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: bMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Beta Co',
        country: 'TH',
        planId: 'beta-plan',
        planYear: 2026,
      }),
    );

    // Seed 1 draft invoice per tenant.
    aInvoiceId = randomUUID();
    bInvoiceId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantA.ctx.slug,
        invoiceId: aInvoiceId,
        memberId: aMemberId,
        planYear: 2026,
        planId: 'alpha-plan',
        draftByUserId: user.userId,
      }),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenantB.ctx.slug,
        invoiceId: bInvoiceId,
        memberId: bMemberId,
        planYear: 2026,
        planId: 'beta-plan',
        draftByUserId: user.userId,
      }),
    );

    // Seed tenant settings + a sequence row per tenant.
    for (const t of [tenantA, tenantB]) {
      await runInTenant(t.ctx, (tx) =>
        tx.insert(tenantInvoiceSettings).values({
          tenantId: t.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 500000n,
          legalNameTh: 'ทดสอบ',
          legalNameEn: 'Test',
          taxId: '0000000000000',
          registeredAddressTh: 'Bangkok',
          registeredAddressEn: 'Bangkok',
          invoiceNumberPrefix: 'T',
          creditNoteNumberPrefix: 'TC',
        }),
      );
      await runInTenant(t.ctx, (tx) =>
        tx.insert(tenantDocumentSequences).values({
          tenantId: t.ctx.slug,
          documentType: 'invoice',
          fiscalYear: 2026,
        }),
      );
    }

    // R7-W2 — seed one invoice_lines row per tenant, parented to the
    // draft invoice seeded above.
    aLineId = randomUUID();
    bLineId = randomUUID();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(invoiceLines).values({
        tenantId: tenantA.ctx.slug,
        lineId: aLineId,
        invoiceId: aInvoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership fee',
        unitPriceSatang: 1_000_000n,
        totalSatang: 1_000_000n,
        position: 1,
      }),
    );
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(invoiceLines).values({
        tenantId: tenantB.ctx.slug,
        lineId: bLineId,
        invoiceId: bInvoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก',
        descriptionEn: 'Membership fee',
        unitPriceSatang: 1_000_000n,
        totalSatang: 1_000_000n,
        position: 1,
      }),
    );

    // R7-W2 — seed one credit_notes row per tenant. Standalone fixture
    // (not linked to a real paid invoice) because the integration test
    // only needs to prove RLS — not domain invariants. `original_invoice_id`
    // points to a random UUID so neither tenant observes a real
    // credit-note-to-invoice link; both rows are RLS-scoped by tenant_id.
    aCreditNoteId = randomUUID();
    bCreditNoteId = randomUUID();
    const creditNoteSnapshotPlaceholder = {
      legal_name_en: 'Test',
      legal_name_th: 'ทดสอบ',
      tax_id: '0000000000000',
      address: 'Bangkok',
    };
    // `originalInvoiceId` must satisfy the FK to `invoices`. Point at
    // the seeded draft invoice per tenant — domain status invariants
    // (credit note only against paid) are enforced at Application
    // layer, not at the DB level, so this FK is satisfied.
    for (const [t, creditNoteId, prefix, origInvoice] of [
      [tenantA, aCreditNoteId, 'T', aInvoiceId],
      [tenantB, bCreditNoteId, 'T', bInvoiceId],
    ] as const) {
      await runInTenant(t.ctx, (tx) =>
        tx.insert(creditNotes).values({
          tenantId: t.ctx.slug,
          creditNoteId,
          originalInvoiceId: origInvoice,
          fiscalYear: 2026,
          sequenceNumber: 1,
          documentNumber: `${prefix}C26-000001`,
          issueDate: '2026-01-15',
          issuedByUserId: user.userId,
          reason: 'R7-W2 isolation fixture',
          creditAmountSatang: 100000n,
          vatSatang: 7000n,
          totalSatang: 107000n,
          tenantIdentitySnapshot: creditNoteSnapshotPlaceholder,
          memberIdentitySnapshot: creditNoteSnapshotPlaceholder,
          pdfBlobKey: `invoicing/${t.ctx.slug}/2026/fixture_v1.pdf`,
          pdfSha256: 'a'.repeat(64),
          pdfTemplateVersion: 1,
        }),
      );
    }
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // invoices
  // ---------------------------------------------------------------------------

  it('A sees only A invoices', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(invoices));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
    expect(rows[0]!.invoiceId).toBe(aInvoiceId);
  });

  it('B sees only B invoices', async () => {
    const rows = await runInTenant(tenantB.ctx, (tx) => tx.select().from(invoices));
    expect(rows.length).toBe(1);
    expect(rows[0]!.invoiceId).toBe(bInvoiceId);
  });

  it('A cannot SELECT B invoice by id (cross-tenant probe returns 0 rows)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(invoices).where(eq(invoices.invoiceId, bInvoiceId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B invoice) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(invoices)
        .set({ status: 'void' })
        .where(eq(invoices.invoiceId, bInvoiceId))
        .returning(),
    );
    expect(updated).toHaveLength(0);
    // Confirm via tenantB-scoped read.
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(invoices).where(eq(invoices.invoiceId, bInvoiceId)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.status).toBe('draft');
  });

  it('A.delete(B invoice) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx.delete(invoices).where(eq(invoices.invoiceId, bInvoiceId)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(invoices).where(eq(invoices.invoiceId, bInvoiceId)),
    );
    expect(check).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // tenant_invoice_settings
  // ---------------------------------------------------------------------------

  it('A cannot SELECT B tenant_invoice_settings', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B settings) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(tenantInvoiceSettings)
        .set({ vatRate: '0.9900' })
        .where(eq(tenantInvoiceSettings.tenantId, tenantB.ctx.slug))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // tenant_document_sequences
  // ---------------------------------------------------------------------------

  it('A cannot read B sequence rows', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(tenantDocumentSequences)
        .where(eq(tenantDocumentSequences.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B sequence) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(tenantDocumentSequences)
        .set({ nextSequenceNumber: 999 })
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, tenantB.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'invoice'),
            eq(tenantDocumentSequences.fiscalYear, 2026),
          ),
        )
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // invoice_lines (R7-W2)
  //
  // Previously covered only implicitly via FK-cascade on invoice
  // deletion. FK is not access control — only RLS is. Probe directly.
  // ---------------------------------------------------------------------------

  it('A sees only A invoice_lines', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(invoiceLines));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
    expect(rows[0]!.lineId).toBe(aLineId);
  });

  it('A cannot SELECT B invoice_lines by id (RLS hides row)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(invoiceLines).where(eq(invoiceLines.lineId, bLineId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B invoice_line) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(invoiceLines)
        .set({ descriptionEn: 'HIJACKED' })
        .where(eq(invoiceLines.lineId, bLineId))
        .returning(),
    );
    expect(updated).toHaveLength(0);
    // Confirm via tenantB-scoped read — original description survives.
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(invoiceLines).where(eq(invoiceLines.lineId, bLineId)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.descriptionEn).toBe('Membership fee');
  });

  it('A.delete(B invoice_line) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx.delete(invoiceLines).where(eq(invoiceLines.lineId, bLineId)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(invoiceLines).where(eq(invoiceLines.lineId, bLineId)),
    );
    expect(check).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // credit_notes (R7-W2)
  //
  // Not previously covered. Probe SELECT/UPDATE/DELETE directly.
  // ---------------------------------------------------------------------------

  it('A sees only A credit_notes', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(creditNotes));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tenantId).toBe(tenantA.ctx.slug);
    expect(rows[0]!.creditNoteId).toBe(aCreditNoteId);
  });

  it('A cannot SELECT B credit_notes by id (RLS hides row)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.creditNoteId, bCreditNoteId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('A.update(B credit_note) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(creditNotes)
        .set({ reason: 'HIJACKED' })
        .where(eq(creditNotes.creditNoteId, bCreditNoteId))
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.creditNoteId, bCreditNoteId)),
    );
    expect(check).toHaveLength(1);
    expect(check[0]!.reason).toBe('R7-W2 isolation fixture');
  });

  it('A.delete(B credit_note) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx.delete(creditNotes).where(eq(creditNotes.creditNoteId, bCreditNoteId)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const check = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.creditNoteId, bCreditNoteId)),
    );
    expect(check).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // NULL tenant context — secure-by-default (FR-013)
  //
  // This invariant (no rows visible under NULL `app.current_tenant`) is
  // covered by `tests/integration/rls-coverage.test.ts` via inspection
  // of `pg_policies.qual` — every F4 policy references
  // `current_setting('app.current_tenant', TRUE)` which returns NULL
  // when unset. A runtime NULL-context test would require the test
  // runner to switch roles to `chamber_app`; the integration test
  // framework uses the BYPASS-RLS owner by design (so helpers can
  // clean up across tenants). The app itself only ever uses
  // `chamber_app` via `runInTenant(ctx, …)`.
});
