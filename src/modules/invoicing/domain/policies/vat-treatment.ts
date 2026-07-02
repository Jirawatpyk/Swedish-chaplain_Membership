/**
 * 088-invoice-tax-flow-redesign (T057 / US8 / FR-023..025 / § F.8.3) —
 * per-invoice VAT treatment policy.
 *
 * `vat_treatment` is a PER-INVOICE (case-by-case, NOT per-member) decision set
 * at issue and pinned into the immutable issue-time row (immutable per FR-023):
 *
 *   - 'standard'          — VAT at the tenant's configured rate (7% default).
 *                           Membership is ALWAYS 'standard'.
 *   - 'zero_rated_80_1_5' — VAT 0% embassy / int'l-org zero-rate under Revenue
 *                           Code §80/1(5). A VATable-at-0% supply (input VAT
 *                           claimable, reported on ภพ.30), NOT a §81 exemption.
 *
 * PURE Domain — no framework/ORM imports.
 */
import { VatRate } from '../value-objects/vat-rate';

/**
 * The two accepted per-invoice VAT treatments. Mirrors the
 * `invoices_vat_treatment_valid` DB CHECK (migration 0234).
 */
export type VatTreatment = 'standard' | 'zero_rated_80_1_5';

/** The §80/1(5) zero rate as a {@link VatRate} (0.0000). */
const ZERO_RATE = VatRate.ofUnsafe('0.0000');

/**
 * FR-025 / G3 — `vat_treatment` is the SINGLE SOURCE OF TRUTH that DRIVES the
 * VAT rate. A `'zero_rated_80_1_5'` invoice ALWAYS computes at 0%; every other
 * treatment uses the tenant's configured standard rate. The VAT rate is NEVER
 * chosen independently of the treatment (no double source-of-truth for the
 * rate).
 */
export function resolveVatRate(
  treatment: VatTreatment,
  standardRate: VatRate,
): VatRate {
  return treatment === 'zero_rated_80_1_5' ? ZERO_RATE : standardRate;
}

/**
 * FR-024 advisory floor — each embassy / int'l-org §80/1(5) purchase is
 * EXPECTED to be ≥ 5,000 THB. 5,000.00 THB = 500,000 satang.
 */
export const ZERO_RATE_MIN_SUBTOTAL_SATANG = 500_000n;

/**
 * FR-024 — NON-BLOCKING advisory: a `'zero_rated_80_1_5'` invoice whose subtotal
 * is BELOW {@link ZERO_RATE_MIN_SUBTOTAL_SATANG} surfaces a warning (the invoice
 * still issues). Returns `false` for `'standard'` (the floor only applies to
 * zero-rate) and for a zero-rate subtotal at or above the threshold.
 */
export function isZeroRateBelowThreshold(
  treatment: VatTreatment,
  subtotalSatang: bigint,
): boolean {
  return (
    treatment === 'zero_rated_80_1_5' &&
    subtotalSatang < ZERO_RATE_MIN_SUBTOTAL_SATANG
  );
}
