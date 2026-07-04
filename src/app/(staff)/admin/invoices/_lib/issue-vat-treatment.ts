/**
 * 088 US8 (UX-A) — pure decision logic for the admin issue-invoice
 * §80/1(5) VAT zero-rate form (FR-023 / FR-024).
 *
 * Owns the three framework-free pieces the issue form relies on, so the
 * presentational component stays a thin shell and the rules are unit-testable
 * in isolation (mirrors `issue-review.ts` + `validateNonMemberBuyer`):
 *
 *   1. `validateZeroRateCert` — the fail-closed CLIENT layer (layer 1 of 3):
 *      a `zero_rated_80_1_5` issue with a blank MFA certificate NUMBER is
 *      blocked before any POST. The server 422 `zero_rate_cert_required` +
 *      the DB CHECK are layers 2 + 3 (defense-in-depth, spec FR-024). The
 *      cert DATE is OPTIONAL (only the NUMBER is the gate) — validated for
 *      format ONLY when the admin entered one.
 *   2. `buildIssueRequestBody` — the exact POST body: `null` (→ empty POST,
 *      backward-compatible legacy issue) for a standard-rate or flag-off
 *      issue; the `{ vatTreatment, zeroRateCertNo, zeroRateCertDate? }`
 *      triplet for a zero-rated issue. 088 UX-B1: when an OPTIONAL cert SCAN
 *      was uploaded, the returned blob key is threaded as `zeroRateCertBlobKey`
 *      (omitted when no scan was attached — the scan stays optional).
 *   3. `isZeroRateLowAmount` — the non-blocking ≥ 5,000 THB pre-submit
 *      advisory trigger (a WARN, never a hard block, FR-024).
 *
 * Pure `.ts` leaf — no React / next / DB imports — so it is client-bundle
 * safe and deterministically testable.
 */

export type VatTreatmentChoice = 'standard' | 'zero_rated_80_1_5';

/**
 * ≥ 5,000 THB (= 500,000 satang) low-amount advisory threshold. Mirrors the
 * domain source of truth `ZERO_RATE_MIN_SUBTOTAL_SATANG` (500_000n) in
 * `src/modules/invoicing/domain/policies/vat-treatment.ts` — duplicated as a
 * plain `number` here so this client leaf never pulls the invoicing barrel
 * (which would drag server-only infra into the client bundle). Kept in sync by
 * the pure-leaf test `issue-vat-treatment.test.ts`.
 */
export const ZERO_RATE_MIN_SUBTOTAL_SATANG = 500_000;

/** Certificate date wire format — mirrors `issueInvoiceSchema.zeroRateCertDate`. */
export const CERT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Certificate-number wire max — mirrors `issueInvoiceSchema.zeroRateCertNo`. */
export const CERT_NO_MAX = 200;

/**
 * i18n leaf keys (resolved to a localised string by the form via
 * `admin.invoices.issue.form.cert.*`). `null` = no error.
 */
export type ZeroRateCertErrors = {
  readonly certNo: 'certNoRequired' | null;
  readonly certDate: 'certDateFormat' | null;
};

export const NO_CERT_ERRORS: ZeroRateCertErrors = {
  certNo: null,
  certDate: null,
};

/**
 * The zero-rated POST payload, or `null` for a standard / flag-off issue
 * (→ an empty POST body, byte-identical to the legacy issue flow so the
 * route defaults `vatTreatment` to `standard`).
 */
export type IssueRequestBody =
  | {
      readonly vatTreatment: 'zero_rated_80_1_5';
      readonly zeroRateCertNo: string;
      readonly zeroRateCertDate?: string;
      /**
       * 088 UX-B1 — the Blob key of an OPTIONAL, already-ClamAV-scanned cert
       * scan. Present ONLY when the admin attached a scan; omitted otherwise
       * (the scan is optional — the cert NUMBER is the fail-closed gate).
       */
      readonly zeroRateCertBlobKey?: string;
    }
  | null;

/**
 * Fail-closed layer 1 (client): a `zero_rated_80_1_5` issue MUST carry a
 * non-blank certificate number. The date is optional; if entered it must be
 * `YYYY-MM-DD`. Returns `NO_CERT_ERRORS` for a standard issue (nothing to
 * validate).
 */
export function validateZeroRateCert(input: {
  readonly vatTreatment: VatTreatmentChoice;
  readonly certNo: string;
  readonly certDate: string;
}): ZeroRateCertErrors {
  if (input.vatTreatment !== 'zero_rated_80_1_5') return NO_CERT_ERRORS;
  const certNo: ZeroRateCertErrors['certNo'] =
    input.certNo.trim() === '' ? 'certNoRequired' : null;
  const trimmedDate = input.certDate.trim();
  const certDate: ZeroRateCertErrors['certDate'] =
    trimmedDate !== '' && !CERT_DATE_RE.test(trimmedDate)
      ? 'certDateFormat'
      : null;
  return { certNo, certDate };
}

export function hasZeroRateCertError(errors: ZeroRateCertErrors): boolean {
  return errors.certNo !== null || errors.certDate !== null;
}

/**
 * Non-blocking ≥ 5,000 THB advisory: true only for a zero-rated sale whose
 * known subtotal is below the threshold. `subtotalSatang` is a plain number
 * (satang) because a bigint cannot cross the RSC → client-prop boundary.
 */
export function isZeroRateLowAmount(
  vatTreatment: VatTreatmentChoice,
  subtotalSatang: number | null,
): boolean {
  return (
    vatTreatment === 'zero_rated_80_1_5' &&
    subtotalSatang !== null &&
    subtotalSatang < ZERO_RATE_MIN_SUBTOTAL_SATANG
  );
}

/**
 * Build the issue POST body. Returns `null` (→ empty POST) unless the flag is
 * on AND the admin chose zero-rate; then it carries the vat_treatment + cert
 * NUMBER (+ DATE when entered). 088 UX-B1: when an OPTIONAL cert SCAN was
 * uploaded (`certBlobKey` non-empty), its Blob key is included as
 * `zeroRateCertBlobKey`; when no scan was attached it is omitted (the scan is
 * optional — the cert NUMBER is the fail-closed gate).
 */
export function buildIssueRequestBody(input: {
  readonly taxAtPayment: boolean;
  readonly vatTreatment: VatTreatmentChoice;
  readonly certNo: string;
  readonly certDate: string;
  readonly certBlobKey?: string | null;
}): IssueRequestBody {
  if (!input.taxAtPayment || input.vatTreatment !== 'zero_rated_80_1_5') {
    return null;
  }
  const certDate = input.certDate.trim();
  const certBlobKey = (input.certBlobKey ?? '').trim();
  return {
    vatTreatment: 'zero_rated_80_1_5',
    zeroRateCertNo: input.certNo.trim(),
    ...(certDate !== '' ? { zeroRateCertDate: certDate } : {}),
    ...(certBlobKey !== '' ? { zeroRateCertBlobKey: certBlobKey } : {}),
  };
}
