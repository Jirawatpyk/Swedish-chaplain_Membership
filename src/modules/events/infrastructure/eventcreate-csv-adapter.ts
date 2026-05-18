/**
 * T010 (Feature 013 / F6.1) — EventCreate CSV format adapter.
 *
 * Pure-function adapter that maps EventCreate's native "Guestlist" CSV
 * export (29-30 columns, multi-line address cells) to the existing
 * Phase 7 canonical `CsvRow` shape.
 *
 * Pure Infrastructure adapter — runs the format-translation. The
 * adapter itself does NOT run the import; the use-case
 * (`importCsv` — T022) invokes the adapter conditionally based on
 * header-detection mode (`detectEventCreateFormat`), then feeds the
 * translated rows through the existing `processAttendeeInTx` pipeline.
 *
 * Decision records:
 *   - Header heuristic (R2)         — presence-of-6 case-sensitive
 *   - Name normalization (R4)       — title-case with hyphen/apostrophe preserve
 *   - Payment-status mapping        — Option B+ (2026-05-18 /speckit-review
 *                                     follow-up): strict allowlist mapped
 *                                     from the upstream `Status` column;
 *                                     the pre-Option-B `Notes` inference
 *                                     was dropped. See
 *                                     `classifyEventCreateStatus` +
 *                                     `statusToPaymentStatus` below.
 *   - PDPA consent (FR-009)         — classified via Domain helper
 *   - Status routing (FR-007 + R2)  — 6-variant discriminated union
 *                                     (Attending → ingest; Cancellation →
 *                                     refund-flip; Pending / Waitlisted /
 *                                     NoShow → record as quota-neutral;
 *                                     unknown → Skipped)
 *   - Unknown-column tolerance      — collected for aggregate observability
 *   - Attendee fingerprint (FR-019a) — 8-step deterministic algorithm
 *
 * Pure TypeScript + node:crypto — Constitution Principle III (no framework
 * imports). `node:crypto` is Node standard library, not framework.
 */
import {
  classifyPdpaConsent,
  computeAttendeeFingerprintFromEmails,
  type PdpaConsentAcknowledged,
} from '../domain/eventcreate-csv-format';
import type { PaymentStatus } from '../domain/value-objects/payment-status';

// Re-export so test imports continue to resolve via the adapter module.
export { computeAttendeeFingerprintFromEmails };

// ---------------------------------------------------------------------------
// Header detection — FR-001 / R2 (presence-of-6 case-sensitive exact match)
// ---------------------------------------------------------------------------
//
// The six canonical EventCreate columns must ALL be present in the header
// row (in any order, possibly surrounded by other columns) for the
// importer to switch into EventCreate-adapter mode. If any of the six is
// missing → fall through to generic-CSV path (Phase 7 behavior unchanged).
//
// Case-sensitivity rationale: EventCreate emits these names with a
// deterministic capitalization verified across both committed fixtures
// (`docs/Attendee list/EventCreate_Guestlist-*.csv`). A future
// capitalization change would surface via the
// `eventcreate_csv_adapter_mode_detected_total{format="generic_csv"}`
// metric.

export const EVENTCREATE_REQUIRED_COLUMNS = [
  'Basic Info',
  'Status',
  'First Name',
  'Last Name',
  'Email',
  'Attendee ID',
] as const;

const EVENTCREATE_REQUIRED_SET: ReadonlySet<string> = new Set<string>(
  EVENTCREATE_REQUIRED_COLUMNS,
);

/**
 * Returns true iff every column in `EVENTCREATE_REQUIRED_COLUMNS` appears
 * in `headerCells` (case-sensitive exact match). Order-independent.
 */
