/**
 * T079 — Drizzle credit-note repository (F4 / US6).
 *
 * Domain ↔ Drizzle mapping. Reads run under `runInTenant(ctx, fn)` so
 * RLS (`credit_notes_tenant_isolation`) enforces tenant scoping on
 * every row touched, even on paths that forget a WHERE tenant_id
 * filter.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { CreditNoteRepo } from '../../application/ports/credit-note-repo';
import {
  asCreditNoteId,
  assertCreditNoteVatBalance,
  type CreditNote,
  type CreditNoteId,
} from '../../domain/credit-note';
import { logger } from '@/lib/logger';
import {
  asInvoiceId,
  type InvoiceId,
} from '../../domain/invoice';
import { Money } from '../../domain/value-objects/money';
import { DocumentNumber } from '../../domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '../../domain/value-objects/fiscal-year';
import { Sha256Hex } from '../../domain/value-objects/sha256-hex';
import {
  makeTenantIdentitySnapshot,
  type TenantIdentitySnapshot,
} from '../../domain/value-objects/tenant-identity-snapshot';
import {
  makeMemberIdentitySnapshot,
  type MemberIdentitySnapshot,
} from '../../domain/value-objects/member-identity-snapshot';
import { creditNotes, invoices, type CreditNoteRow } from '../db';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function rowToCreditNote(
  row: CreditNoteRow,
  originalInvoiceMemberId: string,
): CreditNote {
  const fy = asFiscalYearUnsafe(row.fiscalYear);
  // The document_number in the DB is the canonical value emitted by
  // DocumentNumber.of — parse re-validates, unsafe is safe here.
  const docNum = DocumentNumber.parse(row.documentNumber);
  if (!docNum.ok) {
    // SG-2 — log with structured context so operators can locate
    // the corrupt row without tailing a naked Error message.
    logger.error(
      { creditNoteId: row.creditNoteId, tenantId: row.tenantId, documentNumber: row.documentNumber },
      'drizzle-credit-note-repo: corrupt document_number',
    );
    throw new Error(
      `drizzle-credit-note-repo: corrupt document_number on row ${row.creditNoteId}: ${row.documentNumber}`,
    );
  }
  const sha = Sha256Hex.parse(row.pdfSha256);
  if (!sha.ok) {
    logger.error(
      { creditNoteId: row.creditNoteId, tenantId: row.tenantId },
      'drizzle-credit-note-repo: corrupt pdf_sha256',
    );
    throw new Error(
      `drizzle-credit-note-repo: corrupt pdf_sha256 on row ${row.creditNoteId}: '${row.pdfSha256}'`,
    );
  }
  const cn: CreditNote = {
    tenantId: row.tenantId,
    creditNoteId: asCreditNoteId(row.creditNoteId),
    originalInvoiceId: asInvoiceId(row.originalInvoiceId),
    originalInvoiceMemberId,
    fiscalYear: fy,
    sequenceNumber: row.sequenceNumber,
    documentNumber: docNum.value,
    issueDate: row.issueDate,
    issuedByUserId: row.issuedByUserId,
    reason: row.reason,
    creditAmount: Money.fromSatangUnsafe(BigInt(row.creditAmountSatang as unknown as string)),
    vat: Money.fromSatangUnsafe(BigInt(row.vatSatang as unknown as string)),
    total: Money.fromSatangUnsafe(BigInt(row.totalSatang as unknown as string)),
    tenantIdentitySnapshot: makeTenantIdentitySnapshot(
      row.tenantIdentitySnapshot as TenantIdentitySnapshot,
    ),
    memberIdentitySnapshot: makeMemberIdentitySnapshot(
      row.memberIdentitySnapshot as MemberIdentitySnapshot,
    ),
    pdf: {
      blobKey: row.pdfBlobKey,
      sha256: sha.value,
      templateVersion: row.pdfTemplateVersion,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // IM-5 — invariant guard: credit_amount + vat === total.
  // Protects against a direct DB write or migration that bypasses
  // the use case. Domain integrity violations are logged and thrown
  // so no downstream code sees an inconsistent row.
  const balance = assertCreditNoteVatBalance(cn);
  if (!balance.ok) {
    logger.error(
      {
        creditNoteId: row.creditNoteId,
        tenantId: row.tenantId,
        creditAmountSatang: balance.error.creditAmountSatang.toString(),
        vatSatang: balance.error.vatSatang.toString(),
        totalSatang: balance.error.totalSatang.toString(),
      },
      'drizzle-credit-note-repo: vat_balance_violated',
    );
    throw new Error(
      `drizzle-credit-note-repo: vat balance violated on row ${row.creditNoteId}`,
    );
  }
  return cn;
}

/**
 * Shared query builder for "all CNs against one invoice". The only
 * difference between `findByOriginalInvoice` (opens its own
 * `runInTenant`) and `findByOriginalInvoiceInTx` (re-uses the caller's
 * tx) is HOW the tx is acquired; the SELECT shape + filter + order are
 * identical, so they share this single builder. SG-7 (review fix).
 */
