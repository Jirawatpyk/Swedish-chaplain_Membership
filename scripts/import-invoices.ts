/**
 * import-invoices.ts — ONE-TIME historical membership-invoice BACKFILL for SweCham.
 *
 *   # DRY-RUN (safe default — read sheets + resolve members/plans/cycles, ZERO writes)
 *   TENANT_SLUG=swecham node --env-file=.env.local --import tsx scripts/import-invoices.ts --file <xlsx>
 *
 *   # DEV PROOF (SIMULATED member + cycle on the DEV tenant — proves the whole
 *   #            chain end-to-end: back-dated draft→§87 bill→§86/4 receipt AND the
 *   #            Pass-2 cycle anchor; NO real PII, NO email)
 *   … --file <xlsx> --proof
 *
 *   # CLEANUP-TEST (delete the handful of pre-existing TEST invoices + reset any
 *   #               cycle they corrupted + reset the doc-number sequences; guarded,
 *   #               refuses if the tenant has more than MAX_CLEANUP invoices)
 *   … --file <xlsx> --cleanup-test
 *
 *   # COMMIT (the real backfill — idempotent per member). Run --cleanup-test FIRST.
 *   #  PROD run is gated on accountant sign-off for back-dated §86/4 receipts.
 *   … --file <xlsx> --commit
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * Per member, imports the ONE **current-period** membership invoice and makes the
 * renewal dashboard reflect it. Two sheets are joined:
 *   • "Member Data New"  — authoritative per-member CURRENT state:
 *       [1] Code · [5] Latest Invoice No. · [6] Latest INV Date = period START ·
 *       [10] Renewal date = period END. Coverage = [6] → [10] (the real ROLLING
 *       membership period — anniversary-based, NOT a calendar year).
 *   • "Invoice Data"     — per-member amounts for the 2025 + 2026 columns. The
 *       CURRENT invoice is whichever column's invoice-number equals [5] (may be
 *       the 2025 OR the 2026 column, member-dependent).
 *
 * Pass 1 (F4 invoices): createInvoiceDraft(coverage = sheet period, amount = sheet
 *   VAT-exclusive) → issueInvoice (SC bill, §87 FY follows the ISSUE date via the
 *   historical clock) → paid ? recordPayment(admin_offline_mark → RC §86/4 receipt,
 *   FY follows the PAY date) : issued ; cancelled → void.
 *
 * Pass 2 (renewal cycles — the dashboard fix; DATA backfill, NOT a code change):
 *   the /admin/renewals read-model reads renewal_cycles ONLY (never invoices), so
 *   a paid invoice alone leaves the member showing "renewal due". For each PAID
 *   current invoice we stamp the member's single open cycle via the SHIPPED,
 *   guarded `reanchorPeriodInTx`: period_from/period_to = sheet [6]/[10],
 *   anchored_at = [6] (the canonical paid-coverage marker), anchor_invoice_id =
 *   the invoice, status stays `upcoming`. We KEEP the sheet period (we do NOT
 *   re-anchor to the historical pay date), so the rolling anchor is preserved and
 *   the next renewal runs normally when period_to approaches. No cycle completion,
 *   no next-cycle spawn, no F8 onPaidCallbacks (which would do both).
 *
 * SAFETY — NO EMAIL: every draft `autoEmailOnIssue:false` + every payment
 * `suppressReceiptEmail:true` → issuing/paying enqueues NO outbox row.
 * (2026-06-04 seed incident: auto-email ON emailed a real member.)
 *
 * Barrel-free under standalone tsx: the F4 use-cases + the cycle repo import only
 * within their own module trees; the 3 adapters that pull a sibling BARREL
 * (memberIdentity/membershipAccess/eventRegistration → server-only) are replaced
 * by an inline faithful copy + two never-called stubs. Scripts may deep-import
 * (Principle III governs `src/modules/*`, not scripts).
 */
import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';

