/**
 * Idempotent E2E fixture for the member-portal invoice suite.
 *
 * Seeds two Members + their Contacts + their Invoices so the
 * fixture-gated E2E cases in `tests/e2e/portal-invoices.spec.ts`
 * can assert deterministic browser behaviour:
 *
 *   • `e2e-member@swecham.test` → linked to "E2E Alpha Co" (tenant
 *     'swecham') with **3 issued invoices**: SC-2026-900001/2 are 088 paid
 *     bills (SC bill + RC tax receipt, receipt rendered) and SC-2026-900003
 *     is an open invoice. Row shapes: `scripts/lib/e2e-portal-invoice-seeds.ts`.
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
 *     if already present (looked up by document or bill number). A
 *     paid fixture still in the legacy pre-088 combined-mode shape
 *     (§87 number, no bill number) is deleted with its payments /
 *     refunds / credit notes and re-seeded as an 088 paid bill.
 *
 * Running against a non-swecham tenant is refused (guards the
 * accidental prod-tenant-wipe pathway), and so is a DATABASE_URL the
 * shared `seed-target-guard` cannot rule out as production. It also
 * needs FEATURE_088_TAX_AT_PAYMENT=true.
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
import { eq, and, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
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
import { seedTargetRefusal } from './lib/seed-target-guard';
import {
  E2E_PAID_TEMPLATE_VERSION,
  E2E_PORTAL_INVOICE_SEEDS,
  E2E_SEED_DUE_DATE,
  E2E_SEED_FISCAL_YEAR,
  E2E_SEED_ISSUE_DATE,
  E2E_SEED_PAYMENT_DATE,
  buildE2ePortalInvoiceRow,
  isLegacyFixtureRow,
  mainPdfBlobKey,
  receiptPdfBlobKey,
  splitVat,
  type E2ePortalInvoiceSeed,
  type SeedPdf,
} from './lib/e2e-portal-invoice-seeds';

// --- Constants ----------------------------------------------------------------

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';
const E2E_PASSWORD = 'E2E-Testing-Password-2026!xZ'; // mirrors seed-e2e-user.ts
const E2E_MEMBER_EMAIL = 'e2e-member@swecham.test';
const E2E_MEMBER_EMAIL_EMPTY = 'e2e-member-empty@swecham.test';

/**
 * Pinned fixture ids (see `E2E_PORTAL_INVOICE_SEEDS`): SC-2026-900003 backs
 * `E2E_ISSUED_INVOICE_ID`, SC-2026-900001 backs `E2E_PAID_ONLINE_INVOICE_ID`.
 */
const fixtureId = (number: string): string =>
  E2E_PORTAL_INVOICE_SEEDS.find((s) => s.number === number)!.invoiceId;
const E2E_ISSUED_INVOICE_ID = fixtureId('SC-2026-900003');
const E2E_PAID_ONLINE_INVOICE_ID = fixtureId('SC-2026-900001');

// --- Guards -------------------------------------------------------------------

