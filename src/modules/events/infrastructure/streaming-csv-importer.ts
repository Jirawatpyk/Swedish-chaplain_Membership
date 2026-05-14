/**
 * T093 — Streaming CSV importer (F6 Infrastructure adapter).
 *
 * Hand-rolled UTF-8 CSV parser implementing the `CsvImporter`
 * Application port (`src/modules/events/application/ports/csv-importer.ts`).
 *
 * Format support per research.md R8 / E20 (tightly-specified subset of
 * RFC 4180):
 *   - UTF-8 input; BOM tolerated and stripped.
 *   - LF (`\n`) or CRLF (`\r\n`) row terminators.
 *   - Comma `,` field separator only.
 *   - Optional double-quoted fields with `""` escape for an embedded
 *     quote/comma.
 *
 * Rejected explicitly per R8 / E20:
 *   - Embedded newlines INSIDE quoted fields (Excel "wrap-in-cell"
 *     mode) — surface as "unterminated quoted field" row failure.
 *   - Non-comma separators (semicolon, tab) — header detection
 *     pre-checks and returns `invalid_header`.
 *   - Trailing commas on a row (column count mismatch).
 *   - Single-quoted cells (`'a',b,c`) — treated as a regular cell
 *     containing the `'` character; zod validation will likely fail
 *     downstream.
 *   - Inline comments (`#` lines) — treated as regular data rows;
 *     zod will fail on a malformed `event_external_id`.
 *
 * Pipeline:
 *   1. Decode bytes as UTF-8 (`fatal: true`) + strip BOM.
 *   2. Pre-flight: detect semicolon-as-separator on the header row.
 *   3. Tokenise header; build canonical-column → cell-index map (with
 *      admin `columnMapping` override applied per FR-026).
 *   4. Validate required columns present → return `invalid_header`
 *      with `missingColumns[]` if any missing.
 *   5. Return `ok(asyncIterable)` — the iterable yields one `ParsedRow`
 *      per body line, deferring per-row work until consumed by the
 *      caller (memory stays bounded — peak heap <500 MiB at 5,000
 *      rows per plan.md T138 bench target).
 *
 * Per-row hash (`ParsedRow.rowHash`): SHA-256 over the canonical
 * idempotency key components — `event_external_id || \0 ||
 * attendee_email.toLowerCase() || \0 || (registered_at ?? event_start)`.
 * The tenant_id is supplied by the use-case at idempotency-store insert
 * time (the receipt PK is `(tenant_id, source, request_id)` — RLS +
 * the composite PK provide cross-tenant isolation; we don't need to
 * mix tenant_id into the hash).
 *
 * Pure Infrastructure adapter — implementing the port from Application.
 * Constitution Principle III compliance: imports `node:crypto` (Node
 * standard library, not framework) + the Application port + Domain zod
 * schema. NO `drizzle-orm` / `next` / `react` imports.
 */
import { createHash } from 'node:crypto';
import { ok, err, type Result } from '@/lib/result';
import { CsvRowSchema, type CsvRow } from '../domain/eventcreate-payload';
import type {
  CsvImporter,
  CsvImporterError,
  CsvParseInput,
  ParsedRow,
} from '../application/ports/csv-importer';

// ---------------------------------------------------------------------------
// Canonical column-set constants
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  'event_external_id',
  'event_name',
  'event_start',
  'attendee_email',
  'attendee_name',
] as const;

const OPTIONAL_COLUMNS = [
  'event_category',
  'event_end',
  'event_location',
  'event_url',
  'is_partner_benefit',
  'is_cultural_event',
  'attendee_company',
  'attendee_external_id',
  'ticket_type',
  'ticket_price_thb',
  'payment_status',
  'registered_at',
] as const;

const ALL_COLUMNS = [
  ...REQUIRED_COLUMNS,
  ...OPTIONAL_COLUMNS,
] as const;

type CanonicalKey = (typeof ALL_COLUMNS)[number];

const CANONICAL_COL_SET: ReadonlySet<string> = new Set<string>(ALL_COLUMNS);

// ---------------------------------------------------------------------------
// UTF-8 decode + BOM strip
// ---------------------------------------------------------------------------

function stripBom(s: string): string {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

function decodeUtf8(bytes: Uint8Array): Result<string, CsvImporterError> {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return ok(stripBom(decoder.decode(bytes)));
  } catch {
    return err({ kind: 'invalid_utf8', offset: 0 });
  }
}

// ---------------------------------------------------------------------------
// Tokeniser — single line → cells
// ---------------------------------------------------------------------------

type TokeniseResult =
  | { readonly ok: true; readonly cells: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string };