import {
  createInvoiceDraft,
  type CreateInvoiceDraftDeps,
} from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import {
  issueInvoice,
  type IssueInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/issue-invoice';
import {
  recordPayment,
  type RecordPaymentDeps,
} from '@/modules/invoicing/application/use-cases/record-payment';
import {
  voidInvoice,
  type VoidInvoiceDeps,
} from '@/modules/invoicing/application/use-cases/void-invoice';
import type { ClockPort } from '@/modules/invoicing/application/ports/clock-port';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import { resendEmailOutboxAdapter } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { planLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/plan-lookup-adapter';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { recipientLocaleAdapter } from '@/modules/invoicing/infrastructure/adapters/recipient-locale-adapter';
import type { EventRegistrationLookupPort } from '@/modules/invoicing/application/ports/event-registration-lookup-port';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
// Pass 2 — the shipped, guarded, idempotent cycle re-anchor. The repo file
// imports only @/lib + drizzle schemas + pure domain (no server-only, no
// sibling barrel), so it loads cleanly under standalone tsx.
import { makeDrizzleRenewalCycleRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo';
// The real memberIdentityAdapter imports the `@/modules/members` BARREL (for
// formatMemberNumber/asMemberNumber) and membershipAccessBridge/eventRegistration
// import the `@/modules/renewals`/`@/modules/events` BARRELS — all chain to
// `server-only`, which throws under standalone tsx. We rebuild memberIdentity as
// a FAITHFUL inline copy (deep members-domain helpers) + stub the two never-called
// ports.
import type { TenantTx } from '@/lib/db';
import { ok } from '@/lib/result';
import type {
  MemberIdentityPort,
  MemberIdentityView,
} from '@/modules/invoicing/application/ports/member-identity-port';
import type {
  MembershipAccessPort,
  MembershipAccessSummary,
} from '@/modules/invoicing/application/ports/membership-access-port';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { composeBuyerAddress } from '@/modules/invoicing/infrastructure/adapters/compose-buyer-address';
import {
  asMemberNumber,
  formatMemberNumber,
} from '@/modules/members/domain/value-objects/member-number';

// ---------------------------------------------------------------------------
// Args + guards
// ---------------------------------------------------------------------------
interface Args {
  readonly file: string;
  readonly memberSheet: string;
  readonly invoiceSheet: string;
  readonly commit: boolean;
  readonly proof: boolean;
  readonly cleanupTest: boolean;
}
function parseArgs(argv: string[]): Args {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get('--file');
  if (!file) {
    throw new Error(
      'usage: import-invoices.ts --file <xlsx> [--commit | --proof | --cleanup-test]',
    );
  }
  return {
    file,
    memberSheet: get('--member-sheet') ?? 'Member Data New',
    invoiceSheet: get('--invoice-sheet') ?? 'Invoice Data',
    commit: argv.includes('--commit'),
    proof: argv.includes('--proof'),
    cleanupTest: argv.includes('--cleanup-test'),
  };
}
function requireSwechamTenant(): TenantContext {
  const slug = process.env.TENANT_SLUG ?? 'swecham';
  if (slug !== 'swecham') {
    throw new Error(`import-invoices: refusing TENANT_SLUG="${slug}" — only 'swecham'.`);
  }
  return asTenantContext('swecham');
}
async function findActorUserId(): Promise<string> {
  const preferred = process.env.E2E_ADMIN_EMAIL?.toLowerCase();
  if (preferred) {
    const byEmail = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, preferred), eq(users.role, 'admin')))
      .limit(1);
    if (byEmail[0]) return byEmail[0].id;
  }
  const anyAdmin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(users.createdAt)
    .limit(1);
  if (!anyAdmin[0]) throw new Error('import-invoices: no admin user found.');
  return anyAdmin[0].id;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
const codeUp = (v: unknown) => String(v ?? '').trim().toUpperCase();
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const toIso = (v: unknown): string | null => {
  if (v instanceof Date) {
    // SheetJS `cellDates:true` decodes date serials to LOCAL midnight. Read the
    // LOCAL Y/M/D — NOT toISOString(), which converts to UTC and, on an
    // east-of-UTC runner (Asia/Bangkok, the real run box), shifts every date one
    // day earlier and flips the §87 fiscal year at Jan-1. (Review C1.)
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') {
    const d = XLSX.SSF?.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
};
/** Bangkok-noon UTC instant for a YYYY-MM-DD (stable bangkokLocalDate + §87 FY). */
const bkkInstant = (isoDate: string) => `${isoDate}T05:00:00.000Z`;
/** UTC midnight for a YYYY-MM-DD — matches how renewal_cycles stores period bounds. */
const utcMidnight = (isoDate: string) => `${isoDate}T00:00:00.000Z`;
/** VAT-exclusive amount cell → satang; null for a non-numeric / non-positive cell
 * (text like 'waived'/'N/A', or a hand-typed comma-number) so the row skips
 * gracefully instead of BigInt(NaN) throwing and aborting the whole backfill.
 * (Review I2.) */
const parseAmtSatang = (amt: unknown): bigint | null => {
  const n = typeof amt === 'number' ? amt : Number(String(amt ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 100));
};

// ---------------------------------------------------------------------------
// Sheet reading (pure) — join Member Data New + Invoice Data → current invoice.
// ---------------------------------------------------------------------------
/** Normalise a company name for matching sheet↔prod (both come from Member Data
 * New, so an exact normalised match is a reliable key — NOT the member_number,
 * which the member-import allocated SEQUENTIALLY and does NOT equal the SC code). */
export const normName = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export type ImportStatus = 'paid' | 'unpaid' | 'cancelled';
export interface CurrentImport {
  readonly code: string;
  readonly memberNumber: number;
  readonly company: string; // Member Data New [2] — the resolution key (NOT memberNumber)
  readonly coverageFromIso: string; // Member Data New [6] period start
  readonly coverageToIso: string; // Member Data New [10] renewal date = period end
  readonly issueDate: string; // Invoice Data current column INV Date
  readonly amountExclVatSatang: bigint;
  readonly status: ImportStatus;
  readonly paymentDate: string | null;
  readonly invoiceRef: string; // Latest Invoice No. (MB…) — cross-ref + idempotency
  readonly receiptRef: string | null;
}

interface InvoiceCols {
  readonly no25: string;
  readonly date25: string | null;
  readonly amt25: unknown;
  readonly pay25: string | null;
  readonly st25: string;
  readonly rc25: string | null;
  readonly no26: string;
  readonly date26: string | null;
  readonly amt26: unknown;
  readonly pay26: string | null;
  readonly st26: string;
  readonly rc26: string | null;
}

/** Build one CurrentImport per member by joining the two sheets. Pure + testable. */
export function buildCurrentImports(
  memberRows: unknown[][],
  invoiceRows: unknown[][],
): { imports: CurrentImport[]; skipped: string[] } {
  const skipped: string[] = [];
  // Invoice Data keyed by member code.
  const inv = new Map<string, InvoiceCols>();
  for (const r of invoiceRows.slice(1)) {
    const c = codeUp(r[1]);
    if (!c.startsWith('SC')) continue;
    inv.set(c, {
      no25: String(r[3] ?? '').trim(),
      date25: toIso(r[4]),
      amt25: r[5],
      pay25: toIso(r[9]),
      st25: String(r[10] ?? '').trim().toLowerCase(),
      rc25: r[8] ? String(r[8]).trim() : null,
      no26: String(r[11] ?? '').trim(),
      date26: toIso(r[12]),
      amt26: r[13],
      pay26: toIso(r[18]),
      st26: String(r[19] ?? '').trim().toLowerCase(),
      rc26: r[17] ? String(r[17]).trim() : null,
    });
  }

  const imports: CurrentImport[] = [];
  const seen = new Set<string>();
  for (const r of memberRows.slice(1)) {
    const code = codeUp(r[1]);
    if (!code.startsWith('SC') || seen.has(code)) continue;
    seen.add(code);
    const latest = String(r[5] ?? '').trim(); // Latest Invoice No.
    const periodFrom = toIso(r[6]); // Latest INV Date = period start
    const periodTo = toIso(r[10]); // Renewal date = period end
    if (!latest) { skipped.push(`${code}: no Latest Invoice No.`); continue; }
    if (!periodFrom || !periodTo) { skipped.push(`${code}: missing period ([6]/[10]) for ${latest}`); continue; }
    if (periodFrom >= periodTo) { skipped.push(`${code}: period start >= end (${periodFrom}..${periodTo})`); continue; }
    const ic = inv.get(code);
    if (!ic) { skipped.push(`${code}: no Invoice Data row for ${latest}`); continue; }

    // Pick the column whose invoice number matches the Latest Invoice No.
    let cur: { date: string | null; amt: unknown; pay: string | null; st: string; rc: string | null } | null = null;
    if (ic.no26 && ic.no26 === latest) cur = { date: ic.date26, amt: ic.amt26, pay: ic.pay26, st: ic.st26, rc: ic.rc26 };
    else if (ic.no25 && ic.no25 === latest) cur = { date: ic.date25, amt: ic.amt25, pay: ic.pay25, st: ic.st25, rc: ic.rc25 };
    if (!cur) { skipped.push(`${code}: Latest ${latest} not found in Invoice Data cols (25=${ic.no25} 26=${ic.no26})`); continue; }
    if (!cur.date) { skipped.push(`${code}: current invoice ${latest} has no issue date`); continue; }
    const amountExclVatSatang = parseAmtSatang(cur.amt);
    if (amountExclVatSatang === null) { skipped.push(`${code}: current invoice ${latest} has no valid amount ("${cur.amt}")`); continue; }

    const status: ImportStatus = cur.st === 'paid' ? 'paid' : cur.st === 'cancelled' ? 'cancelled' : 'unpaid';
    imports.push({
      code,
      memberNumber: parseInt(digits(code), 10),
      company: String(r[2] ?? '').trim(),
      coverageFromIso: periodFrom,
      coverageToIso: periodTo,
      issueDate: cur.date,
      amountExclVatSatang,
      status,
      paymentDate: cur.pay,
      invoiceRef: latest,
      receiptRef: cur.rc,
    });
  }
  return { imports, skipped };
}

// ---------------------------------------------------------------------------
// Inline barrel-free port replacements. `memberIdentityPort` is a FAITHFUL copy
// of member-identity-adapter.ts (identical two-arm SQL + snapshot) — the ONLY
// change is formatMemberNumber/asMemberNumber via their deep members-domain path.
// Keep it in sync with that adapter.
// ---------------------------------------------------------------------------
const memberIdentityPort: MemberIdentityPort = {
  async getForIssue(
    txUnknown,
    tenantId: string,
    memberId: string,
    opts?: { readonly forUpdate?: boolean },
  ): Promise<MemberIdentityView | null> {
    const tx = txUnknown as TenantTx;
    const forUpdate = opts?.forUpdate === true;
    const memberRows = (await tx.execute(
      forUpdate
        ? sql`
            SELECT m.member_id, m.company_name, m.tax_id, m.country, m.status,
                   m.address_line1, m.address_line2, m.sub_district, m.city, m.province, m.postal_code,
                   m.archived_at, m.registration_date, m.registration_fee_paid,
                   m.member_number,
                   m.is_vat_registered, m.is_head_office, m.branch_code,
                   COALESCE((SELECT s.member_number_prefix FROM tenant_member_settings s WHERE s.tenant_id = m.tenant_id), 'M') AS member_number_prefix,
                   mp.member_type_scope
              FROM members m
              LEFT JOIN membership_plans mp ON mp.tenant_id = m.tenant_id AND mp.plan_id = m.plan_id AND mp.plan_year = m.plan_year
             WHERE m.tenant_id = ${tenantId} AND m.member_id = ${memberId}
             FOR UPDATE OF m`
        : sql`
            SELECT m.member_id, m.company_name, m.tax_id, m.country, m.status,
                   m.address_line1, m.address_line2, m.sub_district, m.city, m.province, m.postal_code,
                   m.archived_at, m.registration_date, m.registration_fee_paid,
                   m.member_number,
                   m.is_vat_registered, m.is_head_office, m.branch_code,
                   COALESCE((SELECT s.member_number_prefix FROM tenant_member_settings s WHERE s.tenant_id = m.tenant_id), 'M') AS member_number_prefix,
                   mp.member_type_scope
              FROM members m
              LEFT JOIN membership_plans mp ON mp.tenant_id = m.tenant_id AND mp.plan_id = m.plan_id AND mp.plan_year = m.plan_year
             WHERE m.tenant_id = ${tenantId} AND m.member_id = ${memberId}`,
    )) as unknown as Array<{
      member_id: string;
      company_name: string;
      tax_id: string | null;
      country: string;
      address_line1: string | null;
      address_line2: string | null;
      sub_district: string | null;
      city: string | null;
      province: string | null;
      postal_code: string | null;
      status: string;
      archived_at: Date | null;
      registration_date: Date | string;
      registration_fee_paid: boolean;
      member_number: number | null;
      member_number_prefix: string;
      member_type_scope: 'company' | 'individual' | 'both' | null;
      is_vat_registered: boolean;
      is_head_office: boolean;
      branch_code: string | null;
    }>;
    const m = memberRows[0];
    if (!m) return null;
    const [primaryContact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.memberId, memberId), eq(contacts.isPrimary, true)))
      .limit(1);
    const regDate =
      m.registration_date instanceof Date
        ? m.registration_date.toISOString().slice(0, 10)
        : String(m.registration_date).slice(0, 10);
    const memberNumberDisplay =
      m.member_number !== null
        ? formatMemberNumber(m.member_number_prefix, asMemberNumber(m.member_number))
        : null;
    return {
      memberId,
      isActive: m.status === 'active',
      isArchived: m.archived_at !== null,
      memberTypeScope: m.member_type_scope ?? null,
      registrationDate: regDate,
      registrationFeePaid: m.registration_fee_paid,
      snapshot: makeMemberIdentitySnapshot({
        legal_name: m.company_name,
        tax_id: m.tax_id,
        address: composeBuyerAddress({
          addressLine1: m.address_line1,
          addressLine2: m.address_line2,
          subDistrict: m.sub_district,
          city: m.city,
          province: m.province,
          postalCode: m.postal_code,
          country: m.country,
        }),
        primary_contact_name: primaryContact ? `${primaryContact.firstName} ${primaryContact.lastName}` : '',
        primary_contact_email: primaryContact?.email ?? '',
        member_number: m.member_number ?? null,
        member_number_display: memberNumberDisplay,
        buyer_is_vat_registrant: m.is_vat_registered,
        buyer_is_head_office: m.is_head_office ?? true,
        buyer_branch_code: m.branch_code ?? null,
      }),
    };
  },
  async markRegistrationFeePaid(txUnknown, tenantId: string, memberId: string): Promise<void> {
    const tx = txUnknown as TenantTx;
    await tx.execute(sql`
      UPDATE members SET registration_fee_paid = TRUE, updated_at = now()
       WHERE tenant_id = ${tenantId} AND member_id = ${memberId} AND registration_fee_paid = FALSE`);
  },
};