function requireSwechamTenant(): TenantContext {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-e2e-portal-invoices: refusing to run against TENANT_SLUG="${TENANT_SLUG}". Only 'swecham' is allowed.`,
    );
  }
  return asTenantContext('swecham');
}

/**
 * The seed deletes legacy-shape fixture rows (and their payments / credit
 * notes) and mints `@swecham.test` users, so refuse a target that cannot be
 * ruled out as production — the shared dev-seeder guard.
 */
function requireDevTarget(): void {
  const refusal = seedTargetRefusal({
    databaseUrl: process.env.DATABASE_URL,
    blocklistRaw: process.env.TEST_DB_HOST_BLOCKLIST,
    nodeEnv: process.env.NODE_ENV,
    emails: [E2E_MEMBER_EMAIL, E2E_MEMBER_EMAIL_EMPTY],
    confirmedTarget: process.argv.includes('--confirm-target'),
  });
  if (refusal) throw new Error(refusal);
}

/**
 * The paid fixtures are 088 paid bills; with the flag off the app shows their
 * RC instead of the SC number and the `/SC-2026-90000N/` e2e lookups miss.
 */
function require088Flag(): void {
  if (!env.features.f088TaxAtPayment) {
    throw new Error(
      'seed-e2e-portal-invoices: FEATURE_088_TAX_AT_PAYMENT is off. The paid fixtures are 088 bills — set it to true in the env file (prod and dev both run with it on).',
    );
  }
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

/**
 * Render one fixture PDF + upload it to Vercel Blob. The pdf routes proxy
 * `fetch(blobUrl)`, so a placeholder key would 404 from Blob and the route
 * would 502 — a real render + upload lets the member download the fixtures.
 */
async function renderAndUpload(
  input: Parameters<typeof reactPdfRenderAdapter.render>[0],
  blobKey: string,
): Promise<SeedPdf> {
  const rendered = await reactPdfRenderAdapter.render(input);
  await vercelBlobAdapter.uploadPdf({
    key: blobKey,
    body: rendered.bytes,
    contentType: 'application/pdf',
  });
  return { blobKey, sha256: rendered.sha256 };
}

function fixtureDocumentNumber(prefix: 'SC' | 'RC', seed: E2ePortalInvoiceSeed): DocumentNumber {
  const r = DocumentNumber.of(prefix, E2E_SEED_FISCAL_YEAR, seed.sequence);
  if (!r.ok) {
    throw new Error(`seed-e2e-portal-invoices: DocumentNumber.of failed for ${prefix} ${seed.sequence}`);
  }
  return r.value;
}

/**
 * Render the fixture's PDFs. Every fixture gets the non-tax ใบแจ้งหนี้ (bill
 * mode, SC number, issue date); a paid fixture also gets the §86/4 tax receipt
 * (`receipt_combined`, RC number, dated at payment), like a real 088 paid bill.
 */
async function renderFixturePdfs(
  ctx: TenantContext,
  seed: E2ePortalInvoiceSeed,
): Promise<{ mainPdf: SeedPdf; receiptPdf: SeedPdf | null }> {
  const { subtotalSatang, vatSatang } = splitVat(seed.totalSatang);
  const common = {
    dueDate: E2E_SEED_DUE_DATE,
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
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
      // 055-member-number — both null = no Member No. line on the PDF.
      member_number: null,
      member_number_display: null,
    },
    lines: [
      {
        lineId: asInvoiceLineId(randomUUID()),
        kind: 'membership_fee' as const,
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
  };

  const mainPdf = await renderAndUpload(
    {
      ...common,
      kind: 'invoice',
      templateVersion: E2E_PAID_TEMPLATE_VERSION,
      documentNumber: fixtureDocumentNumber('SC', seed),
      issueDate: E2E_SEED_ISSUE_DATE,
      billMode: true,
      invoiceSubject: 'membership',
    },
    mainPdfBlobKey(ctx.slug, seed),
  );
  if (seed.status === 'issued') return { mainPdf, receiptPdf: null };
  const receiptPdf = await renderAndUpload(
    {
      ...common,
      kind: 'receipt_combined',
      templateVersion: E2E_PAID_TEMPLATE_VERSION,
      documentNumber: fixtureDocumentNumber('RC', seed),
      issueDate: E2E_SEED_PAYMENT_DATE,
      invoiceSubject: 'membership',
    },
    receiptPdfBlobKey(ctx.slug, seed),
  );
  return { mainPdf, receiptPdf };
}

/**
 * Delete a fixture still in the legacy pre-088 shape, with its children in FK
 * order (the same order `scripts/lib/e2e-issued-fixture-reset.ts` uses):
 * break the refunds ↔ credit_notes cycle, then refunds, credit notes, payments,
 * and the invoice (its lines cascade). A renewal cycle pointing at a fixture is
 * not ours to unlink, so that refuses instead.
 */
async function deleteLegacyFixture(
  tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
  ctx: TenantContext,
  invoiceId: string,
  number: string,
): Promise<void> {
  const linked = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM renewal_cycles
         WHERE tenant_id = ${ctx.slug}
           AND (linked_invoice_id = ${invoiceId} OR anchor_invoice_id = ${invoiceId})`,
  );
  if ((linked[0]?.n ?? 0) > 0) {
    throw new Error(
      `seed-e2e-portal-invoices: ${number} (${invoiceId}) is referenced by a renewal cycle — unlink it by hand before re-seeding.`,
    );
  }
  await tx.execute(
    sql`UPDATE credit_notes SET source_refund_id = NULL
         WHERE tenant_id = ${ctx.slug}
           AND source_refund_id IN (SELECT id FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = ${invoiceId}))`,
  );
  await tx.execute(
    sql`DELETE FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = ${invoiceId})`,
  );
  await tx.execute(
    sql`DELETE FROM credit_notes WHERE tenant_id = ${ctx.slug} AND original_invoice_id = ${invoiceId}`,
  );
  await tx.execute(sql`DELETE FROM payments WHERE invoice_id = ${invoiceId}`);
  await tx.execute(
    sql`DELETE FROM invoices WHERE tenant_id = ${ctx.slug} AND invoice_id = ${invoiceId}`,
  );
  console.log(`  removed legacy-shape ${number} (${invoiceId}) — re-seeding it as an 088 bill`);
}

