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

- [ ] T001 [P] Verify `BLOB_READ_WRITE_TOKEN` is present in `src/lib/env.ts` zod schema (reused from F4 invoice-PDF storage — must already exist; fail-fast at boot if absent)
- [ ] T002 Add sub-flag `FEATURE_F6_EVENTCREATE_ADAPTER` to `src/lib/env.ts` zod schema (closes `/speckit-analyze` finding F4 + pass-2 finding G1). Specification: env-var name = `FEATURE_F6_EVENTCREATE_ADAPTER`; coercion = **existing `booleanFromString.default(true)` helper** (src/lib/env.ts:29-34, the canonical pattern used by every other `FEATURE_F*` flag — `FEATURE_F3_MEMBERS`, `FEATURE_F4_INVOICING`, `FEATURE_F5_ONLINE_PAYMENT`, `FEATURE_F6_EVENTCREATE`, `FEATURE_F7_BROADCASTS`, `FEATURE_F8_RENEWALS`). Truthy set: `"true"` (case-insensitive trimmed) and `"1"`; everything else falsy. **NOTE the asymmetry with form-field `force_proceed`** in contract csv-import-eventcreate-api.md: the form-field accepts `"true"/"1"/"yes"` (user-friendlier) while the env-var follows the stricter project-wide helper — this is intentional; do not "harmonize" by extending `booleanFromString` (would touch every other feature flag). **Default `true`** at launch for production behaviour (matches `FEATURE_F4_INVOICING` line 207 and `FEATURE_F3_MEMBERS` line 183 patterns). Place adjacent to the existing `FEATURE_F6_EVENTCREATE` declaration at src/lib/env.ts:428 for grouping. App refuses to start if zod validation fails at boot (fail-fast per F1 env-loader pattern). Flips OFF per Spec § Rollback Plan when >5 admin issues attributable to F6.1 in 7 days post-launch.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Migrations + Domain types + Application ports + Infrastructure adapters. **No user-story work can begin until this phase is complete.**

**⚠️ CRITICAL**: Constitution Principle I (tenant isolation) — RLS+FORCE policies on every new table; cross-tenant tests are Review-Gate blockers per clause 3.

