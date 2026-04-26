/**
 * T051 — Drizzle invoice repo (F4).
 *
 * Domain ↔ Drizzle mapping. Transactions are run under `chamber_app`
 * role via `runInTenant(ctx, fn)` so RLS policies enforce tenant
 * scoping even on paths that forget an explicit WHERE filter.
 */
import { and, asc, desc, eq, gt, sql, ilike } from 'drizzle-orm';
import type { InvoiceRepo } from '../../application/ports/invoice-repo';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '../../domain/invoice';
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
  makeMemberIdentitySnapshot,
  memberIdentitySnapshotSchema,
  MalformedSnapshotError,
  type MemberIdentitySnapshot,
} from '../../domain/value-objects/member-identity-snapshot';
import { invoices, invoiceLines, type InvoiceRow, type InvoiceLineRow } from '../db';
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

  return {
    tenantId: row.tenantId,
    invoiceId: asInvoiceId(row.invoiceId),
    memberId: row.memberId,
    planId: row.planId,
    planYear: row.planYear,
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
    memberIdentitySnapshot:
      row.memberIdentitySnapshot === null
        ? null
        : makeMemberIdentitySnapshot(parseMemberIdentitySnapshot(row)),

    paymentMethod: row.paymentMethod ?? null,
    paymentReference: row.paymentReference ?? null,
    paymentNotes: row.paymentNotes ?? null,
    paymentRecordedByUserId: row.paymentRecordedByUserId ?? null,
    paymentDate: row.paymentDate ?? null,

    voidReason: row.voidReason ?? null,
    voidedByUserId: row.voidedByUserId ?? null,

    autoEmailOnIssue: row.autoEmailOnIssue ?? null,

    pdf: buildPdfOrNull(row.pdfBlobKey, row.pdfSha256, row.pdfTemplateVersion, row.invoiceId, 'pdf'),
    receiptPdf: buildPdfOrNull(
      row.receiptPdfBlobKey,
      row.receiptPdfSha256,
      row.receiptPdfTemplateVersion,
      row.invoiceId,
      'receiptPdf',
    ),

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

  return {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      if (externalTx !== undefined) {
        // D-03 tx-reuse path: run inline against the caller's tx.
        // Do NOT open a nested `runInTenant` — Postgres does not
        // support true nested transactions and `SET LOCAL
        // app.current_tenant` has already been established on this
        // connection by the outer `runInTenant`.
        //
        // Backend-dev review F-01 (Group E, 2026-04-24): runtime
        // tenant-mismatch guard. If a future composer mistakenly
        // hands us tenantA's tx while requesting tenantB writes, the
        // outer `SET LOCAL app.current_tenant=A` would still be in
        // effect → F4 writes against tenantA's RLS namespace silently.
        // Re-read `current_setting('app.current_tenant')` and refuse
        // if it disagrees with this repo's bound tenantId. Constitution
        // Principle I clause 3 — make the precondition explicit.
        const externalTxTyped = externalTx as TenantTx;
        const probe = (await externalTxTyped.execute(
          sql`SELECT current_setting('app.current_tenant', TRUE) AS current_tenant`,
        )) as unknown as Array<{ current_tenant: string | null }>;
        const current_tenant = probe[0]?.current_tenant ?? null;
        if (current_tenant !== ctx.slug) {
          throw new Error(
            `makeDrizzleInvoiceRepo: externalTx tenant mismatch — repo bound to "${ctx.slug}" but tx carries "${current_tenant ?? '(unset)'}". Refusing to write to a different tenant's namespace.`,
          );
        }
        return fn(externalTx);
      }
      return runInTenant(ctx, async (tx) => fn(tx));
    },

    async insertDraft(txUnknown, input): Promise<Invoice> {
      const tx = txUnknown as TenantTx;
      const [insertedInvoice] = await tx
        .insert(invoices)
        .values({
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          memberId: input.memberId,
          planId: input.planId,
          planYear: input.planYear,
          status: 'draft',
          draftByUserId: input.draftByUserId,
          autoEmailOnIssue: input.autoEmailOnIssue,
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

    async findById(invoiceId: InvoiceId, tenantIdArg: string): Promise<Invoice | null> {
      return runInTenant(ctx, async (tx) => {
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
        if (!includeDrafts && !opts.status) {
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
          filters.push(ilike(invoices.documentNumber, `%${opts.search}%`));
        }
        if (opts.cursor) {
          filters.push(gt(invoices.invoiceId, opts.cursor));
        }

        const rows = await tx
          .select()
          .from(invoices)
          .where(and(...filters))
          .orderBy(desc(invoices.issueDate), desc(invoices.invoiceId))
          .limit(opts.pageSize + 1);

        const hasMore = rows.length > opts.pageSize;
        const page = rows.slice(0, opts.pageSize) as InvoiceRow[];
        const nextCursor = hasMore ? page[page.length - 1]!.invoiceId : null;

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

    async listPaged(tenantIdArg: string, opts) {
      return runInTenant(ctx, async (tx) => {
        const filters = [eq(invoices.tenantId, tenantIdArg)];
        const includeDrafts = opts.includeDrafts ?? false;
        if (!includeDrafts && !opts.status) {
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
          filters.push(ilike(invoices.documentNumber, `%${opts.search}%`));
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
      // PDF metadata. Status/payment/pdf columns are intentionally NOT
      // guarded by the invoices immutability trigger, so no split
      // write is needed. The WHERE `status='issued'` guard below
      // prevents double-apply on concurrent state-change races.
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
          receiptPdfBlobKey: input.receiptPdf.blobKey,
          receiptPdfSha256: input.receiptPdf.sha256,
          receiptPdfTemplateVersion: input.receiptPdf.templateVersion,
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
      // R-1 fix — atomic issued → void. The immutability trigger
      // whitelists the void_* fields + pdf_sha256, but pdf_sha256 is
      // INTENTIONALLY NOT written here: the caller updates it via
      // `applyInvoicePdfRegeneration` in a second transaction AFTER
      // the blob upload succeeds, preventing DB/Blob desync on blob
      // failure. WHERE guard on status='issued' prevents racing
      // paid/credit-note/double-void.
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
            eq(invoices.status, 'issued'),
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
  };
}