// Stub — recordPayment's terminated gate is EXEMPT for triggeredBy
// 'admin_offline_mark' (066 §4.4), so getMembershipAccess is never invoked here.
const membershipAccessStub: MembershipAccessPort = {
  async getMembershipAccess() {
    return ok({ access: 'full', reason: 'in_good_standing' } satisfies MembershipAccessSummary);
  },
};

// Stub — issueInvoice calls findById ONLY for an event-subject draft; every draft
// here is membership, so it is never invoked.
const eventRegistrationLookupStub: EventRegistrationLookupPort = {
  async findById() {
    return ok(null);
  },
};

// ---------------------------------------------------------------------------
// Deps composition — MUTABLE historical clock + forced taxAtPayment ON.
// ---------------------------------------------------------------------------
let CLOCK_ISO = new Date(0).toISOString();
const historicalClock: ClockPort = { nowIso: () => CLOCK_ISO };
const at = (isoDate: string) => {
  CLOCK_ISO = bkkInstant(isoDate);
};

function makeDraftDeps(tid: string): CreateInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tid),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityPort,
    planLookup: planLookupAdapter,
    audit: f4AuditAdapter,
    clock: historicalClock,
    newUuid: () => randomUUID(),
  };
}
function makeIssueDeps(tid: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tid),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityPort,
    eventRegistrationLookup: eventRegistrationLookupStub,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: historicalClock,
    outbox: resendEmailOutboxAdapter,
    recipientLocale: recipientLocaleAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
    taxAtPayment: 'on',
  } as IssueInvoiceDeps;
}
function makePayDeps(tid: string): RecordPaymentDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tid),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    membershipAccess: membershipAccessStub,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: historicalClock,
    outbox: resendEmailOutboxAdapter,
    memberIdentity: memberIdentityPort,
    recipientLocale: recipientLocaleAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
    asyncReceiptPdf: false,
    taxAtPayment: 'on',
  } as RecordPaymentDeps;
}
function makeVoidDeps(tid: string): VoidInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tid),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: historicalClock,
    outbox: resendEmailOutboxAdapter,
    recipientLocale: recipientLocaleAdapter,
  } as VoidInvoiceDeps;
}

