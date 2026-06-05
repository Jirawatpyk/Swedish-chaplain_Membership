/**
 * Idempotent E2E fixture for the member-portal invoice suite.
 *
 * Seeds two Members + their Contacts + their Invoices so the
 * fixture-gated E2E cases in `tests/e2e/portal-invoices.spec.ts`
 * can assert deterministic browser behaviour:
 *
 *   • `e2e-member@swecham.test` → linked to "E2E Alpha Co" (tenant
 *     'swecham') with **3 issued invoices** (2 paid + 1 open).
 *     Gated by `E2E_MEMBER_HAS_INVOICES=1`.
 *
 *   • `e2e-member-empty@swecham.test` → linked to "E2E Echo Co"
 *     with **0 invoices**. Gated by `E2E_MEMBER_EMPTY=1` via the
 *     `E2E_MEMBER_EMAIL_EMPTY` / `E2E_MEMBER_PASSWORD_EMPTY`
 *     credential variables.
 *
 * Re-running the script:
 *   - Creates the empty-member user if it does not yet exist
 *     (reuses the same password hash as the main seed).
 *   - Upserts both member rows + their primary contacts.
 *   - Re-creates the 3 invoices if missing, or leaves them alone
 *     if already present (detected by (tenant_id, member_id,
 *     document_number) triple uniqueness).
 *
 * Running against a non-swecham tenant is refused (guards the
 * accidental prod-tenant-wipe pathway).
 *
 * Usage:
 *   TENANT_SLUG=swecham node --env-file=.env.local --import tsx scripts/seed-e2e-portal-invoices.ts
 *
 * Depends on:
 *   - `seed-e2e-user.ts` having created e2e-member@swecham.test.
 *   - `seed-swecham-2026-plans.ts` having seeded the `regular` plan
 *     for year 2026 (used as the plan-binding for both members).
 *   - `seed-f4-invoice-settings.ts` having seeded
 *     tenant_invoice_settings for swecham.
 */
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
// 055-member-number — allocate the per-tenant human-readable number INSIDE the
// seed tx (allocator under tenant RLS), mirroring the createMember path.
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';

// --- Constants ----------------------------------------------------------------

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';
const E2E_PASSWORD = 'E2E-Testing-Password-2026!xZ'; // mirrors seed-e2e-user.ts
const E2E_MEMBER_EMAIL = 'e2e-member@swecham.test';
const E2E_MEMBER_EMAIL_EMPTY = 'e2e-member-empty@swecham.test';

/**
 * T082 — Deterministic invoice id for the ISSUED (pay-sheet-ready)
 * fixture. Pinned so E2E specs can consume `E2E_ISSUED_INVOICE_ID`
 * from `.env.local` without needing to re-scrape the seed output on
 * every re-run. Matches `SC-2026-900003` below.
 *
 * Format: a valid UUIDv4 in the `e2e-fixture` prefix namespace. The
 * `invoices.invoice_id` column is `uuid NOT NULL`; this value is
 * parseable by Postgres and reserved for fixture use.
 */
const E2E_ISSUED_INVOICE_ID = '00000000-e2e0-4fff-9ffe-000000900003';

// --- Guards -------------------------------------------------------------------