/**
 * Seed the e2e member's 3 invoices (`E2E_PORTAL_INVOICE_SEEDS`): two 088 paid
 * bills with rendered receipts and one issued invoice. Idempotent: a fixture
 * already in the right shape is left alone; a paid fixture still in the legacy
 * pre-088 shape is replaced.
 */
async function seedInvoicesIfMissing(
  ctx: TenantContext,
  memberId: string,
  adminUserId: string,
): Promise<void> {
  await runInTenant(ctx, async (tx) => {
    for (const s of E2E_PORTAL_INVOICE_SEEDS) {
      const existing = await tx
        .select({
          invoiceId: invoices.invoiceId,
          status: invoices.status,
          documentNumber: invoices.documentNumber,
          billDocumentNumberRaw: invoices.billDocumentNumberRaw,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, ctx.slug),
            or(
              eq(invoices.documentNumber, s.number),
              eq(invoices.billDocumentNumberRaw, s.number),
            ),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (found && isLegacyFixtureRow(found)) {
        await deleteLegacyFixture(tx, ctx, found.invoiceId, s.number);
      } else if (found) {
        console.log(`  invoice ${s.number} already present — invoice_id=${found.invoiceId}`);
        continue;
      }

      // Render + upload BEFORE inserting so the persisted blob keys always
      // point at retrievable objects; a failed upload rolls the tx back.
      const { mainPdf, receiptPdf } = await renderFixturePdfs(ctx, s);
      await tx.insert(invoices).values(
        buildE2ePortalInvoiceRow({
          seed: s,
          tenantSlug: ctx.slug,
          memberId,
          adminUserId,
          mainPdf,
          receiptPdf,
        }),
      );

      // A single membership-fee line, matching the rendered PDFs, so the detail
      // page renders a non-empty line-items table.
      const { subtotalSatang } = splitVat(s.totalSatang);
      await tx.insert(invoiceLines).values({
        tenantId: ctx.slug,
        invoiceId: s.invoiceId,
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026 (E2E fixture)',
        descriptionEn: 'Membership 2026 (E2E fixture)',
        unitPriceSatang: subtotalSatang,
        quantity: '1.0000',
        totalSatang: subtotalSatang,
        position: 1,
      });

      console.log(`  seeded invoice ${s.number} (${s.status}) + PDF ${mainPdf.blobKey}`);
    }
  });
}

// --- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('seeding E2E portal invoice fixtures…');
  const ctx = requireSwechamTenant();
  requireDevTarget();
  require088Flag();

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
        or(
          eq(invoices.billDocumentNumberRaw, 'SC-2026-900003'),
          eq(invoices.documentNumber, 'SC-2026-900003'),
        ),
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
  console.log(`  E2E_PAID_ONLINE_INVOICE_ID='${E2E_PAID_ONLINE_INVOICE_ID}'`);
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
