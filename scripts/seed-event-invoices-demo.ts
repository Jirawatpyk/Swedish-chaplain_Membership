/**
 * DEMO seed — uses a SIMULATED member only; NEVER references a real member
 * (per 2026-06-04 maintainer instruction). The membership + matched-member
 * cases CREATE + USE a clearly-fake demo member (`DEMO Buyer Co., Ltd.
 * (seed)`); the two non-member cases use placeholder buyers. No real-member
 * PII ever enters a demo invoice.
 *
 * DEMO seed — `autoEmailOnIssue: false` on ALL issues so issuing (and the
 * cleanup VOID, which reads the same persisted column) never emails anyone —
 * real or simulated. `issueInvoice`/`voidInvoice` resolve
 * `wantsEmail = autoEmailOnIssue ?? settings.autoEmailEnabled`; pinning the
 * column to `false` forces wantsEmail=FALSE regardless of the tenant's
 * `autoEmailEnabled`, so no outbox row is ever enqueued.
 * Incident 2026-06-04: a prior version of this seed issued with auto-email ON
 * and the outbox-dispatch cron SENT 4 demo invoice emails (issued + voided ×2)
 * to a REAL member before the guard was added. The fake `@seed.invalid` /
 * placeholder buyer emails remain as defence-in-depth, but autoEmailOnIssue
 * is the real guard.
 *
 * DEMO seed — Event-fee vs Membership invoices for an admin list-distinction
 * UX review (054-event-fee-invoices).
 *
 * Creates a small, representative spread of invoices in the DEV tenant
 * (`swecham`, live Neon Singapore via `.env.local`) so a maintainer can open
 * `/admin/invoices` and visually compare how MEMBERSHIP invoices look next to
 * EVENT-fee invoices — to decide a list-distinction treatment (e.g. an "Event"
 * chip + a buyer column). The seed drives the REAL `issueInvoice` use-case for
 * EVERY case, so the §86/4 doc-type gate (tax invoice vs receipt), the Model-B
 * VAT-inclusive split, §87 sequence allocation, and the real bilingual PDF
 * render all run end-to-end:
 *
 *   0. CLEANUP — an EARLIER revision of this seed wrongly used a REAL dev member
 *      for cases 1 + 2 (issued SC-2026-000015 + SC-2026-000016). Those are now
 *      VOIDED by document_number at the top of the run (issued invoices are
 *      immutable + §87-numbered, so VOID is the only removal path). The step is
 *      idempotent: a re-run after the void simply finds nothing to void.
 *   1. MEMBERSHIP invoice — `createInvoiceDraft` for the SIMULATED member
 *      WITH a 13-digit tax_id → real `issueInvoice` → full ใบกำกับภาษี.
 *   2. EVENT invoice, MATCHED MEMBER — event draft keyed to a registration
 *      matched to that SAME simulated member (ticket 1,070 THB) → `issueInvoice`
 *      resolves the buyer from F3 → full tax invoice.
 *   3. EVENT invoice, NON-MEMBER WITH a TIN — buyer snapshot incl. a 13-digit
 *      tax_id → `issueInvoice` renders a full ใบกำกับภาษี.
 *   4. EVENT invoice, NON-MEMBER WITHOUT a TIN — buyer snapshot tax_id null →
 *      `issueInvoice` renders a ใบเสร็จรับเงิน (receipt; tenant is `separate`).
 *
 * WHY the event DRAFTS are built via the invoice repo's `insertDraft` rather
 * than the `createEventInvoiceDraft` use-case: that use-case's F6 lookup
 * adapters import the `@/modules/events` barrel, which forms a
 * `events → members → renewals` require-cycle. Next/Vitest resolve it (bundled
 * ESM live bindings); a standalone tsx run transpiles the CommonJS-default
 * `.ts` graph to CJS and reads an undefined export mid-cycle (a tsx/Node loader
 * limitation, NOT a code bug — the use-case is exercised by the integration
 * tests under Vitest). So the seed shapes the SAME draft row the use-case would
 * (`invoiceSubject='event'`, `eventId` + `eventRegistrationId`, `vatInclusive`,
 * the buyer snapshot pinned at draft for non-members, the inclusive `event_fee`
 * line) directly via `invoiceRepo.insertDraft`, then hands it to the REAL
 * `issueInvoice` — where the doc-type decision actually lives. `issueInvoice`
 * itself imports no events/payments/renewals barrel, so it loads cleanly.
 *
 * Issuing allocates real §87 SC-prefixed document numbers and renders + uploads
 * a real PDF to Vercel Blob. If issuing fails (no BLOB_READ_WRITE_TOKEN, or the
 * PDF render throws), the script LEAVES the invoices as DRAFTS and tells the
 * maintainer to view with `?status=draft`. Either way the Event chip + buyer
 * column are visible; issued additionally exercises the doc-type difference in
 * the detail/PDF view.
 *
 * This is a DEMO seed — it intentionally leaves data behind. The DATA lands in
 * live dev Neon (expected); only the SCRIPT is committed. It is idempotent: a
 * re-run reuses the prior demo event/registrations + skips invoices that already
 * exist for a registration (the partial unique index would otherwise reject the
 * dup) and skips the membership invoice if a demo one is already present.
 *
 * Guard: refuses to run against any tenant other than `swecham` (the dev/first
 * tenant) so it can never touch a production tenant.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/seed-event-invoices-demo.ts
 */
