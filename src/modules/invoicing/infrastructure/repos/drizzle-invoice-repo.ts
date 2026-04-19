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
import {
  makeTenantIdentitySnapshot,
  type TenantIdentitySnapshot,
} from '../../domain/value-objects/tenant-identity-snapshot';
import {
  makeMemberIdentitySnapshot,
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
        : makeMemberIdentitySnapshot(
            row.memberIdentitySnapshot as MemberIdentitySnapshot,
          ),

    paymentMethod: row.paymentMethod ?? null,
    paymentReference: row.paymentReference ?? null,
    paymentNotes: row.paymentNotes ?? null,
    paymentRecordedByUserId: row.paymentRecordedByUserId ?? null,

    voidReason: row.voidReason ?? null,
    voidedByUserId: row.voidedByUserId ?? null,

    autoEmailOnIssue: row.autoEmailOnIssue ?? null,

    pdfBlobKey: row.pdfBlobKey ?? null,
    pdfSha256: row.pdfSha256 ?? null,
    pdfTemplateVersion: row.pdfTemplateVersion ?? null,

    lines,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function makeDrizzleInvoiceRepo(tenantId: string): InvoiceRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
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

    async findDraftById(txUnknown, invoiceId: InvoiceId, tenantIdArg: string): Promise<Invoice | null> {
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
          pdfBlobKey: input.pdfBlobKey,
          pdfSha256: input.pdfSha256,
          pdfTemplateVersion: input.pdfTemplateVersion,
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
      if (!updated) throw new Error('applyIssue: no draft row updated (concurrent issue?)');

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
          pdfBlobKey: input.receiptPdfBlobKey,
          pdfSha256: input.receiptPdfSha256,
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
      if (!updated) throw new Error('applyPayment: no row updated');

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
      await tx
        .update(invoices)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.invoiceId),
          ),
        );
    },
  };
}
