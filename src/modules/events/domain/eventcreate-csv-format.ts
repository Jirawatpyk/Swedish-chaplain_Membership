/**
 * T006 (Feature 013 / F6.1) — EventCreate CSV format value objects.
 *
 * Pure Domain types + a `classifyPdpaConsent` helper that turns raw cell
 * text into a tri-state boolean per FR-009. The classifier is intentionally
 * defensive: the cell appears inside EventCreate's "Personal Data
 * Protection Consent" column and may be missing entirely (generic CSV) or
 * contain free-text variations of "I hereby acknowledge…" / "I do not
 * consent…" / blank dashes / unrecognized phrasing.
 *
 * **PDPA Article 5(1)(c) data minimization** — only the CLASSIFIED
 * boolean is stored in `event_registrations.attendee_pdpa_consent_acknowledged`
 * (migration 0140). The raw consent text is NEVER persisted.
 *
 * Also exports `computeAttendeeFingerprint` (FR-019a 8-step hash) so the
 * use-case + infrastructure adapter both consume from the same source —
 * Clean Architecture III compliance for Application use-case fingerprint
 * computation.
 *
 * Pure TypeScript + `node:crypto` (Node stdlib, not framework) —
 * Constitution Principle III (Domain layer, zero framework imports).
 *
 * /review Full Scope 2026-05-19 — explicit Constitution III reading
 * for `node:crypto`. Principle III enumerates the prohibited framework
 * imports as `next` / `drizzle-orm` / `resend` / `@upstash/*` / `react`
 * (and per ESLint scope: `@react-pdf/renderer` / `@vercel/blob` /
 * `sharp` / `stripe`). The Node-stdlib `node:crypto` module is a
 * pure-function deterministic primitive (SHA-256 → hex), not a
 * framework — it has no I/O, no state, no global side effects, and no
 * lifecycle. Same usage class as `node:buffer` / `node:url` for byte
 * + string normalisation. Co-locating `computeAttendeeFingerprint` in
 * Domain keeps the FR-019a 8-step canonical hash next to its sole
 * input type (`CsvAdapterMode`) and prevents the Application layer
 * from drifting on the canonicalisation order. The fingerprint is a
 * value-object identity, not infrastructure.
 */
import { createHash } from 'node:crypto';

// --- CSV adapter mode discriminator ----------------------------------------
//
// Set by the EventCreate header-presence-of-6 heuristic in
// `eventcreate-csv-adapter.ts` (T010). The Phase 7 generic-CSV path
// continues to work unchanged for non-EventCreate uploads.

export type CsvAdapterMode = 'eventcreate_csv' | 'generic_csv';

// --- PDPA consent classification (FR-009 + post-critique Q1) ---------------
//
// Tri-state result of classifying EventCreate's "Personal Data Protection
// Consent" cell:
//   true  — "I hereby acknowledge…" (acknowledgement of processing)
//   false — "I do not consent…"      (explicit withdrawal)
//   null  — missing / blank / unrecognized / generic-CSV path
//
// A null result means "consent status unknown" — NOT a failure. The
// import does not block on null per FR-009 (consent is captured for
// downstream F7 broadcast filtering, not for ingest gating).

export type PdpaConsentAcknowledged = true | false | null;

// --- Classifier ------------------------------------------------------------
//
// Closed-form rules (matches data-model.md § 4 exactly):
//   1. null / undefined / empty / `-` / `–` (en-dash) → null
//   2. Cell contains "hereby acknowledge" (case-insensitive substring) → true
//   3. Cell contains "do not consent"     (case-insensitive substring) → false
//   4. Anything else → null (unrecognized; aggregated into adapter-metadata
//      for product-team review of EventCreate schema evolution)
//
// Defence-in-depth: 1024-char truncation before substring match guards
// against an attacker supplying a megabyte-long cell to exhaust regex
// state-machine memory. Real EventCreate consent cells are ≤200 chars in
// the committed fixtures.

const PDPA_CELL_MAX_CHARS = 1024;

export function classifyPdpaConsent(
  rawCell: string | null | undefined,
): PdpaConsentAcknowledged {
  if (rawCell === null || rawCell === undefined) return null;

  // Truncate before normalization — bounded work regardless of input size.
  const truncated = rawCell.length > PDPA_CELL_MAX_CHARS
    ? rawCell.slice(0, PDPA_CELL_MAX_CHARS)
    : rawCell;

  const trimmed = truncated.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed === '-' || trimmed === '–') return null;

  if (trimmed.includes('hereby acknowledge')) return true;
  if (trimmed.includes('do not consent')) return false;

  return null;
}

// --- Attendee fingerprint (FR-019a 8-step deterministic algorithm) --------
//
// SHA-256 truncated to 16 hex chars over the deterministic, sorted,
// lowercased list of attendee emails. The Use-case path (Application
// layer) consumes this via the canonical-form helper; the EventCreate
// adapter (Infrastructure layer) wraps it with the EventCreateAttendeeRow
// filter on `status === 'Attending'`.
//
//   3. trim · 4. lowercase · 5. discard empty · 6. lex-sort
//   7. NUL-byte join · 8. SHA-256 hex first 16
//
// Returns null for empty input (no fingerprint to store — the safety-net
// query is skipped). NUL byte is intentional: domain-separated from
// space-joined `attendeeName` constructions elsewhere in the codebase.

export function computeAttendeeFingerprintFromEmails(
  emails: ReadonlyArray<string>,
): string | null {
  const filtered = emails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  if (filtered.length === 0) return null;
  const canonical = [...filtered].sort().join(String.fromCharCode(0));
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}