import { and, eq, sql, isNull, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
// 055-member-number — allocate the per-tenant human-readable number INSIDE the
// seed tx (allocator under tenant RLS), mirroring the createMember path.
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
// All imports are deep paths into the invoicing module — never the
// `@/modules/invoicing` barrel — so we avoid the `payments → renewals → events`
// require-cycle the barrel + `invoicing-deps` would pull in (see header). The
// dependency objects are built inline (mirroring `invoicing-deps.ts`, minus the
// F5 CSV-export lookup the seed never calls).
import {
  createInvoiceDraft,
  type CreateInvoiceDraftDeps,
} from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  voidInvoice,
  type VoidInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/void-invoice';
import { systemClock } from '@/modules/invoicing/application/ports/clock-port';
import {
  makeDrizzleInvoiceRepo,
} from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import { planLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/plan-lookup-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import {
  asInvoiceLineId,
  makeInvoiceLine,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import {
  makeMemberIdentitySnapshot,
  type MemberIdentitySnapshot,
} from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { eventRegistrationLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/event-registration-lookup-adapter';
import { recipientLocaleAdapter } from '@/modules/invoicing/infrastructure/adapters/recipient-locale-adapter';

// --- Inline dependency builders (mirror invoicing-deps.ts, minus F5) ---------

function makeCreateInvoiceDraftDeps(tenantId: string): CreateInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    planLookup: planLookupAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    newUuid: () => randomUUID(),
  };
}

function makeIssueInvoiceDeps(tenantId: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check (real adapter; only invoked for event subjects).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    recipientLocale: recipientLocaleAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
    taxAtPayment: 'off',
  };
}

function makeVoidInvoiceDeps(tenantId: string): VoidInvoiceDeps {
  return {
    pendingRefundGuard: { countPendingRefundsForInvoice: async () => 0 },
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    recipientLocale: recipientLocaleAdapter,
  };
}

// --- Constants ---------------------------------------------------------------

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';

// CLEANUP — the exact two demo invoices a PRIOR revision of this seed wrongly
// issued against a REAL member. Voided by document_number at the top of the
// run. The list is precise on purpose: only these two are touched; the
// non-member fakes (SC-2026-000017 / SC-2026-000018) and every real invoice
// are left strictly alone. Idempotent — a doc number not present is skipped.
const REAL_MEMBER_DEMO_DOC_NUMBERS = [
  'SC-2026-000015', // membership, real member
  'SC-2026-000016', // matched-member event, real member
] as const;
const VOID_CLEANUP_REASON =
  'Demo data cleanup — replacing real-member reference with a simulated member (054 seed fix)';

// SIMULATED demo member — clearly fake (no real person/company). Inserted
// directly (mirroring the F4 integration-test seeds) so it sidesteps the F3
// `asTaxId` checksum validator AND the `@/modules/members` barrel require-cycle
// a standalone tsx run would trip. `companyName` doubles as the idempotency
// marker (skip-if-exists). The placeholder tax_id is 13 digits so the §86/4
// membership require-TIN gate passes; it is NOT a real Thai TIN.
const SIM_MEMBER = {
  legalName: 'DEMO Buyer Co., Ltd. (seed)',
  taxId: '0000000000000', // 13-digit placeholder; NOT a real / checksum-valid TIN
  country: 'TH' as const,
  addressLine1: 'DEMO — 1 Seed Road',
  city: 'Bangkok',
  postalCode: '10110',
  contactFirstName: 'Demo',
  contactLastName: 'Contact',
  contactEmail: 'demo-buyer@seed.invalid',
} as const;

// Stable external ids so a re-run reuses the SAME demo event + registrations
// (the `events_tenant_source_external_unique` +
// `event_regs_tenant_event_external_unique` indexes key on these).
const DEMO_EVENT_EXTERNAL_ID = 'demo_evt_invoice_review_2026';
const REG_EXT_MATCHED = 'demo_reg_matched_member';
const REG_EXT_NONMEMBER_TIN = 'demo_reg_nonmember_with_tin';
const REG_EXT_NONMEMBER_NOTIN = 'demo_reg_nonmember_no_tin';

// Placeholder buyers for the two non-member event cases (NO real PII).
const BUYER_WITH_TIN = {
  legal_name: 'Demo Buyer Co., Ltd.',
  tax_id: '0105560000001', // valid 13-digit Thai TIN shape → full tax invoice
  address: '1 Demo Tower, Sukhumvit Road, Bangkok 10110',
  primary_contact_name: 'Demo Buyer Contact',
  primary_contact_email: 'demo-buyer-tin@example.com',
} as const;

const BUYER_NO_TIN = {
  legal_name: 'Demo Walk-in Guest',
  tax_id: null, // no TIN → §105 receipt (ใบเสร็จรับเงิน)
  address: '99 Demo Lane, Charoen Krung Road, Bangkok 10500',
  primary_contact_name: 'Demo Walk-in Guest',
  primary_contact_email: 'demo-walkin@example.com',
} as const;

// --- Guards ------------------------------------------------------------------

function requireSwechamTenant(): TenantContext {
  if (TENANT_SLUG !== 'swecham') {
    throw new Error(
      `seed-event-invoices-demo: refusing to run against TENANT_SLUG="${TENANT_SLUG}". Only the dev/first tenant 'swecham' is allowed.`,
    );
  }
  return asTenantContext('swecham');
}

// --- Discovery ---------------------------------------------------------------

interface DemoMember {
  readonly memberId: string;
  readonly companyName: string;
  readonly taxId: string;
  readonly planId: string;
  readonly planYear: number;
}

/**
 * STEP 0 — Void the two demo invoices a prior revision wrongly issued against a
 * REAL member, targeted PRECISELY by document_number. Issued invoices are
 * immutable + §87-numbered, so VOID is the only removal path; the voided rows
 * keep their numbers (no §87 gap, never reused). Idempotent: a doc number that
 * is absent (already cleaned, or never created) is skipped; a doc number whose
 * invoice is already `void`/`paid`/etc. is logged and skipped (voidInvoice only
 * acts on `issued`). Returns the document numbers it actually voided.
 */
async function voidRealMemberDemoInvoices(
  ctx: TenantContext,
  adminUserId: string,
): Promise<string[]> {
  // Resolve invoiceId for each target document_number (precise; no fuzzy match).
  const targets = await runInTenant(ctx, async (tx) =>
    tx
      .select({
        invoiceId: invoices.invoiceId,
        documentNumber: invoices.documentNumber,
        status: invoices.status,
        memberId: invoices.memberId,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          inArray(invoices.documentNumber, [...REAL_MEMBER_DEMO_DOC_NUMBERS]),
        ),
      ),
  );

  const voided: string[] = [];
  for (const docNumber of REAL_MEMBER_DEMO_DOC_NUMBERS) {
    const row = targets.find((t) => t.documentNumber === docNumber);
    if (!row) {
      console.log(`  [cleanup] ${docNumber} not found — already clean, skip`);
      continue;
    }
    if (row.status !== 'issued') {
      console.log(`  [cleanup] ${docNumber} status=${row.status} (not issued) — skip`);
      continue;
    }
    const result = await voidInvoice(makeVoidInvoiceDeps(ctx.slug), {
      tenantId: ctx.slug,
      actorUserId: adminUserId,
      requestId: `demo-cleanup-void-${row.invoiceId}`,
      invoiceId: row.invoiceId,
      voidReason: VOID_CLEANUP_REASON,
    });
    if (!result.ok) {
      console.warn(`  [cleanup][warn] could not void ${docNumber}: ${result.error.code}`);
      continue;
    }
    console.log(`  [cleanup] voided ${docNumber} (${row.invoiceId})`);
    voided.push(docNumber);
  }
  return voided;
}

/**
 * STEP 2 — Ensure the SIMULATED demo member exists (idempotent). Inserts the
 * member + a primary contact directly via SQL inside `runInTenant` (mirrors the
 * F4 integration-test member seeds) — this bypasses the F3 `asTaxId` checksum
 * validator (the placeholder TIN is intentionally not checksum-valid) AND the
 * `@/modules/members` barrel require-cycle a standalone tsx run would otherwise
 * trip. Reuses an EXISTING active company-scope plan for the year so the
 * membership invoice can issue without minting a new plan. Idempotent: keyed on
 * `company_name == SIM_MEMBER.legalName`.
 */
async function ensureSimulatedMember(ctx: TenantContext): Promise<DemoMember> {
  return runInTenant(ctx, async (tx) => {
    // Already present? Reuse it.
    const existing = await tx
      .select({
        memberId: members.memberId,
        companyName: members.companyName,
        taxId: members.taxId,
        planId: members.planId,
        planYear: members.planYear,
      })
      .from(members)
      .where(
        and(
          eq(members.tenantId, ctx.slug),
          eq(members.companyName, SIM_MEMBER.legalName),
          isNull(members.archivedAt),
        ),
      )
      .limit(1);
    const found = existing[0];
    if (found && found.taxId !== null) {
      console.log(`  simulated member already present (${found.memberId}) — reuse`);
      return {
        memberId: found.memberId,
        companyName: found.companyName,
        taxId: found.taxId,
        planId: found.planId,
        planYear: found.planYear,
      };
    }

    // Pick an existing active, NON-soft-deleted, company-scope plan for a year.
    // Company scope so the §86/4 membership require-TIN gate applies cleanly.
    const planRows = await tx
      .select({ planId: membershipPlans.planId, planYear: membershipPlans.planYear })
      .from(membershipPlans)
      .where(
        and(
          eq(membershipPlans.tenantId, ctx.slug),
          eq(membershipPlans.isActive, true),
          eq(membershipPlans.memberTypeScope, 'company'),
          isNull(membershipPlans.deletedAt),
        ),
      )
      .orderBy(membershipPlans.planYear, membershipPlans.sortOrder)
      .limit(1);
    const plan = planRows[0];
    if (!plan) {
      throw new Error(
        'seed-event-invoices-demo: no active company-scope plan found in the dev tenant — cannot bind the simulated member. Seed plans first.',
      );
    }

    const memberId = randomUUID();
    const memberNumber = await drizzleMemberNumberAllocator.allocate(
      tx,
      ctx.slug,
    );
    await tx.insert(members).values({
      tenantId: ctx.slug,
      memberId,
      memberNumber,
      companyName: SIM_MEMBER.legalName,
      country: SIM_MEMBER.country,
      taxId: SIM_MEMBER.taxId,
      addressLine1: SIM_MEMBER.addressLine1,
      city: SIM_MEMBER.city,
      postalCode: SIM_MEMBER.postalCode,
      planId: plan.planId,
      planYear: plan.planYear,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: SIM_MEMBER.contactFirstName,
      lastName: SIM_MEMBER.contactLastName,
      email: SIM_MEMBER.contactEmail,
      isPrimary: true,
    });
    console.log(
      `  created simulated member "${SIM_MEMBER.legalName}" (${memberId}) plan=${plan.planId}/${plan.planYear}`,
    );
    return {
      memberId,
      companyName: SIM_MEMBER.legalName,
      taxId: SIM_MEMBER.taxId,
      planId: plan.planId,
      planYear: plan.planYear,
    };
  });
}

async function resolveAdminUserId(): Promise<string> {
  // Prefer the E2E admin the maintainer signs in with; fall back to any admin.
  const preferred = process.env.E2E_ADMIN_EMAIL?.toLowerCase();
  if (preferred) {
    const byEmail = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, preferred), eq(users.role, 'admin')))
      .limit(1);
    if (byEmail.length > 0) return byEmail[0]!.id;
  }
  const anyAdmin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(users.createdAt)
    .limit(1);
  if (anyAdmin.length === 0) {
    throw new Error('seed-event-invoices-demo: no admin user found in the dev tenant.');
  }
  return anyAdmin[0]!.id;
}

