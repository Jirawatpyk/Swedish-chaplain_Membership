/**
 * T077 — CreditNote aggregate root (F4, US6 / FR-020…FR-023).
 *
 * Single-state, immutable aggregate — one row per issued ใบลดหนี้.
 * Creation-only: no transitions, no edits. Mistakes are corrected by
 * issuing a reversing document, not by editing.
 *
 * Invariants:
 *  - credit_amount + vat = total                         (per row)
 *  - tenant sum(total) for a given invoice ≤ invoice.total  (FR-022,
 *    enforced transactionally via `SELECT … FOR UPDATE` on the parent
 *    invoice — see `enforce-credit-cannot-exceed-remainder.ts` for the
 *    Domain-layer invariant; the Application layer provides the lock).
 *  - sequential number is monotone within (tenant, fiscal_year,
 *    doc_type='credit_note') — enforced by `SequenceAllocatorPort`.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Money } from './value-objects/money';
import type { DocumentNumber } from './value-objects/document-number';
import type { FiscalYear } from './value-objects/fiscal-year';
import type { TenantIdentitySnapshot } from './value-objects/tenant-identity-snapshot';
import type { MemberIdentitySnapshot } from './value-objects/member-identity-snapshot';
import type { Sha256Hex } from './value-objects/sha256-hex';
import type { InvoiceId } from './invoice';

declare const CreditNoteIdBrand: unique symbol;
export type CreditNoteId = string & { readonly [CreditNoteIdBrand]: true };

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreditNoteIdError = { kind: 'invalid_credit_note_id'; raw: string };

/** Trusted brand cast. Use for DB→domain mapping or just-generated UUIDs. */
export function asCreditNoteId(raw: string): CreditNoteId {
  return raw as CreditNoteId;
}

/** Validate-and-brand from untrusted input (route params, bodies). */
export function parseCreditNoteId(
  raw: string,
): { ok: true; value: CreditNoteId } | { ok: false; error: CreditNoteIdError } {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return { ok: false, error: { kind: 'invalid_credit_note_id', raw } };
  }
  return { ok: true, value: raw as CreditNoteId };
}

export interface CreditNote {
  readonly tenantId: string;
  readonly creditNoteId: CreditNoteId;
  readonly originalInvoiceId: InvoiceId;
  /**
   * G-1 — memberId of the original invoice, projected via JOIN by the
   * repo. Required for the portal-side ownership check in
   * `getCreditNote` / `getCreditNotePdfSignedUrl` when the actor is a
   * member role: the CN's owner is implicitly the original invoice's
   * member. Storing the value on the CN row was considered but the
   * invoice's member_id is already immutable post-issue (F3 archive
   * does not cascade), so a lookup-time JOIN is cheaper than schema
   * churn. Typed as `string` (not `MemberId`) to avoid a cross-module
   * domain coupling; callers narrow as needed.
   */
  readonly originalInvoiceMemberId: string;

  readonly fiscalYear: FiscalYear;
  readonly sequenceNumber: number;
  readonly documentNumber: DocumentNumber;

  readonly issueDate: string; // YYYY-MM-DD
  readonly issuedByUserId: string;
  readonly reason: string;

  // Money amounts — credit_amount + vat = total
  readonly creditAmount: Money;
  readonly vat: Money;
  readonly total: Money;

  readonly tenantIdentitySnapshot: TenantIdentitySnapshot;
  readonly memberIdentitySnapshot: MemberIdentitySnapshot;

  readonly pdf: {
    readonly blobKey: string;
    readonly sha256: Sha256Hex;
    readonly templateVersion: number;
  };

  /**
   * F5 extension (migration 0038, column `source_refund_id`). When
   * non-null, this CN was created by the F5 refund flow and points to
   * the F5 `refunds.id` row that produced it. NULL for F4-manual CNs
   * issued via the admin UI. Admin listings use this to distinguish
   * "auto-generated refund CN" from "admin-issued CN" in the timeline.
   */
  readonly sourceRefundId: string | null;

  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreditNoteBalanceError = {
  readonly kind: 'vat_balance_violated';
  readonly creditAmountSatang: bigint;
  readonly vatSatang: bigint;
  readonly totalSatang: bigint;
};

/**
 * Review fix IM-5 (2026-04-20) — assert the money invariant
 * `creditAmount + vat === total`.
 *
 * Called by the repo's row-to-domain mapping in `drizzle-credit-note-repo`
 * before returning a CreditNote object. A direct DB UPDATE or a
 * future migration that bypasses the use case could leave an
 * inconsistent row; without this guard it would flow through to the
 * PDF template + audit unnoticed. Runtime rather than compile-time
 * because the three Money values are independent structurally (sharing
 * a single `(credit, vat)` pair type would constrain the CN creation
 * API in ways that complicate the use case's flow).
 */
export function assertCreditNoteVatBalance(
  parts: Pick<CreditNote, 'creditAmount' | 'vat' | 'total'>,
): Result<void, CreditNoteBalanceError> {
  if (parts.creditAmount.satang + parts.vat.satang !== parts.total.satang) {
    return err({
      kind: 'vat_balance_violated',
      creditAmountSatang: parts.creditAmount.satang,
      vatSatang: parts.vat.satang,
      totalSatang: parts.total.satang,
    });
  }
  return ok(undefined);
}