- [ ] T003 Drizzle migration `drizzle/migrations/0139_csv_import_records.sql` — CREATE TABLE `csv_import_records` with all columns (data-model.md § 1 including `attendee_fingerprint TEXT NULL CHECK length=16` per FR-019a) + 4 indexes (tenant+uploaded_at DESC, tenant+event_id, error_csv_expires_at WHERE NOT NULL, tenant+actor_user_id+uploaded_at DESC, tenant+attendee_fingerprint+uploaded_at WHERE NOT NULL) + RLS ENABLE + FORCE + tenant-isolation policy + `updated_at` trigger
- [ ] T004 [P] Drizzle migration `drizzle/migrations/0140_event_registrations_attendee_pdpa_consent.sql` — ALTER TABLE event_registrations ADD COLUMN attendee_pdpa_consent_acknowledged BOOLEAN NULL (zero-downtime per data-model.md § Migration safety)
- [ ] T005 [P] Domain branded type `src/modules/events/domain/csv-import-record-id.ts` — `CsvImportRecordId` branded string + `asCsvImportRecordId(raw)` + `tryCsvImportRecordId(raw): Result<CsvImportRecordId, ValidationError>` (UUID v4 check)
- [ ] T006 [P] Domain value object `src/modules/events/domain/eventcreate-csv-format.ts` — `CsvAdapterMode` union + `PdpaConsentAcknowledged` type + `classifyPdpaConsent(raw): PdpaConsentAcknowledged` helper per FR-009 closed mapping
- [ ] T007 [P] Application port `src/modules/events/application/ports/error-csv-store.ts` — `ErrorCsvStore` interface with `put` / `generateSignedUrl` / `delete` methods + `ErrorCsvStoreError` discriminated union (data-model.md § 4)
- [ ] T008 [P] Audit port extension `src/modules/events/application/ports/audit-port.ts` — add 3 new event types to `F6AuditEventType` + `AuditPayloads`: `csv_import_error_csv_downloaded` / `csv_import_cross_tenant_probe` / `csv_import_event_mismatch_overridden` (contracts/audit-port.md)
- [ ] T009 Relax parser `src/modules/events/infrastructure/streaming-csv-importer.ts` — RFC 4180 embedded-newline-in-quoted-cell support per research.md R1 (state machine: when inside quoted field, `\r`/`\n`/`\r\n` appends to cell buffer, not row terminator). Re-run Phase 7 unit tests at `tests/unit/events/streaming-csv-importer.test.ts` to confirm NO regression (path corrected per `/speckit-analyze` finding F3 — Chamber-OS convention puts parser unit tests under `tests/unit/events/`, not `tests/integration/events/`). Also re-run any integration tests that exercise the parser via the full import path (`tests/integration/events/csv-savepoint-isolation.test.ts`, `tests/integration/events/csv-webhook-equivalence.test.ts` if it references the parser) to confirm no end-to-end regression on real fixtures.
- [ ] T010 EventCreate adapter `src/modules/events/infrastructure/eventcreate-csv-adapter.ts` — header detection (presence-of-6 case-sensitive per FR-001) + column mapping + `normalizeAttendeeName(first,last)` per FR-005 + `mailto:` strip per FR-006 + Status filter per FR-007 + `inferPaymentStatus(notes)` per FR-008 + `classifyPdpaConsent` invocation per FR-009 + unknown-column-tolerance per FR-012 + `computeAttendeeFingerprint(rows)` per FR-019a 8-step algorithm
- [ ] ~~T011~~ — **MERGED into T024** per `/speckit-analyze` finding F1 (circular Phase-2→Phase-3 dependency). Original description proposed wiring `ErrorCsvStore` (T021) and CSV-import-records repo (T020) in Phase 2, but both adapters are created in Phase 3 (US1). All composition-root wiring now happens in T024 after the adapters exist. Task ID retained for reference traceability; no Phase-2 work required here.

**Checkpoint**: Foundation ready — Phase 3-5 user-story work can now begin in parallel

---

## Phase 3: User Story 1 — Upload raw EventCreate export verbatim (Priority: P1) 🎯 MVP

**Story Goal**: Admin downloads EventCreate "Guestlist" CSV export, uploads to `/admin/events/import`, selects the F6 event from a dropdown (or creates it via inline modal), and gets a result-card with match counts in under 3 minutes. Real fixtures committed at `docs/Attendee list/` validate the end-to-end flow.

**Independent Test**: Pre-create a Chamber-OS event "SweCham AGM 2026" (date 2026-03-20), then upload `docs/Attendee list/EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` verbatim. After selecting the pre-created event from the dropdown (filename hint pre-suggests via Sørensen-Dice ≥0.65 fuzzy match), the import processes all 84 rows, correctly identifies "Attending" status, infers payment from Notes, classifies PDPA consent, and produces a result summary.

### Tests for User Story 1 (RED phase — must fail before T020+)

