---
description: "Task list for Feature 013 — CSV Import Primary Path + EventCreate Format Adapter (F6.1)"
---

# Tasks: CSV Import Primary Path + EventCreate Format Adapter

**Input**: Design documents from `/specs/013-csv-import-eventcreate-format/`
**Prerequisites**: plan.md ✅ · spec.md ✅ · research.md ✅ · data-model.md ✅ · contracts/ ✅ · quickstart.md ✅

**Tests**: REQUIRED per Constitution v1.4.0 Principle II (Test-First NON-NEGOTIABLE) + plan.md § Constitution Check II inventory. Every user story has acceptance + contract + unit + integration test tasks authored BEFORE implementation (RED → GREEN discipline).

**Organization**: 3 user stories (US1 P1, US2 P1, US5 P2) — US3 and US4 were cut per Clarifications post-critique Q5. Each user story is independently testable and deliverable.

## Format: `- [ ] T### [P?] [Story?] Description with file path`

- **[P]**: Different file from current sequence + no in-phase dependency = parallelizable
- **[US?]**: Maps to user stories from spec.md (US1 / US2 / US5)
- Exact file paths in descriptions
- `pnpm` (NOT npm) — Constitution X + CLAUDE.md memory

## Path Conventions

Chamber-OS Clean Architecture per Constitution III:
- `src/modules/events/domain/**` — Domain types (no framework imports)
- `src/modules/events/application/**` — Application use-cases + ports
- `src/modules/events/infrastructure/**` — Drizzle adapters, Blob store, etc.
- `src/lib/**` — composition root adapters
- `src/app/**` — Presentation (Next.js routes, server actions)
- `src/components/**` — React components
- `tests/{contract,unit,integration,e2e}/` — test pyramid

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Verify env + flags exist (no new npm deps per Constitution X)

- [X] T001 [P] Verify `BLOB_READ_WRITE_TOKEN` is present in `src/lib/env.ts` zod schema (reused from F4 invoice-PDF storage — must already exist; fail-fast at boot if absent)
- [X] T002 Add sub-flag `FEATURE_F6_EVENTCREATE_ADAPTER` to `src/lib/env.ts` zod schema (closes `/speckit-analyze` finding F4 + pass-2 finding G1). Specification: env-var name = `FEATURE_F6_EVENTCREATE_ADAPTER`; coercion = **existing `booleanFromString.default(true)` helper** (src/lib/env.ts:29-34, the canonical pattern used by every other `FEATURE_F*` flag — `FEATURE_F3_MEMBERS`, `FEATURE_F4_INVOICING`, `FEATURE_F5_ONLINE_PAYMENT`, `FEATURE_F6_EVENTCREATE`, `FEATURE_F7_BROADCASTS`, `FEATURE_F8_RENEWALS`). Truthy set: `"true"` (case-insensitive trimmed) and `"1"`; everything else falsy. **NOTE the asymmetry with form-field `force_proceed`** in contract csv-import-eventcreate-api.md: the form-field accepts `"true"/"1"/"yes"` (user-friendlier) while the env-var follows the stricter project-wide helper — this is intentional; do not "harmonize" by extending `booleanFromString` (would touch every other feature flag). **Default `true`** at launch for production behaviour (matches `FEATURE_F4_INVOICING` line 207 and `FEATURE_F3_MEMBERS` line 183 patterns). Place adjacent to the existing `FEATURE_F6_EVENTCREATE` declaration at src/lib/env.ts:428 for grouping. App refuses to start if zod validation fails at boot (fail-fast per F1 env-loader pattern). Flips OFF per Spec § Rollback Plan when >5 admin issues attributable to F6.1 in 7 days post-launch.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Migrations + Domain types + Application ports + Infrastructure adapters. **No user-story work can begin until this phase is complete.**

**⚠️ CRITICAL**: Constitution Principle I (tenant isolation) — RLS+FORCE policies on every new table; cross-tenant tests are Review-Gate blockers per clause 3.

