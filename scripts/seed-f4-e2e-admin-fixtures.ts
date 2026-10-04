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
// 055-member-number — allocate the per-tenant human-readable number INSIDE the
// seed tx (allocator under tenant RLS), mirroring the createMember path.
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import {
  asInvoiceLineId,
  makeInvoiceLine,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';
const MUTATION_MEMBER_NAME = 'E2E Mutation Co';
// E2E fixture sequence space. The real allocator starts at 1 and
// climbs monotonically; tests reserve the 990000–999999 block.
const PAY_TARGET_SEQ_BASE = 990_000;
const CREDIT_TARGET_SEQ_BASE = 995_000;

// --- 088 zero-rate a11y fixture ---------------------------------------------
//
// `tests/e2e/invoicing/issue-invoice-zero-rate-a11y.spec.ts` needs an EVENT
// draft, and nothing else in the suite guarantees one. The zero-rate toggle it
// exercises renders only when `taxAtPayment && !isMembership`
// (`issue-invoice-form.tsx:142`, with `isMembership` = `invoiceSubject ===
// 'membership'`), so a membership draft can never reveal it — five of that
// file's six tests then skip, and the sixth asserts against the wrong dialog.
//
// Own sentinels rather than reusing an existing event fixture:
// `tests/e2e/helpers/event-fee-as-paid-seed.ts` DELETEs invoices on its
// registrations on every run, the `eventcreate-seed.ts` ones are erased by the
// F6 specs, and `invoices_event_registration_uniq` allows exactly one non-void
// invoice per registration.
const ZERO_RATE_EVENT_EXTERNAL_ID = 'e2e-f088-zero-rate-event';
const ZERO_RATE_REG_EXTERNAL_ID = 'e2e-f088-zero-rate-reg';
const ZERO_RATE_TICKET_THB = 1_500;

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
    const memberNumber = await drizzleMemberNumberAllocator.allocate(
      tx,
      ctx.slug,
    );
    await tx.insert(members).values({
      tenantId: ctx.slug,
      memberId,
      memberNumber,
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
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
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
      // 055-member-number — snapshot now carries member_number + the formatted
      // member_number_display (both null here = no Member No. line on the PDF).
      member_number: null,
      member_number_display: null,
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
    legal_name_en: 'Thai-Swedish Chamber of Commerce',
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
      pdfDocKind: 'invoice',
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
      // CHECK invoices_paid_has_receipt_status (migration 0056) —
      // any paid invoice MUST carry receipt_pdf_status. Seeded as
      // 'rendered' so tests can pretend the async-receipt-PDF worker
      // already ran (the seeder doesn't render a separate receipt PDF
      // — combined-mode tenants reuse the invoice PDF).
      ...(opts.kind === 'credit-target'
        ? {
            receiptPdfStatus: 'rendered' as const,
            receiptPdfBlobKey: blobKey,
            receiptPdfSha256: rendered.sha256,
            receiptPdfTemplateVersion: 1,
          }
        : {}),
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

/** Upsert the zero-rate fixture's own event, keyed on (tenant, source, external_id). */
async function upsertZeroRateEvent(
  ctx: TenantContext,
): Promise<{ eventId: string; name: string; startDateIso: string }> {
  const name = 'E2E 088 Zero-rate Fixture Event';
  const startDate = new Date('2026-05-20T12:00:00Z');
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ eventId: events.eventId, name: events.name, startDate: events.startDate })
      .from(events)
      .where(
        and(
          eq(events.tenantId, ctx.slug),
          eq(events.source, 'eventcreate'),
          eq(events.externalId, ZERO_RATE_EVENT_EXTERNAL_ID),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const e = existing[0]!;
      return { eventId: e.eventId, name: e.name, startDateIso: e.startDate.toISOString() };
    }
    const eventId = randomUUID();
    await tx.insert(events).values({
      tenantId: ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: ZERO_RATE_EVENT_EXTERNAL_ID,
      name,
      startDate,
    } satisfies NewEventRow);
    return { eventId, name, startDateIso: startDate.toISOString() };
  });
}

/** Upsert the fixture's single NON-MEMBER registration, keyed on (tenant, event, external_id). */
async function upsertZeroRateRegistration(ctx: TenantContext, eventId: string): Promise<string> {
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ registrationId: eventRegistrations.registrationId })
      .from(eventRegistrations)
      .where(
        and(
          eq(eventRegistrations.tenantId, ctx.slug),
          eq(eventRegistrations.eventId, eventId),
          eq(eventRegistrations.externalId, ZERO_RATE_REG_EXTERNAL_ID),
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0]!.registrationId;

    const registrationId = randomUUID();
    await tx.insert(eventRegistrations).values({
      tenantId: ctx.slug,
      registrationId,
      eventId,
      externalId: ZERO_RATE_REG_EXTERNAL_ID,
      attendeeEmail: 'zero.rate.fixture@seed.invalid',
      attendeeName: 'E2E Zero-rate Attendee',
      attendeeCompany: 'E2E Zero-rate Buyer Co., Ltd.',
      matchType: 'non_member',
      matchedMemberId: null,
      ticketType: 'Standard',
      ticketPriceThb: ZERO_RATE_TICKET_THB,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-05-10T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
    return registrationId;
  });
}