// ---------------------------------------------------------------------------
// Pass 1 — one invoice, end-to-end through the REAL use-cases.
// ---------------------------------------------------------------------------
interface WriteResult {
  readonly code: string;
  readonly outcome: 'issued' | 'paid' | 'voided' | 'skipped' | 'error';
  readonly documentNumber?: string | null;
  readonly invoiceId?: string;
  readonly detail?: string;
}
async function writeOneInvoice(
  tid: string,
  actorUserId: string,
  memberId: string,
  planId: string,
  planYear: number,
  imp: CurrentImport,
): Promise<WriteResult> {
  const base = { code: imp.code };
  // 1. DRAFT — back-dated to the issue instant; NO auto-email; sheet price + coverage.
  at(imp.issueDate);
  const draft = await createInvoiceDraft(makeDraftDeps(tid), {
    tenantId: tid,
    actorUserId,
    requestId: `import-draft-${imp.code}`,
    memberId,
    planId,
    planYear,
    autoEmailOnIssue: false,
    renewalSignal: { unitPriceSatang: imp.amountExclVatSatang },
    membershipCoverage: { kind: 'window', fromIso: imp.coverageFromIso, toIso: imp.coverageToIso },
  });
  if (!draft.ok) return { ...base, outcome: 'error', detail: `draft:${draft.error.code}` };
  const invoiceId = String(draft.value.invoiceId);

  // 2. ISSUE — SC bill; §87 FY follows the issue date via the clock.
  const issued = await issueInvoice(makeIssueDeps(tid), {
    tenantId: tid,
    actorUserId,
    requestId: `import-issue-${invoiceId}`,
    invoiceId,
  });
  if (!issued.ok) return { ...base, outcome: 'error', invoiceId, detail: `issue:${issued.error.code}` };
  const bill = issued.value.billDocumentNumberRaw ?? issued.value.documentNumber?.raw ?? '';

  if (imp.status === 'cancelled') {
    at(imp.issueDate);
    const voided = await voidInvoice(makeVoidDeps(tid), {
      tenantId: tid,
      actorUserId,
      requestId: `import-void-${invoiceId}`,
      invoiceId,
      voidReason: `Historical import — cancelled in source records (${imp.invoiceRef})`,
    });
    if (!voided.ok) return { ...base, outcome: 'error', invoiceId, documentNumber: bill, detail: `void:${voided.error.code}` };
    return { ...base, outcome: 'voided', invoiceId, documentNumber: bill };
  }

  if (imp.status === 'paid') {
    const payDate = imp.paymentDate ?? imp.issueDate;
    at(payDate);
    const paid = await recordPayment(makePayDeps(tid), {
      tenantId: tid,
      actorUserId,
      requestId: `import-pay-${invoiceId}`,
      invoiceId,
      paymentMethod: 'bank_transfer',
      paymentDate: payDate,
      paymentReference: imp.receiptRef ?? imp.invoiceRef,
      paymentNotes: `Historical import (source ${imp.invoiceRef}${imp.receiptRef ? ` / ${imp.receiptRef}` : ''})`,
      triggeredBy: 'admin_offline_mark',
      suppressReceiptEmail: true,
    });
    if (!paid.ok) return { ...base, outcome: 'error', invoiceId, documentNumber: bill, detail: `pay:${paid.error.code}` };
    return { ...base, outcome: 'paid', invoiceId, documentNumber: paid.value.receiptDocumentNumberRaw ?? bill };
  }

  return { ...base, outcome: 'issued', invoiceId, documentNumber: bill };
}