function tokeniseLine(line: string): TokeniseResult {
  const cells: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i] as string;
    if (!inQuote) {
      if (ch === ',') {
        cells.push(current);
        current = '';
        i++;
        continue;
      }
      if (ch === '"') {
        if (current.length === 0) {
          inQuote = true;
          i++;
          continue;
        }
        return {
          ok: false,
          reason: `unexpected '"' at column ${i + 1} (mid-cell open-quote not supported)`,
        };
      }
      current += ch;
      i++;
      continue;
    }
    // inQuote === true
    if (ch === '"') {
      // Look ahead: `""` is an escaped quote inside the quoted field;
      // a single `"` closes the quoted field.
      const next = line[i + 1];
      if (next === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuote = false;
      i++;
      // After closing quote, next char must be `,` or end-of-line.
      if (i < n && line[i] !== ',') {
        return {
          ok: false,
          reason: `unexpected char '${line[i]}' after closing quote at column ${i + 1}`,
        };
      }
      continue;
    }
    current += ch;
    i++;
  }
  if (inQuote) {
    // Embedded newline inside quoted field (line terminated before the
    // closing `"`) — R8 / E20 explicit rejection.
    return { ok: false, reason: `unterminated quoted field` };
  }
  cells.push(current);
  return { ok: true, cells };
}

// ---------------------------------------------------------------------------
// Header parsing + validation
// ---------------------------------------------------------------------------

interface ParsedHeader {
  readonly columnIndex: ReadonlyMap<CanonicalKey, number>;
  readonly missingRequired: ReadonlyArray<string>;
}

function parseHeader(
  headerLine: string,
  columnMapping?: ReadonlyMap<string, string>,
): Result<ParsedHeader, CsvImporterError> {
  // Pre-flight: detect semicolon separator (the export common-case for
  // EU spreadsheet locales). Error early with a clear message rather
  // than producing 0 cells per row.
  if (!headerLine.includes(',') && headerLine.includes(';')) {
    return err({
      kind: 'invalid_header',
      reason:
        'header row uses semicolons — only comma-separated CSV is supported (re-export as "CSV UTF-8 (Comma delimited)")',
      missingColumns: [],
    });
  }
  const tok = tokeniseLine(headerLine);
  if (!tok.ok) {
    return err({
      kind: 'invalid_header',
      reason: `header tokenise failed: ${tok.reason}`,
      missingColumns: [],
    });
  }
  const map = new Map<CanonicalKey, number>();
  for (let i = 0; i < tok.cells.length; i++) {
    const raw = (tok.cells[i] as string).trim();
    const remapped = columnMapping?.get(raw);
    const canonical = remapped ?? raw;
    if (CANONICAL_COL_SET.has(canonical)) {
      map.set(canonical as CanonicalKey, i);
    }
  }
  const missingRequired: string[] = [];
  for (const col of REQUIRED_COLUMNS) {
    if (!map.has(col)) missingRequired.push(col);
  }
  if (missingRequired.length > 0) {
    return err({
      kind: 'invalid_header',
      reason: `missing required columns: ${missingRequired.join(', ')}`,
      missingColumns: missingRequired,
    });
  }
  return ok({ columnIndex: map, missingRequired: [] });
}

// ---------------------------------------------------------------------------
// Row hash (SHA-256) — canonical idempotency key per row
// ---------------------------------------------------------------------------

function computeRowHash(row: CsvRow): string {
  // Canonical key triple — see contracts/csv-import-api.md § 4b.
  // tenant_id is added implicitly by the idempotency-store PK
  // `(tenant_id, source, request_id)`; the hash only needs to be
  // unique per-(event,attendee,registration-time) within a tenant.
  const ts = row.registered_at ?? row.event_start;
  const canonicalBytes = [
    row.event_external_id,
    row.attendee_email.toLowerCase(),
    ts,
  ].join(' ');
  return createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Per-row mapping + zod validate
// ---------------------------------------------------------------------------

function cellAt(
  cells: ReadonlyArray<string>,
  columnIndex: ReadonlyMap<CanonicalKey, number>,
  key: CanonicalKey,
): string | undefined {
  const idx = columnIndex.get(key);
  if (idx === undefined) return undefined;
  const v = cells[idx];
  if (v === undefined || v.length === 0) return undefined;
  return v;
}

function mapCellsToRow(
  cells: ReadonlyArray<string>,
  columnIndex: ReadonlyMap<CanonicalKey, number>,
):
  | { readonly ok: true; readonly row: CsvRow }
  | { readonly ok: false; readonly reason: string } {
  const raw: Record<string, unknown> = {
    event_external_id: cellAt(cells, columnIndex, 'event_external_id'),
    event_name: cellAt(cells, columnIndex, 'event_name'),
    event_start: cellAt(cells, columnIndex, 'event_start'),
    event_category: cellAt(cells, columnIndex, 'event_category'),
    attendee_email: cellAt(cells, columnIndex, 'attendee_email'),
    attendee_name: cellAt(cells, columnIndex, 'attendee_name'),
    attendee_company: cellAt(cells, columnIndex, 'attendee_company'),
    // E1 verification fix — surface optional admin-supplied attendee
    // ID so the use-case can preserve it verbatim (preserves webhook
    // ↔ CSV equivalence on event_registrations.external_id when the
    // CSV was exported from the same EventCreate dataset).
    attendee_external_id: cellAt(cells, columnIndex, 'attendee_external_id'),
    ticket_type: cellAt(cells, columnIndex, 'ticket_type'),
    ticket_price_thb: cellAt(cells, columnIndex, 'ticket_price_thb'),
    payment_status: cellAt(cells, columnIndex, 'payment_status'),
    registered_at: cellAt(cells, columnIndex, 'registered_at'),
  };
  // Drop undefined keys so zod defaults take effect for optional fields.
  for (const k of Object.keys(raw)) {
    if (raw[k] === undefined) delete raw[k];
  }
  const parsed = CsvRowSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '?';
    const msg = first?.message ?? 'validation failed';
    return { ok: false, reason: `${path}: ${msg}` };
  }
  return { ok: true, row: parsed.data };
}