/**
 * One EVENT draft on that registration, or nothing if one is already live.
 *
 * Keyed on `event_registration_id` rather than on a sequence number: a draft
 * has no sequence number (the allocator runs at issue), so the pay/credit
 * target checks above cannot express this one. The predicate mirrors
 * `invoices_event_registration_uniq` — one non-void invoice per registration.
 *
 * `insertDraft` rather than `createEventInvoiceDraft`: the use case's F6 lookup
 * adapters pull a `events → members → renewals` require-cycle that a standalone
 * `tsx` CJS run resolves to `undefined` (see `seed-event-invoices-demo.ts` § 47-59).
 */
async function seedZeroRateEventDraft(
  ctx: TenantContext,
  adminUserId: string,
): Promise<'created' | 'present'> {
  const event = await upsertZeroRateEvent(ctx);
  const registrationId = await upsertZeroRateRegistration(ctx, event.eventId);

  const live = await runInTenant(ctx, async (tx) => {
    return tx
      .select({ invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.eventRegistrationId, registrationId),
          sql`${invoices.status} <> 'void'`,
        ),
      )
      .limit(1);
  });
  if (live.length > 0) return 'present';

  const lineResult = makeInvoiceLine({
    lineId: asInvoiceLineId(randomUUID()),
    kind: 'event_fee',
    descriptionTh: `ค่าเข้าร่วมงาน ${event.name}`,
    descriptionEn: `Event: ${event.name}`,
    unitPrice: Money.fromSatangUnsafe(BigInt(ZERO_RATE_TICKET_THB) * 100n),
    quantity: '1.0000',
    proRateFactor: null,
    position: 1,
  });
  if (!lineResult.ok) {
    throw new Error(`zero-rate draft: event_fee line build failed: ${lineResult.error.code}`);
  }
  const lines: InvoiceLine[] = [lineResult.value];

  // Non-member buyer, so the snapshot is pinned at draft (a matched member is
  // re-read at issue instead). A tax id is set deliberately: without one the
  // event is issue-blocked (`event_no_tin_requires_paid_issue`) and the spec
  // would skip at its `canIssue` gate instead of opening the dialog.
  const buyerSnapshot = makeMemberIdentitySnapshot({
    legal_name: 'E2E Zero-rate Buyer Co., Ltd.',
    tax_id: '9999999999999',
    address: '88/88 Zero-rate Road, Bangkok',
    primary_contact_name: 'E2E Zero-rate Attendee',
    primary_contact_email: 'zero.rate.fixture@seed.invalid',
  });

  const repo = makeDrizzleInvoiceRepo(ctx.slug);
  await repo.withTx(async (tx) => {
    await repo.insertDraft(tx, {
      tenantId: ctx.slug,
      invoiceId: asInvoiceId(randomUUID()),
      memberId: null,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      eventId: event.eventId,
      eventRegistrationId: registrationId,
      vatInclusive: true,
      draftByUserId: adminUserId,
      // Never email from a seed — `issueInvoice` reads
      // `wantsEmail = autoEmailOnIssue ?? settings.autoEmailEnabled`.
      autoEmailOnIssue: false,
      memberIdentitySnapshot: buyerSnapshot,
      lines,
    });
  });
  return 'created';
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

  // Credit-note target — keep ≥3 unmutated paid invoices at all
  // times so Playwright workers across 3 browser projects (chromium
  // + mobile-safari + mobile-chrome) each have their own credit
  // target. Each `credit-note-full.spec.ts AS1` run consumes one
  // (flips paid → credited). Re-running this seeder tops up to 3.
  const TARGET_UNMUTATED = 3;
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
      );
  });
  const needed = Math.max(0, TARGET_UNMUTATED - creditRows.length);
  if (needed === 0) {
    console.log(`  credit-target ≥${TARGET_UNMUTATED} present (paid) — skip`);
  } else {
    console.log(
      `  credit-target has ${creditRows.length}/${TARGET_UNMUTATED}; seeding ${needed} more`,
    );
    for (let i = 0; i < needed; i++) {
      const seq = await findNextAvailableSeq(ctx, CREDIT_TARGET_SEQ_BASE);
      const r = await seedIssuedInvoice(ctx, memberId, adminUserId, {
        sequenceNumber: seq,
        kind: 'credit-target',
      });
      console.log(`  CREDIT_TARGET_DOCUMENT_NUMBER=${r.documentNumber}`);
    }
  }

  // Zero-rate a11y target — deliberately NON-FATAL. `global-setup.ts` sets
  // `E2E_HAS_ADMIN_FIXTURES=1` only when this whole script exits 0, so throwing
  // here would silently disarm the credit-note specs too. The spec's own gate
  // is what makes a missing draft visible.
  try {
    const outcome = await seedZeroRateEventDraft(ctx, adminUserId);
    console.log(
      outcome === 'present'
        ? '  zero-rate-draft already present (event draft) — skip'
        : '  seeded zero-rate-draft (event draft for the 088 a11y spec)',
    );
  } catch (e) {
    console.warn(
      `  zero-rate-draft FAILED (non-fatal; issue-invoice-zero-rate-a11y will report it): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
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