// --- F6 event + registration seeding (idempotent) ----------------------------

interface DemoEvent {
  readonly eventId: string;
  readonly name: string;
  readonly startDateIso: string;
}

/** Upsert the demo F6 event by (tenant, source, external_id). */
async function upsertDemoEvent(ctx: TenantContext): Promise<DemoEvent> {
  const name = 'Demo Gala Dinner 2026';
  // A recent CE start date — shows on the event_fee line description.
  const startDate = new Date('2026-05-20T12:00:00Z');
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({ eventId: events.eventId, name: events.name, startDate: events.startDate })
      .from(events)
      .where(
        and(
          eq(events.tenantId, ctx.slug),
          eq(events.source, 'eventcreate'),
          eq(events.externalId, DEMO_EVENT_EXTERNAL_ID),
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
      externalId: DEMO_EVENT_EXTERNAL_ID,
      name,
      startDate,
    } satisfies NewEventRow);
    console.log(`  created demo event "${name}" (${eventId})`);
    return { eventId, name, startDateIso: startDate.toISOString() };
  });
}

interface DemoRegistration {
  readonly registrationId: string;
  readonly ticketPriceThb: number;
  readonly matchedMemberId: string | null;
}

/**
 * Upsert one demo registration by (tenant, event, external_id). `ticketPriceThb`
 * is whole THB (×100 → the inclusive satang on the event_fee line).
 */