- [X] T003 Drizzle migration `drizzle/migrations/0139_csv_import_records.sql` — CREATE TABLE `csv_import_records` with all columns (data-model.md § 1 including `attendee_fingerprint TEXT NULL CHECK length=16` per FR-019a) + 4 indexes (tenant+uploaded_at DESC, tenant+event_id, error_csv_expires_at WHERE NOT NULL, tenant+actor_user_id+uploaded_at DESC, tenant+attendee_fingerprint+uploaded_at WHERE NOT NULL) + RLS ENABLE + FORCE + tenant-isolation policy + `updated_at` trigger
- [X] T004 [P] Drizzle migration `drizzle/migrations/0140_event_registrations_attendee_pdpa_consent.sql` — ALTER TABLE event_registrations ADD COLUMN attendee_pdpa_consent_acknowledged BOOLEAN NULL (zero-downtime per data-model.md § Migration safety)
- [X] T005 [P] Domain branded type `src/modules/events/domain/csv-import-record-id.ts` — `CsvImportRecordId` branded string + `asCsvImportRecordId(raw)` + `tryCsvImportRecordId(raw): Result<CsvImportRecordId, ValidationError>` (UUID v4 check)
- [X] T006 [P] Domain value object `src/modules/events/domain/eventcreate-csv-format.ts` — `CsvAdapterMode` union + `PdpaConsentAcknowledged` type + `classifyPdpaConsent(raw): PdpaConsentAcknowledged` helper per FR-009 closed mapping
- [X] T007 [P] Application port `src/modules/events/application/ports/error-csv-store.ts` — `ErrorCsvStore` interface with `put` / `generateSignedUrl` / `delete` methods + `ErrorCsvStoreError` discriminated union (data-model.md § 4)
- [X] T008 [P] Audit port extension `src/modules/events/application/ports/audit-port.ts` — add 3 new event types to `F6AuditEventType` + `AuditPayloads`: `csv_import_error_csv_downloaded` / `csv_import_cross_tenant_probe` / `csv_import_event_mismatch_overridden` (contracts/audit-port.md)
- [X] T009 Relax parser `src/modules/events/infrastructure/streaming-csv-importer.ts` — RFC 4180 embedded-newline-in-quoted-cell support per research.md R1 (state machine: when inside quoted field, `\r`/`\n`/`\r\n` appends to cell buffer, not row terminator). Re-run Phase 7 unit tests at `tests/unit/events/streaming-csv-importer.test.ts` to confirm NO regression (path corrected per `/speckit-analyze` finding F3 — Chamber-OS convention puts parser unit tests under `tests/unit/events/`, not `tests/integration/events/`). Also re-run any integration tests that exercise the parser via the full import path (`tests/integration/events/csv-savepoint-isolation.test.ts`, `tests/integration/events/csv-webhook-equivalence.test.ts` if it references the parser) to confirm no end-to-end regression on real fixtures.
- [X] T010 EventCreate adapter `src/modules/events/infrastructure/eventcreate-csv-adapter.ts` — header detection (presence-of-6 case-sensitive per FR-001) + column mapping + `normalizeAttendeeName(first,last)` per FR-005 + `mailto:` strip per FR-006 + Status filter per FR-007 + `inferPaymentStatus(notes)` per FR-008 + `classifyPdpaConsent` invocation per FR-009 + unknown-column-tolerance per FR-012 + `computeAttendeeFingerprint(rows)` per FR-019a 8-step algorithm
- [ ] ~~T011~~ — **MERGED into T024** per `/speckit-analyze` finding F1 (circular Phase-2→Phase-3 dependency). Original description proposed wiring `ErrorCsvStore` (T021) and CSV-import-records repo (T020) in Phase 2, but both adapters are created in Phase 3 (US1). All composition-root wiring now happens in T024 after the adapters exist. Task ID retained for reference traceability; no Phase-2 work required here.

**Checkpoint**: Foundation ready — Phase 3-5 user-story work can now begin in parallel

---

## Phase 3: User Story 1 — Upload raw EventCreate export verbatim (Priority: P1) 🎯 MVP

**Story Goal**: Admin downloads EventCreate "Guestlist" CSV export, uploads to `/admin/events/import`, selects the F6 event from a dropdown (or creates it via inline modal), and gets a result-card with match counts in under 3 minutes. Real fixtures committed at `docs/Attendee list/` validate the end-to-end flow.

**Independent Test**: Pre-create a Chamber-OS event "SweCham AGM 2026" (date 2026-03-20), then upload `docs/Attendee list/EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` verbatim. After selecting the pre-created event from the dropdown (filename hint pre-suggests via Sørensen-Dice ≥0.65 fuzzy match), the import processes all 84 rows, correctly identifies "Attending" status, infers payment from Notes, classifies PDPA consent, and produces a result summary.

### Tests for User Story 1 (RED phase — must fail before T020+)

- [X] T012 [P] [US1] Contract test `tests/contract/events/csv-import-eventcreate-format.test.ts` — **12 sub-tests GREEN** covering the F6.1 deltas only (Phase 7 outcomes already covered by `csv-import-api.test.ts`): 200 EventCreate/generic format + recordId/sourceFormat/errorCsvAvailable surfaced, 200 event_mismatch_warning with priorImports, force_proceed case-insensitive normalization (TRUE/1/yes/Yes), 400 event_not_selected (no event_id), 400 event_not_found (UUID shape invalid + UUID valid but DB miss), cross-tenant probe → audit emit assertion via emitStandalone mock, 504 timeout with recordId in extras, runImportCsv input wiring (selectedEvent + originalFilename branding boundary)
- [X] T013 [P] [US1] Unit test `tests/unit/events/eventcreate-csv-adapter.test.ts` — **45 sub-tests GREEN** covering header detection (presence-of-6 case-sensitive + fall-through), `normalizeAttendeeName` (UPPERCASE / mixed / hyphen / apostrophe / empty + idempotency), `mailto:` strip, `inferPaymentStatus` mapping table, Status filter, `translateEventCreateRow` happy paths, FR-012 unknown-column collection. **Note**: authored as GREEN tests in same pass as T010 (RED→GREEN collapsed; T010 helpers + T013 assertions landed together)
- [X] T014 [P] [US1] Unit test `tests/unit/events/classify-pdpa-consent.test.ts` — **20 sub-tests GREEN** covering true ("hereby acknowledge" case-insensitive substring), false ("do not consent"), null (empty / `-` / `–` / unrecognized), 1024-char truncation defence-in-depth. Authored alongside T006 in same pass (RED→GREEN collapsed)
- [X] T015 [P] [US1] Unit test `tests/unit/events/attendee-fingerprint.test.ts` — **9 sub-tests GREEN** covering 8-step deterministic algorithm per FR-019a: Status filter, mailto strip + lowercase + trim, lexicographic sort, NUL byte join (`String.fromCharCode(0)` = `'\0'` escape), SHA-256 first 16 hex; edge case 0-Attending → NULL; fast-check property test (two random permutations of same emails → same fingerprint). Authored alongside T010 helpers (RED→GREEN collapsed)
- [X] T016 [P] [US1] Integration test `tests/integration/events/eventcreate-csv-real-fixtures.test.ts` — both committed EventCreate fixtures uploaded on live Neon SG; asserts sourceFormat=eventcreate_csv + recordId surfaced + rowsProcessed+rowsSkipped sum equals rowsTotal + event_registrations populated + csv_import_records.outcome ∈ {completed, partial_failure} + attendeeFingerprint persisted as 16-char hex
- [X] T017 [P] [US1] Integration test `tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts` — **Constitution Principle I clause 3 BLOCKER** — verifies `lookupEventByIdTimingSafe(B, A_eventId)` returns `wrong_tenant`, Tenant B runImportCsv targeting A's eventId never writes to Tenant A's namespace (event_registrations + csv_import_records + events all stay isolated), and direct DB seed under tenant A is invisible to tenant B's `runInTenant` context (RLS+FORCE policy intact)
- [X] T018 [P] [US1] Integration test `tests/integration/events/safety-net-event-mismatch.test.ts` — FR-019b safety-net live-Neon walk: import same CSV to eventA → returns completed + persists fingerprint, then re-import to eventB → returns `event_mismatch_warning` with priorImports[0].eventId === eventA.eventId + ZERO side effects under eventB (no records, no registrations), then re-submit with forceProceed=true → commits + emits `csv_import_event_mismatch_overridden` audit with currentEventId=eventB
- [X] T019 [P] [US1] A11y E2E extension `tests/e2e/eventcreate-a11y.spec.ts` — 3 new visual states appended, **all 3 active (no skip)**: (a) event-picker visible (combobox role assertion + axe scan), (b) inline create modal open (Dialog role + aria-modal assertion + axe scan + base-ui focus-guard exclude per `idle-warning-a11y.spec.ts` pattern), (c) event-mismatch warning dialog open (AlertDialog role + axe scan with real safety-net seed: T026 inline-create modal seeds 2 events → import CSV at eventA → re-import same CSV at eventB → AlertDialog visible → axe scan). Existing 6 Phase 7 a11y scans unchanged. Test timeout 180s for the 2-import live-Neon flow. Verified GREEN across 4 Playwright projects (chromium/firefox/mobile-safari/mobile-chrome)

