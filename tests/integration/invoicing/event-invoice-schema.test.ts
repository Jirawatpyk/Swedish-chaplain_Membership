/**
 * 054-event-fee-invoices (Task 4) — `invoices` event-subject schema
 * integration test (live Neon).
 *
 * Pins the migration-0201 generalisation against the database so a future
 * `DROP CONSTRAINT` / `DROP NOT NULL` regression breaks CI rather than
 * silently shipping. Unit mocks cannot exercise these DB-level guarantees
 * (the CHECK, the partial unique index, the composite FK) — they only show
 * up against live Postgres (F4-R8 discipline).
 *
 * Scenarios:
 *   (1) An `invoice_subject='event'` draft with member_id/plan_id/plan_year
 *       NULL + event_id + event_registration_id set persists, and
 *       `rowsToInvoice` maps invoiceSubject/memberId/eventRegistrationId.
 *   (2) The CHECK `invoices_subject_fields_ck` rejects a membership row with
 *       member_id NULL.
 *   (3) The partial unique index rejects a SECOND non-void event invoice for
 *       the same (tenant_id, event_registration_id), but ALLOWS a second once
 *       the first is voided (status='void').
 *
 * The composite FK `invoices_event_registration_fk` is satisfied by seeding a
 * real F6 `event_registrations` row first; cross-tenant FK/RLS isolation is
 * the subject of the dedicated cross-tenant probe test (Task 5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { events, eventRegistrations } from '@/modules/events/infrastructure/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { issueInvoice } from '@/modules/invoicing/application/use-cases/issue-invoice';
import type { IssueInvoiceDeps } from '@/modules/invoicing/application/use-cases/issue-invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const SEED_FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

/** Seed a minimal F6 event + registration so the composite FK is satisfied. */
async function seedRegistration(
  tenant: TestTenant,
): Promise<{ eventId: string; registrationId: string }> {
  const eventId = randomUUID();
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(events).values({
      eventId,
      tenantId: tenant.ctx.slug,
      externalId: `evt-fee-${randomUUID().slice(0, 8)}`,
      source: 'admin_manual',
      name: 'Event-fee invoice test event',
      startDate: SEED_FAR_FUTURE,
      isPartnerBenefit: false,
      isCulturalEvent: false,
    });
    await tx.insert(eventRegistrations).values({
      registrationId,
      tenantId: tenant.ctx.slug,
      eventId,
      externalId: `att-${randomUUID().slice(0, 8)}`,
      attendeeEmail: `attendee-${randomUUID().slice(0, 8)}@evt-fee.test`,
      attendeeName: 'Event Fee Attendee',
      matchType: 'non_member',
      paymentStatus: 'paid',
      registeredAt: new Date(),
    });
  });
  return { eventId, registrationId };
}

/**
 * Assert a callback throws a Postgres error whose SQLSTATE matches the
 * supplied code (Drizzle wraps the PostgresError under `.cause`).
 *   - 23514 = check_violation
 *   - 23505 = unique_violation
 */
async function expectPgError(fn: () => Promise<unknown>, sqlstate: string): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).not.toBeNull();
  const err = caught as { cause?: { code?: string }; code?: string };
  const code = err.cause?.code ?? err.code ?? null;
  expect(code).toBe(sqlstate);
}

