/**
 * T033 — `CsvImporter` Application port (F6).
 *
 * Streaming CSV parser. The Infrastructure adapter
 * (`streaming-csv-importer.ts`, Phase 7 T093) hand-rolls a parser over
 * Node `readline` per research.md R8 + round-1 E20:
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
  | { readonly kind: 'invalid_header'; readonly reason: string }
  | { readonly kind: 'invalid_utf8'; readonly offset: number }
  | { readonly kind: 'file_too_large'; readonly bytes: number; readonly max: number };

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
}
