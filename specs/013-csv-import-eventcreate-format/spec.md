# Feature Specification: CSV Import Primary Path + EventCreate Format Adapter

**Feature Branch**: `013-csv-import-eventcreate-format`
**Created**: 2026-05-15
**Status**: Draft
**Input**: User description: "อัพเดท Spec F6 EventCreate Integration ใช้ Import attendees from CSV เป็นหลัก. ตัวอย่าง CSV docs\\Attendee list"

---

## Clarifications

### Session 2026-05-15

- Q: Event linking flow — should the admin pre-create the event in Chamber-OS and select it on upload, OR enter inline, OR hybrid? → A: Pre-create event in Chamber-OS, then select from dropdown on upload (Option A — Chamber-OS is the SoR for events; CSV upload is post-event reconciliation)
- Q: Locked-field semantics for manual edits (FR-019) — automatic-on-edit / explicit-action / defer-to-v1.1? → A: Defer to v1.1; v1 semantics = re-upload always wins (Option C — admin manual edits during v1 are ad-hoc; observe production usage before adding lock complexity)
- Q: Cancellation cascade depth (US2 AS3 + FR-018) — registration-row only / auto-trigger F4 refund / configurable? → A: Registration-row only; do NOT auto-trigger F4 refund (Option A — admin always in the loop for money operations; UI surfaces "Pending refund review" badge in F4 invoice list)
- Q: Error CSV PII handling (FR-021) — persist as private Blob / regenerate from audit / redact / no-persist-serve-once? → A: Persist as private Vercel Blob with 30-day TTL + signed URL (15-min expiry) + access audit (Option A — matches F4 invoice PDF pattern; balances PDPA minimization with Excel-fix workflow usability)
- Q: EventCreate header signature heuristic (FR-001) — strict prefix / presence-of-required-columns / admin-selectable / auto-detect-with-confirm? → A: Presence-of-6-required-columns regardless of position (Option B — robust to EventCreate adding new columns; fall back to generic path if any required column missing)

### Session 2026-05-15 (post-critique)

- Q: PDPA consent storage strategy (FR-009) — raw text / boolean only / drop entirely / hash+classification? → A: Boolean only — `attendee_pdpa_consent_acknowledged BOOLEAN NULL` (Option B). Parse classification at import time: `true` if text contains "hereby acknowledge", `false` if contains "do not consent", `null` otherwise. PDPA minimization principle; no DPO process gate needed because data over-collection is avoided by design.
- Q: F4 cross-cutting fallback (FR-018 cancellation cascade) — graceful degrade / block-on-F4 / anti-pattern / drop entirely? → A: Drop entirely — F4 "Pending refund review" badge feature removed from v1 (Option D). Volume too low to justify cross-module coordination (1 tenant × ~50 events/yr × ~5-10 cancellations × few-linked-to-F4-invoice = ~1-3 cases/yr). F6 still detects cancellation + updates registration + credits back quota + emits audit; admin reconciles F4 invoices manually via audit-log search. Cuts migration 0141, F4 module barrel export, F4 UI changes. Aligns with Constitution X (Simplicity / YAGNI).
- Q: Rollback trigger criteria — sub-flag + threshold / manual-only / auto-on-alert / no plan? → A: Sub-flag `FEATURE_F6_EVENTCREATE_ADAPTER` + 7-day issue threshold (Option A). Add explicit rollback criterion in spec § Success Criteria: ">5 admin support issues attributable to F6.1 in first 7 days post-launch → flip `FEATURE_F6_EVENTCREATE_ADAPTER=false`; Phase 7 generic-CSV path remains operational so admin workflow doesn't break entirely." Safety net during the post-launch observation window.
- Q: Match-preview staleness handling — accept + <5min doc / re-run at commit / lock member table / no handling? → A: Accept staleness; preview reflects DB state at preview-time; SC-005 ±2 rows accuracy assumes admin commits within ~5 minutes of preview (Option A). Result summary displays a "DB state changed during preview→commit window" diff note when actual outcome differs from preview. No row-locking, no re-run-on-commit overhead. Aligns with chamber-scale single-admin workflow (no concurrent F3 mutations expected during a normal import session). **(Note: superseded by Q5 — match-preview feature dropped entirely.)**
- Q: US3 (match preview) + US4 (CSV template) — keep in v1 or drop? → A: Drop both from v1. US3 value low for 1-tenant + 1-admin scale (no race, EventCreate export trusted, Phase 7 post-commit summary sufficient). US4 has no v1 user persona (TSCC uses EventCreate export verbatim per US1; non-EventCreate workflows deferred to F6.2). Cuts ~4 implementation days + ~12 tests + 3 components + 1 contract file + dry-run tx code path + 5-phase wizard simplified to 3-phase. v1 MVP = US1+US2+US5. Q4 (staleness handling) becomes moot. Aligns with Q2 cut philosophy: "no recycling work, drop unneeded surfaces early."

## Context

F6 (`012-eventcreate-integration`) shipped Phase 7 (User Story 5 — CSV import) as a secondary fallback path positioned for "non-EventCreate tenants + backfill/recovery for EventCreate tenants." That positioning rested on the assumption that EventCreate's webhook would be the daily-driver via Zapier.

