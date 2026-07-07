/**
 * FR-026 CSV column-mapping canonical constants + route-boundary validator.
 *
 * Single source of truth for the canonical CSV column set, shared by:
 *   - the streaming CSV parser (`infrastructure/streaming-csv-importer.ts`)
 *     — recognises these canonical targets when applying an admin remap
 *     (`columnMapping.get(rawHeader) → canonical`);
 *   - the import route (`/api/admin/events/import`) — validates the
 *     admin-supplied `column_mapping` field (a NEW external input
 *     boundary) fail-closed before threading it to the use-case.
 *
 * DIRECTION (FR-026 hazard): the map the parser consumes is keyed by CSV
 * header, valued by canonical column (`{ "Email Address": "attendee_email" }`).
 * The remap UI naturally collects canonical→header, so the client inverts
 * before POSTing; `parseColumnMappingObject` validates the already-inverted
 * shape and MUST NOT re-invert.
 *
 * Pure Domain module — no framework / node imports (Constitution
 * Principle III). Safe to import from Infrastructure, Application, and the
 * route handler (via the module barrel).
 */

/**
 * Canonical required columns for the strict (legacy) generic-CSV schema.
 * These are the columns the header MUST carry when there is NO admin-
 * selected event context (the `parseStream` path).
 */
export const CSV_REQUIRED_COLUMNS = [
  'event_external_id',
  'event_name',
  'event_start',
  'attendee_email',
  'attendee_name',
] as const;

/**
 * Canonical optional columns the parser recognises. Some (event_end,
 * event_location, event_url, is_partner_benefit, is_cultural_event) are
 * recognised-but-inert in v1 (not mapped into `CsvRow`); they remain
 * valid remap targets so the route's canonical-set check matches the
 * parser's `CANONICAL_COL_SET` exactly.
 */
export const CSV_OPTIONAL_COLUMNS = [
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

export const CSV_CANONICAL_COLUMNS = [
  ...CSV_REQUIRED_COLUMNS,
  ...CSV_OPTIONAL_COLUMNS,
] as const;

export type CsvCanonicalColumn = (typeof CSV_CANONICAL_COLUMNS)[number];

export const CSV_CANONICAL_COLUMN_SET: ReadonlySet<string> = new Set<string>(
  CSV_CANONICAL_COLUMNS,
);

/**
 * Reduced required-column set for the picker-bound generic-CSV path
 * (#10b / FR-026). Post-095 the admin-selected event is authoritative and
 * the parser overrides `event_*` from `eventContext`, so a generic CSV
 * only needs to supply the attendee identity columns. The legacy
 * `parseStream` path (no eventContext) keeps the full `CSV_REQUIRED_COLUMNS`.
 *
 * MUST stay in sync with the client remap gate in `csv-mapping-form.tsx`
 * (a client component cannot import the module barrel without pulling
 * server-only code into the browser bundle, so the two-element list is
 * duplicated there with a back-reference to this constant).
 */
export const CSV_GENERIC_REQUIRED_COLUMNS = [
  'attendee_email',
  'attendee_name',
] as const;

/**
 * Defence-in-depth bounds on the admin-supplied `column_mapping` field.
 * The canonical target set is 17 columns; 64 is a generous ceiling that
 * still rejects unbounded / adversarial maps at the input boundary.
 */
export const MAX_COLUMN_MAPPING_ENTRIES = 64;
export const MAX_COLUMN_MAPPING_KEY_LENGTH = 256;

export type ParsedColumnMapping =
  | { readonly ok: true; readonly mapping: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate the JSON-parsed `column_mapping` field from the import route.
 * Fail-closed: the value MUST be a plain object keyed by CSV header,
 * valued by a canonical column name (the header→canonical direction the
 * parser expects). Returns the header→canonical `Map` on success (empty
 * object → ok with an empty Map, treated as a no-op by the caller).
 */
export function parseColumnMappingObject(raw: unknown): ParsedColumnMapping {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      reason:
        'column_mapping must be a JSON object of { csvHeader: canonicalColumn }',
    };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_COLUMN_MAPPING_ENTRIES) {
    return {
      ok: false,
      reason: `column_mapping has ${entries.length} entries (max ${MAX_COLUMN_MAPPING_ENTRIES})`,
    };
  }
  const mapping = new Map<string, string>();
  for (const [header, canonical] of entries) {
    if (header.length === 0 || header.length > MAX_COLUMN_MAPPING_KEY_LENGTH) {
      return { ok: false, reason: 'column_mapping key length out of range' };
    }
    if (
      typeof canonical !== 'string' ||
      !CSV_CANONICAL_COLUMN_SET.has(canonical)
    ) {
      return {
        ok: false,
        reason: `column_mapping target "${String(canonical)}" is not a canonical column`,
      };
    }
    mapping.set(header, canonical);
  }
  return { ok: true, mapping };
}