// ---------------------------------------------------------------------------
// Pass 2 — stamp the member's open cycle as paid-coverage (dashboard fix).
// Reuses the shipped, guarded, idempotent reanchorPeriodInTx. KEEPS the sheet
// period (no re-anchor to the pay date). Guard requires anchored_at IS NULL, so
// a re-run is a safe no-op and a test-corrupted cycle must be cleared first.
// ---------------------------------------------------------------------------
type CycleRepo = ReturnType<typeof makeDrizzleRenewalCycleRepo>;
type AnchorOutcome = 'anchored' | 'no-cycle' | 'already-anchored' | 'error';
async function anchorCycle(
  ctx: TenantContext,
  repo: CycleRepo,
  memberId: string,
  imp: CurrentImport,
  invoiceId: string,
): Promise<AnchorOutcome> {
  return runInTenant(ctx, async (tx) => {
    const cycle = await repo.findOpenCycleForMemberInTx(tx, ctx.slug, memberId);
    if (!cycle) return 'no-cycle';
    const res = await repo.reanchorPeriodInTx(tx, ctx.slug, cycle.cycleId, {
      periodFrom: utcMidnight(imp.coverageFromIso),
      periodTo: utcMidnight(imp.coverageToIso),
      anchoredAt: utcMidnight(imp.coverageFromIso),
      anchorInvoiceId: invoiceId,
      frozenPlanPriceThb: cycle.frozenPlanPriceThb,
      frozenPlanTermMonths: cycle.frozenPlanTermMonths,
    });
    return res ? 'anchored' : 'already-anchored';
  });
}