**The assumption broke.** EventCreate's REST API is locked behind their **Enterprise tier paywall** (out of reach for chamber-size tenants like TSCC with ~131 members). Without API access, Zapier — and any other middleware (Make.com, n8n, Pipedream) — cannot reach EventCreate to trigger webhook deliveries. The Phase 6 webhook endpoint `/api/webhooks/eventcreate/v1/{tenantSlug}` has no data source for EventCreate tenants.

**The reality**: chambers that use EventCreate manually click "Export Guestlist as CSV" in EventCreate's dashboard, receive a 29-30 column CSV with embedded multi-line cells, and need to upload it into Chamber-OS. The Phase 7 CSV importer was built against a synthetic 5-column schema (`event_external_id`, `event_name`, `event_start`, `attendee_email`, `attendee_name`) that does **not** match what EventCreate actually exports.

**This feature repositions CSV import as the primary ingest path for all tenants** and adds EventCreate-format awareness so admins can upload the raw export without manual reshaping. Reference CSVs are committed under `docs/Attendee list/` — two real exports from SweCham events:
- `EventCreate_Guestlist-grant-thornton-workshop.csv` (56 attendees, 29 columns)
- `EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` (84 attendees, 30 columns)

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload raw EventCreate export without reshaping (Priority: P1)

As a chamber admin, after running an event on EventCreate I want to download the platform's native "Guestlist" CSV export and upload it directly into Chamber-OS so that all attendees are reflected against members, quotas, and audit history — **without** having to rename columns, combine first/last names, strip `mailto:` prefixes, infer payment status from notes, or split multi-line address cells by hand.

**Why this priority**: This is the **primary daily-driver workflow** for every chamber that uses EventCreate. Phase 7's generic CSV format requires manual reshaping per upload, which costs ~20-30 minutes per event and is error-prone (admins forget to map columns, miscount quotas because cancelled attendees were left in, etc.). Without P1 support, EventCreate-using chambers cannot realistically use Chamber-OS as their membership system of record.

**Independent Test**: Pre-create a Chamber-OS event "SweCham Annual General Meeting 2026" (date 2026-03-20) under `/admin/events/new`, then navigate to `/admin/events/import` and upload `docs/Attendee list/EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` verbatim. After the admin selects the pre-created event from the dropdown (filename-hint should pre-suggest it via fuzzy match), the import processes all 84 rows, correctly identifies "Attending" status, infers payment from the Notes field, and produces a result summary equivalent to what Phase 7 would have produced from a pre-shaped synthetic CSV.

**Acceptance Scenarios**:

1. **Given** the admin opens `/admin/events/import` and uploads `EventCreate_Guestlist-grant-thornton-workshop.csv`, **When** the system detects EventCreate header signature (`Basic Info,Status,First Name,Last Name,Email,...`), **Then** the import wizard switches to EventCreate mode, parses all 29 columns, displays a preview of the first 10 attendees with `First Name + Last Name` combined into a single Attendee Name column, and prompts the admin for event-level metadata (event name, event start date) that the CSV does not carry.
2. **Given** the EventCreate CSV contains multi-line address cells inside quoted fields (CSV row spans multiple physical lines), **When** the parser processes those rows, **Then** the multi-line content is preserved as a single field value and the row is treated as one attendee record, not several broken rows.
3. **Given** the EventCreate CSV contains attendees with `Status = "Cancelled"`, `Status = "No Show"`, and `Status = "Attending"`, **When** the import runs, **Then** only `Attending` rows count against member quotas and create registration records; non-attending rows are reported in the result summary with a clear reason ("Skipped: Status=Cancelled") but do not consume quota or pollute member match counts.
4. **Given** an attendee row has `Email = "mailto:lars.svensson@midsummer.se"`, **When** the email is matched against members, **Then** the `mailto:` prefix is stripped before comparison and the canonical lowercase email is used for both match logic and the registration record.
5. **Given** an attendee row's `Notes = "Paid"` or `"invoice sent"` or `"verifying payment"`, **When** the row is processed, **Then** the registration record's payment status is inferred as `paid`, `paid`, or `pending` respectively; absence of a payment hint defaults to `unknown`.

---

### User Story 2 - Re-upload an updated EventCreate export without creating duplicates (Priority: P1)

As a chamber admin, after the event is over I want to re-upload the same EventCreate Guestlist export (which may have been updated with check-in status, cancellations, or payment confirmations) and have Chamber-OS recognize previously-imported attendees as duplicates while still applying any state changes (e.g., a `pending` payment that is now `paid`).

**Why this priority**: EventCreate exports change between the registration close date and the post-event final report. Admins re-export and re-upload routinely — often 2-3 times per event — to keep payment status and check-in attendance current. Without re-upload safety, each re-upload would create duplicate registrations or fail the entire batch.

**Independent Test**: Upload the same `EventCreate_Guestlist-grant-thornton-workshop.csv` twice. First upload creates 56 registrations. Second upload reports `rowsAlreadyImported = 56`, `rowsProcessed = 0` (no new state changes) OR `rowsProcessed = N` where N is the number of rows whose payment status changed between exports.

