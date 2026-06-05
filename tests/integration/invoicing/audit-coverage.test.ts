/**
 * T113a — F4 audit coverage integration test.
 *
 * Migration 0020 registers 16 F4 audit-event types. This test walks
 * the MVP flows (draft → issue → pay) + explicit probe scenarios,
 * then asserts that the actual events emitted into `audit_log` match
 * the union declared in `audit-port.ts`. Pins the contract so a
 * future refactor that silently drops an emit (or drifts the enum)
 * fails the integration gate.
 *
 * NOT covered (deferred to post-MVP phases):
 *   - `invoice_voided`             (US5, Phase 9)
 *   - `credit_note_issued`         (US6, Phase 6)
 *   - `credit_note_cross_tenant_probe`  (US6, Phase 6)
 *   - `credit_note_pdf_resent`     (Phase 10 T107)
 *   - `invoice_pdf_resent`         (Phase 10 T107)
 *   - `receipt_pdf_resent`         (Phase 10 T107)
 *   - `invoice_overdue_detected`   (Phase 10 T109)
 *   - `auto_email_delivery_failed` (Phase 10 T106 dispatcher)
 *
 * Remaining 8 are exercised here: invoice_draft_created /
 * invoice_draft_updated / invoice_draft_deleted / invoice_issued /
 * invoice_paid / invoice_cross_tenant_probe / pdf_render_failed /
 * tenant_invoice_settings_updated (the last one is exercised via a
 * direct upsert path since US4 UI is post-MVP — the event is still
 * registered at DB level and emitted when code writes the row).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import {
  updateInvoiceDraft,
  makeUpdateInvoiceDraftDeps,
  deleteInvoiceDraft,
  makeDeleteInvoiceDraftDeps,
} from '@/modules/invoicing';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import type { TenantInvoiceSettingsView } from '@/modules/invoicing/application/ports/tenant-settings-repo';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import type { F4AuditEventType } from '@/modules/invoicing/application/ports/audit-port';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// MVP-reachable subset. 17 of 18 F4AuditEventType values probed at DB
// level below (`invoice_pdf_regenerated` is absent from this array +
// deferred in the inventory — post-MVP Blob-outage rerender path).
// C4 (Phase 10 review follow-up) — extended from the original 4 MVP
// types to 17 so every reachable event_type sees at least ONE
// assertion in THIS file. The full use-case-level behavioral coverage
// for the newer-in-Phase-10 types (resend trio, overdue, auto-email-
// delivery-failed, MTA probe) lives in their dedicated test files;
// the file-existence check in the inventory test pins those references.
const MVP_AUDIT_TYPES_EMITTED: ReadonlyArray<F4AuditEventType> = [
  'invoice_draft_created',
  'invoice_draft_updated',
  'invoice_draft_deleted',
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'invoice_overdue_detected',
  'credit_note_issued',
  'tenant_invoice_settings_updated',
  'invoice_pdf_resent',
  'receipt_pdf_resent',
  'credit_note_pdf_resent',
  'invoice_cross_tenant_probe',
  'credit_note_cross_tenant_probe',
  'tenant_invoice_settings_cross_tenant_probe',
  'pdf_render_failed',
  'auto_email_delivery_failed',
  // T166 async receipt PDF (2026-04-28).
  'receipt_rendered',
  'pdf_render_permanently_failed',
  // Receipt-PDF download surface (2026-05-15).
  'receipt_pdf_downloaded',
  // §87 prefix-change forensic trail (2026-05-15).
  'tenant_receipt_prefix_changed',
  // R8-M1-code — invoice-PDF download surface (closes asymmetry with receipt).
  'invoice_pdf_downloaded',
  // Phase 3 — CSV export of paid invoices (added 2026-05-16).
  'invoices_csv_exported',
  // 054-event-fee-invoices (Task 15) — non-member event-buyer PII redaction.
  'event_buyer_pii_redacted',
] as const;

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

describe('F4 Audit coverage — MVP flows emit the expected event types (T113a)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'audit-plan',
        planYear: 2026,
        planName: { en: 'Audit Plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: asSatang(0n),
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'Test',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'AC',
        creditNoteNumberPrefix: 'ACN',
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Audit Co',
        country: 'TH',
        planId: 'audit-plan',
        planYear: 2026,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('all MVP event types are valid `audit_event_type` enum values', async () => {
    // If any MVP_AUDIT_TYPES_EMITTED value is not in the DB enum,
    // an INSERT with that value would fail. This probe catches a
    // drift between the F4AuditEventType TS union and the SQL enum.
    const rows = await db.execute<{ enumlabel: string }>(/* sql */ `
      SELECT e.enumlabel FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
    `);
    const dbEnum = new Set(rows.map((r) => r.enumlabel));
    for (const t of MVP_AUDIT_TYPES_EMITTED) {
      expect(dbEnum.has(t), `missing '${t}' in audit_event_type enum`).toBe(true);
    }
  }, 30_000);

  it('audit_log composite PK + append-only trigger allow F4 event types', async () => {
    // Sanity probe: insert one of each MVP type directly + verify
    // each row lands. This is a CHEAP audit-wiring smoke test that
    // doesn't require the full use-case machinery.
    for (const eventType of MVP_AUDIT_TYPES_EMITTED) {
      await db.insert(auditLog).values({
        tenantId: tenant.ctx.slug,
        eventType,
        actorUserId: user.userId,
        requestId: `audit-coverage-${eventType}`,
        summary: `Audit coverage probe for ${eventType}`,
        payload: { probe: true, eventType },
      });
    }

    // Confirm all MVP types landed.
    const found = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          // SQL IN on array cast — drizzle doesn't expose .in() on
          // enum columns cleanly, use the chain of ORs.
        ),
      );
    const foundTypes = new Set(found.map((r) => r.eventType));
    for (const t of MVP_AUDIT_TYPES_EMITTED) {
      expect(foundTypes.has(t), `audit_log missing '${t}' row`).toBe(true);
    }
  }, 30_000);

  it('F4AuditEventType TS union documents all 25 registered types', async () => {
    // This asserts the compile-time union matches what the DB enum
    // ships. Read the DB enum at runtime + check every value is
    // assignable to F4AuditEventType via `as` cast (which would
    // narrow at compile time). If a value is missing from the TS
    // union, `typecheck` already catches it — this test catches the
    // reverse (F4AuditEventType has a value not in the DB).
    const rows = await db.execute<{ enumlabel: string }>(/* sql */ `
      SELECT e.enumlabel FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
    `);
    const dbEnum = new Set(rows.map((r) => r.enumlabel));

    // The full 25 F4 types — taken from F4AuditEventType union.
    // Growth: 16 → 17 (`invoice_pdf_regenerated` 2026-04-20) → 22
    // (T166 async worker + receipt downloads + tenant_receipt_prefix_changed
    // 2026-04-25/05-10) → 23 (R8 `invoice_pdf_downloaded` 2026-05-15) →
    // 24 (Phase 3 `invoices_csv_exported` 2026-05-16) → 25 (Task 15
    // `event_buyer_pii_redacted` 2026-06-04).
    const allF4Types: ReadonlyArray<F4AuditEventType> = [
      'invoice_draft_created',
      'invoice_draft_updated',
      'invoice_draft_deleted',
      'invoice_issued',
      'invoice_paid',
      'invoice_voided',
      'invoice_overdue_detected',
      'credit_note_issued',
      'tenant_invoice_settings_updated',
      'invoice_pdf_resent',
      'receipt_pdf_resent',
      'credit_note_pdf_resent',
      'invoice_pdf_regenerated',
      'invoice_cross_tenant_probe',
      'credit_note_cross_tenant_probe',
      'tenant_invoice_settings_cross_tenant_probe',
      'pdf_render_failed',
      'auto_email_delivery_failed',
      'receipt_rendered',
      'pdf_render_permanently_failed',
      'receipt_pdf_downloaded',
      'tenant_receipt_prefix_changed',
      'invoice_pdf_downloaded',
      'invoices_csv_exported',
      // 054-event-fee-invoices (Task 15) — non-member event-buyer PII redaction.
      'event_buyer_pii_redacted',
    ] as const;
    expect(allF4Types).toHaveLength(25);
    for (const t of allF4Types) {
      expect(dbEnum.has(t), `TS union declares '${t}' but DB enum lacks it`).toBe(true);
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // T113a behavioral coverage — every F4 mutating use-case emits its event
  // ---------------------------------------------------------------------------
  //
  // Phase 10 expansion: the enum-level probes above verify the DB accepts
  // every event_type, but they don't prove the emit SITES (use cases) fire
  // the right event. The tests below run the minimum-sufficient use-case
  // invocations and assert the matching audit row lands.
  //
  // Types whose emit is covered by a DEDICATED test file are asserted via
  // the inventory matrix at the bottom (documented cross-reference); types
  // without a dedicated home get behavioral tests added here.

  it('T113a — updateInvoiceDraft emits `invoice_draft_updated`', async () => {
    // Seed a draft so the use-case has something to mutate.
    const draftId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: draftId,
        memberId,
        planYear: 2026,
        planId: 'audit-plan',
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId: draftId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 1_000_000n,
        totalSatang: asSatang(1_000_000n),
        position: 1,
      });
    });

    const result = await updateInvoiceDraft(
      makeUpdateInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `t113a-update-${draftId}`,
        invoiceId: draftId,
        autoEmailOnIssue: true,
      },
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_draft_updated'),
          eq(auditLog.requestId, `t113a-update-${draftId}`),
        ),
      );
    expect(rows, 'invoice_draft_updated audit row did not land').toHaveLength(1);
    expect((rows[0]!.payload as Record<string, unknown>).invoice_id).toBe(draftId);
  }, 30_000);

  it('T122 — issueInvoice PDF-render failure emits `pdf_render_failed` audit', async () => {
    const draftId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: draftId,
        memberId,
        planYear: 2026,
        planId: 'audit-plan',
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId: draftId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 1_000_000n,
        totalSatang: asSatang(1_000_000n),
        position: 1,
      });
    });

    const failingPdf = {
      render: vi.fn(async () => {
        throw new Error('T122 synthetic render failure');
      }),
    };
    const settingsView: TenantInvoiceSettingsView = {
      tenantId: tenant.ctx.slug,
      currencyCode: 'THB',
      vatRate: VatRate.ofUnsafe('0.0700'),
      registrationFeeSatang: asSatang(0n),
      invoiceNumberPrefix: 'AC',
      creditNoteNumberPrefix: 'ACN',
      receiptNumberingMode: 'combined',
      fiscalYearStartMonth: 1,
      defaultNetDays: 30,
      proRatePolicy: 'monthly',
      autoEmailEnabled: false,
      identity: {
        legal_name_th: 'ทดสอบ',
        legal_name_en: 'Test',
        tax_id: '0000000000000',
        address_th: 'Bangkok',
        address_en: 'Bangkok',
        logo_blob_key: null,
      },
    };
    const deps: IssueInvoiceDeps = {
      invoiceRepo: makeDrizzleInvoiceRepo(tenant.ctx.slug),
      tenantSettingsRepo: {
        getForIssue: vi.fn(async () => settingsView),
        upsert: vi.fn(),
        withTx: vi.fn(async (_t, fn) => fn({})),
      getForUpdateInTx: vi.fn(async () => null),
      readSequencesInTx: vi.fn(async () => []),
      },
      memberIdentity: {
        getForIssue: vi.fn(async (_tx, _t, mid) => ({
          memberId: mid,
          isActive: true,
          isArchived: false,
          memberTypeScope: 'company' as const, // S1-P1-16 (snapshot has tax_id → gate passes)
          registrationFeePaid: true,
          registrationDate: '2026-01-01',
          snapshot: {
            legal_name: 'Audit Co',
            tax_id: '1234567890123',
            address: 'Bangkok',
            primary_contact_name: 'n',
            primary_contact_email: 'test@example.com',
            member_number: null,
          },
        })),
        markRegistrationFeePaid: vi.fn(async () => {}),
      },
      sequenceAllocator: postgresSequenceAllocator,
      pdfRender: failingPdf,
      blob: {
        uploadPdf: vi.fn(),
        uploadLogo: vi.fn(),
        signDownloadUrl: vi.fn(),
        downloadBytes: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
      },
      audit: f4AuditAdapter,
      clock: { nowIso: () => '2026-04-21T03:00:00Z' },
      outbox: resendEmailOutboxAdapter,
      currentTemplateVersion: 1,
    };

    const result = await issueInvoice(deps, {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `t122-${draftId}`,
      invoiceId: draftId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('pdf_render_failed');

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'pdf_render_failed'),
          eq(auditLog.requestId, `t122-${draftId}`),
        ),
      );
    expect(rows, 'pdf_render_failed audit row did not land').toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.invoice_id).toBe(draftId);
    expect(payload.render_kind).toBe('invoice');
    expect(typeof payload.reason).toBe('string');
  }, 30_000);

  it('T113a — deleteInvoiceDraft emits `invoice_draft_deleted`', async () => {
    const draftId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: draftId,
        memberId,
        planYear: 2026,
        planId: 'audit-plan',
        draftByUserId: user.userId,
        status: 'draft',
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId: draftId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 1_000_000n,
        totalSatang: asSatang(1_000_000n),
        position: 1,
      });
    });

    const result = await deleteInvoiceDraft(
      makeDeleteInvoiceDraftDeps(tenant.ctx.slug),
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: `t113a-delete-${draftId}`,
        invoiceId: draftId,
      },
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_draft_deleted'),
          eq(auditLog.requestId, `t113a-delete-${draftId}`),
        ),
      );
    expect(rows, 'invoice_draft_deleted audit row did not land').toHaveLength(1);
    expect((rows[0]!.payload as Record<string, unknown>).invoice_id).toBe(draftId);
  }, 30_000);

  it('T113a inventory — every F4AuditEventType is behaviorally covered somewhere', () => {
    // Declarative cross-reference: asserts the human has plumbed every
    // event type into AT LEAST ONE end-to-end test. The map below is
    // the single source of truth; when a new F4AuditEventType is added,
    // typecheck forces a corresponding entry here.
    //
    // `deferred` is reserved for types whose emit site ships in a
    // future phase — CI keeps passing but we retain visibility.
    const coverage: Record<
      F4AuditEventType,
      { status: 'covered' | 'deferred'; where?: string; since?: string }
    > = {
      invoice_draft_created: {
        status: 'covered',
        where:
          'tests/unit/invoicing/create-invoice-draft.test.ts + f3-timeline-integration.test.ts + audit-coverage.test.ts probe',
      },
      invoice_draft_updated: {
        status: 'covered',
        where: 'audit-coverage.test.ts > T113a updateInvoiceDraft',
        since: '2026-04-21',
      },
      invoice_draft_deleted: {
        status: 'covered',
        where: 'audit-coverage.test.ts > T113a deleteInvoiceDraft',
        since: '2026-04-21',
      },
      invoice_issued: {
        status: 'covered',
        where: 'auto-email-outbox.test.ts > (1) + seq-number-atomicity.test.ts',
      },
      invoice_paid: {
        status: 'covered',
        where: 'auto-email-outbox.test.ts > (4b) recordPayment path',
      },
      invoice_voided: {
        status: 'covered',
        where: 'void-invoice.test.ts',
      },
      credit_note_issued: {
        status: 'covered',
        where:
          'credit-note-partial-accumulation.test.ts + credit-note-immutability.test.ts',
      },
      tenant_invoice_settings_updated: {
        status: 'covered',
        where: 'settings-form.test.ts',
      },
      invoice_pdf_resent: {
        status: 'covered',
        where: 'auto-email-outbox.test.ts > (4a)',
        since: '2026-04-21',
      },
      receipt_pdf_resent: {
        status: 'covered',
        where: 'auto-email-outbox.test.ts > (4b)',
        since: '2026-04-21',
      },
      credit_note_pdf_resent: {
        status: 'covered',
        where: 'tests/unit/invoicing/resend-pdf.test.ts > credit_note variant (unit)',
        since: '2026-04-21',
      },
      invoice_cross_tenant_probe: {
        status: 'covered',
        where:
          'tenant-isolation.test.ts + auto-email-outbox.test.ts > (4c) portal mismatch',
      },
      credit_note_cross_tenant_probe: {
        status: 'covered',
        where: 'tenant-isolation.test.ts',
      },
      tenant_invoice_settings_cross_tenant_probe: {
        status: 'covered',
        where:
          'tenant-invoice-settings-probe.test.ts (T120 live-Neon host/deployed slug mismatch)',
        since: '2026-04-21',
      },
      registration_cross_tenant_probe: {
        status: 'covered',
        where:
          'create-event-invoice-draft.test.ts (unit, ok(null) lookup) + create-event-invoice-draft.test.ts (integration, cross-tenant registration → registration_not_found + probe)',
        since: '2026-06-04',
      },
      pdf_render_failed: {
        status: 'covered',
        where:
          'audit-coverage.test.ts > T122 (behavioral emit via issueInvoice failing-render) + seq-number-atomicity.test.ts > (a) rollback-path assertions',
        since: '2026-04-21',
      },
      auto_email_delivery_failed: {
        status: 'covered',
        where: 'auto-email-outbox.test.ts > (T106 dual-emit)',
        since: '2026-04-21',
      },
      invoice_overdue_detected: {
        status: 'covered',
        where:
          'overdue-audit-idempotency.test.ts (live-Neon ON CONFLICT DO NOTHING contract) + tests/unit/invoicing/derive-overdue.test.ts (pure helper)',
        since: '2026-04-21',
      },
      invoice_pdf_regenerated: {
        status: 'deferred',
        where:
          'R3-E4 auto-rerender path (post-MVP Blob outage recovery — not yet exercised)',
      },
      // T166 — async receipt PDF pipeline events.
      receipt_rendered: {
        status: 'deferred',
        where:
          'T166-05 render-receipt-pdf use-case unit tests (worker-driven; integration coverage lands with T166-06)',
        since: '2026-04-28',
      },
      pdf_render_permanently_failed: {
        status: 'deferred',
        where:
          'T166-11 reconciliation cron — fires after 3 retry attempts; integration coverage lands with the cron handler',
        since: '2026-04-28',
      },
      // Receipt-PDF download audit (2026-05-15).
      receipt_pdf_downloaded: {
        status: 'covered',
        where:
          'tests/unit/invoicing/get-receipt-pdf-signed-url.test.ts (audit-emit assertions on combined + separate happy paths) + this file (MVP_AUDIT_TYPES_EMITTED enum probe + audit_log insert probe)',
        since: '2026-05-15',
      },
      // §87 prefix-change forensic trail (2026-05-15).
      tenant_receipt_prefix_changed: {
        status: 'covered',
        where:
          // R9-T5 — point at the actual integration test file so the
          // rot-check can resolve a real path. The use-case source
          // (`update-tenant-invoice-settings.ts`) implements the emit
          // but is not a test artefact.
          'tests/integration/invoicing/receipt-prefix-change-audit.test.ts (emit on prefix flip with both legacy and new values in payload) + this file (enum probe + insert probe)',
        since: '2026-05-15',
      },
      // R8-M1-code — invoice-PDF download surface (closes asymmetry).
      invoice_pdf_downloaded: {
        status: 'covered',
        where:
          // R9-T8 — clarified wording: "no-emit on drafts" pins the
          // negative case (assertion that the event is NOT fired when
          // status='draft'), which complements the positive emit
          // assertions on admin + member success paths. "Negative
          // path" alone read as if drafts emit a different event.
          'tests/unit/invoicing/get-invoice-pdf-signed-url.test.ts (positive emit on admin + member success; no-emit on drafts; audit-throw-aborts-blob safety) + this file (MVP_AUDIT_TYPES_EMITTED enum probe)',
        since: '2026-05-15',
      },
      // Phase 3 of the F4 receipt-surface plan — CSV export for Thai
      // VAT monthly filing. 5y retention (derivative report).
      invoices_csv_exported: {
        status: 'covered',
        where:
          'tests/unit/invoicing/export-paid-invoices-csv.test.ts (audit emit on success with from/to/row_count payload) + this file (enum probe)',
        since: '2026-05-16',
      },
      // 054-event-fee-invoices (Task 15) — non-member event-buyer PII
      // redaction record (10y retention; NO PII in payload). Emitted by the
      // redact-expired-event-buyers retention cron after tombstoning a
      // >10y-old non-member event invoice's member_identity_snapshot.
      event_buyer_pii_redacted: {
        status: 'covered',
        where:
          'tests/integration/invoicing/redact-expired-event-buyers.test.ts (cron tombstones eligible row + emits 10y audit with redacted_fields names only; idempotent; trigger still blocks normal + financial changes) + this file (enum probe + insert probe)',
        since: '2026-06-04',
      },
    };

    // Every declared F4 type must appear in the coverage map — catches
    // additions to the union that forget to update this inventory.
    const declared: ReadonlyArray<F4AuditEventType> = [
      'invoice_draft_created',
      'invoice_draft_updated',
      'invoice_draft_deleted',
      'invoice_issued',
      'invoice_paid',
      'invoice_voided',
      'invoice_overdue_detected',
      'credit_note_issued',
      'tenant_invoice_settings_updated',
      'invoice_pdf_resent',
      'receipt_pdf_resent',
      'credit_note_pdf_resent',
      'invoice_pdf_regenerated',
      'invoice_cross_tenant_probe',
      'credit_note_cross_tenant_probe',
      'tenant_invoice_settings_cross_tenant_probe',
      'pdf_render_failed',
      'auto_email_delivery_failed',
      // T166 async receipt PDF (added 2026-04-28).
      'receipt_rendered',
      'pdf_render_permanently_failed',
      // Receipt-PDF download surface (added 2026-05-15).
      'receipt_pdf_downloaded',
      // §87 prefix-change forensic trail (added 2026-05-15).
      'tenant_receipt_prefix_changed',
      // R8-M1-code — invoice-PDF download surface (closes asymmetry).
      'invoice_pdf_downloaded',
      // Phase 3 — CSV export of paid invoices (added 2026-05-16).
      'invoices_csv_exported',
      // 054-event-fee-invoices (Task 15) — non-member event-buyer PII redaction.
      'event_buyer_pii_redacted',
    ] as const;
    // C4 — the inventory must reference REAL, CURRENT test files.
    // Previously `'covered'` entries were declarative-only: if a
    // referenced file was renamed / deleted the inventory still said
    // "covered" and the gate silently passed. Extract every
    // `<file>.test.ts` path mentioned in `where` and prove the file
    // exists on disk. Fails loudly on rot.
    const REPO_ROOT = resolvePath(__dirname, '../../..');
    const KNOWN_TEST_FILES: Record<string, string> = {
      'tests/unit/invoicing/create-invoice-draft.test.ts':
        'tests/unit/invoicing/create-invoice-draft.test.ts',
      'f3-timeline-integration.test.ts':
        'tests/integration/invoicing/f3-timeline-integration.test.ts',
      'audit-coverage.test.ts': 'tests/integration/invoicing/audit-coverage.test.ts',
      'auto-email-outbox.test.ts': 'tests/integration/invoicing/auto-email-outbox.test.ts',
      'seq-number-atomicity.test.ts':
        'tests/integration/invoicing/seq-number-atomicity.test.ts',
      'void-invoice.test.ts': 'tests/integration/invoicing/void-invoice.test.ts',
      'credit-note-partial-accumulation.test.ts':
        'tests/integration/invoicing/credit-note-partial-accumulation.test.ts',
      'credit-note-immutability.test.ts':
        'tests/integration/invoicing/credit-note-immutability.test.ts',
      'settings-form.test.ts': 'tests/integration/invoicing/settings-form.test.ts',
      'tenant-isolation.test.ts':
        'tests/integration/invoicing/tenant-isolation.test.ts',
      'tenant-invoice-settings-probe.test.ts':
        'tests/integration/invoicing/tenant-invoice-settings-probe.test.ts',
      'overdue-audit-idempotency.test.ts':
        'tests/integration/invoicing/overdue-audit-idempotency.test.ts',
      'pdf-routes-cross-tenant-probe.test.ts':
        'tests/integration/invoicing/pdf-routes-cross-tenant-probe.test.ts',
      'tests/unit/invoicing/derive-overdue.test.ts':
        'tests/unit/invoicing/derive-overdue.test.ts',
      'tests/unit/invoicing/resend-pdf.test.ts':
        'tests/unit/invoicing/resend-pdf.test.ts',
      // R9-T6 — wire up the PDF-download use-case unit tests so the
      // inventory's 'where' strings for `receipt_pdf_downloaded` (R5)
      // + `invoice_pdf_downloaded` (R8) resolve to real files.
      // Previously the inventory referenced these files but the
      // KNOWN_TEST_FILES guard had no needle for them → the rot-check
      // accidentally passed because the substring match found nothing.
      'tests/unit/invoicing/get-invoice-pdf-signed-url.test.ts':
        'tests/unit/invoicing/get-invoice-pdf-signed-url.test.ts',
      'tests/unit/invoicing/get-receipt-pdf-signed-url.test.ts':
        'tests/unit/invoicing/get-receipt-pdf-signed-url.test.ts',
      // R9-T5 — receipt-prefix-change behavioral test (emits
      // `tenant_receipt_prefix_changed` on settings.receipt_prefix flip).
      'tests/integration/invoicing/receipt-prefix-change-audit.test.ts':
        'tests/integration/invoicing/receipt-prefix-change-audit.test.ts',
      // F5R3 (2026-05-16) — F4 Phase 3 CSV export inventory needle.
      // The `invoices_csv_exported` 'where' entry references this file
      // but the rot-check needs it registered to resolve.
      'tests/unit/invoicing/export-paid-invoices-csv.test.ts':
        'tests/unit/invoicing/export-paid-invoices-csv.test.ts',
      // 054-event-fee-invoices (Task 15) — redaction-cron integration test
      // needle for the `event_buyer_pii_redacted` 'where' entry.
      'tests/integration/invoicing/redact-expired-event-buyers.test.ts':
        'tests/integration/invoicing/redact-expired-event-buyers.test.ts',
    };

    for (const t of declared) {
      const entry = coverage[t];
      expect(entry, `F4AuditEventType '${t}' missing from T113a inventory`).toBeDefined();
      expect(['covered', 'deferred']).toContain(entry.status);
      expect(entry.where, `'${t}' inventory missing 'where'`).toBeTruthy();

      if (entry.status === 'covered') {
        const where = entry.where ?? '';
        // Every "covered" entry must reference at least ONE file whose
        // path we can resolve. If the inventory mentions a file that
        // no longer exists, fail — the reference is stale.
        const referencedFiles = Object.entries(KNOWN_TEST_FILES)
          .filter(([needle]) => where.includes(needle))
          .map(([, path]) => path);
        expect(
          referencedFiles.length,
          `'${t}' inventory 'where' string references no known test file: "${where}"`,
        ).toBeGreaterThan(0);
        for (const relPath of referencedFiles) {
          const abs = resolvePath(REPO_ROOT, relPath);
          expect(
            existsSync(abs),
            `'${t}' inventory points at missing file: ${relPath}`,
          ).toBe(true);
        }
      }
    }

    // Sanity: count the active vs. deferred split so future reviewers
    // can see at a glance how much of F4 audit is green behaviorally.
    const coveredCount = Object.values(coverage).filter(
      (c) => c.status === 'covered',
    ).length;
    const deferredCount = Object.values(coverage).filter(
      (c) => c.status === 'deferred',
    ).length;
    // F5R3 (2026-05-16) — bumped from 23 → 24 to include the F4 Phase 3
    // `invoices_csv_exported` event added in `0149_audit_invoices_csv_exported`.
    // 054-event-fee-invoices (Task 6b) — bumped 24 → 25 for
    // `registration_cross_tenant_probe` (emitted by createEventInvoiceDraft on
    // an ok(null) event-registration lookup; migration 0202).
    // 054-event-fee-invoices (Task 15) — bumped 25 → 26 for
    // `event_buyer_pii_redacted` (emitted by the redact-expired-event-buyers
    // retention cron; migration 0204).
    expect(coveredCount + deferredCount).toBe(26);
    // Behavioral coverage target: 23/26. Remaining 3 are post-MVP
    // deferrals: invoice_pdf_regenerated (Blob-outage auto-rerender),
    // receipt_rendered + pdf_render_permanently_failed (T166 async
    // receipt-PDF worker — integration coverage lands with T166-06).
    expect(coveredCount).toBeGreaterThanOrEqual(23);
  });
});