- [ ] T012 [P] [US1] Contract test `tests/contract/events/csv-import-eventcreate-format.test.ts` — ~20 HTTP outcomes from contracts/csv-import-eventcreate-api.md: 200 commit (EventCreate + generic), 200 `event_mismatch_warning`, 400 `csv-header-invalid` / `csv-parser-error` / `event_not_selected` / `event_not_found`, 404 `event_not_owned_by_tenant` (cross-tenant) + audit emit assertion, 413 pre+post-parse, 415, 429, 504, 503 kill-switch, 403/404 RBAC matrix (manager/member), multipart edge cases — all RED until T022-T024 land
- [ ] T013 [P] [US1] Unit test `tests/unit/events/eventcreate-csv-adapter.test.ts` — header detection (presence-of-6 case-sensitive + fall-through), `normalizeAttendeeName` (UPPERCASE / mixed / hyphen / apostrophe / empty), `mailto:` strip, `inferPaymentStatus` mapping table, Status filter, `classifyPdpaConsent` 3-path rules, FR-012 unknown-column tolerance — RED until T010 lands
- [ ] T014 [P] [US1] Unit test `tests/unit/events/classify-pdpa-consent.test.ts` — true ("hereby acknowledge" case-insensitive substring), false ("do not consent"), null (empty / `-` / `–` / unrecognized), 1024-char truncation defence-in-depth — RED until T006 lands
- [ ] T015 [P] [US1] Unit test `tests/unit/events/attendee-fingerprint.test.ts` — 8-step deterministic algorithm per FR-019a: Status filter, mailto strip + lowercase + trim, lexicographic sort, NUL byte join, SHA-256 first 16 hex; edge case 0-Attending → NULL; property test (fast-check) — two random permutations of same emails → same fingerprint
- [ ] T016 [P] [US1] Integration test `tests/integration/events/eventcreate-csv-real-fixtures.test.ts` — upload `docs/Attendee list/EventCreate_Guestlist-grant-thornton-workshop.csv` (56 rows) + `…-swecham-annual-general-meeting-2026.csv` (84 rows) on live Neon Singapore + assert 100% Attending rows land + audit events emit + idempotency receipts populated
- [ ] T017 [P] [US1] Integration test `tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts` — Constitution Principle I clause 3 blocker — Tenant B uploads EventCreate-format CSV, assert Tenant A's `csv_import_records` + `event_registrations` + `events` stay empty + cross-tenant probe audit emit (extends F6 Phase 7 R-S01 to adapter mode)
- [ ] T018 [P] [US1] Integration test `tests/integration/events/safety-net-event-mismatch.test.ts` — FR-019b — upload CSV to event A (commits, fingerprint stored), upload SAME CSV to event B (different event) → returns `event_mismatch_warning` with priorImports list + NO rows written; admin re-submits with `force_proceed=true` → commit proceeds + emits `csv_import_event_mismatch_overridden` audit; 31-day-old prior import → no warning (boundary strict)
- [ ] T019 [P] [US1] A11y E2E extension `tests/e2e/eventcreate-a11y.spec.ts` — add 3 new visual states: event-picker dropdown closed, inline event-create modal open (P-R2-5), event-mismatch warning dialog open (X-R2-1) — RED until T025-T028 land

### Implementation for User Story 1 (GREEN phase)