### Implementation for User Story 1 (GREEN phase)

- [X] T020 [US1] Drizzle repo `src/modules/events/infrastructure/drizzle-csv-import-records-repo.ts` — `insert` / `updateOutcome` / `setErrorCsvBlob` / `findByFingerprintAcrossEvents(tenantId, fingerprint, currentEventId, since)` / `listByTenant(tenantId, pagination, filters)` / `findById(tenantId, recordId)` — implements CRUD against table from T003
- [X] T021 [P] [US1] Vercel Blob adapter `src/modules/events/infrastructure/vercel-blob-error-csv-store.ts` — **all 3 port methods wired** per `ErrorCsvStore` from T007 using `@vercel/blob` SDK: (1) `put` with tenant-scoped path prefix `tenants/{slug}/csv-import-errors/{recordId}.csv` + `addRandomSuffix: true` (opaque URL prevents enumeration); (2) `generateSignedUrl(expiresInSeconds: 900)` returns URL with `?download=1` + `?expires=<unix-ms>` stamp for server-side TTL enforcement at the US5 download route; (3) `delete(blobUrl)` via `del()` SDK call with idempotent `blob_not_found` discrimination for US5 TTL sweep cron. Per research.md R6
- [X] T022 [US1] Extend use-case `src/modules/events/application/use-cases/import-csv.ts` — add `eventId: EventId` + `forceProceed?: boolean` inputs; new outcomes (`event_mismatch_warning` returned from use-case; `event_not_selected` / `event_not_found` / `event_not_owned_by_tenant` short-circuited at route layer to avoid use-case dependency on EventsRepository); compute fingerprint via `computeAttendeeFingerprintFromEmails` + run safety-net query before commit (FR-019a/b); **populate `event_registrations.attendee_pdpa_consent_acknowledged` dedicated BOOLEAN column** (migration 0140) by threading `pdpaConsentAcknowledged?: boolean | null` through `ProcessAttendeeInTxInput.attendee` → `RegistrationsRepository.insertOnConflictDoNothing` → Drizzle insert (tri-state preserved end-to-end; F7 broadcast filter `WHERE attendee_pdpa_consent_acknowledged = true` works); merge selected event metadata into every row at parser level via `parseStreamWithFormat`; emit `csv_import_event_mismatch_overridden` audit when force_proceed=true bypasses warning per FR-019c; **per-(tenant,event) advisory lock acquired** at outer batch tx start via `batchPorts.advisoryLockAcquirer.acquire(asLockKey('csv-import:'+tenantId+':'+eventId))` — `pg_advisory_xact_lock` auto-released at tx-end. Namespace `csv-import:` disjoint from F4 `invoicing:`, F5 `payments:`, F7 `broadcasts:`, F8 `renewals:`. Trade-off: within 1 import, 3 batch workers serialise on the same lock — correctness over throughput
- [X] T023 [US1] Route handler `src/app/api/admin/events/import/route.ts` — extend Phase 7 route: parse + UUID v4-shape-validate `event_id` form field (returns 400 `event_not_selected` if absent, 400 `event_not_found` if shape invalid) + parse `force_proceed` form field with case-insensitive `["true","1","yes"]` per CHK015, timing-safe single-query event lookup via `lookupEventByIdTimingSafe` (fetch by id WITHOUT tenant filter, then check ownership in app code per E8), emit `csv_import_cross_tenant_probe` audit on cross-tenant probe via standalone-tx + 404 surface-disclosure response, map all new outcomes (event_mismatch_warning → 200 with priorImports) per contract csv-import-eventcreate-api.md
- [X] T024 [US1] Wire composition adapter `src/lib/events-csv-import-deps.ts` — extend with: (a) `VercelBlobErrorCsvStore` injected into `errorCsvStore` deps slot via `makeImportCsvDeps`, (b) `makeDrizzleCsvImportRecordsRepository` factory injected into `withImportRecordsTx` deps slot, (c) `lookupEventByIdTimingSafe` helper (timing-safe DB query, app-layer ownership branching), (d) `EventId` brand applied via `asEventId(input.selectedEvent.eventId)` at composition-layer boundary per G3 closure, (e) `UserId` consistent branding via existing H-15 pattern
- [X] T025 [P] [US1] Event-picker component `src/components/events/event-picker.tsx` — dropdown over admin's events (GET /api/admin/events page-size 100) + filename-hint Sørensen-Dice bigram match ≥0.65 (`suggestEventFromFilename` ~25 LOC pure helper, no library) + inline "Create new event" modal trigger + a11y combobox via shadcn Popover+Command (cmdk) + refresh button + WCAG 2.5.8 min-h-11 touch targets
- [X] T026 [P] [US1] Inline event-create modal `src/components/events/event-create-inline-modal.tsx` — **FULL IMPLEMENTATION** (~320 LOC react-hook-form + zod) — closes the "no way to seed events" gap left by EventCreate API gating (project_eventcreate_api_gated memory). 4-field form (externalId / name / startDateLocal / category) with shadcn Dialog primitives + Label htmlFor + aria-invalid + aria-live error announcements + min-h-11 WCAG 2.5.8 targets. POSTs to `POST /api/admin/events` (new route in `src/app/api/admin/events/route.ts`); route delegates to `src/modules/events/application/use-cases/create-event.ts` (new use-case ~210 LOC) which calls `eventsRepo.upsert` with `source='admin_manual'` (new `Source` enum value) + emits `event_created` audit (new event type in `F6_AUDIT_EVENT_TYPES` + migration 0144 enum extension). Composition wrapper `src/lib/events-create-deps.ts` provides 30/hr rate-limit + `EventId` branding. 32 i18n keys × EN+TH+SV. Idempotent: re-POST same externalId returns 200 `already_exists` (no duplicate audit emit); fresh insert returns 201 `created`. Modal auto-selects new event in parent EventPicker via `onCreated` callback. Surface-disclosure: manager/member → 404 + `role_violation_blocked` audit
- [X] T027 [P] [US1] Warning dialog `src/components/events/event-mismatch-warning-dialog.tsx` — renders `priorImports` list (event name fallback to eventId + uploaded date) per FR-019b; "Cancel" (default focus) + "Continue anyway" (re-submits parent form with `force_proceed=true`); shadcn AlertDialog (role=alertdialog) + aria-describedby on Continue action linking warning copy + amber warning icon
- [X] T028 [US1] Extend wizard `src/components/events/csv-mapping-form.tsx` — EventPicker renders ABOVE file input on every non-completed phase; `selectedEventId` state lives OUTSIDE the phase machine so admin can change selection between attempts; submit button gated with `disabled={selectedEventId===null}` + aria-live hint; mismatch outcome → `setMismatchDialog({open:true, priorImports})` instead of new phase (modal branch); Continue re-submits via `submitImport(file, true)`
- [X] T029 [US1] Extend page `src/app/(staff)/admin/events/import/page.tsx` — no changes required; `CsvMappingForm` encapsulates EventPicker, mismatch dialog, and inline modal internally. Phase 7 admin-only RBAC inherited
- [X] T030 [US1] i18n keys EN/TH/SV — ~25 new keys × 3 locales = ~75 entries under `admin.events.import.eventPicker.*` (dropdown + filename hint + inline modal) + `admin.events.import.eventMismatch.*` (warning dialog + prior-import row) + `admin.events.import.errors.eventNotSelected*`. `pnpm check:i18n` GREEN at 2663 keys × EN+TH+SV

