/**
 * T051 — Drizzle invoice repo (F4).
 *
 * Domain ↔ Drizzle mapping. Transactions are run under `chamber_app`
 * role via `runInTenant(ctx, fn)` so RLS policies enforce tenant
 * scoping even on paths that forget an explicit WHERE filter.
 */
import { and, asc, desc, eq, isNotNull, isNull, lt, ne, or, sql, ilike } from 'drizzle-orm';
import type { InvoiceRepo } from '../../application/ports/invoice-repo';
import type { TaxRegisterRepo } from '../../application/ports/tax-register-repo';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
  type InvoiceSubjectFields,
} from '../../domain/invoice';
import type { VatTreatment } from '../../domain/policies/vat-treatment';
import {
  asInvoiceLineId,
  type InvoiceLine,
} from '../../domain/invoice-line';
import { Money } from '../../domain/value-objects/money';
import { DocumentNumber } from '../../domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '../../domain/value-objects/fiscal-year';
import { VatRate } from '../../domain/value-objects/vat-rate';
import { asProRatePolicyUnsafe } from '../../domain/value-objects/pro-rate-policy';
import { Sha256Hex, type Sha256Hex as Sha256HexT } from '../../domain/value-objects/sha256-hex';
import { InvoiceApplyConflictError } from '../../application/lib/invoice-apply-conflict-error';
import {
  makeTenantIdentitySnapshot,
  type TenantIdentitySnapshot,
} from '../../domain/value-objects/tenant-identity-snapshot';
import {
  memberIdentitySnapshotSchema,
  MalformedSnapshotError,
  type MemberIdentitySnapshot,
} from '../../domain/value-objects/member-identity-snapshot';
import {
  invoices,
  invoiceLines,
  creditNotes,
  type InvoiceRow,
  type InvoiceLineRow,
} from '../db';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function rowToLine(row: InvoiceLineRow): InvoiceLine {
  return {
    lineId: asInvoiceLineId(row.lineId),
    kind: row.kind,
    descriptionTh: row.descriptionTh,
    descriptionEn: row.descriptionEn,
    unitPrice: Money.fromSatangUnsafe(BigInt(row.unitPriceSatang as unknown as string)),
    quantity: String(row.quantity),
    proRateFactor: row.proRateFactor === null ? null : String(row.proRateFactor),
    total: Money.fromSatangUnsafe(BigInt(row.totalSatang as unknown as string)),
    position: row.position,
  };
}

const satangOrNull = (v: unknown): Money | null =>
  v === null ? null : Money.fromSatangUnsafe(BigInt(v as string));

const isoOrNull = (d: Date | null): string | null =>
  d === null ? null : d.toISOString();

/**
 * Build a PDF discriminated-union field from the three nullable DB
 * columns (used by both `invoice.pdf` and `invoice.receiptPdf`).
 * Three valid states:
 *   - all three columns null  → return null (no PDF yet / combined mode)
 *   - all three columns set   → return the object
 *   - any partial combination → THROW (data corruption) rather than
 *     silently dropping, so observable state matches what's on disk.
 * Throws on malformed sha256 hex as well.
 */
function buildPdfOrNull(
  blobKey: string | null,
  sha256Raw: string | null,
  templateVersion: number | null,
  invoiceId: string,
  fieldLabel: 'pdf' | 'receiptPdf',
): { blobKey: string; sha256: Sha256HexT; templateVersion: number } | null {
  const allNull = blobKey === null && sha256Raw === null && templateVersion === null;
  const allSet = blobKey !== null && sha256Raw !== null && templateVersion !== null;
  if (allNull) return null;
  if (!allSet) {
    throw new Error(
      `drizzle-invoice-repo: partial ${fieldLabel} state on row ${invoiceId} — ` +
        `blobKey=${blobKey === null ? 'null' : 'set'}, ` +
        `sha256=${sha256Raw === null ? 'null' : 'set'}, ` +
        `templateVersion=${templateVersion === null ? 'null' : 'set'}`,
    );
  }
  const parsed = Sha256Hex.parse(sha256Raw);
  if (!parsed.ok) {
    throw new Error(
      `drizzle-invoice-repo: corrupt ${fieldLabel}.sha256 on row ${invoiceId}: '${sha256Raw}'`,
    );
  }
  return { blobKey, sha256: parsed.value, templateVersion };
}

/**
 * Runtime boundary validation for `member_identity_snapshot`.
 * Architect review 2026-04-24: jsonb columns are `unknown` at the
 * row→Domain boundary — TS types are aspirational until we parse.
 * A corrupt row anywhere in the pipeline (legacy seed, manual DB
 * patch, future Domain extension forgetting to update a seed)
 * throws MalformedSnapshotError with the exact zod issues so the
 * caller can log / audit / raise a 500 as appropriate for its path.
 */
function parseMemberIdentitySnapshot(row: InvoiceRow): MemberIdentitySnapshot {
  const result = memberIdentitySnapshotSchema.safeParse(
    row.memberIdentitySnapshot,
  );
  if (!result.success) {
    throw new MalformedSnapshotError(row.invoiceId, result.error.issues);
  }
  return result.data;
}

/**
 * 054-event-fee-invoices — corrupt-row sentinel for the subject partition.
 *
 * The DB CHECK `invoices_subject_fields_ck` (migration 0208) GUARANTEES the
 * per-subject NON-NULL / NULL invariants for every persisted row, so this is
 * only ever thrown for a row that bypassed the CHECK (legacy seed, manual DB
 * patch, regressed write). Throwing turns such a row into a loud failure
 * instead of constructing an {@link Invoice} that lies to its consumers about
 * which fields are non-null.
 */
export class MalformedInvoiceSubjectError extends Error {
  constructor(invoiceId: string, detail: string) {
    super(
      `drizzle-invoice-repo: invoice ${invoiceId} violates ` +
        `invoices_subject_fields_ck — ${detail}`,
    );
    this.name = 'MalformedInvoiceSubjectError';
  }
}

/**
 * 054-event-fee-invoices — map the row's subject columns into the
 * subject-discriminated identity partition of the {@link Invoice} DU.
 *
 * Each arm is constructed explicitly (not spread-widened) so TypeScript checks
 * the literal-typed members against {@link InvoiceSubjectFields}. The defensive
 * checks mirror the DB CHECK `invoices_subject_fields_ck` exactly; a row that
 * somehow violated the CHECK fails loud via {@link MalformedInvoiceSubjectError}
 * rather than producing a mis-typed Invoice.
 */
/** @internal Exported for unit-test coverage of the 4 CHECK-violating throw branches. */
export function rowToSubjectFields(row: InvoiceRow): InvoiceSubjectFields {
  if (row.invoiceSubject === 'membership') {
    if (row.memberId === null || row.planId === null || row.planYear === null) {
      throw new MalformedInvoiceSubjectError(
        row.invoiceId,
        'membership row missing member_id/plan_id/plan_year',
      );
    }
    if (
      row.eventId !== null ||
      row.eventRegistrationId !== null ||
      row.vatInclusive !== false
    ) {
      throw new MalformedInvoiceSubjectError(
        row.invoiceId,
        'membership row carries event_id/event_registration_id or vat_inclusive=true',
      );
    }
    return {
      invoiceSubject: 'membership',
      memberId: row.memberId,
      planId: row.planId,
      planYear: row.planYear,
      eventId: null,
      eventRegistrationId: null,
      vatInclusive: false,
    };
  }

  // invoiceSubject === 'event'
  if (row.eventId === null || row.eventRegistrationId === null) {
    throw new MalformedInvoiceSubjectError(
      row.invoiceId,
      'event row missing event_id/event_registration_id',
    );
  }
  if (row.planId !== null || row.planYear !== null) {
    throw new MalformedInvoiceSubjectError(
      row.invoiceId,
      'event row carries plan_id/plan_year',
    );
  }
  return {
    invoiceSubject: 'event',
    // member_id is OPTIONAL for the event subject: a matched member or a
    // non-member buyer (null). Not constrained by the DB CHECK.
    memberId: row.memberId ?? null,
    planId: null,
    planYear: null,
    eventId: row.eventId,
    eventRegistrationId: row.eventRegistrationId,
    vatInclusive: row.vatInclusive,
  };
}

/**
 * 064 (Task 2) — map the `pdf_doc_kind` text column onto the Domain literal
 * union. The DB CHECK `invoices_pdf_doc_kind_valid` pins the value set, so an
 * unknown NON-NULL string can only mean a corrupt row (manual DB patch,
 * dropped CHECK) — THROW loudly (mirrors the corrupt-document_number /
 * partial-pdf throw pattern in this file) rather than constructing an Invoice
 * whose doc kind lies to the J2 credit-note re-render path.
 */
