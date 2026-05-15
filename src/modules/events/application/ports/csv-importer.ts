/**
 * T033 — `CsvImporter` Application port (F6).
 *
 * Streaming CSV parser. The Infrastructure adapter
 * (`streaming-csv-importer.ts`, Phase 7 T093) hand-rolls a parser over
 * Node `readline` per research.md R8:
 *   - UTF-8 + BOM strip
 *   - LF or CRLF row terminator
 *   - Comma separator
 *   - Double-quote escape with `""` for embedded quote/comma
 *   - REJECTS embedded newlines, semicolon separator, trailing commas,
 *     mixed quoting
 *
 * Stream interface: the adapter yields one parsed row at a time so the
 * import use-case can apply per-row processing without buffering the
 * entire file. Memory budget bench at Phase 10 T138 asserts peak <500 MiB
 * at 5,000 rows.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { CsvRow } from '../../domain/eventcreate-payload';
import type { PdpaConsentAcknowledged } from '../../domain/eventcreate-csv-format';

/**
 * Parse outcome for a single row. The importer wraps every row in this
 * Result so an unparseable row does not abort the stream — the
 * use-case logs the failure as `csv_import_row_failed` audit and
 * continues.
 */
export type ParsedRow =
  | {
      readonly ok: true;
      readonly rowNumber: number;
      readonly row: CsvRow;
      /**
       * SHA-256 hash of the canonical row bytes (UTF-8 normalised).
       * Used as the idempotency key for the CSV import path
       * (eventcreate_idempotency_receipts source = 'eventcreate_csv').
       */
      readonly rowHash: string;
      /**
       * F6.1 (Feature 013) — PDPA consent classification per FR-009.
       * Populated by EventCreate-adapter rows; absent (treated as null)
       * for generic Phase 7 rows. Stored in
       * `event_registrations.attendee_pdpa_consent_acknowledged` via the
       * use-case after `processAttendeeInTx` returns.
       */
      readonly pdpaConsentAcknowledged?: PdpaConsentAcknowledged;
    }
  | {
      readonly ok: false;
      readonly rowNumber: number;
      readonly reason: string;
      readonly rawExcerpt: string; // first 200 chars, PII-redacted
    };

export interface CsvParseInput {
  /** Binary file contents — the adapter handles BOM strip + UTF-8 decode. */
  readonly bytes: Uint8Array;
  /**
   * Optional column-name mapping (FR-026 admin remap). If absent, the
   * adapter auto-detects from the first row using the canonical CSV
   * schema column names. The mapping converts CSV header → canonical
   * key (e.g., `{ "Attendee Email": "attendee_email" }`).
   */
  readonly columnMapping?: ReadonlyMap<string, string>;
}

export type CsvImporterError =
  | {
      readonly kind: 'invalid_header';
      readonly reason: string;
      /**
       * Canonical names of required columns missing from the header
       * row. Populated when the rejection reason is "missing required
       * columns"; empty for other header-level errors (e.g. wrong
       * separator detected, all-empty first row).
       */
      readonly missingColumns: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'invalid_utf8';
      /** Best-effort byte offset (often 0 — TextDecoder doesn't expose). */
      readonly offset: number;
      /**
       * H-2 fix (2026-05-15): real decoder error message preserved so
       * routes can surface a user-actionable hint (e.g., "re-save as
       * UTF-8 without BOM") instead of a generic 500.
       */
      readonly reason: string;
    }
  | { readonly kind: 'file_too_large'; readonly bytes: number; readonly max: number };

/**
 * F6.1 (Feature 013) — Selected event context that the admin chose at
 * upload time. The use-case merges this into every row before zod
 * validation, overriding any event_*-prefixed columns in the CSV.
 *
 * For EventCreate-format CSVs (which have NO event_* columns at all),
 * this is the SOLE source of event metadata.
 * For generic-format CSVs, the dropdown selection is AUTHORITATIVE
 * (Phase 7 trusted the CSV; F6.1 makes the dropdown win).
 */
export interface SelectedEventContext {
  readonly externalId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly category: string | null;
}

/**
 * F6.1 (Feature 013) — Extended parse input that binds the upload to
 * one F6 event.
 */
export interface ParseStreamFormattedInput extends CsvParseInput {
  readonly eventContext: SelectedEventContext;
}

/**
 * F6.1 (Feature 013) — Successful parse outcome with format metadata
 * for the `csv_import_records.source_format` column +
 * `eventcreate_csv_adapter_mode_detected_total` counter.
 */
export interface ParseStreamFormatted {
  readonly format: 'eventcreate_csv' | 'generic_csv';
  readonly rows: AsyncIterable<ParsedRow>;
  /**
   * Unknown columns observed on EventCreate-format uploads, per FR-012.
   * Empty for generic format (Phase 7 schema is strict — unknowns
   * silently dropped).
   */
  readonly unknownColumns: ReadonlyArray<string>;
}

export interface CsvImporter {
  /**
   * Async-iterator over parsed rows. The caller iterates with
   * `for await (const row of importer.parseStream(input)) { ... }`
   * so memory stays bounded.
   *
   * Header validation happens BEFORE the first row yield — a malformed
   * header throws (or rather, the adapter returns a single-element
   * iterator yielding `{ok:false, reason: 'invalid header: ...'}` so
   * the caller pattern stays uniform).
   */
  parseStream(
    input: CsvParseInput,
  ): Promise<Result<AsyncIterable<ParsedRow>, CsvImporterError>>;

  /**
   * F6.1 (Feature 013 · T022/T009/T010) — Detect EventCreate vs generic
   * format, then parse + (for EventCreate) translate via the T010
   * adapter, merging `eventContext` into every row before zod
   * validation.
   *
   * The output `rows` AsyncIterable yields the SAME `ParsedRow` shape
   * regardless of source format — the use-case is format-agnostic
   * downstream of this method (FR-027 webhook↔CSV equivalence is
   * preserved because every row still ends up matching `CsvRow` shape
   * before `processAttendeeInTx`).
   *
   * EventCreate-format rows additionally carry `pdpaConsentAcknowledged`
   * for FR-009 storage; generic rows omit the field.
   *
   * TYPE-D3 (Round 1 — type-design-analyzer): REQUIRED. Previously
   * optional with a "Phase 7 mock predates" loophole, which let
   * production code accidentally route through the legacy fallback
   * branch (bypassing the dropdown-authoritative eventContext merge).
   * Phase 7 mocks now provide this method via the shared
   * `wrapParseStreamAsFormat` helper in
   * `tests/unit/events/_helpers/f6-csv-test-fixtures.ts`.
   */
  parseStreamWithFormat(
    input: ParseStreamFormattedInput,
  ): Promise<Result<ParseStreamFormatted, CsvImporterError>>;
}