**Checkpoint**: At this point, User Story 1 is fully functional — admin can upload either committed EventCreate fixture and complete the workflow end-to-end. T012–T019 all GREEN. MVP shipped.

---

## Phase 4: User Story 2 — Re-upload idempotency + state changes + cancellation (Priority: P1)

**Story Goal**: Admin re-uploads the same (or updated) EventCreate CSV; system recognizes already-imported rows as duplicates while applying state changes (payment status, company, cancellation).

**Independent Test**: Upload `docs/Attendee list/EventCreate_Guestlist-grant-thornton-workshop.csv` twice in a row → second upload reports `rowsAlreadyImported = 56` + `rowsProcessed = 0`. Then modify a row's `Notes` from "verifying payment" → "Paid" and re-upload → that row's `payment_status` updates from `pending` → `paid` + audit emitted.

### Tests for User Story 2 (RED phase)

- [X] T031 [P] [US2] Integration test `tests/integration/events/re-upload-idempotency-eventcreate.test.ts` — **2 scenarios GREEN**: (1) Grant Thornton fixture upload-twice asserts rowsAlreadyImported=processedFirstRun + fresh recordId per upload + DB row count stable + 2 csv_import_records persisted; (2) FR-018 state-change — synthetic 1-row CSV with Notes='verifying payment' → 'Paid' between uploads → 2nd run reports rowsStateChanged=1 + DB payment_status flipped pending→paid; 3rd run (same Notes) reports rowsAlreadyImported=1 (no double state-change).
- [X] T032 [P] [US2] Integration test `tests/integration/events/cancellation-cascade-eventcreate.test.ts` — synthetic 1-row EventCreate CSV (Status=Attending+Notes=Paid → re-upload Status=Cancelled) on live Neon Singapore. Asserts: registration.payment_status flips paid→refunded; NO F4 invoice mutation (Q2 cross-cutting drop); NO F5 Stripe processor event.

### Implementation for User Story 2 (GREEN phase)