**Acceptance Scenarios**:

1. **Given** an EventCreate CSV has been imported once, **When** the same CSV is uploaded again with no row-level changes, **Then** the result summary shows `rowsAlreadyImported = 56` and `rowsProcessed = 0`, and no duplicate registrations are created in the database.
2. **Given** an attendee's `Notes` field changed from `verifying payment` to `Paid` between the first and second export, **When** the second CSV is uploaded, **Then** the existing registration's payment status updates from `pending` to `paid` and the change is audit-logged with the source row hash, while the row is reported in `rowsProcessed` (not `rowsAlreadyImported`).
3. **Given** a previously-imported attendee's `Status` changes from `Attending` to `Cancelled` between exports, **When** the second CSV is uploaded, **Then** the registration row's `payment_status` is set to `refunded` (if previously `paid`), the partnership/cultural quota is credited back to the matched member, and an audit entry records the cancellation. The system does NOT automatically refund any F4 invoice or Stripe charge; admin manually reviews the F6 audit log + F4 invoice list to identify cases needing refund. F4 cross-cutting badge feature dropped from v1 scope (see Clarifications Session 2026-05-15 post-critique Q2).

---

### ~~User Story 3~~ — DROPPED v1

Match preview before commit — dropped per Clarifications Session 2026-05-15 post-critique Q5. Phase 7's post-commit result summary is sufficient at 1-tenant + 1-admin scale; preview value insufficient to justify ~3 days impl + dry-run tx complexity + dialog UI. Revisit in v1.x if usage patterns demand pre-commit confidence (e.g., support tickets indicate accidental imports).

---

### ~~User Story 4~~ — DROPPED v1

CSV template download — dropped per Clarifications Session 2026-05-15 post-critique Q5. No v1 user persona (TSCC uses EventCreate export verbatim per US1; non-EventCreate workflows deferred to F6.2). Revisit in v1.x if/when Eventbrite/Luma/Meetup native connectors land and admins start building CSVs from scratch.

---

### User Story 5 - See and reuse history of past imports (Priority: P2)

As a chamber admin, I want to see a list of my past CSV imports — when each ran, who ran it, which event it was for, how many rows landed vs. failed, and download a CSV of just the failed rows so I can fix them in Excel and re-upload — so that I can recover from partial failures and audit my own activity.

