/**
 * T005 (Feature 013 / F6.1) — `CsvImportRecordId` branded type.
 *
 * Identifies one row in `csv_import_records` (migration 0139). Branding is
 * Constitution Principle I clause 1 enforcement: forgetting to pass an
 * import-record id at a call site becomes a compile-time error rather
 * than a runtime mis-match.
 *
 * Follows the F6 module convention from
 * `src/modules/events/domain/branded-types.ts:24-58` — `__brand` symbol-
 * string + `asX` (throws on invalid) + `tryX` (returns `null`). The
 * data-model.md spec illustrates a `Result<…, ValidationError>` return
 * shape; we keep `… | null` here for consistency with the surrounding
 * F6 branded types (lighter ergonomics, no extra Result import in
 * Application layer).
 *
 * Pure TypeScript — Constitution Principle III (Domain has zero
 * framework imports).
 */

// --- Brand declaration ------------------------------------------------------

export type CsvImportRecordId = string & {
  readonly __brand: 'CsvImportRecordId';
};

// --- Validation regex (UUID v4, RFC 4122) -----------------------------------
//
// Accepts canonical UUID v4 shape. The CHECK constraint at the DB layer
// (column type `uuid`) will reject malformed values defence-in-depth, but
// this constructor catches them at the application boundary where the
// error message is more actionable.

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- Smart constructors -----------------------------------------------------

/**
 * Brand an already-validated string as a `CsvImportRecordId`. Use at trust
 * boundaries where input is known-good (post-zod-validation, post-DB-read).
 */
export function asCsvImportRecordId(value: string): CsvImportRecordId {
  if (!UUID_V4_PATTERN.test(value)) {
    throw new Error(
      'CsvImportRecordId must be a valid UUID v4 (RFC 4122 §4.4)',
    );
  }
  return value as CsvImportRecordId;
}

/**
 * Try to brand an unknown value as a `CsvImportRecordId`. Returns `null`
 * on shape mismatch — caller decides the next step (404, retry, etc.).
 */
export function tryCsvImportRecordId(value: unknown): CsvImportRecordId | null {
  if (typeof value !== 'string') return null;
  if (!UUID_V4_PATTERN.test(value)) return null;
  return value as CsvImportRecordId;
}
