/**
 * Streaming CSV importer (F6 Infrastructure adapter).
 *
 * Hand-rolled UTF-8 CSV parser implementing the `CsvImporter`
 * Application port (`src/modules/events/application/ports/csv-importer.ts`).
 *
 * Format support per research.md R8 / E20 + F6.1 research.md R1 update
 * (RFC 4180 § 2.6 — embedded newlines inside quoted cells):
 *   - UTF-8 input; BOM tolerated and stripped.
 *   - LF (`\n`) or CRLF (`\r\n`) row terminators.
 *   - Comma `,` field separator only.
 *   - Optional double-quoted fields with `""` escape for an embedded
 *     quote/comma.
 *   - Embedded `\r` / `\n` / `\r\n` INSIDE quoted cells — the row
 *     spans multiple physical lines. Required by real EventCreate
 *     "Guestlist" exports (Grant Thornton fixture row 2 spans 5
 *     physical lines in the address cell). Implemented via the
 *     `joinMultilineQuotedRows` preprocessing pass below; `tokeniseLine`
 *     itself is unchanged.
 *
 * Rejected explicitly per R8 / E20:
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
  ParseStreamFormatted,
  ParseStreamFormattedInput,
  SelectedEventContext,
} from '../application/ports/csv-importer';
import {
  detectEventCreateFormat,
  translateEventCreateRow,
  collectUnknownEventCreateColumns,
} from './eventcreate-csv-adapter';

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
  } catch (e) {
    // H-2 fix (2026-05-15): preserve the real decoder error so the
    // route can surface a user-actionable hint (admin should re-save
    // their CSV as UTF-8). `offset:0` is retained as a soft signal
    // (real byte offset not exposed by TextDecoder); the appended
    // `reason` field carries the genuine decoder message that callers
    // can log + display.
    return err({
      kind: 'invalid_utf8',
      offset: 0,
      reason:
        e instanceof Error
          ? e.message
          : 'UTF-8 decode failed (re-save the CSV as UTF-8 without BOM)',
    });
  }
}

// ---------------------------------------------------------------------------
// Line dispatcher — RFC 4180 § 2.6 (F6.1 / Feature 013 · T009 · R1)
// ---------------------------------------------------------------------------
//
// Splits decoded text into logical CSV rows while respecting cross-physical-
// line quoted cells. A naïve `text.split(/\r?\n/)` would split inside quoted
// cells too — `tokeniseLine` would then receive a single physical line that
// ends inside an open quote and return `unterminated quoted field`.
//
// The state machine here walks the input once, tracking whether the cursor
// is inside a quoted field. While inside a quote, `\r` / `\n` / `\r\n`
// are appended to the current logical-row buffer (preserved verbatim per
// RFC 4180 § 2.6). Outside a quote, those same characters terminate the
// logical row.
//
// `""` (escaped double-quote inside a quote) is preserved in the buffer
// untouched and does NOT toggle the inQuote state — `tokeniseLine` is
// the canonical source-of-truth for `""` → `"` collapse semantics.
//
// Output array semantics match the previous `text.split(/\r?\n/)` shape:
//   - `""` (empty input) → `[""]`
//   - `"a"` (no trailing newline) → `["a"]`
//   - `"a\nb"` → `["a", "b"]`
//   - `"a\n"` → `["a", ""]` (matches split's trailing-empty behaviour)
//
// Genuinely-unterminated quoted cells at EOF still surface as
// `unterminated quoted field` via `tokeniseLine` (the buffer is fed to
// the tokeniser as-is, the tokeniser exits with `inQuote === true`).

function joinMultilineQuotedRows(text: string): string[] {
  const result: string[] = [];
  let buffer = '';
  let inQuote = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i] as string;

    if (inQuote) {
      if (ch === '"') {
        // `""` escape — keep both chars in the buffer for tokeniseLine to
        // collapse later; do NOT toggle inQuote.
        if (text[i + 1] === '"') {
          buffer += '""';
          i += 2;
          continue;
        }
        // Single `"` closes the quoted cell.
        buffer += '"';
        inQuote = false;
        i++;
        continue;
      }
      // Any other char (including \r / \n) inside a quote is part of
      // the cell content.
      buffer += ch;
      i++;
      continue;
    }

    // Outside a quoted cell.
    if (ch === '"') {
      buffer += '"';
      inQuote = true;
      i++;
      continue;
    }
    if (ch === '\r') {
      // Treat \r\n as a single row terminator; lone \r also terminates
      // (matches the previous /\r?\n/ regex split).
      result.push(buffer);
      buffer = '';
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      result.push(buffer);
      buffer = '';
      i++;
      continue;
    }
    buffer += ch;
    i++;
  }

  // Always push the trailing segment — matches `String.prototype.split`
  // semantics where a trailing newline produces an extra empty element
  // and a missing trailing newline still emits the last row.
  result.push(buffer);
  return result;
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
    // Fires ONLY when the buffer reaches EOF with `inQuote` still true
    // — i.e. the file genuinely ends with an unclosed quote (corrupt
    // CSV). Embedded newlines in quoted cells are coalesced upstream
    // by `joinMultilineQuotedRows` per RFC 4180 § 2.6.
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
      // Generic-CSV path has no PDPA classification — port now requires
      // explicit tri-state, so emit `null` rather than rely on a
      // boundary coalesce in the use-case.
      pdpaConsentAcknowledged: null,
      // Generic-CSV path has no Cancellation surface (the EventCreate
      // Status='Cancelled' classification only fires on the adapter
      // path). Always false here.
      intendedStateChange: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Main parser entry — implements `CsvImporter.parseStream`
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F6.1 (Feature 013 · T022) — EventCreate-format row iterator
// ---------------------------------------------------------------------------
//
// Iterates body lines parsed in EventCreate format. Each row is translated
// via the T010 adapter (Status filter + name normalization + mailto strip
// + payment-status inference + PDPA classification), then merged with the
// admin-selected `eventContext` to form a `CsvRow`-compatible record that
// passes the strict `CsvRowSchema`.
//
// Status filter (FR-007): rows with Status != 'Attending' are surfaced as
// `{ok:false, reason:'Skipped: Status=…'}` so they flow into the use-case's
// `rowsSkipped` counter (distinct from `rowsFailed` — see contract response
// shape).
//
// Output rows additionally carry `pdpaConsentAcknowledged` for FR-009 storage.

async function* iterateEventCreateRows(
  bodyLines: ReadonlyArray<string>,
  headerCells: ReadonlyArray<string>,
  eventContext: SelectedEventContext,
  startLineNumber: number,
): AsyncIterable<ParsedRow> {
  // Build header-name → cell-index map ONCE (avoids per-row Map rebuild).
  const headerIndex = new Map<string, number>();
  for (let i = 0; i < headerCells.length; i++) {
    const name = headerCells[i] ?? '';
    if (name.length > 0) headerIndex.set(name, i);
  }
  const expectedCellCount = headerCells.length;
  const eventStartIso = eventContext.startDate.toISOString();

  for (let i = 0; i < bodyLines.length; i++) {
    const lineNumber = startLineNumber + i;
    const line = bodyLines[i] as string;
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
    if (tok.cells.length !== expectedCellCount) {
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: `column count mismatch — row has ${tok.cells.length} cells, expected ${expectedCellCount}`,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }

    // Build header→cell map for translateEventCreateRow.
    const cells = new Map<string, string>();
    for (const [name, idx] of headerIndex) {
      const value = tok.cells[idx] ?? '';
      cells.set(name, value);
    }

    const translated = translateEventCreateRow(cells);

    // F6.1 Phase 4 US2 (T033) — FR-007 Status filter is split into 3 paths:
    //   1. Attending      → ok:true with the row's inferred payment_status
    //   2. Cancellation   → ok:true with payment_status='refunded' +
    //                       intendedStateChange=true so the use-case
    //                       bypasses the idempotency receipt and routes
    //                       the row through `processAttendeeInTx`'s FR-018
    //                       refund branch (flips existing paid → refunded
    //                       + emits quota_credit_back_refund when matched).
    //   3. Skipped        → ok:false reason="Skipped: …" — flows into
    //                       `rowsSkipped` counter; never reaches the
    //                       per-row tx pipeline.
    if (!translated.isAttending && !translated.isCancellation) {
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: `Skipped: Status=${translated.rawStatus} (not a recognized attending status)`,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }

    // Build CsvRow-compatible raw with eventContext substituted in for
    // event_* columns. payment_status mapped from the T010 inference
    // ('paid' | 'pending' | 'unknown'); the schema only allows
    // ['paid','pending','refunded','free'] — `unknown` maps to 'paid'
    // default (Phase 7 schema default) to keep the row valid; a later
    // pass can re-classify via metadata if needed.
    //
    // Cancellation rows OVERRIDE the inferred payment_status to
    // 'refunded' so the FR-018 refund branch fires deterministically
    // regardless of what Notes said before cancellation.
    const paymentStatus = translated.isCancellation
      ? 'refunded'
      : translated.inferredPaymentStatus === 'unknown'
        ? undefined
        : translated.inferredPaymentStatus;

    const raw: Record<string, unknown> = {
      event_external_id: eventContext.externalId,
      event_name: eventContext.name,
      event_start: eventStartIso,
      event_category: eventContext.category ?? undefined,
      attendee_email: translated.attendeeEmail,
      attendee_name: translated.attendeeName,
      attendee_company: translated.attendeeCompany,
      attendee_external_id: translated.attendeeExternalId,
      ticket_type: translated.ticketType,
      payment_status: paymentStatus,
    };
    for (const k of Object.keys(raw)) {
      if (raw[k] === undefined) delete raw[k];
    }

    const parsed = CsvRowSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') ?? '?';
      const msg = first?.message ?? 'validation failed';
      yield {
        ok: false,
        rowNumber: lineNumber,
        reason: `${path}: ${msg}`,
        rawExcerpt: line.slice(0, 200),
      };
      continue;
    }

    yield {
      ok: true,
      rowNumber: lineNumber,
      row: parsed.data,
      rowHash: computeRowHash(parsed.data),
      pdpaConsentAcknowledged: translated.pdpaConsentAcknowledged,
      // F6.1 Phase 4 US2 (T033) — Cancellation rows flag for receipt
      // bypass + FR-018 routing in the use-case.
      intendedStateChange: translated.isCancellation,
    };
  }
}

// ---------------------------------------------------------------------------
// F6.1 (Feature 013 · T022) — Generic-format row iterator with event-context
// override
// ---------------------------------------------------------------------------
//
// Identical to the Phase 7 `iterateRows` body, except the resulting
// CsvRow has its event_* fields OVERRIDDEN with the admin-selected
// eventContext after schema validation. The admin dropdown is now the
// authority for the event binding (FR-019b safety-net premise).

async function* iterateGenericRowsWithEventContext(
  bodyLines: ReadonlyArray<string>,
  columnIndex: ReadonlyMap<CanonicalKey, number>,
  expectedCellCount: number,
  startLineNumber: number,
  eventContext: SelectedEventContext,
): AsyncIterable<ParsedRow> {
  const eventStartIso = eventContext.startDate.toISOString();
  for await (const row of iterateRows(
    bodyLines,
    columnIndex,
    expectedCellCount,
    startLineNumber,
  )) {
    if (!row.ok) {
      yield row;
      continue;
    }
    // Override event_* with the admin-selected event metadata.
    const merged: CsvRow = {
      ...row.row,
      event_external_id: eventContext.externalId,
      event_name: eventContext.name,
      event_start: eventStartIso,
      event_category: eventContext.category ?? row.row.event_category,
    };
    yield {
      ok: true,
      rowNumber: row.rowNumber,
      row: merged,
      // Rehash with the new (post-override) event_* fields so the
      // idempotency key reflects the event the import is actually
      // bound to — prevents the "same row, two events" idempotency
      // collision the FR-019b safety net is designed to flag.
      rowHash: computeRowHash(merged),
      // Generic-CSV format has no PDPA column — required tri-state at
      // the port boundary, so emit explicit `null`.
      pdpaConsentAcknowledged: null,
      // Generic-CSV format has no Cancellation surface (no EventCreate
      // Status semantics). Always false here.
      intendedStateChange: false,
    };
  }
}

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
    // Split on LF / CRLF, respecting RFC 4180 § 2.6 embedded-newline-in-
    // quoted-cell semantics (F6.1 · T009 / R1). Physical lines that fall
    // inside an open quoted cell get joined into a single logical row;
    // the embedded `\r` / `\n` is preserved in the cell content.
    const rawLines = joinMultilineQuotedRows(text);
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

  // -------------------------------------------------------------------------
  // F6.1 (Feature 013 · T022) — parseStreamWithFormat
  // -------------------------------------------------------------------------

  async parseStreamWithFormat(
    input: ParseStreamFormattedInput,
  ): Promise<Result<ParseStreamFormatted, CsvImporterError>> {
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

    const rawLines = joinMultilineQuotedRows(text);
    const headerLine = rawLines[0] ?? '';
    if (headerLine.trim().length === 0) {
      return err({
        kind: 'invalid_header',
        reason: 'empty header row',
        missingColumns: [...REQUIRED_COLUMNS],
      });
    }

    const headerTokens = tokeniseLine(headerLine);
    if (!headerTokens.ok) {
      return err({
        kind: 'invalid_header',
        reason: `header tokenise failed: ${headerTokens.reason}`,
        missingColumns: [],
      });
    }

    // Detect EventCreate format FIRST (presence-of-6 case-sensitive per
    // FR-001 / R2). If detected, route through the EventCreate adapter
    // path; otherwise fall through to the generic Phase 7 path with
    // event-context override applied post-validation.
    //
    // T053 (F6.1 Phase 6) — when `adapterEnabled === false` (set by the
    // route handler from `FEATURE_F6_EVENTCREATE_ADAPTER=false`), skip
    // detection entirely + force the generic-CSV path. This is the
    // rollback safety net per Spec § Rollback Plan: tenants whose
    // EventCreate header drift breaks the adapter can flip the sub-flag
    // to fall back to the Phase 7 strict schema (which surfaces
    // missing-required-columns as `invalid_header`).
    const headerCells = headerTokens.cells;
    const adapterEnabled = input.adapterEnabled !== false;
    if (adapterEnabled && detectEventCreateFormat(headerCells)) {
      const unknownColumns = collectUnknownEventCreateColumns(headerCells);
      const bodyLines = rawLines.slice(1);
      return ok({
        format: 'eventcreate_csv',
        rows: iterateEventCreateRows(
          bodyLines,
          headerCells,
          input.eventContext,
          2,
        ),
        unknownColumns,
      });
    }

    // Generic Phase 7 path — header must satisfy `parseHeader` strict
    // validation. The eventContext is then merged into each row AFTER
    // schema validation so the dropdown selection wins.
    const headerResult = parseHeader(headerLine, input.columnMapping);
    if (!headerResult.ok) return headerResult;
    const expectedCellCount = headerCells.length;
    const bodyLines = rawLines.slice(1);
    return ok({
      format: 'generic_csv',
      rows: iterateGenericRowsWithEventContext(
        bodyLines,
        headerResult.value.columnIndex,
        expectedCellCount,
        2,
        input.eventContext,
      ),
      unknownColumns: [],
    });
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
  joinMultilineQuotedRows,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
} as const;
