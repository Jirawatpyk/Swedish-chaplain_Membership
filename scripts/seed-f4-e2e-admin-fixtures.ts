/**
 * T115s — Idempotent E2E fixtures for ADMIN mutating flows.
 *
 * Unlocks the `test.fixme` blocks in:
 *   - `tests/e2e/invoice-pay.spec.ts` (US2 AS1/AS2/AS3)
 *   - `tests/e2e/credit-note-*.spec.ts` (US6 mutating happy path)
 *
 * Strategy: seed a dedicated "E2E Mutation Co" member and provision
 *   - 1 ISSUED unpaid invoice in the 990000-series (pay target)
 *   - 1 ISSUED paid invoice in the 990001-series (credit-note target)
 *
 * Tests may mutate these (pay → paid, credit → credited) — re-running
 * this seeder detects the mutation and re-provisions a FRESH issued
 * target using the next 990xxx sequence number. The 990000-series is
 * reserved for E2E mutation fixtures so the real sequential allocator
 * (000001…) never collides.
 *
 * Guards:
 *   - Only `TENANT_SLUG=swecham` (the first tenant) is allowed — refuses
 *     production tenants.
 *   - Requires `seed-e2e-user.ts` + `seed-swecham-2026-plans.ts` +
 *     `seed-f4-invoice-settings.ts` to have run first.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/seed-f4-e2e-admin-fixtures.ts
 *
 * Sibling seeder: `seed-e2e-portal-invoices.ts` (member-side fixtures,
 * uses 900000-series; does not overlap).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';
const MUTATION_MEMBER_NAME = 'E2E Mutation Co';
// E2E fixture sequence space. The real allocator starts at 1 and
// climbs monotonically; tests reserve the 990000–999999 block.
const PAY_TARGET_SEQ_BASE = 990_000;
const CREDIT_TARGET_SEQ_BASE = 995_000;

function requireSwechamTenant(): TenantContext {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-f4-e2e-admin-fixtures: refusing to run against TENANT_SLUG="${TENANT_SLUG}".`,
    );
  }
  return asTenantContext('swecham');
}

async function upsertMutationMember(ctx: TenantContext): Promise<string> {
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ memberId: members.memberId })
      .from(members)
      .where(
        and(
          eq(members.tenantId, ctx.slug),
          eq(members.companyName, MUTATION_MEMBER_NAME),
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0]!.memberId;

    const memberId = randomUUID();
    await tx.insert(members).values({
      tenantId: ctx.slug,
      memberId,
      companyName: MUTATION_MEMBER_NAME,
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
      registrationFeePaid: true,
      status: 'active',
    });
    console.log(`  created member ${MUTATION_MEMBER_NAME} (${memberId})`);
    return memberId;
  });
}

async function findNextAvailableSeq(
  ctx: TenantContext,
  seqBase: number,
): Promise<number> {
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ seq: invoices.sequenceNumber })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          sql`${invoices.sequenceNumber} BETWEEN ${seqBase} AND ${seqBase + 9999}`,
        ),
      );
    const used = new Set(rows.map((r) => r.seq).filter((x): x is number => x !== null));
    for (let i = 0; i < 10_000; i++) {
      if (!used.has(seqBase + i)) return seqBase + i;
    }
    throw new Error(
      `seed-f4-e2e-admin-fixtures: exhausted E2E fixture sequence slot [${seqBase}, ${seqBase + 9999}] — purge old fixtures.`,
    );
  });
}

async function hasUnpaidIssuedInvoice(
  ctx: TenantContext,
  memberId: string,
  seqBase: number,
): Promise<boolean> {
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.memberId, memberId),
          eq(invoices.status, 'issued'),
          sql`${invoices.sequenceNumber} BETWEEN ${seqBase} AND ${seqBase + 9999}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

async function seedIssuedInvoice(
  ctx: TenantContext,
  memberId: string,
  adminUserId: string,
  opts: {
    readonly sequenceNumber: number;
    readonly kind: 'pay-target' | 'credit-target';
  },
): Promise<{ invoiceId: string; documentNumber: string }> {
  const docR = DocumentNumber.of('SC', 2026, opts.sequenceNumber);
  if (!docR.ok) {
    throw new Error(`DocumentNumber.of failed for seq ${opts.sequenceNumber}`);
  }
  const documentNumber = docR.value.raw;
  const totalSatang = 1_070_000n;
  const subtotal = (totalSatang * 100n) / 107n;
  const vat = totalSatang - subtotal;
  const invoiceId = randomUUID();

  const rendered = await reactPdfRenderAdapter.render({
    kind: opts.kind === 'credit-target' ? 'receipt_combined' : 'invoice',
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
      legal_name: `${MUTATION_MEMBER_NAME}, Ltd.`,
      tax_id: '9999999999999',
      address: '99/99 Mutation Road, Bangkok',
      primary_contact_name: 'Mutation Admin',
      primary_contact_email: 'e2e-admin@swecham.test',
    },
    lines: [
      {
        lineId: asInvoiceLineId(randomUUID()),
        kind: 'membership_fee',
        descriptionTh: 'ค่าสมาชิก ปี 2026 (E2E admin mutation fixture)',
        descriptionEn: 'Membership 2026 (E2E admin mutation fixture)',
        unitPrice: Money.fromSatangUnsafe(subtotal),
        quantity: '1.0000',
        proRateFactor: '1.0000',
        total: Money.fromSatangUnsafe(subtotal),
        position: 1,
      },
    ],
    subtotal: Money.fromSatangUnsafe(subtotal),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(vat),
    total: Money.fromSatangUnsafe(totalSatang),
  });
  const blobKey = `tenants/${ctx.slug}/invoices/${invoiceId}/v1.pdf`;
  await vercelBlobAdapter.uploadPdf({
    key: blobKey,
    body: rendered.bytes,
    contentType: 'application/pdf',
  });

  // Must match TenantIdentitySnapshot + MemberIdentitySnapshot field
  // names exactly — used by PDF render and outbox.enqueue on any
  // downstream credit-note / resend / re-render path.
  const tenantSnap = {
    legal_name_en: 'Thailand-Swedish Chamber of Commerce',
    legal_name_th: 'หอการค้าไทย-สวีเดน',
    tax_id: '0000000000000',
    address_th: 'กรุงเทพมหานคร',
    address_en: 'Bangkok',
    logo_blob_key: null,
  };
  const memberSnap = {
    legal_name: MUTATION_MEMBER_NAME,
    tax_id: '9999999999999',
    address: '99/99 Mutation Road, Bangkok',
    primary_contact_name: 'E2E Mutation Admin',
    primary_contact_email: 'e2e-admin@swecham.test',
  };

  await runInTenant(ctx, async (tx) => {
    await tx.insert(invoices).values({
      tenantId: ctx.slug,
      invoiceId,
      memberId,
      planYear: 2026,
      planId: 'regular',
      draftByUserId: adminUserId,
      status: opts.kind === 'credit-target' ? 'paid' : 'issued',
      fiscalYear: 2026,
      sequenceNumber: opts.sequenceNumber,
      documentNumber,
      issueDate: '2026-04-15',
      dueDate: '2026-05-15',
      paidAt: opts.kind === 'credit-target' ? new Date('2026-04-18T00:00:00Z') : null,
      paymentMethod: opts.kind === 'credit-target' ? 'bank_transfer' : null,
      subtotalSatang: subtotal,
      vatRateSnapshot: '0.0700',
      vatSatang: vat,
      totalSatang: totalSatang,
      proRatePolicySnapshot: 'none',
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: tenantSnap,
      memberIdentitySnapshot: memberSnap,
      pdfBlobKey: blobKey,
      pdfSha256: rendered.sha256,
      pdfTemplateVersion: 1,
    });
    await tx.insert(invoiceLines).values({
      tenantId: ctx.slug,
      invoiceId,
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026 (E2E admin mutation fixture)',
      descriptionEn: 'Membership 2026 (E2E admin mutation fixture)',
      unitPriceSatang: subtotal,
      quantity: '1.0000',
      totalSatang: subtotal,
      position: 1,
    });
  });

  console.log(
    `  seeded ${opts.kind} invoice ${documentNumber} (${invoiceId}) + PDF ${blobKey}`,
  );
  return { invoiceId, documentNumber };
}

async function main(): Promise<void> {
  console.log('seeding F4 E2E admin-mutation fixtures…');
  const ctx = requireSwechamTenant();

  const adminRow = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  if (adminRow.length === 0) {
    throw new Error('seed-f4-e2e-admin-fixtures: no admin user — run seed-e2e-user.ts first.');
  }
  const adminUserId = adminRow[0]!.id;

  const memberId = await upsertMutationMember(ctx);

  // Pay target — 1 issued-unpaid at all times.
  if (await hasUnpaidIssuedInvoice(ctx, memberId, PAY_TARGET_SEQ_BASE)) {
    console.log('  pay-target already present (issued+unpaid) — skip');
  } else {
    const seq = await findNextAvailableSeq(ctx, PAY_TARGET_SEQ_BASE);
    const r = await seedIssuedInvoice(ctx, memberId, adminUserId, {
      sequenceNumber: seq,
      kind: 'pay-target',
    });
    console.log(`  PAY_TARGET_DOCUMENT_NUMBER=${r.documentNumber}`);
  }

  // Credit-note target — 1 paid at all times (status may change to
  // credited or partially_credited after a test run — we then seed
  // a fresh one on the next re-run).
  const creditRows = await runInTenant(ctx, async (tx) => {
    return tx
      .select({ invoiceId: invoices.invoiceId, status: invoices.status })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.memberId, memberId),
          eq(invoices.status, 'paid'),
          sql`${invoices.sequenceNumber} BETWEEN ${CREDIT_TARGET_SEQ_BASE} AND ${CREDIT_TARGET_SEQ_BASE + 9999}`,
        ),
      )
      .limit(1);
  });
  if (creditRows.length > 0) {
    console.log('  credit-target already present (paid) — skip');
  } else {
    const seq = await findNextAvailableSeq(ctx, CREDIT_TARGET_SEQ_BASE);
    const r = await seedIssuedInvoice(ctx, memberId, adminUserId, {
      sequenceNumber: seq,
      kind: 'credit-target',
    });
    console.log(`  CREDIT_TARGET_DOCUMENT_NUMBER=${r.documentNumber}`);
  }

  console.log('\n----------------------------------------');
  console.log('Add to .env.local:');
  console.log("  E2E_ADMIN_MUTATION_MEMBER='E2E Mutation Co'");
  console.log('  E2E_HAS_ADMIN_FIXTURES=1');
  console.log('----------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