// ---------------------------------------------------------------------------
// Async generator — yields ParsedRow per body line
// ---------------------------------------------------------------------------

async function* iterateRows(
  bodyLines: ReadonlyArray<string>,
  columnIndex: ReadonlyMap<CanonicalKey, number>,
  expectedCellCount: number,
  startLineNumber: number,
): AsyncIterable<ParsedRow> {
  for (let i = 0; i < bodyLines.length; i++) {
    const lineNumber = startLineNumber + i;
    const line = bodyLines[i] as string;
    // Skip blank lines silently (trailing newline at EOF is the common
    // case; warning every blank row would spam the error report).
    if (line.length === 0 || line.trim().length === 0) continue;
    const tok = tokeniseLine(line);
    if (!tok.ok) {
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: tok.reason,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }
    // Trailing-comma rejection: `a,b,c,` produces 4 cells where the
    // last is empty AND the row has more cells than the header
    // declared. We reject this case (R8 / E20 trailing-comma rule)
    // because it usually signals a hand-edited CSV where a value was
    // deleted but the separator left behind.
    if (
      tok.cells.length === expectedCellCount + 1 &&
      tok.cells[expectedCellCount] === ''
    ) {
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: `trailing comma — row has ${tok.cells.length} cells, expected ${expectedCellCount}`,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }
    if (tok.cells.length !== expectedCellCount) {
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: `column count mismatch — row has ${tok.cells.length} cells, expected ${expectedCellCount}`,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }
    const mapped = mapCellsToRow(tok.cells, columnIndex);
    if (!mapped.ok) {
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: mapped.reason,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }
    yield {
      ok: true,
      rowNumber: lineNumber,
      row: mapped.row,
      rowHash: computeRowHash(mapped.row),
    };
  }
}

// ---------------------------------------------------------------------------
// Main parser entry — implements `CsvImporter.parseStream`
// ---------------------------------------------------------------------------

export const streamingCsvImporter: CsvImporter = {
  async parseStream(
    input: CsvParseInput,
  ): Promise<Result<AsyncIterable<ParsedRow>, CsvImporterError>> {
    const decoded = decodeUtf8(input.bytes);
    if (!decoded.ok) return decoded;
    const text = decoded.value;
    if (text.length === 0) {
      return err({
        kind: 'invalid_header',
        reason: 'empty file',
        missingColumns: [...REQUIRED_COLUMNS],
      });
    }
    // Split on LF / CRLF.
    const rawLines = text.split(/\r?\n/);
    const headerLine = rawLines[0] ?? '';
    if (headerLine.trim().length === 0) {
      return err({
        kind: 'invalid_header',
        reason: 'empty header row',
        missingColumns: [...REQUIRED_COLUMNS],
      });
    }
    const headerResult = parseHeader(headerLine, input.columnMapping);
    if (!headerResult.ok) return headerResult;

    // Detect expected cell count from the header.
    const headerTokens = tokeniseLine(headerLine);
    // headerTokens.ok is guaranteed (parseHeader would have errored
    // otherwise) — but narrow defensively.
    if (!headerTokens.ok) {
      return err({
        kind: 'invalid_header',
        reason: `header tokenise failed: ${headerTokens.reason}`,
        missingColumns: [],
      });
    }
    const expectedCellCount = headerTokens.cells.length;

    const bodyLines = rawLines.slice(1);
    return ok(
      iterateRows(bodyLines, headerResult.value.columnIndex, expectedCellCount, 2),
    );
  },
};

// Test-only helper exports for the unit suite (T093). Underscore prefix
// signals "private to the module + tests"; not re-exported via the
// `@/modules/events` barrel.
export const _internals = {
  tokeniseLine,
  parseHeader,
  computeRowHash,
  mapCellsToRow,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
} as const;
