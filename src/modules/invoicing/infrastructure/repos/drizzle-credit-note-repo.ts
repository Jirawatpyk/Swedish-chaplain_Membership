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
  type CreditNote,
  type CreditNoteId,
} from '../../domain/credit-note';
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
import { creditNotes, type CreditNoteRow } from '../db';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function rowToCreditNote(row: CreditNoteRow): CreditNote {
  const fy = asFiscalYearUnsafe(row.fiscalYear);
  // The document_number in the DB is the canonical value emitted by
  // DocumentNumber.of — parse re-validates, unsafe is safe here.
  const docNum = DocumentNumber.parse(row.documentNumber);
  if (!docNum.ok) {
    throw new Error(
      `drizzle-credit-note-repo: corrupt document_number on row ${row.creditNoteId}: ${row.documentNumber}`,
    );
  }
  const sha = Sha256Hex.parse(row.pdfSha256);
  if (!sha.ok) {
    throw new Error(
      `drizzle-credit-note-repo: corrupt pdf_sha256 on row ${row.creditNoteId}: '${row.pdfSha256}'`,
    );
  }
  return {
    tenantId: row.tenantId,
    creditNoteId: asCreditNoteId(row.creditNoteId),
    originalInvoiceId: asInvoiceId(row.originalInvoiceId),
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
      return rowToCreditNote(inserted as CreditNoteRow);
    },

    async findById(creditNoteId: CreditNoteId, tenantIdArg: string): Promise<CreditNote | null> {
      const row = await runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.tenantId, tenantIdArg),
              eq(creditNotes.creditNoteId, creditNoteId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      });
      return row ? rowToCreditNote(row as CreditNoteRow) : null;
    },

    async findByOriginalInvoice(
      originalInvoiceId: InvoiceId,
      tenantIdArg: string,
    ): Promise<readonly CreditNote[]> {
      const rows = await runInTenant(ctx, async (tx) => {
        return tx
          .select()
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.tenantId, tenantIdArg),
              eq(creditNotes.originalInvoiceId, originalInvoiceId),
            ),
          )
          .orderBy(desc(creditNotes.createdAt));
      });
      return rows.map((r) => rowToCreditNote(r as CreditNoteRow));
    },
  };
}
