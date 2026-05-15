# Phase 0 — Research: CSV Import Primary Path + EventCreate Format Adapter

**Date**: 2026-05-15 · **Feature**: `013-csv-import-eventcreate-format` · **Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

All decisions below resolve specific NEEDS CLARIFICATION items from Technical Context and document the rationale + rejected alternatives for non-trivial design choices.

---

## R1 — Embedded-newline support in quoted CSV cells (RFC 4180)

**Decision**: Relax Phase 7's strict `streaming-csv-importer` to accept `\r`, `\n`, and `\r\n` inside double-quoted cells; treat the cell content as a single field value spanning multiple physical lines. Outside quoted cells, line endings (`\r` / `\n` / `\r\n`) continue to delimit rows.

**Rationale**: EventCreate Guestlist exports routinely emit multi-line address cells inside quoted strings — verified directly against `docs/Attendee list/EventCreate_Guestlist-grant-thornton-workshop.csv` (the address column on row 2 spans 5 physical lines). RFC 4180 § 2.6 explicitly states fields with line breaks are valid if enclosed in quotes. Phase 7 chose strict mode (R8 round-1 E20: "rejects embedded newlines") because the synthetic test fixtures didn't exercise multi-line cells. With real EventCreate fixtures the strict rejection blocks the primary daily-driver workflow — **must change**.

**Implementation approach**:
- Modify the parser's state machine: when inside a quoted field, a bare `\r`, `\n`, or `\r\n` advances the parse position but appends the literal character(s) to the current cell buffer instead of completing the row.
- A `""` (double-quote) inside a quoted field continues to be the escape for a single `"` (Phase 7 behavior unchanged).
- An unmatched closing quote followed by anything other than `,` / `"` / line-terminator continues to be a parser error (Phase 7 strict tokenization preserved).

**Test fixtures**:
- Add `tests/integration/events/csv-fixtures/eventcreate-multiline-address.csv` derived from the real Grant Thornton workshop row 2.
- Property test (fast-check): generate random quoted fields with 0-5 embedded newlines + arbitrary content; assert parser preserves the field value byte-for-byte.

**Alternatives rejected**:
- *Pre-process the upload to flatten multi-line cells*: complex sed-like rewrite; loses correlation between physical lines and logical rows; hard to audit. Rejected — parser is the right layer to fix.
- *Reject EventCreate exports with multi-line cells + ask admin to flatten*: violates the primary user story; defeats the feature's purpose. Rejected.

---

## R2 — Header detection heuristic for EventCreate vs. generic format

**Decision** (per Q5 clarification): Check whether the parsed header row contains **all six required columns** by name, ignoring position and surrounding columns: `Basic Info`, `Status`, `First Name`, `Last Name`, `Email`, `Attendee ID`. Compare using **case-sensitive exact match** (EventCreate emits these names with deterministic capitalization, verified across both committed fixtures). If all six present → switch to EventCreate adapter mode. If any missing → fall through to generic CSV path (existing Phase 7 header validation kicks in).