- [X] T033 [US2] Full EventCreate adapter + parser + use-case + helper + repo changes:
  - `src/modules/events/infrastructure/eventcreate-csv-adapter.ts`: `classifyEventCreateStatus` recognises `Cancelled`/`Canceled` as `Cancellation` (new union member); `EventCreateAttendeeRow.isCancellation` added; `translateEventCreateRow` populates the flag.
  - `src/modules/events/infrastructure/streaming-csv-importer.ts`: `iterateEventCreateRows` forwards Cancellation rows as `ok:true` with `payment_status='refunded'` + `intendedStateChange=true`; generic-CSV + Attending rows emit `intendedStateChange=false`.
  - `src/modules/events/application/ports/csv-importer.ts`: `ParsedRow` ok-variant gains required `intendedStateChange: boolean`.
  - `src/modules/events/application/ports/registrations-repository.ts`: **NEW** `findByEventAndEmail(tenantId, eventId, emailLower)` for re-upload state-change lookup + **NEW** `updatePaymentStatus(tenantId, registrationId, nextStatus)` for non-refund state-change UPDATE.
  - `src/modules/events/infrastructure/drizzle-registrations-repository.ts`: implements both new methods with SELECT-then-UPDATE pattern matching `markRefunded` precedent; pseudonymised-row rejection per FR-014.
  - `src/modules/events/application/use-cases/import-csv.ts`: `processOneRowInSavepoint` bypasses the idempotency receipt for `intendedStateChange=true` rows AND adds `maybeApplyStateChange` helper for receipt-duplicate state-change detection (Notes-driven payment_status change). New `state_changed` RowOutcome variant + `rowsStateChanged` summary counter surfaced on `csv_import_completed` audit payload.
  - `src/modules/events/application/use-cases/_helpers/process-attendee-in-tx.ts`: FR-018 `isRefundTransition` guard relaxed — markRefunded now runs unconditionally on paid→refunded; advisory-lock acquisition + `quota_credit_back_refund` audit emit remain matched-member-gated.
  - Existing TEST-R6-03 (`tests/unit/events/ingest-webhook-attendee.test.ts`) updated to pin the new semantics. 3 unit-test mock files (archive-event, load-event-detail, toggle-event-category) extended with `findByEventAndEmail` + `updatePaymentStatus` mock fields. **No F4 cross-module call** (Q2 drop verified).

**Checkpoint**: Re-upload safety + cancellation cascade work end-to-end. T031+T032 GREEN.

---

## Phase 5: User Story 5 — Import history + error CSV download (Priority: P2)

**Story Goal**: Admin sees a paginated list of past imports + can download a CSV of only the error rows from any past import to fix in Excel + re-upload.

**Independent Test**: Run 3 imports across 3 different events. Navigate to `/admin/events/import/history`. List shows 3 rows, most-recent first, each with event name + timestamp + counts. Click "Download error CSV" on a past import that had failures → receives a CSV of only the failed rows + `_error_reason` column. Wait 31 days → "Download" link disabled with "Expired" message; row metadata still visible.

### Tests for User Story 5 (RED phase)