- [ ] T020 [US1] Drizzle repo `src/modules/events/infrastructure/drizzle-csv-import-records-repo.ts` — `insert` / `updateOutcome` / `setErrorCsvBlob` / `findByFingerprintAcrossEvents(tenantId, fingerprint, currentEventId, since)` / `listByTenant(tenantId, pagination, filters)` / `findById(tenantId, recordId)` — implements CRUD against table from T003
- [ ] T021 [P] [US1] Vercel Blob adapter `src/modules/events/infrastructure/vercel-blob-error-csv-store.ts` — implements `ErrorCsvStore` port from T007 using `@vercel/blob` SDK (put with tenant-scoped path prefix `tenants/{slug}/csv-import-errors/{recordId}.csv`, generateSignedUrl with 15-min expiry, delete) per research.md R6
- [ ] T022 [US1] Extend use-case `src/modules/events/application/use-cases/import-csv.ts` — add `eventId: EventId` + `forceProceed?: boolean` inputs; new outcomes (`event_not_selected` / `event_not_found` / `event_not_owned_by_tenant` / `event_mismatch_warning`); compute fingerprint + run safety-net query before commit (FR-019a/b); store `attendee_pdpa_consent_acknowledged` per row; merge selected event metadata into every row before `processAttendeeInTx`; emit `csv_import_event_mismatch_overridden` audit when force_proceed=true bypasses warning per FR-019c
- [ ] T023 [US1] Route handler `src/app/api/admin/events/import/route.ts` — extend Phase 7 route: parse + **shape-validate** (zod UUID v7) `event_id` form field (required, returns 400 `event_not_selected` if absent / 400 `event_not_found` if shape invalid) + parse `force_proceed` form field with the case-insensitive `["true","1","yes"]` normalization per contract csv-import-eventcreate-api.md (CHK015), timing-safe event lookup (fetch by id without tenant filter then check ownership per E8), map all new outcomes to HTTP responses + audit emit on cross-tenant probe. **Branding boundary clarification (G3 closure)**: T023 hands the route a validated `string` `event_id` to T024's composition wrapper; the `EventId` brand is applied at the composition layer (T024 sub-task e), NOT in T023. This keeps route-layer code framework-aware only and composition-layer code domain-aware only.
- [ ] T024 [US1] Wire composition adapter `src/lib/events-csv-import-deps.ts` (absorbs T011 per F1) — extend Phase 7 file to: (a) import + instantiate `VercelBlobErrorCsvStore` (T021) as `ErrorCsvStore` factory, (b) import + instantiate Drizzle CSV-import-records repo (T020), (c) wire event-mismatch query helper (calls T020's `findByFingerprintAcrossEvents`), (d) inject all new dependencies into `importCsv` use-case (T022), (e) brand the validated-string `event_id` from T023 as `EventId` at the use-case-input boundary (route-layer in T023 only validates UUID shape; brand application is composition-layer concern per Clean-Arch Principle III to keep route framework-aware and composition domain-aware — closes pass-2 finding G3), (f) brand `actorUserId` as `UserId` consistently at the same boundary. This is the ONLY composition-root touch — Phase 2 no longer has separate composition work.
- [ ] T025 [P] [US1] Event-picker component `src/components/events/event-picker.tsx` — dropdown over admin's events + filename-hint fuzzy match (Sørensen-Dice bigrams ≥0.65 threshold per FR-004, ~30 LOC pure function, no library) + inline "Create new event" modal trigger (next task) + a11y combobox pattern
- [ ] T026 [P] [US1] Inline event-create modal `src/components/events/event-create-inline-modal.tsx` — Radix UI Dialog wrapping a form that invokes `src/modules/events/application/use-cases/create-event.ts` use-case verbatim per FR-003 (admin RBAC + Zod validation + audit inherited; modal stays open with inline errors on validation failure per CHK013); on success closes + auto-selects in parent event-picker dropdown
- [ ] T027 [P] [US1] Warning dialog `src/components/events/event-mismatch-warning-dialog.tsx` — renders `priorImports` list (event name + date) per FR-019b; "Cancel" (default focus) + "Continue anyway" (re-submits parent form with `force_proceed=true`); a11y Dialog pattern + role=alertdialog
- [ ] T028 [US1] Extend wizard `src/components/events/csv-mapping-form.tsx` — 4-phase state machine: `event-picker` → `upload` → `submitting` → `completed`. Phase 7's structural 10-row preview retained inside `upload` phase. Handle `event_mismatch_warning` outcome → show warning dialog from T027 (modal branch, not new phase)
- [ ] T029 [US1] Extend page `src/app/(staff)/admin/events/import/page.tsx` — wire `EventPicker` from T025 into the existing form layout; admin-only RBAC inherited from Phase 7
- [ ] T030 [US1] i18n keys EN/TH/SV — ~25 new keys × 3 = ~75 entries under `admin.events.import.eventcreate.*` (adapter labels) + `admin.events.import.eventPicker.*` (dropdown + filename hint + inline modal) + `admin.events.import.eventMismatch.*` (warning dialog title/body/CTA + prior-import row template). TH-primary per chamber audit-message convention; SV follows chamber terminology (kammaradministratör). Run `pnpm check:i18n` → expect parity at ~2700 keys × 3 locales

**Checkpoint**: At this point, User Story 1 is fully functional — admin can upload either committed EventCreate fixture and complete the workflow end-to-end. T012–T019 all GREEN. MVP shipped.

---

## Phase 4: User Story 2 — Re-upload idempotency + state changes + cancellation (Priority: P1)

**Story Goal**: Admin re-uploads the same (or updated) EventCreate CSV; system recognizes already-imported rows as duplicates while applying state changes (payment status, company, cancellation).

**Independent Test**: Upload `docs/Attendee list/EventCreate_Guestlist-grant-thornton-workshop.csv` twice in a row → second upload reports `rowsAlreadyImported = 56` + `rowsProcessed = 0`. Then modify a row's `Notes` from "verifying payment" → "Paid" and re-upload → that row's `payment_status` updates from `pending` → `paid` + audit emitted.

### Tests for User Story 2 (RED phase)

- [ ] T031 [P] [US2] Integration test `tests/integration/events/re-upload-idempotency-eventcreate.test.ts` — FR-017 — upload Grant Thornton fixture twice → assert `rowsAlreadyImported=56` + `rowsProcessed=0` on 2nd run; modify one row's Notes between runs → assert that row's `payment_status` updates + audit emit on 2nd run
- [ ] T032 [P] [US2] Integration test `tests/integration/events/cancellation-cascade-eventcreate.test.ts` — FR-018 — upload CSV with attendee Status=Attending+Notes=Paid → re-upload with same attendee changed to Status=Cancelled → registration `payment_status` flips to `refunded`, partnership/cultural quota credited back to matched member, F6 audit emitted, NO F4 invoice mutation, NO Stripe call

### Implementation for User Story 2 (GREEN phase)

- [ ] T033 [US2] Extend per-row processor `src/modules/events/application/use-cases/_helpers/process-attendee-in-tx.ts` (or sibling helper) — state-change detection on re-upload per FR-018: compare existing registration row vs incoming CSV row for (Notes-inferred payment_status, Status, company_name); on change → UPDATE + audit emit; on `Status: Attending → Cancelled` AND prior payment_status was `paid` → set `payment_status = refunded` + call existing F6 quota credit-back use-case + emit cancellation audit. **No F4 cross-module call** (Q2 drop verified). No locked-field semantics (Q2 cut)

**Checkpoint**: Re-upload safety + cancellation cascade work end-to-end. T031+T032 GREEN.

---

## Phase 5: User Story 5 — Import history + error CSV download (Priority: P2)

**Story Goal**: Admin sees a paginated list of past imports + can download a CSV of only the error rows from any past import to fix in Excel + re-upload.

**Independent Test**: Run 3 imports across 3 different events. Navigate to `/admin/events/import/history`. List shows 3 rows, most-recent first, each with event name + timestamp + counts. Click "Download error CSV" on a past import that had failures → receives a CSV of only the failed rows + `_error_reason` column. Wait 31 days → "Download" link disabled with "Expired" message; row metadata still visible.

### Tests for User Story 5 (RED phase)

- [ ] T034 [P] [US5] Contract test `tests/contract/events/csv-import-history-api.test.ts` — ~12 tests from contracts/csv-import-history-api.md: 200 happy path + pagination + event_id filter + actor filter + expired-blob `errorCsvAvailable: false` + 400/401/403/404/503 + tenant isolation
- [ ] T035 [P] [US5] Contract test `tests/contract/events/error-csv-signed-url-api.test.ts` — ~10 tests from contracts/error-csv-signed-url-api.md: 307 happy path + audit emit + 404 not-found (own tenant) + 404 cross-tenant + cross-tenant probe HIGH-severity audit + 404 blob-swept + 500 signing-failure with NO audit emit + pino `f6_error_csv_signing_failure` log emit + 401/403/503
- [ ] T036 [P] [US5] Integration test `tests/integration/events/csv-import-records-history.test.ts` — seed 50 imports across 5 events on live Neon, query history page response, verify reverse-chrono order + pagination boundaries (page=1, page=N, page>last) + `eventId` filter + `actorUserId` filter. **+ Cross-tenant probe (Constitution Principle I clause 3 — closes `/speckit-analyze` finding F2)**: seed Tenant B with 10 additional imports; assert Tenant A admin's history query returns ONLY Tenant A's records (0 of Tenant B's leak through) via both `runInTenant` application-layer scope AND RLS+FORCE policy enforcement. Mirrors the cross-tenant test pattern from T017 + T037 to give the listing endpoint explicit path-level coverage.
- [ ] T037 [P] [US5] Integration test `tests/integration/events/error-csv-cross-tenant-isolation.test.ts` — Constitution Principle I clause 3 — Tenant A admin requests Tenant B's `recordId/error-csv` → 404 + `csv_import_cross_tenant_probe` HIGH-severity audit emit (extends Phase 7 R-S01 to signed-URL route)
- [ ] T038 [P] [US5] Integration test `tests/integration/events/error-csv-blob-roundtrip.test.ts` — live Vercel Blob — put + generateSignedUrl + admin-fetch (Blob URL resolves) + 15-min URL expiry + access audit emit + delete + post-delete URL resolves to 404
- [ ] T039 [P] [US5] Integration test `tests/integration/events/error-csv-blob-upload-failure.test.ts` — research.md R6 / E2 — mock Vercel Blob `put` to fail AFTER import tx commits → assert outcome is `completed` (rows persisted) + `errorCsvAvailable: false` in response + `f6_error_csv_upload_failed` pino log emit + admin can re-run import to retry blob generation

### Implementation for User Story 5 (GREEN phase)

- [ ] T040 [P] [US5] Use-case `src/modules/events/application/use-cases/list-csv-import-records.ts` — paginated query against `csv_import_records` for tenant scope, filter + sort, return shape per contracts/csv-import-history-api.md (includes `sourceFormat` per FR-025 + `errorCsvAvailable` computed)
- [ ] T041 [P] [US5] Use-case `src/modules/events/application/use-cases/generate-error-csv-signed-url.ts` — fetch record by `(tenantId, recordId)` (tenant-scoped RLS); verify `error_csv_blob_url IS NOT NULL` + `error_csv_expires_at > NOW()`; call `ErrorCsvStore.generateSignedUrl(15min)`; emit `csv_import_error_csv_downloaded` audit ONLY on signing success per strict-audit invariant; on cross-tenant probe (recordId exists in another tenant) emit `csv_import_cross_tenant_probe` HIGH severity (timing-safe surface); on signing failure emit `f6_error_csv_signing_failure` pino log (NOT audit) per S-01
- [ ] T042 [US5] Route handler `src/app/api/admin/events/import/history/route.ts` — GET with query-param pagination + filters per contract; admin-only RBAC inherited
- [ ] T043 [US5] Route handler `src/app/api/admin/events/import/[recordId]/error-csv/route.ts` — GET + 307 redirect to signed URL; admin-only RBAC + tenant scope; emit audit before redirect (strict invariant)
- [ ] T044 [P] [US5] Component `src/components/events/csv-import-history-table.tsx` — TanStack Table v8 (already used in F3) — columns: event name + start date + uploaded_at + actor + counts (total/processed/skipped/failed) + sourceFormat badge per FR-025 (Generic CSV vs EventCreate) + outcome + "Download error CSV" link (disabled when `errorCsvAvailable=false`); paginated 30/page
- [ ] T045 [US5] Extend result card `src/components/events/csv-import-result.tsx` — show `errorCsvAvailable` badge + persistent download link (resolves to same signed-URL endpoint from T043) so admin can download error CSV from BOTH the result card immediately + the history page later
- [ ] T046 [US5] History page `src/app/(staff)/admin/events/import/history/page.tsx` + `loading.tsx` — admin-only server component; uses `FormContainer` per 006-layout convention; CLS-0 skeleton pair; pagination via search params (`?page=2&perPage=30`)
- [ ] T047 [US5] i18n keys EN/TH/SV — ~10 new keys under `admin.events.import.history.*` (page title, table headers, counts labels, download CTA, expired-badge, pagination labels) × 3 locales = ~30 entries
- [ ] T048 [P] [US5] A11y E2E extension — add history page state to `tests/e2e/eventcreate-a11y.spec.ts` (4th visual state for this feature beyond Phase 7's 4)
- [ ] T049 [P] [US5] Use-case `src/modules/events/application/use-cases/sweep-expired-error-csv-blobs.ts` — query records where `error_csv_expires_at < NOW()` AND `error_csv_blob_url IS NOT NULL`; for each: call `ErrorCsvStore.delete(blobUrl)` + UPDATE record SET `error_csv_blob_url = NULL` + emit pino info log with deleted-count; idempotent on retry
- [ ] T050 [US5] Cron handler `src/app/api/internal/retention/sweep-error-csv-blobs/route.ts` — Bearer-auth via `CRON_SECRET` (existing env from F4/F5/F7); invokes T049; returns count; pinned to Node runtime

**Checkpoint**: History + error CSV download fully functional. T034–T039 GREEN. Pre-flag-flip operator gate: register cron-job.org entry (daily 05:00 Asia/Bangkok with email alert on ≥2-day consecutive failures per critique E5).

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Observability, sub-flag wiring, E2E, runbook, perf, final review gates

- [ ] T051 [P] OTel metrics in `src/lib/metrics.ts` — `eventcreate_csv_adapter_mode_detected_total{tenant, format}` counter (FR-025) + `eventcreate_csv_error_csv_downloaded_total{tenant}` counter (Q4 access frequency) wired to use-cases. Reuses Phase 7's 4 existing csv-import metrics
- [ ] T052 Pino aggregate log `f6_eventcreate_adapter_unknown_columns` — per-upload aggregate (not per-row) emitted at end of EventCreate-format imports, payload includes distinct unknown column names + counts; feeds product-team review of EventCreate schema evolution per FR-012
- [ ] T053 Sub-flag wiring — at top of `src/app/api/admin/events/import/route.ts`, check `FEATURE_F6_EVENTCREATE_ADAPTER` immediately after master `FEATURE_F6_EVENTCREATE` check; when sub-flag is `false`, force generic-CSV path even if EventCreate signature detected (rollback safety net per Spec § Rollback Plan)
- [ ] T054 [P] Runbook `docs/runbooks/eventcreate-csv-import.md` — operational runbook covering: TTL sweep cron failure recovery + manual sweep command, signed-URL leak response, EventCreate header drift detection (`csv_import_adapter_mode_detected_total{format="generic_csv"}` unexpected spike), mid-import flag-flip behaviour (E14), concurrent operation invariants (E-R2-2), Blob upload failure recovery (E2), event-mismatch override audit review (X-R2-1), rollback procedure per spec § Rollback Plan
- [ ] T055 [P] E2E test `tests/e2e/csv-eventcreate-import.spec.ts` — full workflow with Grant Thornton fixture via real-DOM Playwright; **manual-gate** per project convention (auto-skips when `E2E_ADMIN_EMAIL` + `E2E_ADMIN_PASSWORD` absent); reuses Phase 7 `tests/e2e/csv-fallback-import.spec.ts` shared-context pattern; `--workers=1` mandatory per CLAUDE.md memory; covers event-picker selection, inline-modal create (one scenario), upload, event-mismatch warning + override, result card + error-CSV download
- [ ] T056 Full CI gate — run `pnpm typecheck` + `pnpm lint` + `pnpm check:i18n` + `pnpm check:layout` + `pnpm test:integration` against live Neon Singapore. Expect all green. Fix any drift. Capture output to file per CLAUDE.md `feedback_no_repeated_test_runs` memory
- [ ] T057 Perf bench reuse — run Phase 7's `tests/integration/perf/csv-import-perf.test.ts` against the new EventCreate adapter path with `RUN_PERF=1` (cross-region dev bench, 200 rows); compare against Phase 7 baseline (~54.6s @ 200 rows); flag regression if >10% slower

### Pre-flag-flip Operator Gates (NOT engineering work — operator action documented)

These run outside the impl phase but block prod flag-flip:

- [ ] T058 [Operator gate] cron-job.org dashboard entry — daily 05:00 Asia/Bangkok hit on `/api/internal/retention/sweep-error-csv-blobs` with Bearer `CRON_SECRET`; configure email alert on ≥2 consecutive day failures per E5
- [ ] T059 [Operator gate] SC-006 prod-region perf bench — operator runs `RUN_PERF_PROD_REGION=1 pnpm test:perf` on a Vercel `sin1` runner with intra-region Neon `ap-southeast-1`; assert 1,000 EventCreate rows < 60s
- [ ] T060 [Operator gate] Manual E2E run on staging — `pnpm test:e2e --grep "csv-eventcreate-import" --workers=1` against staging deployment with seeded TSCC tenant + admin credentials + both committed fixtures
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