**Rationale**:
- Robust to EventCreate adding new columns before/between/after the canonical six (FR-012's "tolerate unknown columns" intent).
- Cheap O(N) on header row only (N ≤ ~40 columns even in pessimistic future EventCreate evolution).
- Case-sensitive match catches typos / column-name drift that admin manually-edited the CSV would introduce — if EventCreate changes capitalization in a future version, our pino warning surfaces it (see Observability metric `eventcreate_csv_adapter_mode_detected_total`).

**Implementation approach**:
- `eventcreate-csv-adapter.ts` exports `detectEventCreateFormat(headerCells: string[]): boolean` — pure function, takes the parsed header row as cell array.
- Required-columns set is a frozen string array constant; future additions are explicit edits.
- Adapter routing happens at the `importCsv` use-case boundary: read header → detect → branch to EventCreate adapter or generic path.

**Property tests (fast-check)**:
- Generate headers containing all 6 required + 0-30 random extra columns in random positions → assert detector returns `true`.
- Generate headers missing 1 of the 6 + the rest of the canonical set → assert detector returns `false`.
- Generate headers with case-shifted matches (`basic info` vs `Basic Info`) → assert detector returns `false` (case-sensitive).

**Alternatives rejected**:
- *Strict prefix match*: brittle to schema evolution (rejected per Q5 deliberation).
- *Admin-selectable dropdown*: adds friction, requires admin to know format (rejected per Q5).
- *Auto-detect with admin confirmation modal*: adds UI step; falls back to admin knowledge anyway (rejected — Q5 chose presence-of-columns).

---

## R3 — CSV formula injection defence (OWASP A03 + Excel attack vectors)

**Decision**: When generating the **error rows CSV** (FR-021 + Q4), prefix any cell whose first character is `=`, `+`, `-`, or `@` with a single quote (`'`) — the standard CSV injection mitigation. Inbound CSV parsing (admin upload path) does NOT need this defence because the data is consumed into the database, not re-rendered into a spreadsheet. (Original R3 also covered the CSV template download per FR-023, but that surface was dropped at the post-critique Q5 review.)

**Rationale**:
- An attacker who controls an attendee email or notes field (e.g., `=cmd|'/c calc'!A0`) could weaponize a re-downloaded error CSV if a chamber admin opens it in Excel — Excel would execute the formula. This is a real, documented attack class.
- Prefixing with `'` makes Excel render the cell as text (the leading apostrophe is hidden by Excel's display). No Chamber-OS-side behavioral cost.
- The CSV template is admin-controlled content (static fixture), but the mitigation is cheap insurance against future field additions.
- The streaming-csv-importer (inbound parser) writes parsed values into Postgres as plain strings — no re-rendering into a spreadsheet downstream — so the inbound side is safe.

**Implementation approach**:
- New helper `csvSafeCell(value: string): string` in `src/lib/csv-safe.ts` — if first char ∈ `=+-@`, return `"'" + value`; else return value unchanged.
- All cells written into the **error CSV** Blob pass through `csvSafeCell`.
- All cells written into the **CSV template** download pass through `csvSafeCell`.
- Unit test: assert formula payloads (e.g., `=cmd|'/c calc'!A0`, `@SUM(A1:A10)`, `-2+3+cmd|...`) are prefixed.

**Alternatives rejected**:
- *Reject + drop the row before it enters the database*: legitimate emails / company names could legitimately start with `+` (international phone in notes, etc.). Rejected — false positives.
- *No mitigation, rely on Excel's "Enable macros" prompt*: most chamber admins click through prompts; the prompt only protects when macros are explicit, not formula functions. Rejected.

---

## R4 — Name capitalization normalization (FR-005)

**Decision**: Combine EventCreate's `First Name` + `Last Name` into a single `attendee_name` field. Apply **title-case normalization** that respects locale: lowercase ALL except the first letter of each whitespace-separated token AND the first letter after each hyphen / apostrophe.

**Rationale**:
- Real EventCreate data has both `JOHN STEWART ANDERSON` (Grant Thornton row 2) and `Lars Svensson` (AGM row 2) in the same `First Name` column — capitalisation is admin-controlled and inconsistent.
- Title case is the Latin-script chamber-roster convention; matches member-record convention in F3.
- Hyphen/apostrophe handling preserves names like `Anderson-Smith` and `O'Brien`.
- The original capitalization is preserved in the audit trail (`csv_import_row_failed`'s `rawRowExcerpt` already retains first 200 chars).

**Implementation approach**:
- `normalizeAttendeeName(first: string, last: string): string` in `eventcreate-csv-adapter.ts`:
  ```
  combined = first.trim() + " " + last.trim()
  for each token (split on whitespace):
    for each sub-token (split on '-' or "'"):
      capitalize first char, lowercase the rest
    rejoin
  ```
- Edge case: empty `Last Name` → trim trailing space; if BOTH empty → fall back to the `Basic Info` column (which itself may be uppercase — apply same normalization).
- Empty result (both first + last + Basic Info are empty) → row goes to `errorRows[]` with reason "Missing attendee name" (FR-029 row-failure isolation).

**Tests**:
- Unit cases: `("JOHN STEWART", "ANDERSON")` → `"John Stewart Anderson"`; `("anna", "hammargren")` → `"Anna Hammargren"`; `("Mary-Jane", "O'Brien")` → `"Mary-Jane O'Brien"`; `("", "")` → row error.
- Property test: idempotency — `normalize(normalize(x)) === normalize(x)`.

**Alternatives rejected**:
- *Use `Basic Info` field directly*: capitalization is admin-controlled and inconsistent. Rejected.
- *No normalization — preserve original*: produces mixed case across roster (`JOHN STEWART ANDERSON` alongside `Anna Hammargren`); poor UX in member directory. Rejected.

---

## R5 — Payment status inference from EventCreate `Notes` column (FR-008)

**Decision**: Closed mapping table from `Notes` column trimmed content to canonical `payment_status` value:

| Notes (trimmed, case-insensitive) | → `payment_status` |
|---|---|
| `Paid` | `paid` |
| `invoice sent` | `paid` (chamber has invoiced; admin marked as paid intent) |
| `verifying payment` | `pending` |
| `Pending` | `pending` |
| empty / `–` (en-dash) / `-` (hyphen) | `unknown` |
| **any other value** | `unknown` + pino structured log `f6_eventcreate_unknown_payment_note` (aggregated per-upload, not per-row) |

**Rationale**:
- `Notes` is a free-text field in EventCreate; chamber admins have evolved a convention (verified in both fixtures). The closed mapping captures the observed convention without over-engineering free-text parsing.
- `unknown` is the safe default — downstream F4 invoicing already handles `unknown` payment status correctly (admin manually reconciles).
- The pino log on unrecognized values surfaces drift over time; the product team can extend the mapping table when a new pattern emerges.

**Implementation approach**:
- `inferPaymentStatus(notes: string | null | undefined): 'paid' | 'pending' | 'unknown'` in `eventcreate-csv-adapter.ts`.
- Trim + lowercase + strict-equal match against the mapping. Whitespace inside the value (e.g., `"  Paid  "` vs `"Paid"`) is normalized.
- The pino log fires at the end of the import (aggregate count of distinct unknown patterns + 1 example each), NOT per row — avoids log spam.

**Tests**:
- Unit table: each row of the mapping above → expected output.
- Aggregation test: 84-row CSV with 5 distinct `Notes` patterns → log fires once with the right aggregate counts.

**Alternatives rejected**:
- *Use the EventCreate `Ticket` column instead* (e.g., `"SweCham Members (2,950 THB)"` implies paid): conflates ticket tier with payment status; rows can have a paid ticket type but pending payment. Rejected.
- *Force admin to map `Notes` values to payment statuses in UI*: adds setup friction; admin doesn't know all the values until they upload. Rejected.

---

## R6 — Vercel Blob private bucket + signed URL + TTL sweep (FR-021, Q4)

**Decision**:
- **Storage**: Vercel Blob `@vercel/blob` private bucket (one bucket per environment; tenant-scoped path prefix `tenants/{tenantSlug}/csv-import-errors/{recordId}.csv`).
- **Signed URL**: 15-minute expiry per access; generated server-side on each `GET /api/admin/events/import/{recordId}/error-csv` request after admin RBAC + ownership check.
- **TTL sweep**: daily cron at 05:00 Asia/Bangkok via cron-job.org → `/api/internal/retention/sweep-error-csv-blobs` (Bearer-auth via `CRON_SECRET`) → query `csv_import_records WHERE error_csv_expires_at < NOW()` → `vercelBlob.del(blobUrl)` + UPDATE `error_csv_blob_url = NULL` + emit pino info log. 30-day TTL.
- **Access audit**: every successful signed-URL generation emits `csv_import_error_csv_downloaded` audit event with admin user, import record id, source IP, timestamp.

**Rationale**:
- Pattern matches F4 invoice PDF storage (already in production) — same Blob library, same lifecycle, same audit shape. Zero new infrastructure dependency.
- Private bucket means URL-guessing attacks are infeasible (Blob URL contains random suffix); signed URL adds time-bound access on top.
- 30-day TTL aligns with PDPA Section 37 minimization principle — admins typically resolve error rows within days, not months; longer retention serves no operational purpose.
- 15-minute signed URL expiry balances usability (admin clicks download → file downloads before expiry) with leak window (URL in browser history loses utility quickly).
- Daily TTL sweep cron handles the bulk delete; we do NOT rely on Vercel Blob's native lifecycle policy because it doesn't exist at the time of writing.

**Implementation approach**:
- `ErrorCsvStore` port in Application:
  ```ts
  put(input: {tenantId, recordId, csvBytes, expiresAt}): Promise<Result<{blobUrl}, StoreError>>
  generateSignedUrl(input: {blobUrl, expiresInSeconds: 900}): Promise<Result<{signedUrl}, StoreError>>
  delete(input: {blobUrl}): Promise<Result<void, StoreError>>
  ```
- `VercelBlobErrorCsvStore` in Infrastructure implements via `@vercel/blob` SDK.
- TTL sweep is a separate use-case `sweep-expired-error-csv-blobs.ts` invoked by cron handler.

**Tests**:
- Integration (live Vercel Blob in test env): put + signed-URL + access + delete round-trip.
- Unit: signed-URL access emits audit event with all required fields.
- Cron handler: contract test (`tests/contract/events/sweep-error-csv-cron.test.ts`) with bearer auth + 200 OK + count returned.

**Blob upload failure handling** (closes critique E2):
- If `ErrorCsvStore.put()` fails AFTER the main import tx has committed (rows already in DB, but error-CSV blob write fails) → use-case sets `csv_import_records.error_csv_blob_url = NULL` + `error_csv_expires_at = NULL`, emits `f6_error_csv_upload_failed` pino log at level `error` with `{recordId, tenantId, errorRowCount, err}`. Import outcome stays `completed` (rows persisted; the loss is only the per-row error detail download), and the response sets `errorCsvAvailable: false`.
- Admin sees the result card with error counts but no "Download error CSV" link. Admin can re-upload the same CSV to regenerate the error rows (Phase 7 idempotency ensures committed rows skip; only failed rows are re-attempted). Re-upload regenerates the blob on success.
- Operators alert on `f6_error_csv_upload_failed` log rate > 0/min to detect Vercel Blob outages independently of the main import path.

**Alternatives rejected**:
- *Regenerate error CSV on-demand from audit log*: Phase 7 audit `rawRowExcerpt` field is truncated to 200 chars — insufficient to reconstruct full rows. Would require extending audit payload to full row, which is itself a PII duplication issue. Rejected (Q4 deliberation).
- *Redact PII in error CSV* (hash email, mask name): defeats the Excel-fix workflow purpose. Rejected (Q4 deliberation).
- *No persistence — serve once at completion screen*: admin loses access if they navigate away or refresh. Rejected (Q4 deliberation).

---

## ~~R7 — F4 "Pending refund review" badge~~ — DROPPED v1

**Status**: DROPPED per Clarifications Session 2026-05-15 post-critique Q2.

**Reason**: Volume too low to justify cross-module coordination at SweCham scale (1 tenant × ~50 events/yr × ~5-10 cancellations × few-linked-to-F4-invoice ≈ 1-3 cases/year). The original R7 design proposed a cross-cutting F4 column + UI badge + dismiss action + F4 barrel-exported `signalRefundReview` use-case + new audit event — which adds material complexity (migration 0141, F4 cross-module call, ~2-3 days impl, ongoing maintenance) for a feature that fires 1-3 times per year.

**Replacement workflow**: F6 CSV-import use-case still detects `Status: Attending → Cancelled` on re-upload, updates the registration's `payment_status = refunded`, credits back partnership/cultural quota, and emits cancellation audit (existing F6 audit event taxonomy). Admin manually reviews F6 audit log + F4 invoice list to identify cases needing manual refund via existing F4 Stripe flow. No F4 module changes. No `csv_import_refund_review_signalled` audit event. No migration 0141. No `invoices.refund_review_state` column.

**Re-eligibility for v1.x**: revisit if (a) chamber count grows materially, (b) cancellation rate proves significantly higher than 1-3/year, or (c) admin support tickets indicate "I forgot to refund a cancelled attendee" as a recurring problem. Original design above remains the reference if/when revisited.

---

## Summary of decisions

| # | Decision | NEEDS CLARIFICATION resolved? |
|---|---|---|
| R1 | Embedded-newline-in-quoted-cell parser relax (RFC 4180) | Yes — implementation detail of FR-011 |
| R2 | Presence-of-6-columns header heuristic (case-sensitive) | Yes — Q5 from `/speckit.clarify` |
| R3 | CSV formula injection mitigation on outbound error CSV + template | Yes — implicit security requirement |
| R4 | Title-case normalization for First+Last Name combine | Yes — implementation detail of FR-005 |
| R5 | Closed mapping table Notes → payment_status + pino aggregate on unknown | Yes — FR-008 |
| R6 | Vercel Blob private + 15-min signed URL + 30-day TTL sweep + access audit | Yes — Q4 from `/speckit.clarify` |
| R7 | ~~F4 "Pending refund review" badge~~ — DROPPED v1 (post-critique Q2) | Q3 original resolved but feature dropped at critique gate |

**All NEEDS CLARIFICATION items resolved.** Ready to enter Phase 1 (data-model.md, contracts/, quickstart.md, agent context update).