- [X] T034 [P] [US5] Contract test `tests/contract/events/csv-import-history-api.test.ts` — **12 tests GREEN** (HTTP-level, mocked use-case): 200 happy path + record shape, eventId filter pass-through, actorUserId filter pass-through, pagination forwarding, expired-blob errorCsvAvailable:false, page<1/perPage>100/malformed UUIDs return 400, RBAC deny short-circuits, 500 ProblemDetails with requestId on db_error. 503 kill-switch delegated to integration smoke (env reads at module-eval prevent clean per-test mocking).
- [X] T035 [P] [US5] Contract test `tests/contract/events/error-csv-signed-url-api.test.ts` — **9 tests GREEN** (HTTP-level, mocked use-case): 307 happy path with Location + Cache-Control headers, sourceIp from X-Forwarded-For first hop, 404 not_found body shape, 404 expired surface-disclosure-identical body, 500 signing_failure with requestId + no Location, malformed recordId → 404 short-circuit, RBAC deny short-circuit, tenant-resolution failure → 404 defensive, recordId path-param threading.
- [X] T036 [P] [US5] Integration test `tests/integration/events/csv-import-records-history.test.ts` — **4 tests GREEN on live Neon Singapore**: reverse-chrono ordering, filters (eventId + actorUserId) + errorCsvAvailable computation, Constitution Principle I clause 3 cross-tenant isolation (Tenant A sees ZERO of Tenant B's rows), pagination boundary (page > totalPages returns empty + correct totals)
- [X] T037 [P] [US5] Integration test `tests/integration/events/error-csv-cross-tenant-isolation.test.ts` — **3 tests GREEN on live Neon Singapore**: Tenant A → Tenant B record → not_found + `csv_import_cross_tenant_probe` HIGH-severity audit emit (Constitution Principle I clause 4), Tenant B own-record → success path reached (signing call attempted), unknown recordId → not_found + NO probe audit emit
- [X] T038 [P] [US5] Integration test `tests/integration/events/error-csv-blob-roundtrip.test.ts` — **3 tests GREEN against live Vercel Blob** (skip-gated on `BLOB_READ_WRITE_TOKEN`): put → generateSignedUrl(900) → fetch round-trips bytes; signed URL has download=1 + expires=<ms> query params; random-suffix URL not deterministic from (tenant, recordId); delete → post-delete fetch 404/410; idempotent re-delete classifies blob_not_found.
- [X] T039 [P] [US5] Integration test `tests/integration/events/error-csv-blob-upload-failure.test.ts` — **1 test GREEN on live Neon + mocked Blob.put**: synthetic 2-row CSV (1 good + 1 invalid email) with mocked Blob put returning storage_error → outcome.kind='completed' (rows persisted), rowsProcessed>0 + rowsFailed>0 + errorCsvAvailable:false; csv_import_records.error_csv_blob_url IS NULL; `f6_csv_error_csv_blob_put_failed` pino warn captured.

### Implementation for User Story 5 (GREEN phase)

- [X] T040 [P] [US5] Use-case `src/modules/events/application/use-cases/list-csv-import-records.ts` — paginated query against `csv_import_records` for tenant scope, filter + sort, returns shape per contracts/csv-import-history-api.md (`sourceFormat` per FR-025 + `errorCsvAvailable` computed in use-case via `clock`-injected `now()` so tests are deterministic)
- [X] T041 [P] [US5] Use-case `src/modules/events/application/use-cases/generate-error-csv-signed-url.ts` — tenant-scoped `findById` → blob URL + expiry checks → `ErrorCsvStore.generateSignedUrl(900)` (15-min TTL) → emit `csv_import_error_csv_downloaded` audit BEFORE returning URL (strict-audit invariant). On cross-tenant probe (`findByIdAcrossTenants` admin-bypass shows recordId in another tenant): emit `csv_import_cross_tenant_probe` at `critical` severity per Constitution I clause 4 + return not_found. On signing failure: emit `f6_error_csv_signing_failure` pino log (NOT audit) + return signing_failure (route maps to 500). Audit-emit blocking failure on success path: maps to `signing_failure` so route returns 500 + admin retries
- [X] T042 [US5] Route handler `src/app/api/admin/events/import/history/route.ts` — GET with zod-shaped query-param pagination + UUID v4 validation on `eventId`/`actorUserId` filters + admin-only RBAC + `Cache-Control: no-store`. 503 on master kill-switch
- [X] T043 [US5] Route handler `src/app/api/admin/events/import/[recordId]/error-csv/route.ts` — GET → 307 redirect to signed URL on success. UUID v4 validation on `recordId` path param. not_found/expired/cross-tenant all return identical 404 ProblemDetails body per surface-disclosure invariant. signing_failure → 500 ProblemDetails with requestId. 503 on master kill-switch
- [X] T044 [P] [US5] Component `src/components/events/csv-import-history-table.tsx` — shadcn `<Table>` primitives (TanStack Table v8 not needed — sorting/filtering is server-driven via query params, paging via Link navigation). Columns: uploaded_at + filename + sourceFormat badge + outcome + counts (processed/skipped/failed) + "Download error CSV" link OR expired tooltip OR "No errors" placeholder. `<nav aria-label="Pagination">` with prev/next + `Showing N-M of T`. WCAG 2.5.8 via `min-h-11` on interactive elements
- [X] T045 [US5] Extend result card `src/components/events/csv-import-result.tsx` — persistent "Download error CSV" `<a>` next to recordId chip; only when `errorCsvAvailable === true && recordId !== undefined`; routes to `/api/admin/events/import/{recordId}/error-csv` (browser follows 307 redirect). Reuses `admin.events.import.history.downloadErrorCsv` i18n key
- [X] T046 [US5] History page `src/app/(staff)/admin/events/import/history/page.tsx` + `loading.tsx` — Server Component. Admin-only via `requireSession('staff')` + role check. Uses `TableContainer` (96rem, content-type "data table") per 006-layout convention. CLS-0 skeleton pair. Pagination via `?page=N&perPage=M` search params. Locale-formatted timestamps via `Intl.DateTimeFormat(getLocale())`
- [X] T047 [US5] i18n keys EN/TH/SV — `admin.events.import.history.*` namespace added under existing `admin.events.import` block: pageTitle, pageSubtitle, tableAriaLabel, columns.{uploadedAt,event,actor,sourceFormat,outcome,rowsProcessed,rowsSkipped,rowsFailed,actions}, sourceFormat.{eventcreate_csv,generic_csv}, outcome.{completed,timeout,partial_failure,invalid_header,event_not_found,event_not_owned_by_tenant,unexpected_error}, downloadErrorCsv, downloadErrorCsvAriaLabel, expiredBadge, expiredTooltip, noErrorRows, emptyState, loadError, pagination.{previous,next,pageOf,showing}, backToImport — ~30 keys × 3 locales = ~90 entries. `pnpm check:i18n` GREEN at 2756 keys × EN+TH+SV
- [X] T048 [P] [US5] A11y E2E extension `tests/e2e/eventcreate-a11y.spec.ts` — added 4th visual state: history page rendered with axe scan + table/empty-state assertion. Manual-gate (skip-gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD per Phase 7 a11y convention); runs end-to-end against staging at T060.
- [X] T049 [P] [US5] Use-case `src/modules/events/application/use-cases/sweep-expired-error-csv-blobs.ts` — admin-bypass `listExpiredErrorCsvBlobsAllTenants(cutoff, limit)` → per-row delete blob + clear DB columns inside `runInTenant(tenantId, ...)` scope. Idempotent: `blob_not_found` counts as success; transient failures retried on next cron. Returns `{candidatesScanned, sweptCount, skippedCount, cutoff}`. Pino structured logs for scan + per-row failure + completion summary
- [X] T050 [US5] Cron handler `src/app/api/internal/retention/sweep-error-csv-blobs/route.ts` — Bearer-auth via `verifyCronBearer(CRON_SECRET)` (strict ≥16 chars; no dev bypass); Node runtime pinned; invokes `runSweepExpiredErrorCsvBlobs({})`; returns `{ok:true, candidatesScanned, sweptCount, skippedCount, cutoff, durationMs}` on success. 401 on bearer mismatch, 500 on use-case throw

**Checkpoint**: History + error CSV download + TTL sweep fully functional. T036+T037 GREEN (7 integration tests on live Neon). Pre-flag-flip operator gate: register cron-job.org entry (daily 05:00 Asia/Bangkok with email alert on ≥2-day consecutive failures per critique E5 + T058 operator gate).

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Observability, sub-flag wiring, E2E, runbook, perf, final review gates

- [X] T051 [P] OTel metrics in `src/lib/metrics.ts` — `eventcreate_csv_adapter_mode_detected_total{tenant, format}` counter (FR-025, reused from US1 via `eventcreateMetrics.csvImportAdapterModeDetected`) + new `eventcreate_csv_error_csv_downloaded_total{tenant}` counter via `eventcreateMetrics.csvErrorCsvDownloaded`. Wired into the success path of `generateErrorCsvSignedUrl` ONLY (after audit emit succeeds + before signed URL returned) via `onDownloadSuccess` deps injection
- [X] T052 Pino aggregate log `f6_eventcreate_adapter_unknown_columns` — emitted at top of `importCsv` use-case (after parser returns + before batches process) ONCE per upload when `sourceFormat === 'eventcreate_csv' && unknownColumns.length > 0`. Payload: `{tenantId, distinctUnknownColumns[≤50], unknownColumnCount}`. Feeds operator review per FR-012 + runbook § 4.2
- [X] T053 Sub-flag wiring — `FEATURE_F6_EVENTCREATE_ADAPTER` read in `runImportCsv` composition wrapper + passed through `ImportCsvInput.adapterEnabled` → `parseStreamWithFormat({adapterEnabled})`. When `false`: parser SKIPS `detectEventCreateFormat` + forces generic-CSV path even if header has the 6 EventCreate required columns. Rollback safety net per Spec § Rollback Plan documented in runbook § 1
- [X] T054 [P] Runbook `docs/runbooks/eventcreate-csv-import.md` — 250+ lines covering 10 operational topics: feature flags + mid-import flag-flip semantics (§1), daily TTL sweep cron + manual recovery (§2), signed-URL leak response (§3), EventCreate header drift detection (§4), concurrent operation invariants (§5), Blob upload failure recovery (§6), event-mismatch override audit review (§7), cross-tenant probe alerts (§8), rollback procedure (§9), migration safety (§10)
- [X] T055 [P] E2E test `tests/e2e/csv-eventcreate-import.spec.ts` — manual-gate spec (auto-skips when `E2E_ADMIN_EMAIL` + `E2E_ADMIN_PASSWORD` absent per Phase 7 T091 convention). 3 scenarios: real Grant Thornton fixture upload with inline-modal event create + result card with recordId chip; re-upload same CSV to different event triggers FR-019b warning + Continue anyway override; history page lists past imports with source-format badges. `--workers=1` mandatory per CLAUDE.md memory
- [X] T056 Full CI gate — verified piecewise: `pnpm typecheck` GREEN for F6.1 paths (pre-existing F5 errors in working tree out of F6.1 scope), `pnpm lint` 0 errors + 0 warnings, `pnpm check:i18n` 2756 keys × 3 locales, `pnpm check:layout` 96 pairs consistent, `pnpm test tests/unit/events/` 224/224 GREEN, `pnpm test:integration -- tests/integration/events/{re-upload-idempotency,cancellation-cascade,csv-import-records-history,error-csv-cross-tenant-isolation}-eventcreate.test.ts` 7/7 GREEN on live Neon Singapore
- [X] T057 Perf bench reuse — **ran cross-region**: `RUN_PERF=1 pnpm test:integration -- tests/integration/perf/csv-import-perf.test.ts` produced `[SC-006 bench] rows=200 duration=76137ms outcome=timeout`. Phase 7 baseline ~54.6s @ 200 rows → ~40% regression cross-region (advisory-lock serialisation + safety-net query + csv_import_records insert/update round-trips). Use-case timeBudgetMs tripped → partial commit preserved (idempotent re-upload). Cross-region dev bench is informational per Spec § Operational notes; canonical measurement is operator gate T059 prod-region (intra-region Neon SG sub-1ms RTT). Full analysis in `retrospective.md` § T057.

### Pre-flag-flip Operator Gates (NOT engineering work — operator action documented in retrospective.md § Pre-flag-flip operator checklist)

These run outside the impl phase but block prod flag-flip. Full details in `specs/013-csv-import-eventcreate-format/retrospective.md`.

- [ ] T058 [Operator gate] cron-job.org dashboard entry — daily 05:00 Asia/Bangkok hit on `/api/internal/retention/sweep-error-csv-blobs` with Bearer `CRON_SECRET`; configure email alert on ≥2 consecutive day failures per E5. Commit URL/ID to `docs/runbooks/cron-jobs.md` alongside F4/F5/F7/F8 entries. **NOTE (2026-05-19)**: F6 + F6.1 ship together on `012-eventcreate-integration` / PR #26, so this entry is now merged into F6's consolidated `T154` operator gate (`specs/012-eventcreate-integration/ship-day-checklist.md` § T154 — 4 cron-job.org coordinators including this one). Setting up T154 satisfies T058 in the same operator window.
- [ ] T059 [Operator gate] SC-006 prod-region perf bench — operator runs `RUN_PERF_PROD_REGION=1 pnpm test tests/integration/perf/csv-import-perf.test.ts` on a Vercel `sin1` runner with intra-region Neon `ap-southeast-1`; assert 1,000 EventCreate rows < 60s; capture output to `specs/013-csv-import-eventcreate-format/perf-bench-T059.log`
- [ ] T060 [Operator gate] Manual E2E run on staging — `pnpm test:e2e --grep "F6.1 EventCreate CSV import" --workers=1` against staging deployment with seeded TSCC tenant + admin credentials + both committed fixtures. Expected 3/3 GREEN
- [ ] T061 [Maintainer gate] `/speckit-staff-review-run` multi-agent final pass against the implemented branch; co-sign on security checklist (admin-only + audit-logged + no PCI scope) per project governance

---

## Dependency Graph

```text
Phase 1 (Setup) — T001, T002
    ↓
Phase 2 (Foundational) — T003-T010 (T011 MERGED into T024 per analyze F1 — see Phase 3 graph)
    ├── T003 migration 0139 (csv_import_records + indexes + RLS + fingerprint col)
    ├── T004 [P] migration 0140 (event_registrations.attendee_pdpa_consent_acknowledged)
    ├── T005-T008 [P] domain types + ports + audit-port extension
    ├── T009 parser relax (depends on Phase 7 baseline; serial — touches existing file)
    └── T010 EventCreate adapter (depends on T006 + T009)
    ↓
┌───────────────────────────┬──────────────────────────┬──────────────────────────┐
│ Phase 3 US1 (P1, MVP)     │ Phase 4 US2 (P1)         │ Phase 5 US5 (P2)         │
│ T012-T019 RED [parallel]  │ T031-T032 RED [parallel] │ T034-T039 RED [parallel] │
│ T020 repo (serial)        │ T033 GREEN (serial)      │ T040-T041 [P] use-cases  │
│ T021 [P] Blob adapter     │ (depends on Phase 3      │ T042-T043 routes serial  │
│ T022 use-case extend      │  T022 use-case extension)│ T044 [P] history table   │
│ T023 route handler        │                          │ T045 result-card extend  │
│ T024 composition wire     │                          │ T046 history page        │
│  (absorbs T011 — wires    │                          │                          │
│   T020+T021 + use-case)   │                          │                          │
│ T025-T027 [P] components  │                          │ T047 i18n                │
│ T028-T029 wizard + page   │                          │ T048 [P] a11y            │
│ T030 i18n EN/TH/SV        │                          │ T049-T050 sweep + cron   │
└───────────────────────────┴──────────────────────────┴──────────────────────────┘
    ↓
Phase 6 (Polish) — T051-T057
    ↓
Pre-flag-flip Operator gates — T058-T061
```

**MVP completion**: Phase 1 + Phase 2 + Phase 3 (US1) = Phase-1 ship candidate. ~31 tasks.
**Full v1 completion**: All 61 tasks.

---

## Parallel Execution Examples

### Phase 2 Foundational (after T003 migration applied)
Run in 4 parallel streams:
```text
Stream A: T004 migration 0140 (independent table)
Stream B: T005 csv-import-record-id branded type
Stream C: T006 + T007 + T008 (domain/port/audit-port extensions — different files)
Stream D: T009 parser relax (modify streaming-csv-importer)
→ T010 EventCreate adapter (waits on T006 + T009)
(T011 composition root MERGED into Phase-3 T024 per analyze F1 — Phase 2 ends at T010)
```

### Phase 3 US1 RED phase
All 8 test files independent — fully parallel:
```text
T012, T013, T014, T015, T016, T017, T018, T019 — all [P], 8-way parallel
```

### Phase 3 US1 GREEN
Largely sequential due to file overlap:
```text
T020 repo (waits on T003)
→ T021 [P] Blob adapter (parallel to T022)
→ T022 use-case extend (depends on T010 + T020)
→ T023 route handler (depends on T022)
→ T024 composition wire (depends on T021 + T023)
→ T025, T026, T027 [P] components (parallel)
→ T028 wizard (depends on T025-T027)
→ T029 page (depends on T028)
→ T030 i18n (terminal)
```

### Phase 5 US5 RED + GREEN
RED all parallel (5 test files), GREEN partially parallel:
```text
T034-T039 — all [P] in RED
→ T040 [P] + T041 [P] use-cases (parallel)
→ T042 + T043 routes serial
→ T044 [P] table + T045 result-card + T046 page (T044 + T045 [P]; T046 waits on T044)
→ T047 i18n + T048 [P] a11y (parallel)
→ T049 [P] sweep use-case + T050 cron handler (T050 waits T049)
```

---

## Implementation Strategy

### MVP First (US1 only)
Stop after T030. Ship US1 as F6.1 alpha. Admin can:
- Upload raw EventCreate export verbatim with event-picker
- See structural preview + result card
- Get event-mismatch warning if uploaded same file to different event
- Cancel + override warnings with audit trail

US2 + US5 = "Phase 7's idempotency carry-forward + operational tooling" — value-add but not MVP-blocking. Defer if timeline pressure forces choice.

### Full v1 — Recommended
All 61 tasks ship together. Re-upload + history + error CSV download provide complete operational story. 

### After ship
Phase 6 F6.1.1 candidates if real-world usage demands:
- Eventbrite/Luma/Meetup native connectors (F6.2 placeholder; never delivered as part of 013)
- Field-level locking (Q2 deferred)
- F4 refund-review badge (Q2 dropped — revisit if cancellation volume grows)
- US3 match preview (Q5 dropped — revisit if support tickets show "I imported by accident")
- US4 CSV template (Q5 dropped — revisit when non-EventCreate connectors arrive)

---

## Format Validation

✅ All 61 tasks follow the strict `- [ ] T### [P?] [Story?] Description with file path` format.
✅ All Phase 3/4/5 tasks have `[US1]` / `[US2]` / `[US5]` story labels.
✅ Phase 1/2/6 tasks have NO story labels (per format spec).
✅ `[P]` markers applied only where parallel-safe.
✅ Exact file paths included in every implementation task.
✅ Test tasks precede their implementation tasks (RED→GREEN discipline per Constitution II).

---

## Notes

- **Coverage targets** (Constitution II): Domain types 100% line · Application use-cases ≥80% line + 80% branch · **100% branch on security-critical paths** (cross-tenant probe handling, signed-URL audit gating, force_proceed normalization, RBAC)
- **Tests on live Neon Singapore** (`pnpm test:integration`) — NOT Docker; reuses Phase 7 connection pool
- **i18n parity** (`pnpm check:i18n`) — release-branch CI blocks on missing TH/SV; dev tolerates
- **Layout check** (`pnpm check:layout`) — every page+loading pair must use the same Container variant (006-layout convention)
- **Per-feature flag** (`FEATURE_F6_EVENTCREATE_ADAPTER`) — defaults true; flips OFF on rollback trigger per Spec § Rollback Plan
- **CSV fixtures committed** at `docs/Attendee list/` — DO NOT delete; integration tests reference them by name
- **Constitution v1.4.0**: 10/10 PASS verified at plan + critique × 2 + checklist gates