**Why this priority**: Operational visibility. Today, if 6 of 84 rows fail during import, the admin sees the count in the result summary but cannot retrieve those 6 rows without re-running the entire import (and getting back fresh row numbers that don't match the original file). Import history + downloadable error reports closes this gap and makes the workflow forgiving.

**Independent Test**: Run 3 imports for different events. Navigate to `/admin/events/import/history`. The list shows 3 rows, most-recent first, each with event name, timestamp, admin name, rowsProcessed/rowsAlreadyImported/errorRows counts, and a "Download error CSV" link on any row that had failures.

**Acceptance Scenarios**:

1. **Given** the admin has run at least one import in the last 30 days, **When** they navigate to `/admin/events/import/history`, **Then** the page lists those imports in reverse chronological order with: event name, event start date, import run timestamp, admin who ran it, total rows, processed count, skipped count, error count, and a downloadable "error rows only" CSV link (disabled if zero errors).
2. **Given** the admin clicks "Download error CSV" on a past import with 6 error rows, **When** the file downloads, **Then** the file contains a header row + the 6 original failed rows verbatim + a final column `_error_reason` explaining why each row failed; the file is structurally a valid CSV that can be re-uploaded after correction.
3. **Given** an import is still in progress (long-running CSV), **When** the admin navigates to history, **Then** the in-progress import is shown with a "Running…" status.

---

### Edge Cases

- **EventCreate adds a new column in a future export**: the parser must tolerate unknown extra columns (skip them) rather than reject the upload, so a chamber on Chamber-OS v1 can keep ingesting CSVs even after EventCreate updates their export format.
- **An admin uploads a CSV from a non-EventCreate source (Eventbrite, Excel)**: the parser must still accept the generic Phase 7 canonical schema (`event_external_id`, `event_name`, `event_start`, `attendee_email`, `attendee_name`) so existing F6 users are not regressed.
- **Admin uploads the wrong file type** (e.g., `.xlsx` exported from Excel without saving as CSV): the system must detect this and explain "This looks like Excel — please save as CSV first" rather than fail with a cryptic parser error. Optional v1.1: client-side conversion via SheetJS so `.xlsx` is accepted directly.
- **Multi-line address with `\r` only** (old Mac line endings inside quoted cells): parser must treat `\r`, `\n`, and `\r\n` consistently as newlines inside quoted strings.
- **Two attendees in the same CSV have the same email** (e.g., spouse registered under same email): both rows must process as separate registrations with distinct `attendee_external_id` values from EventCreate's `Attendee ID` column.
- **EventCreate `Email` column contains both `mailto:user@example.com` and `user@example.com` patterns in different rows of the same file**: parser must normalize both to `user@example.com` consistently.
- **PDPA consent missing for a row** (`Personal Data Protection Consent` cell is empty or contains "I do not consent..."): the row still imports because chamber operational need overrides marketing consent, but the consent value is captured in the registration record's metadata so the chamber can later filter out non-consenting members from marketing broadcasts (F7).
- **CSV exceeds 5 MiB or 1,000 rows**: existing Phase 7 limits apply — admin sees a clear "file too large, please split into multiple files" message; v1.1 may relax these caps.
- **Status column has values Chamber-OS doesn't recognize** (e.g., `Waitlisted`): row is skipped with reason "Skipped: Status=Waitlisted (not a recognized attending status)" rather than imported, so quota is not accidentally consumed.
- **Re-upload after some rows were manually edited in Chamber-OS UI** (admin fixed a typo on a registration): for v1, the re-upload **does** overwrite the manual edit with the CSV-derived value (re-upload always wins per Q2 resolution); the audit trail records both changes so the admin can trace history. Documented workflow: admins make manual edits AFTER their final CSV re-upload of an event.
- **Admin cancels mid-import** (browser close / network interruption / page refresh after Confirm): there is NO graceful admin-cancel mechanism in v1. The use-case completes the current batch even if the admin's browser disconnects (per Phase 7 NEW-A tentative-buffer pattern, partial commits are atomic at the batch level). Admin returns to import history page to see whether the import committed or timed out; if `outcome = 'completed'` or `outcome = 'timeout'`, rows are persisted and admin can re-upload safely (idempotency makes re-upload deterministic).

---

## Requirements *(mandatory)*

### Functional Requirements

**Format detection & event metadata**

- **FR-001**: System MUST detect EventCreate CSV format by checking whether the header row contains ALL SIX of these required columns by **case-sensitive exact match** (the column names must appear verbatim — EventCreate emits these names with deterministic capitalization verified across the committed real fixtures): `Basic Info`, `Status`, `First Name`, `Last Name`, `Email`, `Attendee ID`. Position-independent (column order does not matter). When all six are present, the parser switches to EventCreate adapter mode automatically — admin does not have to declare the format. The presence-based heuristic is robust to EventCreate adding new columns before, between, or after the canonical six in future export versions. When any required column is missing OR any required name does not match case-sensitively, the system falls back to the generic CSV path (FR-002) which will then either succeed (if generic schema matches) or surface a clear header-validation error. Case-sensitivity is deliberate: a future EventCreate capitalization drift (e.g., `basic info` lowercase) MUST trigger fallthrough so the product team is notified via the `eventcreate_csv_adapter_mode_detected_total{format="generic_csv"}` metric drop rather than silently consuming a potentially-malformed header.
- **FR-002**: System MUST also accept the existing Phase 7 generic canonical schema (`event_external_id,event_name,event_start,attendee_email,attendee_name,...`) when the header does NOT match EventCreate's signature, so non-EventCreate workflows continue to work unchanged.
- **FR-003**: System MUST require the admin to select an existing Chamber-OS event from a dropdown before processing an EventCreate-format CSV (Chamber-OS is the source of truth for events; CSV upload is post-event reconciliation). The selected event's metadata (event name, event start date, event category, event external ID) is merged into every row as if it had been a per-row column. If no matching event exists, the event-picker MUST provide an **inline "Create new event" modal** (opens above the current import workflow, captures event name + start date + category + optional external ID, invokes the `createEvent` Application use-case at `src/modules/events/application/use-cases/create-event.ts` — admin RBAC + Zod validation + `event_created` audit emit inherited — then closes and auto-selects the newly-created event in the dropdown). On validation failure (zod errors, duplicate `external_id`, etc.), the modal MUST stay open with inline field-level error messages; admin corrects + retries. Admin does NOT have to navigate away from the import page — reduces round-trip friction for the daily-driver workflow per Clarifications post-critique P8.
  - **Implementation note (2026-05-15 post-T026)**: Spec originally referenced `create-event.ts` and "same use-case as `/admin/events/new`". At F6.1 design time neither artefact existed — events were only created via webhook ingest (Zapier→EventCreate) which `project_eventcreate_api_gated` memory documents as blocked behind EventCreate's Enterprise-tier API. T026 introduced BOTH the use-case (`createEvent` ~210 LOC, `Source: 'admin_manual'`, new audit type `event_created` via migration 0144) AND the POST `/api/admin/events` route (admin-only, 30/hr rate-limit, surface-disclosure 404 for non-admin) — modal POSTs JSON to that route rather than calling the use-case directly via RPC. Functional equivalence preserved (admin RBAC + Zod + audit); routing pattern aligns with REST conventions across `/api/admin/**`. There is no separate `/admin/events/new` page in v1 — the inline modal IS the canonical event-creation surface.
- **FR-004**: System MUST suggest an event default in the dropdown by parsing the uploaded filename. Algorithm: (1) strip the `EventCreate_Guestlist-` prefix + `.csv` suffix, (2) replace hyphens with spaces, (3) title-case the result → produce a search string (e.g., `EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` → "Swecham Annual General Meeting 2026"). (4) Score each candidate event's `name` against the search string using **Sørensen–Dice coefficient on character bigrams** (a standard string-similarity metric, no library needed — ~30 LOC). (5) If the top-scoring candidate has similarity ≥ **0.65**, pre-select it in the dropdown; otherwise leave the dropdown unselected. Threshold 0.65 chosen empirically against the committed fixtures — admin can always override by manually selecting from the dropdown. The fuzzy-match is convenience-grade — false-positives don't write data (admin confirms before submit).

**Per-row field mapping & cleaning**

- **FR-005**: System MUST combine EventCreate's separate `First Name` and `Last Name` columns into a single `attendee_name` field with normalized capitalization (e.g., title case, preserving compound names like "ANDERSON-SMITH" semantically); the `Basic Info` column is not used for matching because its capitalization is inconsistent.
- **FR-006**: System MUST strip the `mailto:` prefix from email values if present, lowercase the local part and domain, and use the cleaned email for both match logic and the registration record.
- **FR-007** (revised 2026-05-18 — Option B+): System MUST mirror EventCreate's `Status` column directly into `event_registrations.payment_status` so chamber pre-event workflows (F7 broadcasts, F8 at-risk scoring) can see registrations the moment they exist upstream — not after the host individually flips each to `Attending` (which the user confirms is unreliable). Mapping:
  - `Attending` → persists with `payment_status='paid'` (COUNTS toward quota per **FR-019**)
  - `Pending` → persists with `payment_status='pending'` (does NOT count toward quota)
  - `Cancelled` / `Canceled` → routed via **FR-018** cancellation cascade (`payment_status='refunded'` on existing paid row + quota credit-back)
  - `Waitlisted` → persists with `payment_status='waitlisted'` (does NOT count toward quota)
  - `No Show` / `NoShow` / `No-Show` → persists with `payment_status='no_show'` (does NOT count toward quota)
  - Anything else (blank, typo, custom label) → reported in `rowsSkipped` as `"Skipped: Status=<value> (not a recognized status)"`; no registration row created.

  Re-uploads where Status has flipped (e.g., `Pending → Attending` after the host verifies payment) MUST be detected by the existing receipt-duplicate state-change probe and applied as an UPDATE to `payment_status`, surfaced in `rowsStateChanged`.

- **FR-008** (revised 2026-05-18 — Option B+): The previous Notes-cell `inferPaymentStatus` heuristic is **REMOVED**. EventCreate's `Notes` column in TSCC's real-world exports contains attendee IDs and free-text comments, NOT payment-status indicators (verified against the AGM 2026 and Swedish National Day 2026 fixtures). `Status` is the single source of truth for `payment_status` per FR-007. Adapters MUST NOT parse `Notes` for payment-status inference. The column is still recognised (no "unknown column" warning emitted) but ignored.

- **FR-019** (added 2026-05-18 — Option B+): Quota counting MUST use a strict allowlist on `payment_status`: only rows where `payment_status === 'paid'` OR `payment_status === 'free'` contribute to partnership / cultural quota. All other states (`pending`, `refunded`, `waitlisted`, `no_show`) are quota-neutral. Re-upload with a status flip that promotes a quota-neutral state to `'paid'` (e.g., `pending → paid` via Status change in EventCreate) MUST update both `payment_status` AND the `counted_against_partnership` / `counted_against_cultural_quota` flags consistently in the same transaction.
- **FR-009**: System MUST classify each row's `Personal Data Protection Consent` value into a boolean at import time and store it as `event_registrations.attendee_pdpa_consent_acknowledged BOOLEAN NULL`. Classification rules: `true` if cell content contains the substring "hereby acknowledge" (case-insensitive); `false` if contains "do not consent" (case-insensitive); `null` if missing / `-` / `–` / unrecognized text. The raw consent text is **NOT** stored — PDPA minimization principle (Article 5(1)(c) GDPR / PDPA Section 24 purpose limitation). A `null` or `false` value does NOT block import; F7 broadcast filter consumes `WHERE attendee_pdpa_consent_acknowledged = true` to determine marketing-eligible recipients. See Clarifications § Session 2026-05-15 (post-critique).
- **FR-010**: System MUST use EventCreate's `Attendee ID` value (format `16568206-1`) as the canonical `attendee_external_id`; this ensures re-uploads correctly identify duplicates.

**Parser robustness**

- **FR-011**: System MUST correctly parse CSV rows whose cells contain embedded line breaks (`\r`, `\n`, or `\r\n`) inside double-quoted strings — these are valid per RFC 4180 and EventCreate emits them routinely for multi-line addresses. Rows must be treated as one record per logical row, not split on internal line breaks.
- **FR-012**: System MUST tolerate unknown columns in EventCreate exports without rejecting the upload; columns beyond the recognized canonical set are silently ignored but logged for product-team review of future schema additions.
- **FR-013**: System MUST preserve all existing Phase 7 parser correctness guarantees (BOM stripping, CRLF tolerance, comma separator only, double-quote `""` escape, rejection of semicolon separators or trailing commas, 5 MiB file cap, 1,000 row cap pre-v1.1) for both EventCreate and generic schemas.

**Match preview**

- ~~**FR-014**~~ — Match preview dry-run — DROPPED v1 (US3 cut per Clarifications Session 2026-05-15 post-critique Q5).
- ~~**FR-015**~~ — Drill into unmatched from preview — DROPPED v1 (US3 cut).
- ~~**FR-016**~~ — Cancel from preview with zero side effects — DROPPED v1 (US3 cut).

**Re-upload safety & idempotency**

- **FR-017**: System MUST treat a re-uploaded EventCreate row as a duplicate by canonical key `(tenant_id, source='eventcreate_csv', sha256(event_external_id NUL attendee_email_lowercase NUL registered_at_or_event_start))`, matching the existing Phase 7 idempotency contract.
- **FR-018**: System MUST detect and apply per-row state changes between re-uploads — specifically, if the `Notes`-inferred payment status, the `Status` value, or the company name changes, the corresponding registration record MUST be updated and the change MUST be audit-logged with the new row hash. When `Status: Attending → Cancelled` is detected, the system MUST set `payment_status = refunded` (if previously `paid`), credit back the partnership/cultural quota to the matched member, and emit a cancellation audit event — but MUST NOT trigger any F4 invoice refund or Stripe charge reversal (admin always remains in the loop for money operations). F4 invoice reconciliation is out of v1 scope (see Clarifications § Session 2026-05-15 post-critique Q2 — F4 badge feature dropped due to low volume); admin manually reviews F6 audit log + F4 invoice list to identify cases needing manual refund.
- **FR-019**: For v1, re-upload always wins over manual UI edits — there is no field-level lock semantics. Each successful CSV import overwrites all registration fields covered by the CSV (`payment_status`, `attendee_company`, `ticket_type`, `match_type`, etc.) with the CSV-derived values. The audit trail records both the manual edit and the subsequent CSV overwrite so an admin can trace the change history. A future v1.1 may introduce explicit field locking; for v1 the documented workflow is: admins make manual edits AFTER their final CSV re-upload of an event, not before. (Resolved 2026-05-15 — see Clarifications § Session 2026-05-15)
- **FR-019a**: System MUST compute an `attendee_fingerprint` at import time over the parsed CSV's attendee emails. Algorithm (deterministic, reproducible across implementations): (1) Filter rows to `Status = "Attending"` only. (2) Extract `attendee_email` from each row. (3) Strip `mailto:` prefix per FR-006 + lowercase + trim each email. (4) Sort the resulting list lexicographically (ASCII byte order). (5) Join with the **NUL byte** (`\0`) as separator. (6) Compute SHA-256 of the UTF-8-encoded joined string. (7) Take the **first 16 hex characters** of the digest (64-bit truncation; 2^32 imports/tenant for 50% collision probability per birthday paradox — astronomical at SweCham scale). (8) Store as the `attendee_fingerprint` column. **Edge case (0 Attending rows)**: if step 1 yields an empty list, the fingerprint MUST be NULL (not the empty-string hash) — a 0-row import is operationally an admin mistake (wrong file? all-cancelled event?) AND has no attendees to collide on, so the safety net (FR-019b) is skipped for that import. The fingerprint MUST be stored in `csv_import_records.attendee_fingerprint` for retrospective queries (closes critique pass-2 X-R2-1 — event-mismatch safety net).
- **FR-019b**: BEFORE committing the import, the system MUST query `csv_import_records` for matching fingerprints within the last 30 days under the same tenant, EXCLUDING the currently-selected event. **Boundary semantics**: the time window is **strictly greater than `NOW() - INTERVAL '30 days'`** (i.e., a prior import at exactly 30 days + 1 second ago is OUT-OF-WINDOW; at 29 days 23 hours 59 minutes 59 seconds ago is IN-WINDOW). Query also excludes records where `attendee_fingerprint IS NULL` (the 0-row edge case from FR-019a). If at least one such match exists AND the request did NOT include `force_proceed: true`, the system MUST return outcome `event_mismatch_warning` with the list of prior matching imports (each item: `recordId`, `eventId`, `eventName`, `uploadedAt`). NO rows are written. The admin sees a warning dialog: "These attendees were imported to event '{prior.eventName}' on {prior.uploadedAt}. You are about to import to event '{currentEvent.name}'. Continue anyway?" with default focus on "Cancel"; the admin can click "Continue anyway" which re-submits the form with `force_proceed: true` and the import proceeds normally. This guards against the admin-error scenario where the wrong event is selected in the dropdown — preventing accidental double-counting of attendees across two events. **Performance budget**: the lookup query p95 < 100ms on the indexed `idx_csv_import_records_tenant_fingerprint_uploaded_at` (closes critique CHK034).
- **FR-019c**: When the admin overrides the warning (re-submits with `force_proceed: true`), the use-case MUST emit a `csv_import_event_mismatch_overridden` audit event with payload `{ actorUserId, recordId, currentEventId, priorRecordIds: [...], priorEventIds: [...] }` for forensic trail. The import then proceeds via the normal commit path.

**Import history & error report**

- **FR-020**: System MUST persist a record of every import attempt (admin user, timestamp, event linked, rows processed/already-imported/error/skipped counts, outcome `completed`/`timeout`/`partial_failure`) with 5-year retention to match the broader F6 audit-trail policy.
- **FR-021**: System MUST provide a "Download error CSV" action per past import that contains the failed rows verbatim + a final `_error_reason` column explaining each failure. The error CSV MUST be stored in a private Vercel Blob bucket (not publicly accessible by URL guessing); access MUST be via a server-issued signed URL with 15-minute expiry on each download click. The Blob MUST auto-delete after 30 days via a TTL sweep (PDPA data-minimization). Each download MUST emit an audit event recording the admin who downloaded, the timestamp, and the import record ID, so PII access to historical attendee data is fully audited. After 30 days the import history still shows the import metadata + counts, but the "Download error CSV" link is disabled with explanation "Error CSV expired after 30 days per data-retention policy."
- **FR-022**: System MUST display import history at `/admin/events/import/history` with: event name, event start date, import timestamp, admin who ran it, all 4 count buckets, outcome status, and the error-CSV download link; the page MUST paginate when more than 30 imports exist.

**CSV template download**

- ~~**FR-023**~~ — CSV template download — DROPPED v1 (US4 cut per Clarifications Session 2026-05-15 post-critique Q5).

**Audit & compliance**

- **FR-024**: System MUST emit `csv_import_completed` audit events with the full result summary (counts + duration + timedOut flag + `sourceFormat` from this feature) and `csv_import_row_failed` audit events per failed row (with FailureStage taxonomy from Phase 7). This feature introduces **3 new audit event types** documented in `contracts/audit-port.md`: `csv_import_error_csv_downloaded` (signed-URL access — Q4), `csv_import_cross_tenant_probe` (high-severity isolation breach attempt — Constitution Principle I clause 4), and `csv_import_event_mismatch_overridden` (admin override of FR-019b safety net — `warn` severity, added by critique pass-2 X-R2-1 alongside FR-019c). The originally-planned `csv_import_refund_review_signalled` event was dropped at the post-critique Q2 review alongside the F4 cross-cutting feature. All inherit F6's 5-year retention.
- **FR-025**: System MUST log the EventCreate-vs-generic format detection result on each upload so the product team can track adoption of the EventCreate adapter path over time. Additionally, the import-history table (FR-022) MUST display the `sourceFormat` column visibly — existing Phase 7 generic-CSV users see "Generic CSV" badge on past uploads, EventCreate-format users see "EventCreate" badge, providing organic onboarding for users transitioning between formats without requiring a release-notes blast.

### Key Entities *(include if feature involves data)*

- **CSV Import Record**: Represents one upload attempt. Attributes: id, tenant_id, admin_user_id, uploaded_at, event_id (foreign key to F6 events), source_format (`eventcreate_csv` / `generic_csv`), rows_total, rows_processed, rows_already_imported, rows_skipped (Status filter), rows_failed, outcome (`completed` / `timeout` / `partial_failure`), duration_ms, error_csv_blob_url (nullable — null when zero error rows OR after 30-day TTL expiry), error_csv_expires_at (nullable, 30 days after import for TTL sweep). Relates to F6 `events` and to per-row `event_registrations`.
~~**Locked Field Marker**~~ — Removed v1 (Q2 resolved 2026-05-15: defer to v1.1, re-upload always wins). May be re-introduced in v1.1 if production usage indicates demand.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can upload `EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` (84 rows, 30 columns, embedded multi-line addresses) verbatim and complete the full import workflow in **under 3 minutes total wall-clock**. Measurement window: **starts** at the admin's first click of the "Upload CSV" or "Choose file" button on `/admin/events/import`; **ends** when the result card renders with the completion summary (measured client-side via `performance.now()` between the file-input change event and the result-card mount event). The 3-minute budget includes admin reading + decision steps (event-picker selection, preview review, click Confirm) — measured against the SweCham AGM 2026 fixture as the canonical 84-row baseline.
- **SC-002**: 100% of rows with `Status = "Attending"` in a valid EventCreate export land as registrations after a single click of "Confirm import," with 0 rows requiring manual reshaping before upload.
- **SC-003**: Re-uploading the same EventCreate CSV with no row changes reports `rowsAlreadyImported = N` (where N is the row count of the first upload's `rowsProcessed`) and `rowsProcessed = 0`, with no duplicate registrations created.
- **SC-004**: Re-uploading an EventCreate CSV where some rows have changed payment status (Notes column updated from "verifying payment" → "Paid") correctly updates only the changed rows and reports them in `rowsProcessed`, while unchanged rows are reported in `rowsAlreadyImported`.
- ~~**SC-005**~~ — Match preview accuracy — DROPPED v1 (US3 cut; criterion moot).
- **SC-006**: Admin can download an "error rows only" CSV from a past import and re-upload it after correction; ≥95% of failed rows succeed on the second attempt when the failures were data-quality issues (typos, missing emails).
- ~~**SC-007**~~ — Template self-consistency — DROPPED v1 (US4 cut; criterion moot).
- **SC-008**: TSCC admin completes the first EventCreate CSV import within 5 minutes of starting it, without requiring engineer intervention (binary outcome, measurable from `csv_import_records.outcome = 'completed'` for the first row keyed `(tenantId='swecham', actorUserId=<admin>)` post-launch — recast for 1-tenant scale per critique pass-2 P-R2-6). Operational signals tracked via `eventcreate_csv_adapter_mode_detected_total` OTel metric (adoption) + `csv_import_event_mismatch_overridden` audit (safety net hit rate) for ongoing tuning.

### Rollback Plan

- **Sub-flag**: `FEATURE_F6_EVENTCREATE_ADAPTER` (separate from the Phase 6 master flag `FEATURE_F6_EVENTCREATE`). Defaults to `true` at launch. When flipped to `false`, the EventCreate adapter path (FR-001 detection + FR-005-FR-010 adapter mode) is disabled — admin uploads are still processed via Phase 7's generic-CSV schema; the workflow degrades but does not fail entirely.
- **Auto-trigger criterion**: if > 5 admin support requests in the first 7 days post-launch are **attributable to F6.1** (defined as: the support request explicitly references a CSV-import surface — adapter detection, event-picker, import button, history page, error-CSV download, or warning dialog — AND the maintainer cannot resolve via documentation alone, requiring a code-level fix or workaround), flip the sub-flag OFF immediately while engineering investigates. Re-enable after root-cause + fix lands. Maintainer-discretion at chamber scale; logged in retrospective doc post-launch.
- **Manual trigger**: maintainer may flip the sub-flag at any time based on OTel signals (e.g., `eventcreate_csv_adapter_mode_detected_total{format="eventcreate_csv"}` drop to 0 unexpectedly, `csvImportAuditEmitFailed` rate elevated, etc.).
- **Recovery**: re-enabling the sub-flag is zero-downtime — no migration rollback needed; users immediately get the adapter path back.

---

## Assumptions

- **EventCreate export format is reasonably stable**: while EventCreate may add new columns over time, the core columns (`Status`, `First Name`, `Last Name`, `Email`, `Attendee ID`, `Notes`, `Company Name`, `Registration Category`) will remain present and named consistently for the v1 of this feature. The parser tolerates unknown extra columns gracefully (FR-012) but assumes the recognized columns retain their names.
- **Chamber admins still operate within their EventCreate tenant**: the feature assumes admins continue to use EventCreate as their event-registration UI; this feature only changes how their export reaches Chamber-OS, not the upstream platform choice.
- **Phase 7 parser limits remain in v1**: 5 MiB file cap, 1,000 row cap, no background-job queue. Larger imports (>5k rows, multi-event batches in one file) are F6.2 backlog.
- **Generic CSV path is unchanged**: chambers that currently upload non-EventCreate CSVs continue to do so; this feature adds an EventCreate-aware code path alongside the generic path, not in place of it.
- **PDPA consent is captured but does not block import**: chambers need attendance data for operational purposes (quota tracking, F4 invoicing) regardless of marketing consent; the consent value is recorded for downstream filtering by F7 broadcast (FR-009).
- **Existing F6 webhook endpoint remains available** for future non-EventCreate auto-ingest sources (Eventbrite, Luma, Meetup native APIs); this feature does not deprecate that endpoint, but explicitly does NOT add new auto-ingest sources in v1.
- **Filename hint heuristic is best-effort**: FR-004's filename → event name suggestion is convenience-grade; the admin always confirms or overrides before the upload commits.
- **Existing Phase 7 audit/observability scaffolding is reused**: `csv_import_completed` + `csv_import_row_failed` audit event types, `csvImportCompleted` + `csvImportDurationSeconds` + `csvImportRateLimitFallback` + `csvImportAuditEmitFailed` OTel counters, rate-limit (5/hr per (tenant, actor)), and tenant-isolation guarantees from F6 Phase 7 all carry forward unchanged.

---

## Out of Scope (Explicit Non-Goals)

- **EventCreate native API integration**: locked behind EventCreate's Enterprise paywall; not pursued.
- **Eventbrite / Luma / Meetup native connectors**: deferred to F6.2 as separate features.
- **Background-job queue for >1,000-row imports**: deferred to F6.2.
- **Excel (.xlsx) native upload without prior CSV conversion**: deferred to F6.1.1 if demand warrants the SheetJS dependency.
- **Multi-event imports in a single file**: out of scope; each upload corresponds to exactly one event.
- **Real-time progress streaming during import**: the result summary appears at end of run, as in Phase 7.
- **Auto-creating members from non-member CSV rows**: non-matched attendees become `non_member` registrations only; admin must use F3 member-create flow to upgrade them.

---

## Open Questions (limit 3 per spec-kit guideline)

The following questions are marked for `/speckit.clarify` resolution before `/speckit.plan`:

1. ~~**Event linking flow** (FR-003)~~ — **Resolved 2026-05-15**: pre-create event in Chamber-OS + select from dropdown (see Clarifications § Session 2026-05-15)

2. ~~**Locked-field semantics for manual edits** (FR-019)~~ — **Resolved 2026-05-15**: defer to v1.1; v1 = re-upload always wins (see Clarifications § Session 2026-05-15)

3. ~~**Cancellation cascade depth** (US2 AS3 + FR-018)~~ — **Resolved 2026-05-15**: registration-row only; manual F4 refund via "Pending refund review" badge (see Clarifications § Session 2026-05-15)