function selectByOriginalInvoice(
  tx: TenantTx,
  originalInvoiceId: InvoiceId,
  tenantIdArg: string,
) {
  // G-1 — LEFT JOIN invoices to project `member_id` (required for the
  // portal-side ownership check; see CreditNote.originalInvoiceMemberId
  // doc comment). The join is cheap (composite PK lookup) and returns
  // the same row count as the unjoined query because every CN has
  // exactly one original invoice (FK-enforced). Using LEFT to be
  // resilient to a future orphan row (schema allows the FK but we
  // prefer not to 500 the UI if an invoice is ever hard-deleted).
  return tx
    .select({
      creditNote: creditNotes,
      originalInvoiceMemberId: invoices.memberId,
    })
    .from(creditNotes)
    .leftJoin(
      invoices,
      and(
        eq(invoices.tenantId, creditNotes.tenantId),
        eq(invoices.invoiceId, creditNotes.originalInvoiceId),
      ),
    )
    .where(
      and(
        eq(creditNotes.tenantId, tenantIdArg),
        eq(creditNotes.originalInvoiceId, originalInvoiceId),
      ),
    )
    .orderBy(desc(creditNotes.createdAt));
}

export function makeDrizzleCreditNoteRepo(tenantId: string): CreditNoteRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async insertCreditNote(txUnknown, input): Promise<CreditNote> {
      const tx = txUnknown as TenantTx;
      const [inserted] = await tx
        .insert(creditNotes)
        .values({
          tenantId: input.tenantId,
          creditNoteId: input.creditNoteId,
          originalInvoiceId: input.originalInvoiceId,
          fiscalYear: input.fiscalYear,
          sequenceNumber: input.sequenceNumber,
          documentNumber: input.documentNumber,
          issueDate: input.issueDate,
          issuedByUserId: input.issuedByUserId,
          reason: input.reason,
          creditAmountSatang: input.creditAmountSatang,
          vatSatang: input.vatSatang,
          totalSatang: input.totalSatang,
          tenantIdentitySnapshot: input.tenantIdentitySnapshot,
          memberIdentitySnapshot: input.memberIdentitySnapshot,
          pdfBlobKey: input.pdf.blobKey,
          pdfSha256: input.pdf.sha256,
          pdfTemplateVersion: input.pdf.templateVersion,
        })
        .returning();
      if (!inserted) {
        throw new Error('drizzle-credit-note-repo: insertCreditNote returned no row');
      }
      // G-1 — the caller (issue-credit-note.ts) holds the original
      // invoice row under a FOR UPDATE lock in the same tx; we could
      // have the caller pass the memberId in, but a one-shot JOIN
      // SELECT here keeps the port contract narrow (caller only
      // supplies insert data) and the JOIN is a composite-PK lookup.
      const [joinRow] = await tx
        .select({ memberId: invoices.memberId })
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.invoiceId, input.originalInvoiceId),
          ),
        )
        .limit(1);
      if (!joinRow) {
        throw new Error(
          'drizzle-credit-note-repo: insertCreditNote — original invoice not found for JOIN',
        );
      }
      return rowToCreditNote(inserted as CreditNoteRow, joinRow.memberId);
    },

    async findById(creditNoteId: CreditNoteId, tenantIdArg: string): Promise<CreditNote | null> {
      const result = await runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({
            creditNote: creditNotes,
            originalInvoiceMemberId: invoices.memberId,
          })
          .from(creditNotes)
          .leftJoin(
            invoices,
            and(
              eq(invoices.tenantId, creditNotes.tenantId),
              eq(invoices.invoiceId, creditNotes.originalInvoiceId),
            ),
          )
          .where(
            and(
              eq(creditNotes.tenantId, tenantIdArg),
              eq(creditNotes.creditNoteId, creditNoteId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      });
      if (!result) return null;
      if (!result.originalInvoiceMemberId) {
        logger.error(
          { creditNoteId, tenantId: tenantIdArg },
          'drizzle-credit-note-repo: findById — CN row has no matching invoice (orphan)',
        );
        return null;
      }
      return rowToCreditNote(
        result.creditNote as CreditNoteRow,
        result.originalInvoiceMemberId,
      );
    },

    async findByOriginalInvoice(
      originalInvoiceId: InvoiceId,
      tenantIdArg: string,
    ): Promise<readonly CreditNote[]> {
      const rows = await runInTenant(ctx, async (tx) =>
        selectByOriginalInvoice(tx, originalInvoiceId, tenantIdArg),
      );
      return rows.flatMap((r) =>
        r.originalInvoiceMemberId
          ? [rowToCreditNote(r.creditNote as CreditNoteRow, r.originalInvoiceMemberId)]
          : [],
      );
    },

    async findByOriginalInvoiceInTx(
      txUnknown,
      originalInvoiceId: InvoiceId,
      tenantIdArg: string,
    ): Promise<readonly CreditNote[]> {
      const rows = await selectByOriginalInvoice(
        txUnknown as TenantTx,
        originalInvoiceId,
        tenantIdArg,
      );
      return rows.flatMap((r) =>
        r.originalInvoiceMemberId
          ? [rowToCreditNote(r.creditNote as CreditNoteRow, r.originalInvoiceMemberId)]
          : [],
      );
    },
  };
}