// ---------------------------------------------------------------------------
// --cleanup-test — delete the pre-existing TEST invoices + un-corrupt any cycle
// they anchored + reset the doc-number sequences. Guarded against nuking a
// populated system.
// ---------------------------------------------------------------------------
// Pre-launch tenant carries only backfill/test invoices (no real ongoing
// billing), so the cap accommodates a full-backfill rollback while still
// refusing to nuke a genuinely populated (post-launch) system.
const MAX_CLEANUP = 300;
async function cleanupTestInvoices(ctx: TenantContext, commit: boolean): Promise<void> {
  const tid = ctx.slug;
  const rows = (await runInTenant(ctx, (tx) =>
    tx.execute(sql`
      SELECT i.invoice_id, i.status, i.bill_document_number_raw, i.receipt_document_number_raw,
             i.member_id, m.member_number, m.company_name
        FROM invoices i LEFT JOIN members m ON m.tenant_id = i.tenant_id AND m.member_id = i.member_id
       WHERE i.tenant_id = ${tid} ORDER BY i.created_at`),
  )) as unknown as Array<Record<string, unknown>>;
  console.log(`=== cleanup-test: ${rows.length} existing invoice(s) ===`);
  for (const r of rows) {
    console.log(`  ${r.status} bill=${r.bill_document_number_raw ?? '-'} rc=${r.receipt_document_number_raw ?? '-'} #${r.member_number ?? '-'} ${String(r.company_name ?? '(no member)').slice(0, 30)}`);
  }
  if (rows.length === 0) { console.log('nothing to clean.'); return; }
  if (rows.length > MAX_CLEANUP) {
    throw new Error(`cleanup-test: REFUSING — ${rows.length} invoices exceeds the ${MAX_CLEANUP} safety cap. This does not look like a test-only tenant.`);
  }
  if (!commit) {
    console.log(`\n[dry-run] pass --commit to delete these ${rows.length}, un-corrupt their cycles, and reset sequences.`);
    return;
  }
  const ids = rows.map((r) => String(r.invoice_id));
  await runInTenant(ctx, async (tx) => {
    const idArr = sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
    // Un-corrupt cycles that any of these invoices anchored/linked.
    await tx.execute(sql`
      UPDATE renewal_cycles SET anchored_at = NULL, anchor_invoice_id = NULL
       WHERE tenant_id = ${tid} AND anchor_invoice_id IN ${idArr}`);
    await tx.execute(sql`
      UPDATE renewal_cycles SET linked_invoice_id = NULL
       WHERE tenant_id = ${tid} AND linked_invoice_id IN ${idArr}`);
    // A cycle may also point at a credit note (renewal_cycles_linked_credit_note_fk,
    // ON DELETE NO ACTION) whose original_invoice_id is one of these invoices —
    // release it too or the credit_notes DELETE below FK-violates + rolls back.
    // (Review M1.)
    await tx.execute(sql`
      UPDATE renewal_cycles SET linked_credit_note_id = NULL
       WHERE tenant_id = ${tid} AND linked_credit_note_id IN (
         SELECT credit_note_id FROM credit_notes WHERE tenant_id = ${tid} AND original_invoice_id IN ${idArr})`);
    // FK-ordered delete: refunds → payments → credit_notes → invoice_lines → invoices.
    // (refunds FK both invoices AND payments, so it must precede payments; it
    // carries its own invoice_id. credit_notes links via original_invoice_id.)
    await tx.execute(sql`DELETE FROM refunds WHERE tenant_id = ${tid} AND invoice_id IN ${idArr}`);
    await tx.execute(sql`DELETE FROM payments WHERE tenant_id = ${tid} AND invoice_id IN ${idArr}`);
    await tx.execute(sql`DELETE FROM credit_notes WHERE tenant_id = ${tid} AND original_invoice_id IN ${idArr}`);
    await tx.execute(sql`DELETE FROM invoice_lines WHERE tenant_id = ${tid} AND invoice_id IN ${idArr}`);
    await tx.execute(sql`DELETE FROM invoices WHERE tenant_id = ${tid} AND invoice_id IN ${idArr}`);
    // Reset the per-(tenant, doc_type, fiscal_year) sequence counters so the
    // backfill starts each stream clean; ON CONFLICT bootstraps fresh at 1.
    await tx.execute(sql`DELETE FROM tenant_document_sequences WHERE tenant_id = ${tid}`);
  });
  console.log(`\n[commit] deleted ${ids.length} test invoice(s), cleared cycle anchors, reset doc sequences.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = requireSwechamTenant();
  const tid = ctx.slug;

  if (args.cleanupTest) {
    await cleanupTestInvoices(ctx, args.commit);
    return;
  }

  const wb = XLSX.readFile(args.file, { cellDates: true });
  const md = wb.Sheets[args.memberSheet];
  const iv = wb.Sheets[args.invoiceSheet];
  if (!md) throw new Error(`sheet "${args.memberSheet}" not found`);
  if (!iv) throw new Error(`sheet "${args.invoiceSheet}" not found`);
  const memberRows = XLSX.utils.sheet_to_json<unknown[]>(md, { header: 1, raw: true });
  const invoiceRows = XLSX.utils.sheet_to_json<unknown[]>(iv, { header: 1, raw: true });
  const { imports, skipped } = buildCurrentImports(memberRows, invoiceRows);

  if (args.proof) {
    await runProof(ctx, tid);
    return;
  }

  // Resolve members BY COMPANY NAME — NOT by member_number. The member-import
  // allocated member_number SEQUENTIALLY, so it does NOT equal the SC code;
  // resolving by parseInt(code) matches the WRONG member (a wrong-buyer §86/4).
  // The sheet company ([2]) and the prod company both come from "Member Data New",
  // so an exact normalised name is the reliable key. Ambiguous (duplicate) prod
  // names are refused rather than guessed.
  const dbMembers = await runInTenant(ctx, (tx) =>
    tx
      .select({ memberNumber: members.memberNumber, memberId: members.memberId, companyName: members.companyName, planId: members.planId, planYear: members.planYear })
      .from(members)
      .where(and(eq(members.tenantId, tid), isNull(members.archivedAt))),
  );
  type DbMember = (typeof dbMembers)[number];
  const byName = new Map<string, DbMember>();
  const nameDup = new Set<string>();
  for (const m of dbMembers) { const k = normName(m.companyName); if (byName.has(k)) nameDup.add(k); byName.set(k, m); }
  const resolve = (p: CurrentImport): DbMember | null => {
    const k = normName(p.company);
    if (nameDup.has(k)) return null; // ambiguous — never guess a buyer on a tax document
    return byName.get(k) ?? null;
  };
  const planRows = await runInTenant(ctx, (tx) =>
    tx.select({ planId: membershipPlans.planId, planYear: membershipPlans.planYear }).from(membershipPlans).where(and(eq(membershipPlans.tenantId, tid), isNull(membershipPlans.deletedAt))),
  );
  const planExists = new Set(planRows.map((p) => `${p.planId}:${p.planYear}`));

  const resolvable = imports.filter((p) => resolve(p) !== null);
  const unmatched = imports.filter((p) => resolve(p) === null);
  // §87 allocation order: ascending issue_date so the gap-free bill/receipt
  // counters increment chronologically within each fiscal year.
  resolvable.sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.code.localeCompare(b.code));

  const fy = new Map<number, number>();
  for (const p of resolvable) { const y = Number(p.issueDate.slice(0, 4)); fy.set(y, (fy.get(y) ?? 0) + 1); }
  const byStatus = (s: ImportStatus) => resolvable.filter((p) => p.status === s).length;

  console.log(`===== import-invoices ${args.commit ? 'COMMIT' : 'DRY-RUN'} (current-period invoices) =====`);
  console.log(`members in sheet: ${imports.length} | resolvable: ${resolvable.length} | unmatched: ${unmatched.length} | skipped: ${skipped.length}`);
  console.log(`status: paid=${byStatus('paid')} unpaid=${byStatus('unpaid')} cancelled=${byStatus('cancelled')}`);
  console.log('§87 by issue-date FY: ' + [...fy.entries()].sort().map(([y, n]) => `FY${y}:${n}`).join('  '));
  if (skipped.length) { console.log('\nskipped:'); skipped.slice(0, 20).forEach((s) => console.log('  ⚠ ' + s)); }

  if (!args.commit) {
    console.log('\n[dry-run] no writes. Sample (first 8, alloc order):');
    resolvable.slice(0, 8).forEach((p) => {
      const m = resolve(p)!;
      console.log(`  ${p.issueDate} ${p.code} ${m.companyName.slice(0, 24).padEnd(24)} cover ${p.coverageFromIso}→${p.coverageToIso} ${Number(p.amountExclVatSatang) / 100}thb ${p.status}${p.paymentDate ? ' pay@' + p.paymentDate : ''} [${p.invoiceRef}]`);
    });
    console.log('\n[dry-run] --proof = DEV end-to-end proof (incl. Pass-2 cycle anchor). --commit = real backfill (run --cleanup-test first).');
    return;
  }

  // ---- COMMIT ---------------------------------------------------------------
  const actorUserId = await findActorUserId();
  const repo = makeDrizzleRenewalCycleRepo(ctx);
  console.log('\n[commit] actor:', actorUserId);

  // Idempotency + Pass-2 recovery (Review I1). Pass 1 (invoice) and Pass 2 (cycle
  // anchor) commit in SEPARATE transactions, so a prior run can leave a member
  // paid-but-unanchored (or issued-but-unpaid). Query existing membership invoices
  // WITH status + id so we can: (a) not double-import; (b) still re-anchor a paid
  // member whose Pass 2 never committed (reanchor's `anchored_at IS NULL` guard
  // makes it a safe no-op if already done); (c) surface an issued-but-unpaid
  // member whose source says paid, for manual repair.
  const existing = await runInTenant(ctx, (tx) =>
    tx
      .select({ memberId: invoices.memberId, status: invoices.status, invoiceId: invoices.invoiceId })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tid), eq(invoices.invoiceSubject, 'membership'))),
  );
  const prior = new Map<string, { invoiceId: string; paid: boolean }>();
  for (const e of existing) {
    if (!e.memberId) continue; // membership invoices always have a member; guard the nullable column
    const paidRow = e.status === 'paid';
    const cur = prior.get(e.memberId);
    if (!cur || (paidRow && !cur.paid)) prior.set(e.memberId, { invoiceId: e.invoiceId, paid: paidRow });
  }
  console.log(`[commit] ${prior.size} member(s) already have a membership invoice.`);

  let paid = 0, issuedN = 0, voided = 0, skippedN = 0, errored = 0;
  let anchored = 0, recovered = 0, noCycle = 0, anchorSkip = 0, partial = 0;
  for (const imp of resolvable) {
    const m = resolve(imp)!;
    if (!planExists.has(`${m.planId}:${m.planYear}`)) { skippedN++; console.log(`  ${imp.code} SKIP no-plan(${m.planId}:${m.planYear})`); continue; }

    const already = prior.get(m.memberId);
    if (already) {
      // Already imported. Recover Pass 2 for a paid member; surface a partial.
      if (imp.status === 'paid' && already.paid) {
        const a = await anchorCycle(ctx, repo, m.memberId, imp, already.invoiceId);
        if (a === 'anchored') recovered++;
        console.log(`  ${imp.code} already-imported → Pass2 ${a}`);
      } else if (imp.status === 'paid' && !already.paid) {
        partial++;
        console.log(`  ${imp.code} ⚠ PARTIAL: issued(unpaid) invoice exists but source=paid — needs manual fix`);
      } else {
        skippedN++;
      }
      continue;
    }

    const r = await writeOneInvoice(tid, actorUserId, m.memberId, m.planId, m.planYear, imp);
    if (r.outcome === 'error') { errored++; console.log(`  ${imp.code} ERROR ${r.detail}`); continue; }
    if (r.outcome === 'paid') paid++; else if (r.outcome === 'issued') issuedN++; else if (r.outcome === 'voided') voided++;
    // Pass 2 — anchor the cycle for a PAID current invoice.
    let anchorTag = '';
    if (r.outcome === 'paid' && r.invoiceId) {
      const a = await anchorCycle(ctx, repo, m.memberId, imp, r.invoiceId);
      if (a === 'anchored') anchored++; else if (a === 'no-cycle') noCycle++; else anchorSkip++;
      anchorTag = ` cycle=${a}`;
    }
    console.log(`  ${imp.code} → ${r.documentNumber ?? '-'} ${r.outcome}${anchorTag}`);
  }

  console.log(`\n[commit] invoices: paid=${paid} issued=${issuedN} voided=${voided} skipped=${skippedN} error=${errored} partial=${partial}`);
  console.log(`[commit] cycles:   anchored=${anchored} recovered=${recovered} no-cycle=${noCycle} guard-skip=${anchorSkip}`);
  if (partial > 0) console.log(`[commit] ⚠ ${partial} member(s) issued-but-unpaid though source=paid — resolve manually (void + re-import, or record payment).`);
}

// ---------------------------------------------------------------------------
// DEV write-path proof — SIMULATED member + cycle. Proves Pass 1 (back-dated
// draft→§87 bill→§86/4 receipt) AND Pass 2 (cycle anchored to the sheet period).
// ---------------------------------------------------------------------------
const PROOF_MEMBER = {
  legalName: 'IMPORT-PROOF Buyer Co., Ltd. (dev)',
  taxId: '0000000000000',
  country: 'TH' as const,
  addressLine1: 'PROOF — 1 Test Road',
  city: 'Bangkok',
  postalCode: '10110',
} as const;

async function runProof(ctx: TenantContext, tid: string): Promise<void> {
  const actorUserId = await findActorUserId();
  const cover = { fromIso: '2025-11-16', toIso: '2026-11-16' }; // a rolling (non-calendar) period
  const repo = makeDrizzleRenewalCycleRepo(ctx);

  const member = await runInTenant(ctx, async (tx) => {
    const existingRows = await tx
      .select({ memberId: members.memberId, planId: members.planId, planYear: members.planYear })
      .from(members)
      .where(and(eq(members.tenantId, tid), eq(members.companyName, PROOF_MEMBER.legalName)))
      .limit(1);
    let mrow = existingRows[0];
    if (!mrow) {
      const plan = await tx
        .select({ planId: membershipPlans.planId, planYear: membershipPlans.planYear })
        .from(membershipPlans)
        .where(and(eq(membershipPlans.tenantId, tid), eq(membershipPlans.isActive, true), eq(membershipPlans.memberTypeScope, 'company'), isNull(membershipPlans.deletedAt)))
        .orderBy(membershipPlans.planYear, membershipPlans.sortOrder)
        .limit(1);
      if (!plan[0]) throw new Error('proof: no active company-scope plan in the dev tenant.');
      const memberId = randomUUID();
      const memberNumber = await drizzleMemberNumberAllocator.allocate(tx, ctx.slug);
      await tx.insert(members).values({
        tenantId: tid, memberId, memberNumber, companyName: PROOF_MEMBER.legalName, country: PROOF_MEMBER.country,
        taxId: PROOF_MEMBER.taxId, addressLine1: PROOF_MEMBER.addressLine1, city: PROOF_MEMBER.city, postalCode: PROOF_MEMBER.postalCode,
        planId: plan[0].planId, planYear: plan[0].planYear, status: 'active',
      });
      await tx.insert(contacts).values({ tenantId: tid, contactId: randomUUID(), memberId, firstName: 'Proof', lastName: 'Contact', email: 'import-proof@seed.invalid', isPrimary: true });
      mrow = { memberId, planId: plan[0].planId, planYear: plan[0].planYear };
      console.log(`  [proof] created simulated member ${memberId} plan=${plan[0].planId}/${plan[0].planYear}`);
    }
    // Ensure a fresh unanchored open cycle for the proof (delete any prior proof cycle first).
    await tx.execute(sql`DELETE FROM renewal_cycles WHERE tenant_id = ${tid} AND member_id = ${mrow.memberId}`);
    await tx.execute(sql`
      INSERT INTO renewal_cycles (tenant_id, cycle_id, member_id, status, period_from, period_to, expires_at,
        cycle_length_months, tier_at_cycle_start, plan_id_at_cycle_start, frozen_plan_price_thb, frozen_plan_term_months, frozen_plan_currency, created_at, updated_at)
      VALUES (${tid}, ${randomUUID()}, ${mrow.memberId}, 'upcoming',
        ${utcMidnight(cover.fromIso)}, ${utcMidnight(cover.toIso)}, ${utcMidnight(cover.toIso)},
        12, 'regular', ${mrow.planId}, '15000.00', 12, 'THB', now(), now())`);
    return mrow;
  });

  const proof: CurrentImport = {
    code: 'PROOF', memberNumber: -1, company: PROOF_MEMBER.legalName, coverageFromIso: cover.fromIso, coverageToIso: cover.toIso,
    issueDate: '2026-03-11', amountExclVatSatang: 1500000n, status: 'paid', paymentDate: '2026-03-19',
    invoiceRef: 'PROOF-MB', receiptRef: 'PROOF-RC',
  };
  console.log('  [proof] Pass 1: back-dated paid membership invoice (draft→bill→§86/4 receipt)…');
  const r = await writeOneInvoice(tid, actorUserId, member.memberId, member.planId, member.planYear, proof);
  console.log(`  [proof] Pass 1 result: ${r.outcome} doc=${r.documentNumber ?? '-'} ${r.detail ?? ''}`);
  if (r.outcome !== 'paid' || !r.invoiceId) throw new Error(`proof Pass 1 FAILED: ${r.outcome} (${r.detail})`);

  console.log('  [proof] Pass 2: anchor the cycle to the sheet period…');
  const a = await anchorCycle(ctx, repo, member.memberId, proof, r.invoiceId);
  console.log(`  [proof] Pass 2 result: ${a}`);
  if (a !== 'anchored') throw new Error(`proof Pass 2 FAILED: expected 'anchored', got '${a}'`);

  // Verify the cycle end-state.
  const [cyc] = (await runInTenant(ctx, (tx) =>
    tx.execute(sql`SELECT status, period_from, period_to, anchored_at, anchor_invoice_id FROM renewal_cycles WHERE tenant_id = ${tid} AND member_id = ${member.memberId}`),
  )) as unknown as Array<Record<string, unknown>>;
  const okCycle =
    cyc && cyc.status === 'upcoming' && cyc.anchored_at != null &&
    String(cyc.anchor_invoice_id) === r.invoiceId &&
    String(cyc.period_from).slice(0, 10) === cover.fromIso &&
    String(cyc.period_to).slice(0, 10) === cover.toIso;
  console.log(`  [proof] cycle end-state: status=${cyc?.status} period=${String(cyc?.period_from).slice(0,10)}→${String(cyc?.period_to).slice(0,10)} anchored_at=${String(cyc?.anchored_at).slice(0,10)} anchorInv=${cyc?.anchor_invoice_id === r.invoiceId ? 'MATCH' : 'MISMATCH'}`);
  if (!okCycle) throw new Error('proof Pass 2 FAILED: cycle end-state not as expected');
  console.log('  [proof] ✅ Pass 1 (§86/4 receipt, no email) + Pass 2 (cycle anchored to sheet period) both proven.');
}

if (process.argv[1]?.endsWith('import-invoices.ts')) {
  main()
    .then(() => db.$client.end())
    .catch((e) => {
      console.error('[import-invoices] FAILED:', e?.message ?? e);
      process.exit(1);
    });
}
