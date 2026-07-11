/**
 * T079 — Drizzle credit-note repository (F4 / US6).
 *
 * Domain ↔ Drizzle mapping. Reads run under `runInTenant(ctx, fn)` so
 * RLS (`credit_notes_tenant_isolation`) enforces tenant scoping on
 * every row touched, even on paths that forget a WHERE tenant_id
 * filter.
 */
import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import { asSatang } from '@/lib/money';
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
  // 054-event-fee-invoices (Task 8) — null for credit notes against a
  // NON-member event invoice (the original invoice's member_id is NULL).
  originalInvoiceMemberId: string | null,
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
    // F5 extension — NULL for F4-manual CNs; non-NULL = refund-origin
    sourceRefundId: row.sourceRefundId,
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
      // 054-event-fee-invoices (Task 8) — see findById: distinguish a genuine
      // orphan (joined invoice id null) from a valid event CN (member id null,
      // invoice id present). Every row here filters on a known
      // `originalInvoiceId`, so a null `originalInvoiceId` means the invoice was
      // hard-deleted (orphan) — those are dropped; a null member_id is kept.
      originalInvoiceId: invoices.invoiceId,
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
          ...(input.sourceRefundId !== undefined
            ? { sourceRefundId: input.sourceRefundId }
            : {}),
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
      // 054-event-fee-invoices (Task 8) — credit notes are now issued against
      // BOTH membership invoices (member_id non-null, `invoices_subject_fields_ck`)
      // AND non-member EVENT invoices (member_id NULL). A null member_id here is
      // a VALID event-fee CN (the buyer is a non-member attendee), NOT a contract
      // violation — pass it through. `joinRow` being absent above already covers
      // the genuine "original invoice missing" error. The CN row carries its own
      // pinned buyer snapshot; `originalInvoiceMemberId === null` simply means no
      // F3 member owns it (so member-role ownership checks correctly deny).
      return rowToCreditNote(inserted as CreditNoteRow, joinRow.memberId);
    },

    async findBySourceRefundId(
      txUnknown,
      tenantIdArg: string,
      sourceRefundId: string,
    ): Promise<CreditNote | null> {
      // CRITICAL-1 (F5 idempotency) — transaction-scoped reverse lookup on the
      // partial unique index `credit_notes_source_refund_id_uniq`. Threads the
      // caller's `tx` (never the pool-global `db`) so RLS is enforced on the
      // same connection under the invoice lock / fresh reconcile tx (Principle
      // I). At most one row (partial unique index); `limit(1)` is belt-and-
      // suspenders. LEFT JOIN mirrors `findById` so an orphan CN (invoice hard-
      // deleted — FK-prevented in practice) is dropped rather than 500-ing.
      const tx = txUnknown as TenantTx;
      const rows = await tx
        .select({
          creditNote: creditNotes,
          originalInvoiceMemberId: invoices.memberId,
          originalInvoiceId: invoices.invoiceId,
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
            eq(creditNotes.sourceRefundId, sourceRefundId),
          ),
        )
        .limit(1);
      const result = rows[0] ?? null;
      if (!result) return null;
      if (!result.originalInvoiceId) {
        logger.error(
          { tenantId: tenantIdArg, sourceRefundId },
          'drizzle-credit-note-repo: findBySourceRefundId — CN row has no matching invoice (orphan)',
        );
        return null;
      }
      return rowToCreditNote(
        result.creditNote as CreditNoteRow,
        result.originalInvoiceMemberId,
      );
    },

    async findById(creditNoteId: CreditNoteId, tenantIdArg: string): Promise<CreditNote | null> {
      const result = await runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({
            creditNote: creditNotes,
            originalInvoiceMemberId: invoices.memberId,
            // 054-event-fee-invoices (Task 8) — project the joined invoice id
            // so we can distinguish a genuine ORPHAN (no matching invoice row →
            // this is null) from a VALID event-fee CN (invoice row exists but
            // its member_id is null). The old `!originalInvoiceMemberId` check
            // conflated the two and dropped valid event CNs.
            originalInvoiceId: invoices.invoiceId,
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
      // Orphan = the LEFT JOIN matched no invoice row at all (FK should make
      // this impossible, but defend). A null member_id WITH a matched invoice
      // is a valid non-member event CN — pass it through.
      if (!result.originalInvoiceId) {
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
      // 054-event-fee-invoices (Task 8) — drop only genuine orphans (no joined
      // invoice id); keep event CNs (null member_id, invoice present).
      return rows.flatMap((r) =>
        r.originalInvoiceId
          ? [rowToCreditNote(r.creditNote as CreditNoteRow, r.originalInvoiceMemberId)]
          : [],
      );
    },

    async findByOriginalInvoiceInTx(
      txUnknown,
      originalInvoiceId: InvoiceId,
      tenantIdArg: string,
    ): Promise<readonly CreditNote[]> {
      // R17-08 — defensive cap + stable sequence-number ordering for the
      // annotation-build callsite in `issueCreditNote` (re-renders the
      // original invoice PDF with the CN reference list). Remainder
      // guard + partial-accumulation invariant already bound the list
      // size in practice (typically 1-3 partial credits per invoice);
      // LIMIT 20 is a pathological-data-state backstop so a direct DB
      // insert bypassing the use case can't balloon the in-tx query or
      // produce an unbounded annotation footer. ASC by sequence_number
      // matches the display order in the annotation footer (callers
      // can drop their own re-sort).
      const tx = txUnknown as TenantTx;
      const rows = await tx
        .select({
          creditNote: creditNotes,
          originalInvoiceMemberId: invoices.memberId,
          // 054-event-fee-invoices (Task 8) — orphan-vs-event discriminator
          // (see findById). The annotation callsite in issueCreditNote MUST
          // see the just-inserted event CN (member_id null), so the skip below
          // keys on the joined invoice id, not the member id.
          originalInvoiceId: invoices.invoiceId,
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
        .orderBy(asc(creditNotes.sequenceNumber))
        .limit(20);
      return rows.flatMap((r) =>
        r.originalInvoiceId
          ? [rowToCreditNote(r.creditNote as CreditNoteRow, r.originalInvoiceMemberId)]
          : [],
      );
    },

    async listPaged(input): Promise<{
      readonly rows: readonly {
        readonly creditNoteId: string;
        readonly documentNumberRaw: string;
        readonly issueDate: string;
        readonly originalInvoiceId: string;
        readonly originalInvoiceNumberRaw: string | null;
        readonly memberLegalName: string;
        readonly totalSatang: import('@/lib/money').Satang;
        readonly reason: string;
      }[];
      readonly total: number;
    }> {
      // G-3 — admin directory. Clamp pageSize to 1..100 per port
      // contract so callers can't accidentally pull the whole tenant
      // via `pageSize: Number.MAX_SAFE_INTEGER`.
      const pageSize = Math.max(1, Math.min(100, input.pageSize | 0));
      const offset = Math.max(0, input.offset | 0);

      const filters: ReturnType<typeof and>[] = [
        eq(creditNotes.tenantId, input.tenantId),
      ];
      if (typeof input.fiscalYear === 'number' && Number.isFinite(input.fiscalYear)) {
        filters.push(eq(creditNotes.fiscalYear, input.fiscalYear));
      }
      if (input.search && input.search.trim().length > 0) {
        filters.push(ilike(creditNotes.documentNumber, `%${input.search.trim()}%`));
      }
      const whereClause = filters.length === 1 ? filters[0] : and(...filters);

      return runInTenant(ctx, async (tx) => {
        // Paged rows — LEFT JOIN invoices to project document_number
        // + member_id for the per-row display. Projection is narrow
        // (no snapshot/PDF hydration) because the list UI only
        // scans summary fields.
        const rows = await tx
          .select({
            creditNoteId: creditNotes.creditNoteId,
            documentNumberRaw: creditNotes.documentNumber,
            issueDate: creditNotes.issueDate,
            originalInvoiceId: creditNotes.originalInvoiceId,
            originalInvoiceNumberRaw: invoices.documentNumber,
            memberIdentitySnapshot: creditNotes.memberIdentitySnapshot,
            totalSatang: creditNotes.totalSatang,
            reason: creditNotes.reason,
          })
          .from(creditNotes)
          .leftJoin(
            invoices,
            and(
              eq(invoices.tenantId, creditNotes.tenantId),
              eq(invoices.invoiceId, creditNotes.originalInvoiceId),
            ),
          )
          .where(whereClause)
          .orderBy(desc(creditNotes.issueDate), desc(creditNotes.creditNoteId))
          .limit(pageSize)
          .offset(offset);

        // Parallel COUNT(*) for offset pagination "Showing X of N"
        // UI. Runs against the same WHERE filters so the count
        // matches the paged result set.
        const [{ total } = { total: 0 }] = await tx
          .select({ total: sql<number>`COUNT(*)::int` })
          .from(creditNotes)
          .where(whereClause);

        // 054-event-fee-invoices (Task 8 reviewer note) — intentionally NO
        // orphan-id filter here (unlike findByOriginalInvoice* which drop rows
        // where the joined invoice id is null). `listPaged` projects a NARROW
        // DTO whose `originalInvoiceNumberRaw: string | null` field already
        // gracefully surfaces an orphan as null in the admin list, so a future
        // hard-deleted-invoice edge case is visible rather than silently dropped.
        // The three aggregate-return paths (findById / findByOriginalInvoice /
        // findByOriginalInvoiceInTx) DO apply the orphan filter because they must
        // return a fully-validated CreditNote domain object.
        const projected = rows.map((r) => {
          const snap = r.memberIdentitySnapshot as { legal_name?: string } | null;
          return {
            creditNoteId: r.creditNoteId,
            documentNumberRaw: r.documentNumberRaw,
            issueDate: r.issueDate,
            originalInvoiceId: r.originalInvoiceId,
            originalInvoiceNumberRaw: r.originalInvoiceNumberRaw,
            memberLegalName: snap?.legal_name ?? '—',
            // F5R3 H-5 (2026-05-16) — brand at DB→Domain boundary.
            totalSatang: asSatang(BigInt(r.totalSatang as unknown as string)),
            reason: r.reason,
          };
        });

        return { rows: projected, total: Number(total ?? 0) };
      });
    },
  };
}