describe('invoices event-subject schema — 054-event-fee-invoices (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('(1) persists an event-subject draft (null member/plan) + maps via rowsToInvoice', async () => {
    const { eventId, registrationId } = await seedRegistration(tenant);
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const invoiceId = asInvoiceId(randomUUID());

    const invoice = await repo.withTx((tx) =>
      repo.insertDraft(tx, {
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId: null,
        planId: null,
        planYear: null,
        invoiceSubject: 'event',
        eventId,
        eventRegistrationId: registrationId,
        vatInclusive: true,
        draftByUserId: user.userId,
        autoEmailOnIssue: null,
        lines: [],
      }),
    );

    // Domain mapping (rowsToInvoice) round-trip.
    expect(invoice.invoiceSubject).toBe('event');
    expect(invoice.memberId).toBeNull();
    expect(invoice.planId).toBeNull();
    expect(invoice.planYear).toBeNull();
    expect(invoice.eventId).toBe(eventId);
    expect(invoice.eventRegistrationId).toBe(registrationId);
    expect(invoice.vatInclusive).toBe(true);

    // Persisted row matches.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(invoices).where(eq(invoices.invoiceId, invoiceId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invoiceSubject).toBe('event');
    expect(rows[0]!.memberId).toBeNull();
    expect(rows[0]!.eventRegistrationId).toBe(registrationId);
    expect(rows[0]!.vatInclusive).toBe(true);
  }, 60_000);

  it('(2) CHECK rejects a membership row with member_id NULL', async () => {
    await expectPgError(
      () =>
        runInTenant(tenant.ctx, (tx) =>
          tx.insert(invoices).values({
            tenantId: tenant.ctx.slug,
            invoiceId: randomUUID(),
            // invoice_subject defaults to 'membership' → CHECK requires
            // member_id/plan_id/plan_year. Leave them NULL → violation.
            memberId: null,
            planId: null,
            planYear: null,
            draftByUserId: user.userId,
            status: 'draft',
          }),
        ),
      '23514',
    );
  }, 60_000);

  it('(3) partial unique index — one non-void event invoice per registration; void is excluded', async () => {
    // --- Sub-test A: uniqueness enforcement ---
    // Use one registration for the rejection proof.
    const { eventId: eventIdA, registrationId: registrationIdA } =
      await seedRegistration(tenant);

    async function insertDraft(regId: string, eid: string): Promise<string> {
      const invoiceId = randomUUID();
      await runInTenant(tenant.ctx, (tx) =>
        tx.insert(invoices).values({
          tenantId: tenant.ctx.slug,
          invoiceId,
          memberId: null,
          planId: null,
          planYear: null,
          invoiceSubject: 'event',
          eventId: eid,
          eventRegistrationId: regId,
          status: 'draft',
          draftByUserId: user.userId,
        }),
      );
      return invoiceId;
    }

    // First non-void (draft) event invoice for registration A — OK.
    await insertDraft(registrationIdA, eventIdA);

    // Second non-void event invoice for the SAME registration — rejected by
    // the partial unique index (23505).
    await expectPgError(() => insertDraft(registrationIdA, eventIdA), '23505');

    // The index DDL's partial predicate MUST exclude voided invoices — this
    // is the "a voided event invoice frees the registration for re-issue"
    // contract. Assert the predicate is literally `status <> 'void'` (and
    // scoped to event rows) so a regression that drops/weakens the WHERE
    // clause — e.g. mistakenly to `status <> 'voided'`, a non-existent enum
    // value that would make the predicate always-true and silently widen
    // the index to cover voided rows — breaks CI.
    const idxDef = await runInTenant(tenant.ctx, (tx) =>
      tx.execute(
        sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'invoices_event_registration_uniq'`,
      ),
    );
    const indexdef = (idxDef as unknown as Array<{ indexdef: string }>)[0]?.indexdef ?? '';
    expect(indexdef).toContain(`(invoice_subject = 'event'::invoice_subject)`);
    expect(indexdef).toContain(`status <> 'void'::invoice_status`);
    // Negative guard: the broken `'voided'` literal must NOT appear.
    expect(indexdef).not.toContain(`'voided'`);

    // --- Sub-test B: void frees the registration slot ---
    // Use a FRESH registration so the still-live draft from sub-test A
    // cannot interfere with the void-allows proof.
    //
    // Approach (Option B): insert the voided invoice directly with
    // `status='void'` + all fields required by the non-draft lifecycle
    // CHECK constraints, then assert a non-void draft for the SAME
    // registration coexists without a 23505.
    //
    // Why not draft→void UPDATE (Option A): a draft row has no
    // `sequence_number`, and `invoices_draft_has_no_number` requires
    // `status='draft' OR sequence_number IS NOT NULL` — flipping a
    // bare draft to void would violate that CHECK. Inserting the row
    // directly as void with all required fields is the schema-valid path
    // that correctly represents a real invoice that went through the
    // full issue→void lifecycle.
    const { eventId: eventIdB, registrationId: registrationIdB } =
      await seedRegistration(tenant);

    const VOID_MEMBER_SNAPSHOT = {
      legal_name: 'Event Buyer Co',
      address: 'Bangkok',
      primary_contact_name: 'Test Attendee',
      primary_contact_email: 'attendee@void-test.example',
    };
    const voidInvoiceId = randomUUID();

    // Insert a fully-coherent voided event invoice (all non-draft CHECKs met).
    // `invoices_non_draft_has_snapshots` (live DB definition, confirmed via
    // `pg_get_constraintdef`) requires: subtotal_satang, vat_rate_snapshot,
    // vat_satang, total_satang, fiscal_year, sequence_number, document_number,
    // issue_date, due_date, pro_rate_policy_snapshot, net_days_snapshot,
    // tenant_identity_snapshot, member_identity_snapshot, pdf_blob_key,
    // pdf_sha256, pdf_template_version — all non-null.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: voidInvoiceId,
        memberId: null,
        planId: null,
        planYear: null,
        invoiceSubject: 'event',
        eventId: eventIdB,
        eventRegistrationId: registrationIdB,
        status: 'void',
        draftByUserId: user.userId,
        fiscalYear: 2099,
        sequenceNumber: 99001,
        documentNumber: 'EVT-2099-099001',
        subtotalSatang: 100000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7000n,
        totalSatang: 107000n,
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legal_name_en: 'Test Chamber', tax_id: '0000000000000' },
        memberIdentitySnapshot: VOID_MEMBER_SNAPSHOT,
        pdfBlobKey: `event-invoices/${voidInvoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        // 064 (Task 2) — non-draft rows must say what their main PDF is
        // (`invoices_non_draft_has_doc_kind`). This buyer snapshot has no
        // tax_id, so the issue path would have rendered a §105 receipt.
        pdfDocKind: 'receipt_separate',
        voidedAt: new Date(),
        voidReason: 'voided to release registration slot (test)',
        voidedByUserId: user.userId,
      }),
    );

    // Guard against a false-positive: confirm the void row really landed,
    // otherwise the "draft succeeds" assertion below would pass even if the
    // void INSERT had silently failed.
    const voidExists = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.invoiceId, voidInvoiceId))),
    );
    expect(voidExists[0]!.n).toBe(1);

    // A non-void draft for the SAME registration MUST succeed — the void row is
    // excluded from the partial unique index (predicate: `status <> 'void'`).
    const afterVoidId = await insertDraft(registrationIdB, eventIdB);
    expect(afterVoidId).not.toBe(voidInvoiceId);

    // Sanity: exactly one non-void event invoice for registration B.
    const live = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, tenant.ctx.slug),
            eq(invoices.eventRegistrationId, registrationIdB),
            sql`status <> 'void'`,
          ),
        ),
    );
    expect(live[0]!.n).toBe(1);
  }, 90_000);
});

