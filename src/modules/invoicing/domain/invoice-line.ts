/**
 * T031 — InvoiceLine child entity (F4).
 *
 * Plain immutable shape + pure constructor. Referentially owned by the
 * Invoice aggregate — creating / updating lines is done via the parent's
 * state transitions (new lines on draft only; no line edits after issue).
 */
import { err, ok, type Result } from '@/lib/result';
import type { Money } from './value-objects/money';
import { Money as MoneyClass } from './value-objects/money';

export const INVOICE_LINE_KINDS = ['membership_fee', 'registration_fee', 'event_fee'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

declare const InvoiceLineIdBrand: unique symbol;
export type InvoiceLineId = string & { readonly [InvoiceLineIdBrand]: true };

export function asInvoiceLineId(raw: string): InvoiceLineId {
  return raw as InvoiceLineId;
}

export interface InvoiceLine {
  readonly lineId: InvoiceLineId;
  readonly kind: InvoiceLineKind;
  readonly descriptionTh: string;
  readonly descriptionEn: string;
  readonly unitPrice: Money;
  /** `numeric(10,4)` from the DB — kept as string for fidelity. */
  readonly quantity: string;
  /** `numeric(6,4)` or null when not pro-rated (registration fee). */
  readonly proRateFactor: string | null;
  readonly total: Money;
  readonly position: number;
}

export type InvoiceLineError =
  | { code: 'quantity_not_positive'; quantity: string }
  | { code: 'description_empty'; field: 'th' | 'en' }
  | { code: 'pro_rate_factor_required_for_membership' };

export interface NewInvoiceLineInput {
  readonly lineId: InvoiceLineId;
  readonly kind: InvoiceLineKind;
  readonly descriptionTh: string;
  readonly descriptionEn: string;
  readonly unitPrice: Money;
  readonly quantity: string;
  readonly proRateFactor: string | null;
  readonly position: number;
}

/**
 * Construct a line + compute total_satang = unit_price × quantity ×
 * coalesce(proRateFactor, 1). Rounding at each multiplication is
 * half-away-from-zero via Money.multiplyByFraction.
 */
export function makeInvoiceLine(input: NewInvoiceLineInput): Result<InvoiceLine, InvoiceLineError> {
  if (input.descriptionTh.trim().length === 0) {
    return err({ code: 'description_empty', field: 'th' });
  }
  if (input.descriptionEn.trim().length === 0) {
    return err({ code: 'description_empty', field: 'en' });
  }
  const qtyNum = Number(input.quantity);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    return err({ code: 'quantity_not_positive', quantity: input.quantity });
  }
  if (input.kind === 'membership_fee' && input.proRateFactor === null) {
    return err({ code: 'pro_rate_factor_required_for_membership' });
  }

  // total = unitPrice × quantity × proRateFactor.
  // Step 1: unitPrice × quantity (multiplyByDecimal4 on up-to-4dp string).
  const afterQty = input.unitPrice.multiplyByDecimal4(normaliseDecimal4(input.quantity));
  // Step 2: × proRateFactor (if any).
  const total = input.proRateFactor === null
    ? afterQty
    : afterQty.multiplyByDecimal4(normaliseDecimal4(input.proRateFactor));

  return ok({
    lineId: input.lineId,
    kind: input.kind,
    descriptionTh: input.descriptionTh,
    descriptionEn: input.descriptionEn,
    unitPrice: input.unitPrice,
    quantity: input.quantity,
    proRateFactor: input.proRateFactor,
    total,
    position: input.position,
  });
}

/** Pad a decimal string to 4-dp form expected by Money.multiplyByDecimal4. */
function normaliseDecimal4(s: string): string {
  const [int, frac = ''] = s.split('.');
  const padded = (frac + '0000').slice(0, 4);
  return `${int}.${padded}`;
}

// Helper: construct zero-value Money — used by tests / fixtures.
export const ZERO_MONEY: Money = MoneyClass.zero();