function pdfDocKindOrNull(
  raw: string | null,
  invoiceId: string,
): Invoice['pdfDocKind'] {
  if (raw === null) return null;
  if (raw === 'invoice' || raw === 'receipt_combined' || raw === 'receipt_separate') {
    return raw;
  }
  throw new Error(
    `drizzle-invoice-repo: corrupt pdf_doc_kind on row ${invoiceId}: '${raw}'`,
  );
}

function rowsToInvoice(row: InvoiceRow, lines: readonly InvoiceLine[]): Invoice {
  let docNum: DocumentNumber | null = null;
  if (row.documentNumber !== null) {
    const parsed = DocumentNumber.parse(row.documentNumber);
    if (!parsed.ok) {
      throw new Error(
        `drizzle-invoice-repo: corrupt document_number on row ${row.invoiceId}: ${row.documentNumber}`,
      );
    }
    docNum = parsed.value;
  }

  const subtotal = satangOrNull(row.subtotalSatang);
  const vat = satangOrNull(row.vatSatang);
  const total = satangOrNull(row.totalSatang);
  const credited = Money.fromSatangUnsafe(
    BigInt(row.creditedTotalSatang as unknown as string),
  );

  // 054-event-fee-invoices — construct the subject-discriminated identity
  // partition (the `Invoice` DU is keyed on `invoice_subject`). The DB CHECK
  // `invoices_subject_fields_ck` (migration 0208) GUARANTEES these invariants
  // for every persisted row; the defensive throws below turn a corrupt row
  // (legacy seed, manual DB patch, regressed write) into a loud
  // MalformedInvoiceSubjectError instead of a mis-typed Invoice that lies to
  // its consumers about which fields are non-null.
  const subjectFields = rowToSubjectFields(row);

  return {
    tenantId: row.tenantId,
    invoiceId: asInvoiceId(row.invoiceId),
    ...subjectFields,
    status: row.status as InvoiceStatus,
    draftByUserId: row.draftByUserId,

    fiscalYear: row.fiscalYear === null ? null : asFiscalYearUnsafe(row.fiscalYear),
    sequenceNumber: row.sequenceNumber ?? null,
    documentNumber: docNum,

    issueDate: row.issueDate ?? null,
    dueDate: row.dueDate ?? null,
    paidAt: isoOrNull(row.paidAt),
    voidedAt: isoOrNull(row.voidedAt),

    currency: 'THB',
    subtotal,
    vatRate: row.vatRateSnapshot === null ? null : VatRate.ofUnsafe(row.vatRateSnapshot),
    vat,
    total,
    creditedTotal: credited,

    proRatePolicy:
      row.proRatePolicySnapshot === null
        ? null
        : asProRatePolicyUnsafe(row.proRatePolicySnapshot),
    netDays: row.netDaysSnapshot ?? null,

    tenantIdentitySnapshot:
      row.tenantIdentitySnapshot === null
        ? null
        : makeTenantIdentitySnapshot(
            row.tenantIdentitySnapshot as TenantIdentitySnapshot,
          ),
    // READ path — `parseMemberIdentitySnapshot` (structural, with the invoiceId
    // on the error) is the whole job. It used to be wrapped in
    // `makeMemberIdentitySnapshot`, which (a) re-parsed the same object for
    // nothing and (b) applied the WRITE-only `registrant ⇒ TIN` rule to rows that
    // were written before that rule existed — one such row threw here and 500'd
    // the entire invoice list. See `readMemberIdentitySnapshot`'s docblock.
    memberIdentitySnapshot:
      row.memberIdentitySnapshot === null
        ? null
        : Object.freeze(parseMemberIdentitySnapshot(row)),

    paymentMethod: row.paymentMethod ?? null,
    paymentReference: row.paymentReference ?? null,
    paymentNotes: row.paymentNotes ?? null,
    paymentRecordedByUserId: row.paymentRecordedByUserId ?? null,
    paymentDate: row.paymentDate ?? null,

    voidReason: row.voidReason ?? null,
    voidedByUserId: row.voidedByUserId ?? null,

    autoEmailOnIssue: row.autoEmailOnIssue ?? null,

    pdf: buildPdfOrNull(row.pdfBlobKey, row.pdfSha256, row.pdfTemplateVersion, row.invoiceId, 'pdf'),
    pdfDocKind: pdfDocKindOrNull(row.pdfDocKind, row.invoiceId),
    receiptPdf: buildPdfOrNull(
      row.receiptPdfBlobKey,
      row.receiptPdfSha256,
      row.receiptPdfTemplateVersion,
      row.invoiceId,
      'receiptPdf',
    ),
    // T166 — async receipt PDF state. NULL on non-paid rows (CHECK
    // constraint enforces); pending|rendered|failed otherwise.
    receiptPdfStatus: row.receiptPdfStatus ?? null,
    receiptPdfRenderAttempts: row.receiptPdfRenderAttempts ?? 0,
    receiptPdfLastError: row.receiptPdfLastError ?? null,
    receiptDocumentNumberRaw: row.receiptDocumentNumberRaw ?? null,
    // 088 US1 — non-§87 bill number (SC) allocated at issue in the new flow.
    billDocumentNumberRaw: row.billDocumentNumberRaw ?? null,
    // 088 US8 (§ F.8) — per-invoice VAT treatment + pinned MFA cert. The DB
    // column is NOT NULL DEFAULT 'standard'; the narrow cast is safe because
    // `invoices_vat_treatment_valid` pins the value set (a corrupt value would
    // be a dropped-CHECK anomaly, out of scope for a silent coerce here).
    vatTreatment: (row.vatTreatment ?? 'standard') as VatTreatment,
    zeroRateCertNo: row.zeroRateCertNo ?? null,
    zeroRateCertDate: row.zeroRateCertDate ?? null,
    zeroRateCertBlobKey: row.zeroRateCertBlobKey ?? null,

    lines,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Build an InvoiceRepo bound to `tenantId`.
 *
 * When `externalTx` is supplied, the repo's `withTx` short-circuits to
 * invoke the callback directly against that transaction INSTEAD of
 * opening a new `runInTenant` tx. This is the tx-sharing path used by
 * the F5 → F4 invoicing-bridge (Reliability D-03, Group E2b): F5 owns
 * the outer tx, and threads it into F4's `markPaidFromProcessor` so the
 * payment-row update and the invoice flip to `paid` commit atomically.
 *
 * Preconditions when `externalTx` is supplied:
 *   - Caller has already entered `runInTenant` (so `app.current_tenant`
 *     is SET LOCAL on the same session) — the F5 confirm-payment
 *     use-case guarantees this by wrapping the bridge call in its own
 *     `paymentsRepo.withTx`, which IS `runInTenant`-based.
 *
 * When `externalTx` is absent, behaviour is unchanged: F4 opens its
 * own tenant-bound tx exactly as it did before.
 */
export function makeDrizzleInvoiceRepo(
  tenantId: string,
  externalTx?: unknown,
): InvoiceRepo {
  const ctx = asTenantContext(tenantId);

  /**
   * Run `fn` on the tenant-scoped connection: inline against a caller-supplied
   * `externalTx` when present, else a fresh `runInTenant`. Shared by `withTx`
   * (mutation paths — D-03 atomic bridge) and the tx-aware `findById` read
   * (B.1 review Fix#2 — the F5 refund pre-flight threads its Phase A tx so the
   * F4 credited-total read runs on the SAME pooled connection as the payment
   * `FOR UPDATE`, instead of a nested `runInTenant` acquiring a 2nd pooled
   * connection that can self-deadlock under concurrent refunds).
   *
   * Backend-dev review F-01 (Group E, 2026-04-24): runtime tenant-mismatch
   * guard. If a future composer hands us tenantA's tx while this repo is bound
   * to tenantB, the outer `SET LOCAL app.current_tenant=A` would still be in
   * effect → F4 would read/write against tenantA's RLS namespace silently.
   * Re-read `current_setting('app.current_tenant')` and refuse on disagreement
   * (Constitution Principle I clause 3 — make the precondition explicit).
   * Postgres has no true nested transactions, so we never open one when an
   * `externalTx` is supplied; `SET LOCAL app.current_tenant` was already
   * established on that connection by the outer `runInTenant`.
   */
  async function withTenantConn<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    if (externalTx !== undefined) {
      const externalTxTyped = externalTx as TenantTx;
      const probe = (await externalTxTyped.execute(
        sql`SELECT current_setting('app.current_tenant', TRUE) AS current_tenant`,
      )) as unknown as Array<{ current_tenant: string | null }>;
      const current_tenant = probe[0]?.current_tenant ?? null;
      if (current_tenant !== ctx.slug) {
        throw new Error(
          `makeDrizzleInvoiceRepo: externalTx tenant mismatch — repo bound to "${ctx.slug}" but tx carries "${current_tenant ?? '(unset)'}". Refusing to read from or write to a different tenant's namespace.`,
        );
      }
      return fn(externalTx);
    }
    return runInTenant(ctx, async (tx) => fn(tx));
  }

  return {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return withTenantConn(fn);
    },

    async insertDraft(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      // 054-event-fee-invoices — `input` carries the subject-discriminated
      // identity fields as the `InvoiceSubjectFields` DU (write-seam twin of
      // the read model). Narrow on `invoiceSubject` and map only that arm's
      // valid fields onto the row; the off-subject columns are the arm's typed
      // `null` literal. Mirrors the read-seam `rowToSubjectFields`. DB columns
      // are unchanged — this is a type-level tightening only.
      const subjectColumns =
        input.invoiceSubject === 'membership'
          ? {
              invoiceSubject: 'membership' as const,
              memberId: input.memberId,
              planId: input.planId,
              planYear: input.planYear,
              eventId: null,
              eventRegistrationId: null,
              vatInclusive: false,
            }
          : {
              invoiceSubject: 'event' as const,
              // member_id is OPTIONAL on the event arm: matched member (string)
              // or non-member buyer (null).
              memberId: input.memberId,
              planId: null,
              planYear: null,
              eventId: input.eventId,
              eventRegistrationId: input.eventRegistrationId,
              vatInclusive: input.vatInclusive,
            };
      const [insertedInvoice] = await tx
        .insert(invoices)
        .values({
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          ...subjectColumns,
          status: 'draft',
          draftByUserId: input.draftByUserId,
          autoEmailOnIssue: input.autoEmailOnIssue,
          // 054-event-fee-invoices (Task 6b) — pin the BUYER snapshot at draft
          // for NON-MEMBER event attendees (no member row to re-read at issue).
          // `undefined` (membership + matched-member callers) → DB null; the
          // snapshot is then populated at ISSUE for those subjects (FR-038).
          memberIdentitySnapshot: input.memberIdentitySnapshot ?? null,
        })
        .returning();
      if (!insertedInvoice) throw new Error('insertDraft: no row returned');

      if (input.lines.length > 0) {
        await tx.insert(invoiceLines).values(
          input.lines.map((l) => ({
            tenantId: input.tenantId,
            lineId: l.lineId,
            invoiceId: input.invoiceId,
            kind: l.kind,
            descriptionTh: l.descriptionTh,
            descriptionEn: l.descriptionEn,
            unitPriceSatang: l.unitPrice.satang,
            quantity: l.quantity,
            proRateFactor: l.proRateFactor,
            totalSatang: l.total.satang,
            position: l.position,
          })),
        );
      }

      return rowsToInvoice(insertedInvoice as InvoiceRow, input.lines);
    },

    async findByIdInTx(txUnknown, invoiceId: InvoiceId, tenantIdArg: string): Promise<Invoice | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenantIdArg), eq(invoices.invoiceId, invoiceId)))
        .limit(1);
      if (!row) return null;
      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(and(eq(invoiceLines.tenantId, tenantIdArg), eq(invoiceLines.invoiceId, invoiceId)))
        .orderBy(asc(invoiceLines.position));
      const lines = lineRows.map(rowToLine);
      return rowsToInvoice(row as InvoiceRow, lines);
    },

    /**
     * Wave-4 S28 — `findByIdInTx` + row lock in one round-trip. The
     * `.for('update')` modifier takes the SAME row lock `lockForUpdate`'s
     * raw `FOR UPDATE` takes (drizzle-tenant-settings-repo precedent), so
     * the caller-contract lock ordering is unchanged — one SELECT instead
     * of the former lock-then-reload pair.
     */
    async findByIdInTxForUpdate(
      txUnknown,
      invoiceId: InvoiceId,
      tenantIdArg: string,
    ): Promise<Invoice | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenantIdArg), eq(invoices.invoiceId, invoiceId)))
        .limit(1)
        .for('update');
      if (!row) return null;
      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(and(eq(invoiceLines.tenantId, tenantIdArg), eq(invoiceLines.invoiceId, invoiceId)))
        .orderBy(asc(invoiceLines.position));
      return rowsToInvoice(row as InvoiceRow, lineRows.map(rowToLine));
    },

    async findById(invoiceId: InvoiceId, tenantIdArg: string): Promise<Invoice | null> {
      // B.1 review Fix#2 — `withTenantConn` runs inline against a caller
      // `externalTx` when the repo was built with one (F5 refund pre-flight),
      // else opens its own `runInTenant` (unchanged for every existing caller
      // — none pass `externalTx` to `makeGetInvoiceDeps` today).
      return withTenantConn(async (txUnknown) => {
        const tx = txUnknown as TenantTx;
        const [row] = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantIdArg), eq(invoices.invoiceId, invoiceId)))
          .limit(1);
        if (!row) return null;
        const lineRows = await tx
          .select()
          .from(invoiceLines)
          .where(
            and(eq(invoiceLines.tenantId, tenantIdArg), eq(invoiceLines.invoiceId, invoiceId)),
          )
          .orderBy(asc(invoiceLines.position));
        return rowsToInvoice(row as InvoiceRow, lineRows.map(rowToLine));
      });
    },

    async list(tenantIdArg: string, opts) {
      return runInTenant(ctx, async (tx) => {
        const filters = [eq(invoices.tenantId, tenantIdArg)];

        const includeDrafts = opts.includeDrafts ?? false;
        // Unconditional draft-exclusion guard (kept in lockstep with
        // `listPaged`). #15 fix: the prior `(!opts.status || opts.status ===
        // 'all')` guard still let `status: 'draft'` bypass — the specific-status
        // branch below fired `eq(status, 'draft')`, returning drafts even with
        // `includeDrafts: false` (reachable via `GET /api/invoices?status=draft`
        // with no `includeDrafts=true`). Excluding drafts whenever they are not
        // opted-in is correct for EVERY status, because the filters array is
        // AND-combined:
        //   - undefined / 'all'  → drafts excluded (subsumes the prior fix)
        //   - 'issued'/'paid'/…  → eq(status, X) AND status != 'draft' (no-op
        //     for non-draft statuses)
        //   - 'draft'            → eq(status, 'draft') AND status != 'draft' →
        //     EMPTY (the #15 fix: a raw API draft request without the flag now
        //     returns nothing — members/managers must opt in via includeDrafts)
        // `includeDrafts: true` (admin member-detail / GDPR export) skips the
        // exclusion entirely, so all legitimate draft paths are unchanged.
        if (!includeDrafts) {
          filters.push(sql`${invoices.status} != 'draft'`);
        }
        if (opts.status && opts.status !== 'all') {
          filters.push(eq(invoices.status, opts.status));
        }
        if (opts.fiscalYear !== undefined) {
          filters.push(eq(invoices.fiscalYear, opts.fiscalYear));
        }
        if (opts.memberId) filters.push(eq(invoices.memberId, opts.memberId));
        if (opts.search && opts.search.length > 0) {
          // W1 (064 remediation) — β as-paid no-TIN rows carry their printed
          // §105 number in receipt_document_number_raw with document_number
          // NULL, and paid separate-mode rows ALSO have an RC number admins
          // search by. 088 T069/FR-030 — an issued ใบแจ้งหนี้ bill carries its
          // non-§87 SC number in bill_document_number_raw (document_number NULL
          // until payment), so match that column too or an issued 088 bill is
          // unfindable by its printed SC number. Match ANY printed
          // §87/§105/SC number. Kept in lockstep with `listPaged` below.
          filters.push(
            or(
              ilike(invoices.documentNumber, `%${opts.search}%`),
              ilike(invoices.receiptDocumentNumberRaw, `%${opts.search}%`),
              ilike(invoices.billDocumentNumberRaw, `%${opts.search}%`),
            )!,
          );
        }
        if (opts.cursor) {
          // S1-P1-9b: composite (issueDate, invoiceId) keyset matching the
          // ORDER BY desc(issueDate) [Postgres DESC = NULLS FIRST], desc(invoiceId).
          // A single-column invoiceId keyset is wrong here — invoiceId is a
          // random UUID, NOT aligned with issueDate — so across >1 page it
          // skipped/duplicated rows, skewing the F9 insights paginated
          // aggregation (revenue/overdue) once a tenant exceeds PAGE=100 rows.
          // Cursor format: `${issueDate ?? ''}|${invoiceId}` — an empty
          // issueDate-part means a NULL issueDate (a draft), which sorts FIRST.
          const sep = opts.cursor.indexOf('|');
          const cIssue = sep >= 0 ? opts.cursor.slice(0, sep) : '';
          const cId = sep >= 0 ? opts.cursor.slice(sep + 1) : opts.cursor;
          if (cIssue === '') {
            // Cursor row had a NULL issueDate (draft): remaining = other null
            // rows with a smaller invoiceId, OR every non-null row (which sort
            // after the null group).
            filters.push(
              or(
                and(isNull(invoices.issueDate), lt(invoices.invoiceId, cId)),
                isNotNull(invoices.issueDate),
              )!,
            );
          } else {
            // Cursor row had a real issueDate — the null group already preceded it.
            filters.push(
              and(
                isNotNull(invoices.issueDate),
                or(
                  lt(invoices.issueDate, cIssue),
                  and(eq(invoices.issueDate, cIssue), lt(invoices.invoiceId, cId)),
                ),
              )!,
            );
          }
        }

        const rows = await tx
          .select()
          .from(invoices)
          .where(and(...filters))
          .orderBy(desc(invoices.issueDate), desc(invoices.invoiceId))
          .limit(opts.pageSize + 1);

        const hasMore = rows.length > opts.pageSize;
        const page = rows.slice(0, opts.pageSize) as InvoiceRow[];
        // S1-P1-9b: composite cursor — encode (issueDate, invoiceId) of the last
        // row so the next page resumes the keyset correctly.
        const lastRow = page[page.length - 1];
        const nextCursor =
          hasMore && lastRow
            ? `${lastRow.issueDate ?? ''}|${lastRow.invoiceId}`
            : null;

        // Load lines in a single follow-up query for each invoice on the page.
        const invoiceIds = page.map((r) => r.invoiceId);
        const linesByInvoice = new Map<string, InvoiceLine[]>();
        if (invoiceIds.length > 0) {
          const allLines = await tx
            .select()
            .from(invoiceLines)
            .where(
              and(
                eq(invoiceLines.tenantId, tenantIdArg),
                sql`${invoiceLines.invoiceId} IN (${sql.join(
                  invoiceIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
              ),
            )
            .orderBy(asc(invoiceLines.invoiceId), asc(invoiceLines.position));
          for (const lr of allLines) {
            const bucket = linesByInvoice.get(lr.invoiceId) ?? [];
            bucket.push(rowToLine(lr as InvoiceLineRow));
            linesByInvoice.set(lr.invoiceId, bucket);
          }
        }

        return {
          rows: page.map((r) => rowsToInvoice(r, linesByInvoice.get(r.invoiceId) ?? [])),
          nextCursor,
        };
      });
    },

    /**
     * void-on-reissue (Task 2) — the member's strictly-older outstanding
     * new-flow MEMBERSHIP bills. Shape filter (bill_document_number_raw NOT
     * NULL AND document_number NULL) excludes legacy §86/4 bills; status
     * excludes paid/void/credited; invoice_subject excludes event invoices.
     * The `(created_at, invoice_id) < bound` row-comparison is asymmetric BY
     * DESIGN — it never matches the bound (newest) bill itself, so concurrent
     * same-member issues converge on one deterministic survivor.
     */
    async listSupersedableMembershipBills(tenantIdArg, memberId, bound) {
      return runInTenant(ctx, async (tx) => {
        const rows = await (tx as TenantTx)
          .select({ invoiceId: invoices.invoiceId })
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, tenantIdArg),
              eq(invoices.memberId, memberId),
              eq(invoices.invoiceSubject, 'membership'),
              eq(invoices.status, 'issued'),
              isNotNull(invoices.billDocumentNumberRaw),
              isNull(invoices.documentNumber),
              // Cast the ISO string inside SQL so postgres-js doesn't try to
              // serialize a raw JS Date inside a composite row-value tuple
              // (same fix as drizzle-member-repo.ts's cursor comparison).
              sql`(${invoices.createdAt}, ${invoices.invoiceId}) < (${bound.createdAt.toISOString()}::timestamptz, ${bound.invoiceId})`,
              sql`${invoices.invoiceId} <> ${bound.excludeInvoiceId}`,
            ),
          )
          .orderBy(invoices.createdAt, invoices.invoiceId);
        return rows.map((r) => ({ invoiceId: r.invoiceId }));
      });
    },

    async listPaged(tenantIdArg: string, opts) {
      return runInTenant(ctx, async (tx) => {
        const filters = [eq(invoices.tenantId, tenantIdArg)];
        const includeDrafts = opts.includeDrafts ?? false;
        // Unconditional draft-exclusion guard (kept in lockstep with the cursor
        // `list`). #15 fix: the prior `(!opts.status || opts.status === 'all')`
        // guard still let `status: 'draft'` bypass — the specific-status branch
        // below fired `eq(status, 'draft')`, returning drafts even with
        // `includeDrafts: false`. Excluding drafts whenever they are not opted-in
        // is correct for EVERY status because the filters array is AND-combined:
        //   - undefined / 'all'  → drafts excluded (subsumes the prior fix; the
        //     member portal calls `{ includeDrafts: false, status: 'all' }`)
        //   - 'issued'/'paid'/…  → eq(status, X) AND status != 'draft' (no-op
        //     for non-draft statuses)
        //   - 'overdue'          → status = 'issued' AND past-due AND status !=
        //     'draft' (no-op; 'issued' already excludes 'draft')
        //   - 'draft'            → eq(status, 'draft') AND status != 'draft' →
        //     EMPTY (the #15 fix: a raw draft request without the flag returns
        //     nothing)
        // `includeDrafts: true` (admin member-detail / GDPR export) skips the
        // exclusion entirely so all legitimate draft paths are unchanged.
        if (!includeDrafts) {
          filters.push(sql`${invoices.status} != 'draft'`);
        }
        if (opts.status === 'overdue') {
          // S1-P1-8: 'overdue' is a DERIVED view, not a stored status, so the
          // old `eq(status,'overdue')` matched zero rows. Mirror the
          // computeIsOverdue rule (status='issued' AND Bangkok-today > dueDate,
          // strict) in SQL so this filter agrees with the per-row overdue badge.
          filters.push(eq(invoices.status, 'issued'));
          filters.push(
            sql`${invoices.dueDate} IS NOT NULL AND ${invoices.dueDate} < (now() AT TIME ZONE 'Asia/Bangkok')::date`,
          );
        } else if (opts.status && opts.status !== 'all') {
          filters.push(eq(invoices.status, opts.status));
        }
        if (opts.fiscalYear !== undefined) {
          filters.push(eq(invoices.fiscalYear, opts.fiscalYear));
        }
        if (opts.memberId) filters.push(eq(invoices.memberId, opts.memberId));
        if (opts.invoiceSubject) {
          // 054-event-fee-invoices — subject filter (membership | event).
          // Maps directly to the stored `invoice_subject` discriminator.
          filters.push(eq(invoices.invoiceSubject, opts.invoiceSubject));
        }
        // 088 T065b (FR-031) — tax-document-type filter. Derived from the
        // numbering columns + status (see the port doc + T065b report):
        //   sc → 088 bill still awaiting payment (bill number, no §86/4 receipt).
        //   rc → §86/4 tax receipt. `receipt_document_number_raw` carries BOTH
        //        the §86/4 'RC' stream AND the §105 'RE' stream; the 'RE' prefix
        //        is HARDCODED + reserved in tenant settings (see
        //        issue-event-invoice-as-paid.ts:474 + update-tenant-invoice-
        //        settings), so `NOT LIKE 'RE-%'` robustly isolates the §86/4
        //        register (RC prefix is tenant-configurable, RE is not).
        //   re → the §105 receipt register ('RE-' prefix).
        //   cn → invoices carrying a credit note (credited / partially_credited);
        //        the credit-note ROWS live in `credit_notes` — this is the
        //        invoice-list cross-reference (a full ใบลดหนี้ register is
        //        follow-on).
        if (opts.documentType === 'sc') {
          filters.push(isNotNull(invoices.billDocumentNumberRaw));
          filters.push(isNull(invoices.receiptDocumentNumberRaw));
        } else if (opts.documentType === 'rc') {
          filters.push(isNotNull(invoices.receiptDocumentNumberRaw));
          filters.push(sql`${invoices.receiptDocumentNumberRaw} NOT LIKE 'RE-%'`);
        } else if (opts.documentType === 're') {
          filters.push(sql`${invoices.receiptDocumentNumberRaw} LIKE 'RE-%'`);
        } else if (opts.documentType === 'cn') {
          filters.push(
            or(
              eq(invoices.status, 'credited'),
              eq(invoices.status, 'partially_credited'),
            )!,
          );
        }
        // 088 T065b (FR-031) — payment-tax-point state filter. Under the 088
        // tax-at-payment model the tax point is the PAYMENT moment (§86/4/§105
        // receipt issued), NOT issue. pre_payment = an 088 bill still awaiting
        // payment; at_payment = a receipt has been issued.
        if (opts.taxPointState === 'pre_payment') {
          filters.push(isNotNull(invoices.billDocumentNumberRaw));
          filters.push(isNull(invoices.receiptDocumentNumberRaw));
        } else if (opts.taxPointState === 'at_payment') {
          filters.push(isNotNull(invoices.receiptDocumentNumberRaw));
        }
        // 088 T065b (FR-031 / US8) — pinned per-invoice VAT treatment filter.
        if (opts.vatTreatment) {
          filters.push(eq(invoices.vatTreatment, opts.vatTreatment));
        }
        if (opts.search && opts.search.length > 0) {
          // W1 (064 remediation) — match invoice doc number OR the §105
          // receipt number OR (088 T069/FR-030) the non-§87 SC bill number
          // (bill_document_number_raw, NULL document_number until payment) so an
          // issued 088 ใบแจ้งหนี้ is findable by its printed SC number; see the
          // `list` variant above for the rationale. Kept in lockstep.
          filters.push(
            or(
              ilike(invoices.documentNumber, `%${opts.search}%`),
              ilike(invoices.receiptDocumentNumberRaw, `%${opts.search}%`),
              ilike(invoices.billDocumentNumberRaw, `%${opts.search}%`),
            )!,
          );
        }
        if (opts.paidOnlineOnly) {
          // F5 US3 reconciliation filter — invoice has at least one
          // succeeded F5 payment via card or PromptPay. Raw SQL because
          // F4 should not import F5 Drizzle schema (`payments` is the
          // F5 table; coupling stays as a fixed string identifier here,
          // verified by the F5 RLS coverage test). RLS on `payments`
          // already enforces tenant isolation, so the explicit
          // `tenant_id = invoices.tenant_id` join clause is defence in
          // depth (same posture used elsewhere in this file).
          filters.push(sql`EXISTS (
            SELECT 1 FROM payments p
            WHERE p.invoice_id = ${invoices.invoiceId}
              AND p.tenant_id = ${invoices.tenantId}
              AND p.status = 'succeeded'
              AND p.method IN ('card', 'promptpay')
          )`);
        }

        const [rowsRaw, countRows] = await Promise.all([
          tx
            .select()
            .from(invoices)
            .where(and(...filters))
            .orderBy(desc(invoices.issueDate), desc(invoices.invoiceId))
            .limit(opts.pageSize)
            .offset(opts.offset),
          tx.execute(
            sql`SELECT COUNT(*)::int AS c FROM invoices WHERE ${and(...filters)!}`,
          ),
        ]);
        const page = rowsRaw as InvoiceRow[];
        const total = Number(
          (countRows as unknown as Array<{ c: number }>)[0]?.c ?? 0,
        );

        const invoiceIds = page.map((r) => r.invoiceId);
        const linesByInvoice = new Map<string, InvoiceLine[]>();
        if (invoiceIds.length > 0) {
          const allLines = await tx
            .select()
            .from(invoiceLines)
            .where(
              and(
                eq(invoiceLines.tenantId, tenantIdArg),
                sql`${invoiceLines.invoiceId} IN (${sql.join(
                  invoiceIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`,
              ),
            )
            .orderBy(asc(invoiceLines.invoiceId), asc(invoiceLines.position));
          for (const lr of allLines) {
            const bucket = linesByInvoice.get(lr.invoiceId) ?? [];
            bucket.push(rowToLine(lr as InvoiceLineRow));
            linesByInvoice.set(lr.invoiceId, bucket);
          }
        }

        return {
          rows: page.map((r) => rowsToInvoice(r, linesByInvoice.get(r.invoiceId) ?? [])),
          total,
        };
      });
    },

    async applyIssue(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      const [updated] = await tx
        .update(invoices)
        .set({
          status: 'issued',
          fiscalYear: input.fiscalYear,
          sequenceNumber: input.sequenceNumber,
          documentNumber: input.documentNumber,
          // 088 US1 — non-§87 bill number (SC) written in the new flow; the
          // legacy §87-at-issue path leaves it undefined → NULL (unchanged).
          billDocumentNumberRaw: input.billDocumentNumberRaw ?? null,
          // 088 US8 (§ F.8) — pinned per-invoice VAT treatment + MFA cert.
          // Default 'standard' keeps every pre-US8 caller (and the legacy path)
          // on the unchanged VAT-7% behaviour; cert fields NULL unless zero-rated.
          vatTreatment: input.vatTreatment ?? 'standard',
          zeroRateCertNo: input.zeroRateCertNo ?? null,
          zeroRateCertDate: input.zeroRateCertDate ?? null,
          zeroRateCertBlobKey: input.zeroRateCertBlobKey ?? null,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          subtotalSatang: input.subtotalSatang,
          vatRateSnapshot: input.vatRate,
          vatSatang: input.vatSatang,
          totalSatang: input.totalSatang,
          proRatePolicySnapshot: input.proRatePolicySnapshot,
          netDaysSnapshot: input.netDaysSnapshot,
          tenantIdentitySnapshot: input.tenantIdentitySnapshot,
          memberIdentitySnapshot: input.memberIdentitySnapshot,
          pdfBlobKey: input.pdf.blobKey,
          pdfSha256: input.pdf.sha256,
          pdfTemplateVersion: input.pdf.templateVersion,
          // 064 (Task 2) — what the rendered main PDF IS; required on every
          // non-draft row (`invoices_non_draft_has_doc_kind`).
          pdfDocKind: input.pdfDocKind,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            // Defense-in-depth — application calls lockForUpdate first,
            // but an UPDATE without a status guard could still overwrite
            // an already-issued row if a refactor removed the lock.
            eq(invoices.status, 'draft'),
          ),
        )
        .returning();
      if (!updated) throw new InvoiceApplyConflictError('applyIssue');

      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, input.tenantId),
            eq(invoiceLines.invoiceId, input.invoiceId),
          ),
        )
        .orderBy(asc(invoiceLines.position));
      return rowsToInvoice(updated as InvoiceRow, lineRows.map(rowToLine));
    },

    async deleteDraft(txUnknown, invoiceId: InvoiceId, tenantIdArg: string): Promise<void> {
      const tx = txUnknown as TenantTx;
      // invoice_lines cascade-deletes via FK
      await tx
        .delete(invoices)
        .where(and(eq(invoices.tenantId, tenantIdArg), eq(invoices.invoiceId, invoiceId)));
    },

    async lockForUpdate(txUnknown, invoiceId: InvoiceId, tenantIdArg: string) {
      const tx = txUnknown as TenantTx;
      const rows = (await tx.execute(sql`
        SELECT status FROM invoices
         WHERE tenant_id = ${tenantIdArg} AND invoice_id = ${invoiceId}
         FOR UPDATE
      `)) as unknown as Array<{ status: InvoiceStatus }>;
      return rows[0]?.status ?? null;
    },

    async applyPayment(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      // Single atomic UPDATE: issued → paid + payment fields + receipt
      // PDF metadata (sync) or status='pending' marker (async, T166).
      // Status/payment/pdf columns are intentionally NOT guarded by
      // the invoices immutability trigger, so no split write is
      // needed. The WHERE `status='issued'` guard below prevents
      // double-apply on concurrent state-change races.
      const isRendered = input.receiptPdf.kind === 'rendered';
      const [updated] = await tx
        .update(invoices)
        .set({
          status: 'paid',
          paidAt: sql`now()`,
          paymentMethod: input.paymentMethod,
          paymentReference: input.paymentReference,
          paymentNotes: input.paymentNotes,
          paymentRecordedByUserId: input.paymentRecordedByUserId,
          // R7-W5 — admin-entered payment date (distinct from paidAt
          // which is the server-side mark-paid timestamp).
          paymentDate: input.paymentDate,
          // F4 final-review C1: write RECEIPT columns, NOT invoice
          // columns. The invoice PDF's blobKey+sha256 stays frozen at
          // its issue-time values for audit integrity.
          // T166: sync path stamps blob_key+sha256 + status='rendered';
          // async path leaves blob fields NULL + status='pending' (the
          // worker fills them later via applyReceiptPdf).
          receiptPdfBlobKey: isRendered ? input.receiptPdf.blobKey : null,
          receiptPdfSha256: isRendered ? input.receiptPdf.sha256 : null,
          receiptPdfTemplateVersion: isRendered
            ? input.receiptPdf.templateVersion
            : null,
          receiptPdfStatus: isRendered ? 'rendered' : 'pending',
          // Persist the pre-allocated receipt doc number on BOTH paths
          // (sync + async) so the UI ("Receipt No." field/column) +
          // audit reader can read it back without re-parsing the PDF
          // bytes. Previously the sync 'rendered' path left this NULL
          // assuming the doc num was "baked into the PDF bytes", but
          // that meant the detail page + list column showed nothing
          // for separate-mode invoices paid synchronously.
          // NULL in combined-mode (receipt reuses the invoice doc num).
          receiptDocumentNumberRaw: input.receiptPdf.receiptDocumentNumberRaw,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            eq(invoices.status, 'issued'),
          ),
        )
        .returning();
      if (!updated) throw new InvoiceApplyConflictError('applyPayment');

      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, input.tenantId),
            eq(invoiceLines.invoiceId, input.invoiceId),
          ),
        )
        .orderBy(asc(invoiceLines.position));
      return rowsToInvoice(updated as InvoiceRow, lineRows.map(rowToLine));
    },

    /**
     * 064 — as-paid issuance: SINGLE UPDATE draft→paid with every
     * snapshot / numbering / payment / pdf field set in one statement,
     * so there is no partial-failure window and the immutability
     * trigger (early-return on OLD.status='draft') never blocks it.
     * The non-draft + paid CHECKs (snapshots 0203, paid_has_payment
     * 0019, paid_has_receipt_status 0056, doc_kind 0211) all validate
     * against the post-UPDATE row in this one commit.
     *
     * Numbering per the input discriminated union:
     *   - 'invoice_stream' (TIN buyer) → sequence_number +
     *     document_number set, receipt_document_number_raw NULL.
     *   - 'receipt_stream' (no-TIN β) → both NULL +
     *     receipt_document_number_raw set. This shape passes
     *     `invoices_non_draft_has_snapshots` via the 0212 relaxed leg
     *     (event subject + receipt_document_number_raw present,
     *     invoice-stream pair NULL).
     *
     * receipt_pdf_status lands as 'rendered' (NEVER 'pending'): for
     * as-paid the rendered main PDF IS the receipt (combined) or the
     * §105 receipt (separate β) — no async receipt worker is involved.
     * receipt_pdf_blob_key stays NULL for the same reason (defensive
     * explicit write; a draft row already carries NULL).
     */
    async applyIssueAsPaid(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      const numberingColumns =
        input.numbering.kind === 'invoice_stream'
          ? {
              sequenceNumber: input.numbering.sequenceNumber,
              documentNumber: input.numbering.documentNumber,
              receiptDocumentNumberRaw: null,
            }
          : {
              sequenceNumber: null,
              documentNumber: null,
              receiptDocumentNumberRaw: input.numbering.receiptDocumentNumberRaw,
            };
      const [updated] = await tx
        .update(invoices)
        .set({
          status: 'paid',
          fiscalYear: input.fiscalYear,
          ...numberingColumns,
          issueDate: input.issueDate,
          // As-paid: the document is settled the moment it exists.
          dueDate: input.issueDate,
          netDaysSnapshot: 0,
          subtotalSatang: input.subtotalSatang,
          vatRateSnapshot: input.vatRate,
          vatSatang: input.vatSatang,
          totalSatang: input.totalSatang,
          // Event subject only — pro-rating is a membership concept
          // (relaxed CHECK 0203 exempts the event subject).
          proRatePolicySnapshot: null,
          tenantIdentitySnapshot: input.tenantIdentitySnapshot,
          memberIdentitySnapshot: input.memberIdentitySnapshot,
          pdfBlobKey: input.pdf.blobKey,
          pdfSha256: input.pdf.sha256,
          pdfTemplateVersion: input.pdf.templateVersion,
          pdfDocKind: input.pdfDocKind,
          paidAt: sql`now()`,
          paymentMethod: input.paymentMethod,
          paymentReference: input.paymentReference,
          paymentNotes: input.paymentNotes,
          paymentRecordedByUserId: input.paymentRecordedByUserId,
          paymentDate: input.paymentDate,
          receiptPdfStatus: 'rendered',
          receiptPdfBlobKey: null,
          // M-1 — complete the defensive receipt-triplet null. The combined
          // (or β separate) receipt IS the main PDF: its bytes metadata lives
          // in pdf_sha256/pdf_template_version above, so no receipt_* bytes
          // metadata may exist. A draft row already carries NULLs; writing
          // them explicitly keeps the as-paid UPDATE self-describing.
          receiptPdfSha256: null,
          receiptPdfTemplateVersion: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            // Concurrent issue / as-paid race: the loser's UPDATE
            // matches 0 rows and throws below (mirrors applyIssue).
            eq(invoices.status, 'draft'),
          ),
        )
        .returning();
      if (!updated) throw new InvoiceApplyConflictError('applyIssueAsPaid');

      // Wave-4 S26 — no line re-select: the CALLER CONTRACT requires
      // `input.lines` to be the post-lock draft read from this same tx,
      // and the held invoice row lock makes the lines immutable until
      // commit, so echoing them is byte-identical to re-reading.
      return rowsToInvoice(updated as InvoiceRow, input.lines);
    },

    /**
     * T166-05 — async receipt PDF worker callback. Idempotent:
     *   - status='pending' → flip to 'rendered' + write blob fields
     *   - status='rendered' → no-op (return existing row unchanged)
     *   - status='failed'  → also flip to 'rendered' (reconciliation
     *     retry path) + clear `receipt_pdf_last_error`
     * The WHERE clause excludes `receipt_pdf_status='rendered'` from the
     * UPDATE so a duplicate worker call with stale bytes cannot overwrite
     * a successful render. We then re-fetch the row to return it.
     *
     * 088 T068 (reliability M-2 / async TOCTOU) — the WHERE ALSO excludes
     * `status='void'`: the §86/4 receipt renders async (record-payment
     * enqueues; § F.2), so a worker can read a still-`paid` row, render a
     * NORMAL (un-stamped) receipt, and only THEN attempt this write — by
     * which point a void may have committed (at void time the row had
     * receiptPdf=null → voidInvoice Target B was skipped, only the bill was
     * stamped). Without this guard the un-stamped receipt bytes would land
     * on the void row → a voided sale serving a downloadable UN-stamped
     * §86/4 receipt (violates CHK027 / § F.3). Postgres re-evaluates the
     * WHERE against the latest row version under READ COMMITTED (EvalPlanQual),
     * so a concurrently-committed void is caught here even when the read
     * (render-receipt-pdf.ts:146) saw `paid`. A void row correctly ends with
     * receiptPdf=null + its RC number retained (void is terminal; the FR-019
     * "re-render on demand" tension is accepted — a void has no valid receipt).
     * Only `void` is blocked: a `credited`/`partially_credited` receipt
     * re-render still lands (and credit requires receiptPdfStatus='rendered'
     * FIRST, so a pending-render + credit race cannot occur).
     */
    async applyReceiptPdf(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      // DO NOT SET `receiptDocumentNumberRaw` in this UPDATE — it is
      // stamped atomically in `applyPayment` (both sync + async paths
      // since the Bug 3 fix in commit 44c1af8b) and any write here
      // would risk overwriting it to NULL on a worker re-arm, breaking
      // the UI "Receipt No." surface that reads this field. Drizzle's
      // partial `.set({...})` omits unmentioned columns from the SQL
      // UPDATE entirely so the existing value is preserved.
      await tx
        .update(invoices)
        .set({
          receiptPdfBlobKey: input.blobKey,
          receiptPdfSha256: input.sha256,
          receiptPdfTemplateVersion: input.templateVersion,
          receiptPdfStatus: 'rendered',
          receiptPdfLastError: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            // Idempotent re-arm: rendered rows skip the UPDATE so we
            // don't churn updated_at on every duplicate worker run.
            ne(invoices.receiptPdfStatus, 'rendered'),
            // 088 T068 — never land an un-stamped receipt on a VOID row (see
            // the method doc: async TOCTOU). Matches 0 rows → NO-OP; the
            // re-fetch below still returns the (void) row unchanged.
            ne(invoices.status, 'void'),
          ),
        );
      // Re-fetch via the public read path so callers always receive a
      // domain Invoice (not the raw row).
      const [row] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
          ),
        )
        .limit(1);
      if (!row) {
        // R2-I-NEW-1 — kind='applyReceiptPdf' (NOT 'applyPayment') so
        // alerting + log filters can route this distinct receipt-PDF
        // write conflict separately from payment state conflicts.
        throw new InvoiceApplyConflictError('applyReceiptPdf');
      }
      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, input.tenantId),
            eq(invoiceLines.invoiceId, input.invoiceId),
          ),
        )
        .orderBy(asc(invoiceLines.position));
      return rowsToInvoice(row as InvoiceRow, lineRows.map(rowToLine));
    },

    /**
     * T166-11 — Reconciliation cron callback. Flips status='failed' +
     * increments attempt counter + stores error message. Caller
     * (worker) re-enqueues the outbox row after this commits so the
     * cron's next pass picks it back up. Idempotent only if caller
     * coordinates re-enqueue carefully — the attempt counter ALWAYS
     * advances on each call.
     */
    async applyReceiptPdfFailure(txUnknown, input) {
      const tx = txUnknown as TenantTx;
      // R1-C2 + R2-C-NEW-1 — DO NOT roll a healthy `rendered` row
      // back to `failed`, AND surface the race-won outcome to the
      // caller via a discriminated return so the use-case treats it
      // as a success Result (no spurious attempts++).
      const [updated] = await tx
        .update(invoices)
        .set({
          receiptPdfStatus: 'failed',
          receiptPdfRenderAttempts: sql`${invoices.receiptPdfRenderAttempts} + 1`,
          receiptPdfLastError: input.errorMessage.slice(0, 1000),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            ne(invoices.receiptPdfStatus, 'rendered'),
          ),
        )
        .returning();
      if (!updated) {
        // UPDATE matched zero rows — either the row vanished or it's
        // already 'rendered'. Re-fetch to distinguish.
        const [existing] = await tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, input.tenantId),
              eq(invoices.invoiceId, input.invoiceId),
            ),
          )
          .limit(1);
        if (!existing) {
          // R2-I-NEW-1 — kind='applyReceiptPdfFailure' so this is
          // distinguishable from a payment-flip conflict in alerts.
          throw new InvoiceApplyConflictError('applyReceiptPdfFailure');
        }
        // Row is rendered — race won by the success write. Return
        // the rendered Invoice with kind='race_won_by_success' so
        // the caller (renderReceiptPdf catch block) maps it to ok().
        const lineRowsExisting = await tx
          .select()
          .from(invoiceLines)
          .where(
            and(
              eq(invoiceLines.tenantId, input.tenantId),
              eq(invoiceLines.invoiceId, input.invoiceId),
            ),
          )
          .orderBy(asc(invoiceLines.position));
        // R2-N-2 — defensive: if the rendered row somehow has partial
        // PDF state (e.g. operator manual UPDATE during incident),
        // rowsToInvoice's buildPdfOrNull throws. Catch + treat as
        // failed to avoid an untyped throw that crashes the dispatcher.
        let invoice: Invoice;
        try {
          invoice = rowsToInvoice(
            existing as InvoiceRow,
            lineRowsExisting.map(rowToLine),
          );
        } catch {
          // Partial state — fall through to the failed-row write path
          // by re-throwing the conflict; the dispatcher will retry +
          // reconcile cron will surface permanently_failed if it sticks.
          throw new InvoiceApplyConflictError('applyReceiptPdfFailure');
        }
        return { kind: 'race_won_by_success' as const, invoice };
      }
      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, input.tenantId),
            eq(invoiceLines.invoiceId, input.invoiceId),
          ),
        )
        .orderBy(asc(invoiceLines.position));
      return {
        kind: 'failed' as const,
        invoice: rowsToInvoice(updated as InvoiceRow, lineRows.map(rowToLine)),
      };
    },

    async applyDraftUpdate(txUnknown, input): Promise<void> {
      const tx = txUnknown as TenantTx;
      // Build the patch from caller-supplied fields only — omit keys
      // the caller didn't set so the UPDATE doesn't overwrite columns
      // with stale values.
      const patch: Record<string, unknown> = {};
      if (input.autoEmailOnIssue !== undefined) patch.autoEmailOnIssue = input.autoEmailOnIssue;
      if (input.planId !== undefined) patch.planId = input.planId;
      if (input.planYear !== undefined) patch.planYear = input.planYear;
      // Skip the UPDATE entirely when no real field changed — prevents
      // a no-op UPDATE that would still bump updated_at.
      if (Object.keys(patch).length === 0) return;
      // W3 fix — add `status='draft'` guard (mirrors applyIssue /
      // applyPayment patterns at lines 426 & 491). The Application
      // use-case reads+checks status before calling this, but without
      // a FOR UPDATE lock there is a race window where a concurrent
      // issueInvoice flips the row to 'issued'. The guard + throw
      // closes the race: if no row matches, the UPDATE silently
      // succeeds with zero rows and the caller gets an untyped
      // success — a data-integrity hole on draft-only fields
      // (auto_email_on_issue, plan_id, plan_year) which the DB
      // immutability trigger does NOT cover.
      const [updated] = await tx
        .update(invoices)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            eq(invoices.status, 'draft'),
          ),
        )
        .returning({ invoiceId: invoices.invoiceId });
      if (!updated) throw new InvoiceApplyConflictError('applyDraftUpdate');
    },

    async applyCreditNoteRollup(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      // Single atomic UPDATE: bump credited_total + flip status. The
      // WHERE guard requires the pre-rollup status be paid OR
      // partially_credited — anything else (draft / issued / void /
      // credited) means a concurrent state change raced ahead and we
      // must bail so the caller can roll back.
      const [updated] = await tx
        .update(invoices)
        .set({
          creditedTotalSatang: input.newCreditedTotalSatang,
          status: input.newStatus,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            // allow rollup from paid OR partially_credited only
            sql`${invoices.status} IN ('paid', 'partially_credited')`,
          ),
        )
        .returning();
      if (!updated) throw new InvoiceApplyConflictError('applyCreditNoteRollup');

      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, input.tenantId),
            eq(invoiceLines.invoiceId, input.invoiceId),
          ),
        )
        .orderBy(asc(invoiceLines.position));
      return rowsToInvoice(updated as InvoiceRow, lineRows.map(rowToLine));
    },

    async applyVoid(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      // R-1 fix — atomic issued|paid → void. The immutability trigger
      // whitelists the void_* fields + pdf_sha256, but pdf_sha256 is
      // INTENTIONALLY NOT written here: the caller updates it via
      // `applyInvoicePdfRegeneration` in a second transaction AFTER
      // the blob upload succeeds, preventing DB/Blob desync on blob
      // failure.
      //
      // 088 T068 — the WHERE CAS accepts BOTH `issued` AND `paid`. Voiding a
      // PAID membership is the spec's edge path (§ F.3 / edge-case line 172):
      // normally an issued §86/4 is cancelled via a §86/10 credit note, but a
      // void must still stamp VOID on both the ใบแจ้งหนี้ bill AND the §86/4
      // tax-receipt blobs. The CAS still rejects any concurrent transition to
      // void / credited / partially_credited / draft (→ InvoiceApplyConflictError
      // → typed `concurrent_state_change`) — the caller already holds the
      // invoice-row FOR UPDATE lock, so this guard is defence-in-depth against a
      // status flip between the lock read and this write. The DB immutability
      // trigger + CHECKs permit paid→void (status is not locked; the
      // receipt-status CHECK is vacuous for non-paid rows; the event-registration
      // partial unique index explicitly frees voided rows).
      const [updated] = await tx
        .update(invoices)
        .set({
          status: 'void',
          voidReason: input.voidReason,
          voidedByUserId: input.voidedByUserId,
          voidedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
            or(eq(invoices.status, 'issued'), eq(invoices.status, 'paid')),
          ),
        )
        .returning();
      if (!updated) throw new InvoiceApplyConflictError('applyVoid');

      const lineRows = await tx
        .select()
        .from(invoiceLines)
        .where(
          and(
            eq(invoiceLines.tenantId, input.tenantId),
            eq(invoiceLines.invoiceId, input.invoiceId),
          ),
        )
        .orderBy(asc(invoiceLines.position));
      return rowsToInvoice(updated as InvoiceRow, lineRows.map(rowToLine));
    },

    async applyInvoicePdfRegeneration(txUnknown, input): Promise<void> {
      const tx = txUnknown as TenantTx;
      // Single-column UPDATE — pdf_sha256 only. Blob key + template
      // version are fixed by the content-addressed key + the pinned
      // templateVersion stored at issue time. The invoices
      // immutability trigger explicitly whitelists pdf_sha256 for
      // re-render scenarios (VOID + CREDITED annotations + R3-E4
      // blob-miss recovery).
      await tx
        .update(invoices)
        .set({
          pdfSha256: input.pdfSha256,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
          ),
        );
    },

    async applyReceiptPdfRegeneration(txUnknown, input): Promise<void> {
      const tx = txUnknown as TenantTx;
      // 088 US6 — single-column UPDATE, receipt_pdf_sha256 only. Receipt blob
      // key + template version are fixed by the content-addressed key + the
      // pinned templateVersion stored at payment time; only the sha changes to
      // match the CREDITED-annotated re-render. The invoices immutability
      // trigger does NOT lock receipt_pdf_sha256 (it locks the receipt NUMBER,
      // migration 0235), so this write lands on a partially_credited/credited
      // row. Mirrors `applyInvoicePdfRegeneration` (pdf_sha256) for the Shape-1
      // parent whose §86/4 receipt lives in the SEPARATE receipt blob.
      await tx
        .update(invoices)
        .set({
          receiptPdfSha256: input.receiptPdfSha256,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
          ),
        );
    },
  };
}

/**
 * 088 T065b (FR-031, ภพ.30 support) — Drizzle impl of {@link TaxRegisterRepo}.
 *
 * Period-scoped §86/4 RC tax-receipt register (+ its §80/1(5) zero-rate subset).
 * Reuses the private `rowsToInvoice` mapper in this file (no line query — the
 * register renders header fields only, so `lines: []`). RLS-scoped via
 * `runInTenant` (the explicit `tenant_id` filter is defence-in-depth, mirroring
 * `listPaged`).
 *
 * Bucketing basis (§78/1 tax point): the admin-entered `payment_date`
 * (Bangkok-local calendar date), falling back to `(paid_at AT TIME ZONE
 * 'Asia/Bangkok')::date` only when a receipt row has no `payment_date` (so no
 * receipt is ever dropped from a period). NEVER the server `paid_at` timestamp
 * alone — a payment recorded on 2026-03-31 but server-marked after the UTC
 * midnight roll belongs to the March filing, not April — and NEVER the
 * bill/issue `fiscal_year` column (the RC receipt's §87 fiscal year rides its
 * `RC-{FY}-…` number, dated by the tax point).
 *
 * RC-vs-RE isolation: `receipt_document_number_raw` carries both the §86/4 'RC'
 * stream and the §105 'RE' stream; the 'RE' prefix is HARDCODED + settings-
 * reserved, so `NOT LIKE 'RE-%'` isolates the §86/4 register (rc_register /
 * zero_rate_sales) while `LIKE 'RE-%'` isolates the §105 register (re_register)
 * — both robust against a mis-configured prefix, both pure for the RD audit.
 *
 * 088 B2 review FINDING 1 — the §105 'RE' receipts carry REAL 7% output VAT, so
 * `sumPeriodOutputVat` folds BOTH streams into the period ภ.พ.30 output-VAT
 * figure (understating it by excluding §105 would be an under-filing).
 *
 * ภ.พ.30 correctness (Revenue Code):
 *   - VOIDED receipts stay LISTED in `listForPeriod` (a cancelled tax invoice
 *     must appear in the sales report, marked cancelled) but are EXCLUDED from
 *     `sumPeriodOutputVat` (their VAT must not be counted in the period total).
 *   - §86/10 credit notes (`credit_notes`) REDUCE output VAT in the month they
 *     are ISSUED, so `sumPeriodOutputVat` also returns the period credit-note
 *     VAT for the use-case to subtract (net = RC + RE − credit notes).
 */
export function makeDrizzleTaxRegisterRepo(tenantId: string): TaxRegisterRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async listForPeriod(tenantIdArg, opts) {
      return runInTenant(ctx, async (tx) => {
        const filters = [
          eq(invoices.tenantId, tenantIdArg),
          isNotNull(invoices.receiptDocumentNumberRaw),
          // Bucket by the §78/1 PAYMENT-date tax point (`payment_date`,
          // Bangkok-local calendar), falling back to `paid_at` only when a
          // receipt has no `payment_date` so no receipt is ever dropped.
          // Inclusive both ends. No explicit `paid_at IS NOT NULL` guard — the
          // COALESCE + range comparison naturally excludes any date-less row.
          // NOTE: NO status filter. Per the Revenue Code a VOIDED (cancelled)
          // tax invoice must STILL appear in the sales report (marked
          // cancelled), so void rows stay LISTED here; they are excluded only
          // from the period output-VAT TOTAL (`sumPeriodOutputVat`).
          sql`COALESCE(${invoices.paymentDate}, (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok')::date) >= ${opts.from}`,
          sql`COALESCE(${invoices.paymentDate}, (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok')::date) <= ${opts.to}`,
        ];
        if (opts.kind === 're_register') {
          // §105 RE stream only (no-TIN event/member receipts).
          filters.push(sql`${invoices.receiptDocumentNumberRaw} LIKE 'RE-%'`);
        } else {
          // §86/4 RC stream (see factory doc for why the prefix split is robust).
          filters.push(sql`${invoices.receiptDocumentNumberRaw} NOT LIKE 'RE-%'`);
          if (opts.kind === 'zero_rate_sales') {
            filters.push(eq(invoices.vatTreatment, 'zero_rated_80_1_5'));
          }
        }

        // Ordered by the receipt number ASC. Every row in a given register
        // shares one prefix ('RC' or 'RE'), so string ASC == sequential order.
        const rows = (await tx
          .select()
          .from(invoices)
          .where(and(...filters))
          .orderBy(asc(invoices.receiptDocumentNumberRaw))) as InvoiceRow[];

        return rows.map((r) => rowsToInvoice(r, []));
      });
    },

    async sumPeriodOutputVat(tenantIdArg, opts) {
      return runInTenant(ctx, async (tx) => {
        // (1) GROSS output VAT: single pass over the period's receipts, split
        // by stream via a conditional aggregate. Summing `vat_satang` (not
        // sales) means the §80/1(5) zero-rate subset contributes 0 output VAT
        // with no explicit exclusion. COALESCE guards the empty-period → NULL
        // sum. Bucketed by the §78/1 PAYMENT-date tax point (`payment_date`,
        // else `paid_at` fallback) — see `listForPeriod`. VOIDED receipts are
        // EXCLUDED (`status <> 'void'`): a cancelled tax invoice is still shown
        // in the sales report but its VAT is NOT counted in the period total.
        // `credited` / `partially_credited` receipts STAY counted here — their
        // reduction is the §86/10 credit note netted in step (2).
        const [agg] = await tx
          .select({
            rcVat: sql<string>`COALESCE(SUM(${invoices.vatSatang}) FILTER (WHERE ${invoices.receiptDocumentNumberRaw} NOT LIKE 'RE-%'), 0)::text`,
            reVat: sql<string>`COALESCE(SUM(${invoices.vatSatang}) FILTER (WHERE ${invoices.receiptDocumentNumberRaw} LIKE 'RE-%'), 0)::text`,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.tenantId, tenantIdArg),
              isNotNull(invoices.receiptDocumentNumberRaw),
              ne(invoices.status, 'void'),
              sql`COALESCE(${invoices.paymentDate}, (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok')::date) >= ${opts.from}`,
              sql`COALESCE(${invoices.paymentDate}, (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok')::date) <= ${opts.to}`,
            ),
          );

        // (2) §86/10 credit-note VAT ISSUED in the period — SUBTRACTED from
        // gross output VAT for the net ภ.พ.30 figure (the use-case does the
        // arithmetic). A credit note is terminal (no status column) and reduces
        // output VAT in the month of its `issue_date`. RLS-scoped by the same
        // `runInTenant` tx.
        const [cnAgg] = await tx
          .select({
            cnVat: sql<string>`COALESCE(SUM(${creditNotes.vatSatang}), 0)::text`,
          })
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.tenantId, tenantIdArg),
              sql`${creditNotes.issueDate} >= ${opts.from}`,
              sql`${creditNotes.issueDate} <= ${opts.to}`,
            ),
          );

        return {
          rcVatSatang: agg?.rcVat ?? '0',
          reVatSatang: agg?.reVat ?? '0',
          creditNoteVatSatang: cnAgg?.cnVat ?? '0',
        };
      });
    },
  };
}