async function upsertDemoRegistration(
  ctx: TenantContext,
  args: {
    readonly eventId: string;
    readonly externalId: string;
    readonly attendeeName: string;
    readonly attendeeEmail: string;
    readonly attendeeCompany: string | null;
    readonly ticketPriceThb: number;
    readonly matchType: 'member_domain' | 'non_member';
    readonly matchedMemberId: string | null;
  },
): Promise<DemoRegistration> {
  return runInTenant(ctx, async (tx) => {
    const existing = await tx
      .select({
        registrationId: eventRegistrations.registrationId,
        ticketPriceThb: eventRegistrations.ticketPriceThb,
        matchedMemberId: eventRegistrations.matchedMemberId,
      })
      .from(eventRegistrations)
      .where(
        and(
          eq(eventRegistrations.tenantId, ctx.slug),
          eq(eventRegistrations.eventId, args.eventId),
          eq(eventRegistrations.externalId, args.externalId),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const r = existing[0]!;
      // Self-heal: an EARLIER revision matched this demo registration to a REAL
      // member. If the stored matchedMemberId has drifted from the desired
      // (simulated) one, rewrite it so NO real-member reference lingers in the
      // demo event registration. No-op once aligned. attendeeCompany is also
      // refreshed to the simulated company name for display consistency.
      if (r.matchedMemberId !== args.matchedMemberId) {
        await tx
          .update(eventRegistrations)
          .set({
            matchedMemberId: args.matchedMemberId,
            attendeeCompany: args.attendeeCompany,
            matchType: args.matchType,
          })
          .where(
            and(
              eq(eventRegistrations.tenantId, ctx.slug),
              eq(eventRegistrations.registrationId, r.registrationId),
            ),
          );
        console.log(
          `  refreshed demo registration ${args.externalId} matchedMemberId → ${args.matchedMemberId ?? 'null'}`,
        );
      }
      return {
        registrationId: r.registrationId,
        ticketPriceThb: r.ticketPriceThb ?? args.ticketPriceThb,
        matchedMemberId: args.matchedMemberId,
      };
    }

    const registrationId = randomUUID();
    await tx.insert(eventRegistrations).values({
      tenantId: ctx.slug,
      registrationId,
      eventId: args.eventId,
      externalId: args.externalId,
      attendeeEmail: args.attendeeEmail,
      attendeeName: args.attendeeName,
      attendeeCompany: args.attendeeCompany,
      matchType: args.matchType,
      matchedMemberId: args.matchedMemberId,
      ticketType: 'Standard',
      ticketPriceThb: args.ticketPriceThb,
      paymentStatus: 'paid',
      registeredAt: new Date('2026-05-10T03:00:00Z'),
    } satisfies NewEventRegistrationRow);
    console.log(`  created demo registration ${args.externalId} (${registrationId})`);
    return {
      registrationId,
      ticketPriceThb: args.ticketPriceThb,
      matchedMemberId: args.matchedMemberId,
    };
  });
}

/**
 * Build + persist an event-fee DRAFT invoice exactly as
 * `createEventInvoiceDraft` would (Model B: a single VAT-INCLUSIVE `event_fee`
 * line; invoice subtotal/vat/total stay null until issue). Returns the new
 * invoiceId. See the file header for why this is done via `insertDraft` rather
 * than the use-case (the use-case's F6 lookup adapters trip a require-cycle
 * under standalone tsx).
 */
async function insertEventDraft(
  ctx: TenantContext,
  adminUserId: string,
  args: {
    readonly event: DemoEvent;
    readonly registrationId: string;
    readonly inclusiveSatang: bigint;
    readonly memberId: string | null;
    readonly buyerSnapshot: MemberIdentitySnapshot | null;
  },
): Promise<string> {
  const ceDate = bangkokLocalDate(args.event.startDateIso);
  const lineResult = makeInvoiceLine({
    lineId: asInvoiceLineId(randomUUID()),
    kind: 'event_fee',
    descriptionTh: `ค่าเข้าร่วมงาน ${args.event.name} (${ceDate})`,
    descriptionEn: `Event: ${args.event.name} (${ceDate})`,
    unitPrice: Money.fromSatangUnsafe(args.inclusiveSatang),
    quantity: '1.0000',
    proRateFactor: null,
    position: 1,
  });
  if (!lineResult.ok) {
    throw new Error(`insertEventDraft: event_fee line build failed: ${lineResult.error.code}`);
  }
  const lines: InvoiceLine[] = [lineResult.value];

  const invoiceId = asInvoiceId(randomUUID());
  const repo = makeDrizzleInvoiceRepo(ctx.slug);
  await repo.withTx(async (tx) => {
    await repo.insertDraft(tx, {
      tenantId: ctx.slug,
      invoiceId,
      memberId: args.memberId,
      planId: null,
      planYear: null,
      invoiceSubject: 'event',
      eventId: args.event.eventId,
      eventRegistrationId: args.registrationId,
      vatInclusive: true,
      draftByUserId: adminUserId,
      // DEMO seed — autoEmailOnIssue:false on ALL issues so issuing never
      // emails anyone (real or simulated). Incident 2026-06-04: a prior
      // version emailed a real member. issueInvoice/voidInvoice read
      // wantsEmail = autoEmailOnIssue ?? settings.autoEmailEnabled, so false
      // here forces NO outbox enqueue regardless of the tenant setting.
      autoEmailOnIssue: false,
      memberIdentitySnapshot: args.buyerSnapshot,
      lines,
    });
  });
  return String(invoiceId);
}

// --- Invoice creation via the REAL use-cases ---------------------------------

type IssueState = 'issued' | 'draft';

interface SeededInvoice {
  readonly label: string;
  readonly subject: 'membership' | 'event';
  readonly docType: string;
  readonly invoiceId: string;
  readonly state: IssueState;
  readonly documentNumber: string | null;
}

/**
 * Issue a draft invoice. On any failure (e.g. missing Blob token / PDF render
 * throw), logs a warning and leaves the invoice as a DRAFT (best-effort demo).
 * Returns the resolved state + the allocated document number (if issued).
 */
async function tryIssue(
  ctx: TenantContext,
  adminUserId: string,
  invoiceId: string,
  label: string,
): Promise<{ state: IssueState; documentNumber: string | null }> {
  try {
    const result = await issueInvoice(makeIssueInvoiceDeps(ctx.slug), {
      tenantId: ctx.slug,
      actorUserId: adminUserId,
      requestId: `demo-issue-${invoiceId}`,
      invoiceId,
    });
    if (!result.ok) {
      // Already-issued from a prior run → read back the document number.
      if (result.error.code === 'invoice_already_issued') {
        const [row] = await runInTenant(ctx, async (tx) =>
          tx
            .select({ documentNumber: invoices.documentNumber })
            .from(invoices)
            .where(and(eq(invoices.tenantId, ctx.slug), eq(invoices.invoiceId, invoiceId)))
            .limit(1),
        );
        return { state: 'issued', documentNumber: row?.documentNumber ?? null };
      }
      console.warn(
        `  [warn] could not issue "${label}" (${result.error.code}) — left as DRAFT`,
      );
      return { state: 'draft', documentNumber: null };
    }
    // `Invoice.documentNumber` is a DocumentNumber value object once issued;
    // expose its `.raw` string for the report.
    return { state: 'issued', documentNumber: result.value.documentNumber?.raw ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  [warn] issue threw for "${label}" — left as DRAFT: ${msg}`);
    return { state: 'draft', documentNumber: null };
  }
}

/**
 * Skip an event-fee invoice if a non-void one already exists for this
 * registration (the partial unique index would reject a second draft).
 * Returns the existing invoiceId + its state when present, else null.
 */
async function findExistingEventInvoice(
  ctx: TenantContext,
  registrationId: string,
): Promise<{ invoiceId: string; state: IssueState; documentNumber: string | null } | null> {
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        invoiceId: invoices.invoiceId,
        status: invoices.status,
        documentNumber: invoices.documentNumber,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.eventRegistrationId, registrationId),
          sql`${invoices.status} <> 'void'`,
        ),
      )
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      invoiceId: r.invoiceId,
      state: r.status === 'draft' ? 'draft' : 'issued',
      documentNumber: r.documentNumber ?? null,
    };
  });
}

/** Find an existing demo MEMBERSHIP invoice for this member (any non-void). */
async function findExistingMembershipDemoInvoice(
  ctx: TenantContext,
  memberId: string,
): Promise<{ invoiceId: string; state: IssueState; documentNumber: string | null } | null> {
  return runInTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        invoiceId: invoices.invoiceId,
        status: invoices.status,
        documentNumber: invoices.documentNumber,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, ctx.slug),
          eq(invoices.memberId, memberId),
          eq(invoices.invoiceSubject, 'membership'),
          sql`${invoices.status} <> 'void'`,
        ),
      )
      .orderBy(sql`${invoices.createdAt} DESC`)
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      invoiceId: r.invoiceId,
      state: r.status === 'draft' ? 'draft' : 'issued',
      documentNumber: r.documentNumber ?? null,
    };
  });
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('seeding DEMO event-vs-membership invoices for list-distinction review…');
  const ctx = requireSwechamTenant();
  const adminUserId = await resolveAdminUserId();
  console.log(`  tenant=${ctx.slug}  admin=${adminUserId}`);

  // --- Step 0: CLEANUP — void the two real-member demo invoices a prior
  // revision wrongly issued (precise; by document_number only). ---------------
  const voidedDocNumbers = await voidRealMemberDemoInvoices(ctx, adminUserId);

  // --- Step 2: ensure the SIMULATED demo member (idempotent). The membership +
  // matched-member cases below use ONLY this fake member — never a real one. ---
  const member = await ensureSimulatedMember(ctx);
  console.log(
    `  using simulated member "${member.companyName}" (${member.memberId}) plan=${member.planId}/${member.planYear}`,
  );

  const seeded: SeededInvoice[] = [];

  // --- Case 1: MEMBERSHIP invoice for the member WITH a tax_id ----------------
  {
    const existing = await findExistingMembershipDemoInvoice(ctx, member.memberId);
    if (existing) {
      console.log(`  [1/4] membership invoice already present (${existing.state}) — skip create`);
      let state = existing.state;
      let documentNumber = existing.documentNumber;
      if (state === 'draft') {
        const issued = await tryIssue(ctx, adminUserId, existing.invoiceId, 'membership');
        state = issued.state;
        documentNumber = issued.documentNumber;
      }
      seeded.push({
        label: 'membership',
        subject: 'membership',
        docType: 'tax invoice (ใบกำกับภาษี)',
        invoiceId: existing.invoiceId,
        state,
        documentNumber,
      });
    } else {
      const draft = await createInvoiceDraft(makeCreateInvoiceDraftDeps(ctx.slug), {
        tenantId: ctx.slug,
        actorUserId: adminUserId,
        requestId: `demo-membership-draft-${member.memberId}`,
        memberId: member.memberId,
        planId: member.planId,
        planYear: member.planYear,
        // DEMO seed — autoEmailOnIssue:false on ALL issues so issuing never
        // emails anyone (real or simulated). Incident 2026-06-04: a prior
        // version emailed a real member. issueInvoice/voidInvoice read
        // wantsEmail = autoEmailOnIssue ?? settings.autoEmailEnabled, so false
        // here forces NO outbox enqueue regardless of the tenant setting.
        autoEmailOnIssue: false,
      });
      if (!draft.ok) {
        throw new Error(`seed-event-invoices-demo: membership draft failed: ${draft.error.code}`);
      }
      console.log(`  [1/4] created membership draft ${draft.value.invoiceId}`);
      const issued = await tryIssue(ctx, adminUserId, draft.value.invoiceId, 'membership');
      seeded.push({
        label: 'membership',
        subject: 'membership',
        docType: 'tax invoice (ใบกำกับภาษี)',
        invoiceId: draft.value.invoiceId,
        state: issued.state,
        documentNumber: issued.documentNumber,
      });
    }
  }

  // --- F6 event + 3 registrations (idempotent) --------------------------------
  const event = await upsertDemoEvent(ctx);
  const matchedReg = await upsertDemoRegistration(ctx, {
    eventId: event.eventId,
    externalId: REG_EXT_MATCHED,
    attendeeName: 'Demo Matched Attendee',
    attendeeEmail: 'demo-matched@example.com',
    attendeeCompany: member.companyName,
    ticketPriceThb: 1070,
    matchType: 'member_domain',
    matchedMemberId: member.memberId,
  });
  const nonMemberTinReg = await upsertDemoRegistration(ctx, {
    eventId: event.eventId,
    externalId: REG_EXT_NONMEMBER_TIN,
    attendeeName: 'Demo Buyer Contact',
    attendeeEmail: 'demo-buyer-tin@example.com',
    attendeeCompany: 'Demo Buyer Co., Ltd.',
    ticketPriceThb: 2140,
    matchType: 'non_member',
    matchedMemberId: null,
  });
  const nonMemberNoTinReg = await upsertDemoRegistration(ctx, {
    eventId: event.eventId,
    externalId: REG_EXT_NONMEMBER_NOTIN,
    attendeeName: 'Demo Walk-in Guest',
    attendeeEmail: 'demo-walkin@example.com',
    attendeeCompany: null,
    ticketPriceThb: 535,
    matchType: 'non_member',
    matchedMemberId: null,
  });

  // --- Case 2: EVENT invoice — matched member ---------------------------------
  await seedEventInvoice(ctx, adminUserId, seeded, {
    label: 'event / matched member',
    docType: 'tax invoice (ใบกำกับภาษี)',
    event,
    registration: matchedReg,
    // matched member → buyer is resolved from F3 at issue (snapshot null at draft).
    memberId: member.memberId,
    buyer: undefined,
  });

  // --- Case 3: EVENT invoice — non-member WITH a TIN --------------------------
  await seedEventInvoice(ctx, adminUserId, seeded, {
    label: 'event / non-member WITH TIN',
    docType: 'tax invoice (ใบกำกับภาษี)',
    event,
    registration: nonMemberTinReg,
    memberId: null,
    buyer: BUYER_WITH_TIN,
  });

  // --- Case 4: EVENT invoice — non-member WITHOUT a TIN -----------------------
  await seedEventInvoice(ctx, adminUserId, seeded, {
    label: 'event / non-member NO TIN',
    docType: 'receipt (ใบเสร็จรับเงิน)',
    event,
    registration: nonMemberNoTinReg,
    memberId: null,
    buyer: BUYER_NO_TIN,
  });

  // --- Report -----------------------------------------------------------------
  const anyDraft = seeded.some((s) => s.state === 'draft');
  console.log('\n----------------------------------------');
  if (voidedDocNumbers.length > 0) {
    console.log(`Cleanup — voided real-member demo invoices: ${voidedDocNumbers.join(', ')}`);
  } else {
    console.log('Cleanup — no real-member demo invoices to void (already clean).');
  }
  console.log('----------------------------------------');
  console.log('DEMO invoices seeded (dev tenant "swecham"):');
  for (const s of seeded) {
    console.log(
      `  • [${s.subject}] ${s.label}: ${s.state}` +
        (s.documentNumber ? ` — ${s.documentNumber}` : '') +
        ` (${s.docType})`,
    );
  }
  console.log('----------------------------------------');
  console.log('Open the admin list at:');
  console.log('  http://localhost:3100/admin/invoices');
  if (anyDraft) {
    console.log('Some invoices stayed as DRAFTS — to see them include drafts:');
    console.log('  http://localhost:3100/admin/invoices?status=draft');
  }
  console.log('Admin sign-in: http://localhost:3100/admin/sign-in');
  console.log('----------------------------------------');
}

async function seedEventInvoice(
  ctx: TenantContext,
  adminUserId: string,
  seeded: SeededInvoice[],
  args: {
    readonly label: string;
    readonly docType: string;
    readonly event: DemoEvent;
    readonly registration: DemoRegistration;
    /** Matched-member id (buyer resolved from F3 at issue), or null for non-member. */
    readonly memberId: string | null;
    /** Manual buyer for the non-member cases; undefined for a matched member. */
    readonly buyer:
      | {
          readonly legal_name: string;
          readonly tax_id: string | null;
          readonly address: string;
          readonly primary_contact_name: string;
          readonly primary_contact_email: string;
        }
      | undefined;
  },
): Promise<void> {
  const push = (invoiceId: string, state: IssueState, documentNumber: string | null): void => {
    seeded.push({
      label: args.label,
      subject: 'event',
      docType: args.docType,
      invoiceId,
      state,
      documentNumber,
    });
  };

  const existing = await findExistingEventInvoice(ctx, args.registration.registrationId);
  if (existing) {
    console.log(`  event invoice for ${args.label} already present (${existing.state}) — skip create`);
    if (existing.state === 'draft') {
      const issued = await tryIssue(ctx, adminUserId, existing.invoiceId, args.label);
      push(existing.invoiceId, issued.state, issued.documentNumber);
    } else {
      push(existing.invoiceId, existing.state, existing.documentNumber);
    }
    return;
  }

  // Non-member → pin the buyer snapshot at DRAFT (the use-case behaviour).
  // Matched member → snapshot stays null at draft; issue-invoice re-reads the
  // live member via getForIssue.
  let buyerSnapshot: MemberIdentitySnapshot | null = null;
  if (args.memberId === null) {
    if (!args.buyer) {
      throw new Error(`seed-event-invoices-demo: non-member event "${args.label}" needs a buyer`);
    }
    buyerSnapshot = makeMemberIdentitySnapshot({
      legal_name: args.buyer.legal_name,
      tax_id: args.buyer.tax_id,
      address: args.buyer.address,
      primary_contact_name: args.buyer.primary_contact_name,
      primary_contact_email: args.buyer.primary_contact_email,
    });
  }

  const inclusiveSatang = BigInt(args.registration.ticketPriceThb) * 100n;
  const invoiceId = await insertEventDraft(ctx, adminUserId, {
    event: args.event,
    registrationId: args.registration.registrationId,
    inclusiveSatang,
    memberId: args.memberId,
    buyerSnapshot,
  });
  console.log(`  created event draft for ${args.label} ${invoiceId}`);
  const issued = await tryIssue(ctx, adminUserId, invoiceId, args.label);
  push(invoiceId, issued.state, issued.documentNumber);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