/**
 * 064-event-invoice-paid-flow (Task 2) — `invoices.pdf_doc_kind` column.
 *
 * Persists WHAT the main PDF actually is (§86/4 'invoice', combined
 * §86/4+§105ทวิ 'receipt_combined', §105 'receipt_separate') so downstream
 * code (the J2 credit-note annotation re-render) never has to derive it. The
 * migration backfills every pre-existing non-draft row; new non-draft rows
 * MUST carry the kind (CHECK `invoices_non_draft_has_doc_kind`).
 *
 * Scenarios:
 *   (1) Issuing a MEMBERSHIP invoice through the REAL `issueInvoice` use-case
 *       (real repos + allocator + identity adapter on live Neon; mocked PDF
 *       renderer + Blob, mirroring issue-vs-archive-race.test.ts) persists
 *       `pdf_doc_kind='invoice'` and `rowsToInvoice` maps it onto
 *       `Invoice.pdfDocKind`.
 *   (2) Backfill completeness — across ALL tenants (owner connection), no
 *       non-draft row has a NULL `pdf_doc_kind`.
 */
describe('invoices.pdf_doc_kind — 064-event-invoice-paid-flow Task 2 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'pdk-task2-plan';

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

  function makeDeps(tenantId: string): IssueInvoiceDeps {
    return {
      invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
      tenantSettingsRepo: drizzleTenantSettingsRepo,
      memberIdentity: memberIdentityAdapter,
      sequenceAllocator: postgresSequenceAllocator,
      pdfRender: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
          sha256: Sha256Hex.ofUnsafe('a'.repeat(64)),
        })),
      },
      blob: {
        uploadPdf: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
        uploadLogo: vi.fn(async ({ key }) => ({ key, url: `https://blob.test/${key}` })),
        signDownloadUrl: vi.fn(async () => 'https://blob.test/signed'),
        downloadBytes: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => [] as string[]),
      },
      audit: f4AuditAdapter,
      clock: { nowIso: () => '2026-06-10T10:00:00Z' },
      outbox: { enqueue: vi.fn(async () => {}) },
      currentTemplateVersion: 1,
    };
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'PDK Task2 Plan' },
        description: { en: 'pdf_doc_kind integration plan' },
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
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 0n,
        legalNameTh: 'ทดสอบ',
        legalNameEn: 'PDK Test Chamber',
        taxId: '0000000000000',
        registeredAddressTh: 'Bangkok',
        registeredAddressEn: 'Bangkok',
        invoiceNumberPrefix: 'PDK',
        creditNoteNumberPrefix: 'CN',
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('(1) issueInvoice persists pdf_doc_kind=invoice for a membership invoice + rowsToInvoice maps it', async () => {
    const invoiceId = randomUUID();
    const memberId = randomUUID();

    // Seed an active TIN-carrying company member + primary contact + a draft
    // membership invoice with exactly one membership_fee line (the §86/4
    // gate requires the buyer TIN; the identity adapter reads the contact).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'PDK Doc Kind Co',
        country: 'TH',
        taxId: '0105536000020',
        planId,
        planYear: 2026,
        status: 'active',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Pat',
        lastName: 'Buyer',
        email: `pdk-${memberId.slice(0, 8)}@dockind.example`,
        isPrimary: true,
      });
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: user.userId,
        status: 'draft',
        creditedTotalSatang: 0n,
      });
      await tx.insert(invoiceLines).values({
        tenantId: tenant.ctx.slug,
        lineId: randomUUID(),
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026',
        descriptionEn: 'Membership 2026',
        unitPriceSatang: 100_000n,
        totalSatang: 100_000n,
        position: 1,
      });
    });

    const r = await issueInvoice(makeDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      invoiceId,
    });
    if (!r.ok) {
      throw new Error(`issueInvoice failed: ${JSON.stringify(r.error)}`);
    }

    // Use-case return path (applyIssue RETURNING → rowsToInvoice).
    expect(r.value.status).toBe('issued');
    expect(r.value.pdfDocKind).toBe('invoice');

    // Fresh load — proves the value PERSISTED and maps through
    // rowsToInvoice on the plain read path, not just on RETURNING.
    const repo = makeDrizzleInvoiceRepo(tenant.ctx.slug);
    const reloaded = await repo.findById(asInvoiceId(invoiceId), tenant.ctx.slug);
    expect(reloaded?.pdfDocKind).toBe('invoice');

    // Raw column check — the persisted string is exactly 'invoice'.
    const raw = await runInTenant(tenant.ctx, (tx) =>
      tx.execute(
        sql`SELECT pdf_doc_kind FROM invoices WHERE tenant_id = ${tenant.ctx.slug} AND invoice_id = ${invoiceId}`,
      ),
    );
    const rawRows = raw as unknown as Array<{ pdf_doc_kind: string | null }>;
    expect(rawRows[0]?.pdf_doc_kind).toBe('invoice');
  }, 60_000);

  it('(2) backfill complete — no non-draft row anywhere has NULL pdf_doc_kind', async () => {
    // Owner connection (BYPASSRLS) — the backfill claim is GLOBAL across
    // tenants, so this deliberately does NOT run under runInTenant. Test-only
    // path; production code never queries cross-tenant this way.
    const raw = await db.execute(
      sql`SELECT count(*)::int AS n FROM invoices WHERE pdf_doc_kind IS NULL AND status <> 'draft'`,
    );
    const rows = Array.isArray(raw)
      ? (raw as unknown as Array<{ n: number }>)
      : (raw as unknown as { rows: Array<{ n: number }> }).rows;
    expect(rows[0]!.n).toBe(0);
  }, 60_000);
});