function requireSwechamTenant(): TenantContext {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-e2e-portal-invoices: refusing to run against TENANT_SLUG="${TENANT_SLUG}". Only 'swecham' is allowed.`,
    );
  }
  return asTenantContext('swecham');
}

// --- Helpers ------------------------------------------------------------------

async function ensureUser(email: string): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1);
  if (existing.length > 0) return existing[0]!.id;

  const hash = await argon2Hasher.hash(E2E_PASSWORD);
  const inserted = await db
    .insert(users)
    .values({
      email,
      role: 'member',
      status: 'active',
      passwordHash: hash,
      displayName: 'E2E Empty Member',
      lastPasswordChangedAt: new Date(),
    })
    .returning({ id: users.id });
  console.log(`  created user ${email}`);
  return inserted[0]!.id;
}

/**
 * Upsert a members row by (tenant_id, company_name) — the closest
 * natural-key available in the schema. Returns the member_id.
 */
async function upsertMember(
  ctx: TenantContext,
  companyName: string,
): Promise<string> {
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ memberId: members.memberId })
      .from(members)
      .where(
        and(
          eq(members.tenantId, ctx.slug),
          eq(members.companyName, companyName),
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0]!.memberId;

    const memberId = randomUUID();
    const memberNumber = await drizzleMemberNumberAllocator.allocate(
      tx,
      ctx.slug,
    );
    await tx.insert(members).values({
      tenantId: ctx.slug,
      memberId,
      memberNumber,
      companyName,
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
      registrationFeePaid: true,
      status: 'active',
    });
    console.log(`  created member ${companyName} (${memberId})`);
    return memberId;
  });
}

/**
 * Upsert a primary contact for the given member that has
 * `linked_user_id` = userId. Required for the portal
 * `findByLinkedUserId` lookup to succeed.
 */
async function upsertLinkedPrimaryContact(
  ctx: TenantContext,
  memberId: string,
  userId: string,
  email: string,
  firstName: string,
  lastName: string,
): Promise<void> {
  await runInTenant(ctx, async (tx) => {
    // The unique index `contacts_tenant_email_uniq` forbids two
    // active contacts with the same email inside one tenant. If a
    // pre-existing contact owns this email, we update its member
    // binding + linked user instead of inserting a new row. That
    // preserves idempotency across repeat seed runs and tolerates
    // pre-existing F3 fixtures that seeded the same email under a
    // different member.
    const byEmail = await tx
      .select({
        contactId: contacts.contactId,
        memberId: contacts.memberId,
        linkedUserId: contacts.linkedUserId,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, ctx.slug),
          eq(sql`lower(${contacts.email})`, email.toLowerCase()),
          sql`${contacts.removedAt} IS NULL`,
        ),
      )
      .limit(1);

    // Drop any other primary on the target member so the
    // `contacts_one_primary_per_member` partial unique index stays
    // happy when we flip `is_primary = true`.
    await tx
      .update(contacts)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(contacts.tenantId, ctx.slug),
          eq(contacts.memberId, memberId),
          eq(contacts.isPrimary, true),
          sql`${contacts.removedAt} IS NULL`,
        ),
      );

    if (byEmail.length > 0) {
      const row = byEmail[0]!;
      if (row.memberId === memberId && row.linkedUserId === userId) {
        // Already correctly linked — ensure it stays primary.
        await tx
          .update(contacts)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(
            and(
              eq(contacts.tenantId, ctx.slug),
              eq(contacts.contactId, row.contactId),
            ),
          );
        console.log(
          `  contact for ${email} → member ${memberId} already linked`,
        );
        return;
      }
      await tx
        .update(contacts)
        .set({
          memberId,
          linkedUserId: userId,
          isPrimary: true,
          firstName,
          lastName,
          preferredLanguage: 'en',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contacts.tenantId, ctx.slug),
            eq(contacts.contactId, row.contactId),
          ),
        );
      console.log(
        `  re-linked existing contact ${email} → member ${memberId}`,
      );
      return;
    }

    await tx.insert(contacts).values({
      tenantId: ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName,
      lastName,
      email,
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: userId,
    });
    console.log(`  linked new contact ${email} → member ${memberId}`);
  });
}

interface InvoiceSeed {
  readonly docNumber: string;
  readonly status: 'paid' | 'issued';
  readonly totalSatang: bigint;
  readonly sequenceNumber: number;
}

/**
 * Render a real PDF for the given invoice seed + upload it to Vercel
 * Blob. Returns the blob key + sha256 as stored on the invoice row
 * so the /portal/invoices/[id]/pdf route can byte-stream it back.
 *
 * This exists because the pdf route proxies `fetch(blobUrl)` — a
 * placeholder key would return 404 from Blob and the route would
 * 502. Real render + upload = member can download the seeded PDFs.
 */
async function renderAndUploadPdf(
  ctx: TenantContext,
  seed: InvoiceSeed,
  invoiceId: string,
): Promise<{ blobKey: string; sha256: string }> {
  const docR = DocumentNumber.of(
    'SC',
    2026,
    seed.sequenceNumber,
  );
  if (!docR.ok) {
    throw new Error(
      `seed-e2e-portal-invoices: DocumentNumber.of failed for ${seed.docNumber}`,
    );
  }
  const subtotalSatang = (seed.totalSatang * 100n) / 107n;
  const vatSatang = seed.totalSatang - subtotalSatang;
  const rendered = await reactPdfRenderAdapter.render({
    kind: seed.status === 'paid' ? 'receipt_combined' : 'invoice',
    templateVersion: 1,
    documentNumber: docR.value,
    issueDate: '2026-04-15',
    dueDate: '2026-05-15',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: 'E2E Alpha Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 E2E Road, Bangkok',
      primary_contact_name: 'E2E Alpha',
      primary_contact_email: 'e2e-member@swecham.test',
    },
    lines: [
      {
        lineId: asInvoiceLineId(randomUUID()),
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026 (E2E fixture)',
        descriptionEn: 'Membership 2026 (E2E fixture)',
        unitPrice: Money.fromSatangUnsafe(subtotalSatang),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(subtotalSatang),
        position: 1,
      },
    ],
    subtotal: Money.fromSatangUnsafe(subtotalSatang),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(vatSatang),
    total: Money.fromSatangUnsafe(seed.totalSatang),
  });
  const blobKey = `tenants/${ctx.slug}/invoices/${invoiceId}/v1.pdf`;
  await vercelBlobAdapter.uploadPdf({
    key: blobKey,
    body: rendered.bytes,
    contentType: 'application/pdf',
  });
  return { blobKey, sha256: rendered.sha256 };
}

/**
 * Seed 3 issued invoices for the given member. Each invoice satisfies
 * the `invoices_non_draft_has_snapshots` + `invoices_paid_has_payment`
 * CHECK constraints with placeholder snapshot + PDF fields (the
 * adapter layer populates real ones when rendering, but CHECK only
 * requires NOT NULL).
 */
async function seedInvoicesIfMissing(
  ctx: TenantContext,
  memberId: string,
  adminUserId: string,
): Promise<void> {
  // Document-number format per Domain value-object `DocumentNumber`:
  // `{prefix}-{YYYY}-{NNNNNN}` with 6-digit zero-padded sequence.
  // We use the high end of the sequence space (900000+) so E2E
  // fixtures never collide with the real sequential allocator which
  // starts at 000001 and climbs monotonically. SweCham has historically
  // issued ~100s of invoices per year; the 900000-series is a safe
  // namespace reservation for test rows.
  const seeds: InvoiceSeed[] = [
    { docNumber: 'SC-2026-900001', status: 'paid', totalSatang: 1_070_000n, sequenceNumber: 900001 },
    { docNumber: 'SC-2026-900002', status: 'paid', totalSatang: 2_140_000n, sequenceNumber: 900002 },
    { docNumber: 'SC-2026-900003', status: 'issued', totalSatang: 535_000n, sequenceNumber: 900003 },
  ];

  const tenantSnap = {
    legal_name_en: 'Thailand-Swedish Chamber of Commerce',
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    tax_id: '0000000000000',
    address: 'Bangkok',
  };
  const memberSnap = {
    company_name: 'E2E Alpha Co',
    tax_id: null,
    address: null,
    // FR-038 — snapshot MUST carry the primary contact email so F4's
    // `recordPayment` can enqueue the auto-email receipt without
    // reaching back into the mutable members/contacts tables.
    primary_contact_email: 'e2e-member@swecham.test',
    primary_contact_name: 'E2E Alpha',
  };

  await runInTenant(ctx, async (tx) => {
    for (const s of seeds) {
      const existing = await tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, ctx.slug),
            eq(invoices.documentNumber, s.docNumber),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        const existingId = existing[0]!.invoiceId;
        if (s.status === 'issued' && s.sequenceNumber === 900003) {
          // T082: surface the existing UUID so the operator can copy
          // the correct E2E_ISSUED_INVOICE_ID into .env.local even if
          // the row was inserted before deterministic-UUID pinning
          // landed (pre-T082 seeds used randomUUID() for every row).
          console.log(
            `  invoice ${s.docNumber} already present — invoice_id=${existingId}`,
          );
        } else {
          console.log(`  invoice ${s.docNumber} already present — skip`);
        }
        continue;
      }

      const subtotal = (s.totalSatang * 100n) / 107n;
      const vat = s.totalSatang - subtotal;
      // T082: pin the ISSUED fixture to a deterministic UUID so the
      // `E2E_ISSUED_INVOICE_ID` env var in .env.local stays stable
      // across re-seeds. Paid fixtures stay on random UUIDs (they
      // are not URL-referenced by E2E specs).
      const invoiceId =
        s.status === 'issued' && s.sequenceNumber === 900003
          ? E2E_ISSUED_INVOICE_ID
          : randomUUID();
      // Render + upload the real PDF BEFORE inserting the row so the
      // blob key we persist always points at a retrievable object.
      // If upload fails, the transaction rolls back and the row is
      // never created — no dangling DB record with a ghost key.
      const pdf = await renderAndUploadPdf(ctx, s, invoiceId);
      await tx.insert(invoices).values({
        tenantId: ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId: 'regular',
        draftByUserId: adminUserId,
        status: s.status,
        fiscalYear: 2026,
        sequenceNumber: s.sequenceNumber,
        documentNumber: s.docNumber,
        issueDate: '2026-04-15',
        dueDate: '2026-05-15',
        paidAt: s.status === 'paid' ? new Date('2026-04-18T00:00:00Z') : null,
        paymentMethod: s.status === 'paid' ? 'bank_transfer' : null,
        subtotalSatang: subtotal,
        vatRateSnapshot: '0.0700',
        vatSatang: vat,
        totalSatang: s.totalSatang,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: tenantSnap,
        memberIdentitySnapshot: memberSnap,
        pdfBlobKey: pdf.blobKey,
        pdfSha256: pdf.sha256,
        pdfTemplateVersion: 1,
      });

      // Seed a single membership-fee line so the detail page renders
      // a non-empty line-items table. Matches the PDF render call
      // above (single-line membership_fee) so downloaded bytes align
      // with what the UI shows.
      await tx.insert(invoiceLines).values({
        tenantId: ctx.slug,
        invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026 (E2E fixture)',
        descriptionEn: 'Membership 2026 (E2E fixture)',
        unitPriceSatang: subtotal,
        quantity: '1.0000',
        totalSatang: subtotal,
        position: 1,
      });

      console.log(
        `  seeded invoice ${s.docNumber} (${s.status}) + PDF ${pdf.blobKey}`,
      );
    }
  });
}

// --- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('seeding E2E portal invoice fixtures…');
  const ctx = requireSwechamTenant();

  // We need an admin user id for the invoice draft_by_user_id FK.
  const adminRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (adminRow.length === 0) {
    throw new Error(
      'seed-e2e-portal-invoices: no admin user found. Run seed-e2e-user.ts first.',
    );
  }
  const adminUserId = adminRow[0]!.id;

  // ── Stream A: e2e-member has 3 invoices ───────────────────────────────────
  const memberUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, E2E_MEMBER_EMAIL))
    .limit(1);
  if (memberUser.length === 0) {
    throw new Error(
      `seed-e2e-portal-invoices: ${E2E_MEMBER_EMAIL} not found. Run seed-e2e-user.ts first.`,
    );
  }
  const memberUserId = memberUser[0]!.id;
  const alphaMemberId = await upsertMember(ctx, 'E2E Alpha Co');
  await upsertLinkedPrimaryContact(
    ctx,
    alphaMemberId,
    memberUserId,
    E2E_MEMBER_EMAIL,
    'E2E',
    'Alpha',
  );
  await seedInvoicesIfMissing(ctx, alphaMemberId, adminUserId);

  // ── Stream B: e2e-member-empty has 0 invoices ─────────────────────────────
  const emptyUserId = await ensureUser(E2E_MEMBER_EMAIL_EMPTY);
  const echoMemberId = await upsertMember(ctx, 'E2E Echo Co');
  await upsertLinkedPrimaryContact(
    ctx,
    echoMemberId,
    emptyUserId,
    E2E_MEMBER_EMAIL_EMPTY,
    'E2E',
    'Echo',
  );
  // No invoices for Echo — AS3 empty-state surface.

  // T082 — surface the actual ISSUED invoice_id in the DB (may be the
  // deterministic pinned UUID for fresh seeds, or a pre-T082 random
  // UUID if the row already existed). Prefer reading back from DB to
  // tolerate both cases cleanly.
  const [issuedRow] = await db
    .select({ invoiceId: invoices.invoiceId })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, ctx.slug),
        eq(invoices.documentNumber, 'SC-2026-900003'),
      ),
    )
    .limit(1);
  const issuedId = issuedRow?.invoiceId ?? E2E_ISSUED_INVOICE_ID;

  console.log('\n----------------------------------------');
  console.log('Add to .env.local:');
  console.log(`  E2E_MEMBER_HAS_INVOICES=1`);
  console.log(`  E2E_MEMBER_EMAIL_EMPTY='${E2E_MEMBER_EMAIL_EMPTY}'`);
  console.log(`  E2E_MEMBER_PASSWORD_EMPTY='${E2E_PASSWORD}'`);
  console.log(`  E2E_MEMBER_EMPTY=1`);
  console.log(`  E2E_ISSUED_INVOICE_ID='${issuedId}'`);
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