export function detectEventCreateFormat(
  headerCells: ReadonlyArray<string>,
): boolean {
  // Cheap O(N + M) — N ≤ ~40 header cells, M = 6 required cells.
  const headerSet = new Set<string>(headerCells);
  for (const required of EVENTCREATE_REQUIRED_SET) {
    if (!headerSet.has(required)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Name normalization — FR-005 / R4 (title-case, hyphen/apostrophe-aware)
// ---------------------------------------------------------------------------
//
// Real EventCreate data has both `JOHN STEWART ANDERSON` (all-caps) and
// `Lars Svensson` (proper case) in the same `First Name` column —
// chamber-admin-controlled capitalization is inconsistent. We normalize
// to title-case to match the F3 member-directory convention.
//
// Rule: lowercase ALL characters except the first letter of each
// whitespace-separated token AND the first letter after each hyphen or
// apostrophe. `O'Brien` and `Mary-Jane` are preserved.
//
// Empty result (both names blank) is reported by the caller via the
// row-failure path — the helper itself returns the empty string and lets
// the use-case decide.

function titleCaseToken(token: string): string {
  if (token.length === 0) return token;
  // Split on hyphen / apostrophe; capitalize each sub-token.
  return token
    .split(/([-'])/u)
    .map((part) => {
      if (part === '-' || part === "'") return part;
      if (part.length === 0) return part;
      const head = part.charAt(0).toUpperCase();
      const tail = part.slice(1).toLowerCase();
      return head + tail;
    })
    .join('');
}

export function normalizeAttendeeName(first: string, last: string): string {
  const combined = `${first.trim()} ${last.trim()}`.trim();
  if (combined.length === 0) return '';
  return combined
    .split(/\s+/u)
    .map(titleCaseToken)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Email cleanup — FR-006 (strip `mailto:` prefix when present)
// ---------------------------------------------------------------------------
//
// Real EventCreate exports sometimes emit `mailto:jane@example.com` in the
// `Email` column — verified against AGM fixture row 2. We strip the
// `mailto:` prefix (case-insensitive) so the downstream `attendee_email`
// shape matches the Phase 7 `CsvRow.attendee_email` zod schema.

export function stripMailtoPrefix(raw: string): string {
  if (raw.length < 7) return raw;
  if (raw.slice(0, 7).toLowerCase() === 'mailto:') {
    return raw.slice(7).trim();
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Status filter — FR-007 (mirror EventCreate Status, F6.1 Option B+)
// ---------------------------------------------------------------------------
//
// Bug-fix 2026-05-18 — original FR-007 dropped every non-Attending /
// non-Cancelled row into rowsSkipped, silently losing the chamber's
// pre-event registration list (TSCC's Pending uploads → 17/17 dropped).
// Option B+ mirrors EventCreate's authoritative `Status` field into the
// `event_registrations.payment_status` column so F7 broadcasts + F8
// at-risk scoring see registrations the moment they exist upstream.
// Re-upload after a host flips Status (Pending → Attending) drives the
// state-change UPDATE path in maybeApplyStateChange — no per-row admin
// clicks needed.
//
// Notes-based inference was REMOVED: the `Notes` column in TSCC's
// real-world CSV exports is used for attendee IDs and free-text
// comments, NOT payment status. inferPaymentStatus + PAYMENT_NOTES_MAPPING
// produced noise and is gone. `Status` is now the single source of truth.

/**
 * EventCreate `Status` discriminator (F6.1 Option B+, 2026-05-18).
 *
 *   - `Attending`    → persists with `payment_status='paid'`, COUNTS toward quota
 *   - `Pending`      → persists with `payment_status='pending'`, does NOT count
 *   - `Cancellation` → flips an existing paid registration to `'refunded'` via
 *                      FR-018 credit-back; first-time cancellations land as
 *                      ghost rows (no-op) flowing into rowsSkipped
 *   - `Waitlisted`   → persists with `payment_status='waitlisted'`, does NOT count
 *   - `NoShow`       → persists with `payment_status='no_show'`, does NOT count
 *                      (admin can still mark No Show seats consumed via toggle)
 *   - `Skipped`      → unrecognised Status value (blank, typo, custom label)
 *                      flows into rowsSkipped with `Skipped: Status=...` reason
 */
export type EventCreateRowStatus =
  | 'Attending'
  | 'Cancellation'
  | 'Pending'
  | 'Waitlisted'
  | 'NoShow'
  | 'Skipped';

export function classifyEventCreateStatus(
  rawStatus: string | null | undefined,
): EventCreateRowStatus {
  if (rawStatus === null || rawStatus === undefined) return 'Skipped';
  const trimmed = rawStatus.trim();
  if (trimmed === 'Attending') return 'Attending';
  if (trimmed === 'Cancelled' || trimmed === 'Canceled') return 'Cancellation';
  if (trimmed === 'Pending') return 'Pending';
  if (trimmed === 'Waitlisted') return 'Waitlisted';
  if (trimmed === 'No Show' || trimmed === 'NoShow' || trimmed === 'No-Show') {
    return 'NoShow';
  }
  return 'Skipped';
}

/**
 * Map an EventCreate Status discriminator to the persisted payment_status.
 * Pure function — keeps the mapping table central + testable.
 * `Skipped` returns null because skipped rows never reach the DB.
 */
export function statusToPaymentStatus(
  status: EventCreateRowStatus,
): Exclude<PaymentStatus, 'free'> | null {
  switch (status) {
    case 'Attending':
      return 'paid';
    case 'Pending':
      return 'pending';
    case 'Cancellation':
      return 'refunded';
    case 'Waitlisted':
      return 'waitlisted';
    case 'NoShow':
      return 'no_show';
    case 'Skipped':
      return null;
    default: {
      // C2 follow-up — defence-in-depth exhaustiveness assertion.
      // Adding a 7th `EventCreateRowStatus` variant forces this case
      // to compile-error (`never` cannot accept the new literal),
      // catching a missing mapping at build time rather than at
      // runtime as silent fall-through.
      const _exhaustive: never = status;
      throw new Error(
        `unhandled EventCreateRowStatus: ${_exhaustive as string}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// EventCreate row translation
// ---------------------------------------------------------------------------
//
// Translates a parsed EventCreate row (header-cells → cell-values map) to
// the canonical Phase 7 `CsvRow`-compatible shape PLUS the F6.1-specific
// attendee_pdpa_consent_acknowledged field. The use-case (T022) injects
// event_external_id / event_name / event_start from the admin-selected
// event before passing the row to `processAttendeeInTx`.
//
// `event_external_id` / `event_name` / `event_start` are intentionally
// LEFT BLANK here — the adapter is event-agnostic (it processes a
// guestlist without knowing which Chamber-OS event the admin will link
// it to). The use-case fills these in from the selected event.

export interface EventCreateAttendeeRow {
  /**
   * F6.1 Option B+ (2026-05-18) — discriminator for the EventCreate
   * Status column. Caller branches on this; `Skipped` rows are dropped
   * before reaching the savepoint pipeline. Replaces the old
   * `isAttending` + `isCancellation` boolean pair (which couldn't
   * represent Pending / Waitlisted / NoShow).
   */
  readonly status: EventCreateRowStatus;
  /**
   * F6.1 Option B+ — payment_status to persist on the registration row.
   * Derived from `status` via `statusToPaymentStatus`. `null` only when
   * `status === 'Skipped'`, in which case the row is dropped and never
   * reaches the DB.
   */
  readonly paymentStatus: Exclude<PaymentStatus, 'free'> | null;
  /**
   * F6.1 Phase 4 US2 (T033) — true when `status === 'Cancellation'`.
   * Causes the use-case to BYPASS the idempotency receipt and route the
   * row directly through `processAttendeeInTx`'s FR-018 refund branch
   * (flips an existing paid row → refunded + credit-back audit). All
   * other states (including Pending/Waitlisted/NoShow) go through the
   * normal receipt-then-insert pipeline.
   */
  readonly intendedStateChange: boolean;
  /** Lowercased + mailto-stripped + trimmed for idempotency hashing. */
  readonly attendeeEmail: string;
  /** Title-case normalized full name. */
  readonly attendeeName: string;
  /** Free-text company name; passthrough for member matching. */
  readonly attendeeCompany: string | undefined;
  /** Verbatim EventCreate attendee ID for FR-017 idempotency hashing. */
  readonly attendeeExternalId: string | undefined;
  /** Free-text ticket label from `Ticket` column. */
  readonly ticketType: string | undefined;
  /** PDPA consent classification per FR-009 / Q1. */
  readonly pdpaConsentAcknowledged: PdpaConsentAcknowledged;
  /** Raw `Status` cell — preserved for skipped-row error reporting. */
  readonly rawStatus: string;
}

/**
 * Translate one EventCreate body row (a `{headerName: cellValue}` map) to
 * the F6.1 attendee shape. The header-to-cell map is built by the
 * caller (use-case) from the canonical EventCreate header indexing.
 *
 * F6.1 Option B+ change (2026-05-18): `Notes` is no longer parsed for
 * payment-status inference (TSCC's real-world `Notes` cells contain
 * attendee IDs and free-text comments, NOT payment state). `Status` is
 * the single source of truth.
 */
export function translateEventCreateRow(
  cells: ReadonlyMap<string, string>,
): EventCreateAttendeeRow {
  const status = cells.get('Status') ?? '';
  const first = cells.get('First Name') ?? '';
  const last = cells.get('Last Name') ?? '';
  const emailRaw = cells.get('Email') ?? '';
  const company = cells.get('Company Name')?.trim();
  const attendeeId = cells.get('Attendee ID')?.trim();
  const ticket = cells.get('Ticket')?.trim();
  const pdpa = cells.get('Personal Data Protection Consent');

  const email = stripMailtoPrefix(emailRaw).trim().toLowerCase();
  const classification = classifyEventCreateStatus(status);

  return {
    status: classification,
    paymentStatus: statusToPaymentStatus(classification),
    intendedStateChange: classification === 'Cancellation',
    attendeeEmail: email,
    attendeeName: normalizeAttendeeName(first, last),
    attendeeCompany: company && company.length > 0 ? company : undefined,
    attendeeExternalId:
      attendeeId && attendeeId.length > 0 && attendeeId !== '–'
        ? attendeeId
        : undefined,
    ticketType: ticket && ticket.length > 0 && ticket !== '–' ? ticket : undefined,
    pdpaConsentAcknowledged: classifyPdpaConsent(pdpa),
    rawStatus: status,
  };
}

// ---------------------------------------------------------------------------
// Unknown-column tolerance — FR-012 (collect names for aggregate logging)
// ---------------------------------------------------------------------------
//
// EventCreate occasionally adds new columns (verified across the two
// committed fixtures — the workshop CSV has different optional columns
// than the AGM CSV). FR-012 requires we tolerate unknown columns at
// import time AND surface their names to the product team via a per-
// upload aggregate pino log (`f6_eventcreate_adapter_unknown_columns`
// emitted by `import-csv.ts`). This helper collects the list; the
// use-case emits the log.
//
// The set of "known" columns is the union of REQUIRED + standard
// optionals that the adapter actively reads. Any header cell outside
// this set is "unknown" and collected here.

const EVENTCREATE_KNOWN_COLUMNS: ReadonlySet<string> = new Set<string>([
  // Required (FR-001 / R2)
  'Basic Info',
  'Status',
  'First Name',
  'Last Name',
  'Email',
  'Attendee ID',
  // Optional read by the translator
  'Company Name',
  'Ticket',
  'Notes',
  'Personal Data Protection Consent',
  // Optional ignored at translation time but recognised as expected
  // (does not warrant an "unknown column" log entry)
  'Phone Number',
  'Phone Number Consent',
  'Registration Date',
  'Added Date',
  'Last Updated Date',
  'Attendee Edited Date',
  'Guest Of',
  'Number of Guests Allowed',
  'Checked In',
  'Order ID',
  'VIP',
  'Assigned Table',
  'Tags',
  'Registration Category',
  'Last Email Sent',
  'Last Email Sent Date',
  'Unsubscribed',
]);

export function collectUnknownEventCreateColumns(
  headerCells: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const unknown: string[] = [];
  for (const cell of headerCells) {
    if (!EVENTCREATE_KNOWN_COLUMNS.has(cell)) unknown.push(cell);
  }
  return unknown;
}

// ---------------------------------------------------------------------------
// Attendee fingerprint — FR-019a (event-mismatch safety net)
// ---------------------------------------------------------------------------
//
// SHA-256 truncated to 16 hex characters over the deterministic, sorted,
// lowercased list of `attendee_email` values for rows where
// `Status === 'Attending'`. The 8-step algorithm (per spec):
//
//   1. Filter input rows to `status === 'Attending'`.
//   2. Strip `mailto:` prefix from each email (already done in
//      `translateEventCreateRow`).
//   3. Trim each email.
//   4. Lowercase each email.
//   5. Discard empty/whitespace-only emails.
//   6. Sort lexicographically (`Array.prototype.sort` default).
//   7. Join with the NUL byte (` `) — domain-separated from
//      `attendeeName` joins which use space.
//   8. SHA-256 digest, hex-encoded, take first 16 characters.
//
// Edge case: a guestlist with ZERO Attending rows produces NULL (the
// safety net query is skipped — there is nothing to match against).
// The use-case stores NULL in `csv_import_records.attendee_fingerprint`.

export function computeAttendeeFingerprint(
  rows: ReadonlyArray<EventCreateAttendeeRow>,
): string | null {
  // Delegate to the Domain helper (single source-of-truth for the 8-step
  // algorithm — closes Clean Arch Principle III gap where the Application
  // use-case needed the same hash as the EventCreate adapter).
  return computeAttendeeFingerprintFromEmails(
    rows.filter((r) => r.status === 'Attending').map((r) => r.attendeeEmail),
  );
}

