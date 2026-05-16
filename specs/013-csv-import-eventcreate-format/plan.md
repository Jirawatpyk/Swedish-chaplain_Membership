# Implementation Plan: CSV Import Primary Path + EventCreate Format Adapter

**Branch**: `013-csv-import-eventcreate-format` | **Date**: 2026-05-15 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/013-csv-import-eventcreate-format/spec.md`

**Note**: This plan is a follow-on to F6 Phase 7 (012-eventcreate-integration). All Phase 7 audit, observability, idempotency, RLS+FORCE, and rate-limit scaffolding is reused — this feature extends the existing surface, not greenfield work.

---

## Summary

CSV import was shipped in F6 Phase 7 as a **secondary fallback** assuming Zapier→EventCreate webhooks would be the primary daily-driver. That assumption broke when EventCreate's API was confirmed Enterprise-only — Zapier cannot reach EventCreate without API access, leaving the Phase 6 webhook endpoint without a data source for EventCreate tenants. This feature **repositions CSV import as the primary ingest path for all tenants** and adds first-class support for EventCreate's native "Guestlist" export format (29-30 columns, embedded multi-line address cells, payment status inferred from Notes column, etc. — directly verified against real exports under `docs/Attendee list/`).

**Technical approach**:
- Add an EventCreate-format **adapter** in the Infrastructure layer that maps EventCreate's 29-30 native columns to the existing Phase 7 canonical `CsvRow` shape, including: header-presence detection (6-column heuristic), First+Last name combination, `mailto:` email cleanup, payment-status inference from `Notes`, `Status` filter (only `Attending` rows proceed), PDPA consent capture into row metadata, and embedded-newline-in-quoted-cell support (RFC 4180-compliant — relaxing the Phase 7 strict parser that rejected these).
- Replace Phase 7's "header columns must include event metadata" requirement with a **pre-upload event picker**: admin selects an existing F6 event from a dropdown before processing; the chosen event's metadata is injected into every parsed row before reaching `processAttendeeInTx`. This honours the Q1 clarification ("Chamber-OS is SoR for events; CSV upload is post-event reconciliation").
- ~~Extend Phase 7's `importCsv` use-case with a match-preview dry-run path~~ — DROPPED v1 per Clarifications post-critique Q5 (US3 cut).
- Persist per-import audit records in a new `csv_import_records` table (PII-minimal — counts + outcome + admin + linked event + Blob URL + expiry), and store the post-import error-rows CSV in a private Vercel Blob with 30-day TTL + signed-URL download + access audit (Q4 clarification).
- Surface a "Pending refund review" badge on F4 invoices whose linked event_registration was cancelled via CSV re-upload (Q3 clarification) — no automated Stripe refund.
- Reuse 100% of Phase 7's audit-event taxonomy, OTel metrics, rate-limit, RLS, and tenant-isolation scaffolding. The generic-CSV path stays unchanged so existing non-EventCreate workflows are not regressed.

---

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (unchanged from F1–F8) — `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · `@vercel/blob` (already used by F4 invoice PDF) · existing F6 Phase 7 streaming parser (`src/modules/events/infrastructure/streaming-csv-importer.ts`) · `i18n-iso-countries` (F3) · `react-hook-form` + `zod` for the event-picker form. **Zero new npm dependencies** (Constitution X).
**Storage**: Neon Postgres `ap-southeast-1` (Singapore) — 1 new table `csv_import_records` + extension columns on existing `event_registrations` (per row attendee_pdpa_consent_acknowledged BOOLEAN — classified at import time per PDPA minimization). Vercel Blob private bucket for error-rows CSV (TTL-swept). No payment data touched (Principle IV n/a).
**Testing**: Vitest (unit + contract + integration on live Neon Singapore) · Playwright (E2E with `--workers=1` per memory) · `@axe-core/playwright` (WCAG 2.1 AA across 3 visual states: idle / preview-error / completed — match-preview state removed per Q5 US3 cut) · `fast-check` (property tests for header-detection heuristic edge cases) — all already in F1–F8 stack
**Target Platform**: Vercel Fluid Compute (`sin1` Singapore — F1 documented deviation from "Thailand primary" preserved)
**Project Type**: SaaS web-service (Multi-Tenant Aware, Single-Tenant Deployed per `docs/saas-architecture.md`)
**Performance Goals**:
- CSV upload + result rendering: full workflow p95 < **3 minutes** including admin reading time (SC-001)
- Import processing: 1,000-row CSV < 60s (inherited from Phase 7 SC-006; UNVERIFIED on prod-region — pre-flag-flip operator gate retained)
- ~~Match-preview accuracy~~ — DROPPED v1 (US3 cut per Q5)
- Error CSV signed-URL generation: p95 < 250ms (admin click → download begins)
**Constraints**:
- 5 MiB file cap + 1,000 row cap from Phase 7 retained for v1 (raises deferred to F6.2)
- 5 imports/hour per (tenant, actor) rate-limit from Phase 7 retained
- Per-(tenant, event) advisory lock on import — only ONE import per event running at a time (prevents racing re-uploads)
- Tenant isolation: 2-layer (app-level branded `TenantId` + DB-level RLS+FORCE) — Constitution Principle I clause 3 cross-tenant integration test mandatory (Review-Gate blocker)
- PDPA: 30-day TTL on error-CSV Blob; signed URL 15-min expiry; every download emits audit event
- All forbidden-fields-in-logs rules from CLAUDE.md apply (no passwords, tokens, session IDs, raw email bodies; attendee emails are NOT forbidden but are PDPA-tracked)
**Scale/Scope**: SweCham scale = ~131 members × 50-100 events/year × ~50 attendees/event = ~5,000 attendees/year/tenant. EventCreate exports observed: 56 rows (workshop) + 84 rows (AGM). 1k-row cap covers chamber-day-of major events with headroom.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.4.0*

### NON-NEGOTIABLE gates (4 / 4 evaluated)

- [X] **I. Data Privacy & Security** — PASS
  - **Lawful basis**: PDPA Section 24 (legitimate interest — chamber member-roster maintenance) + GDPR Article 6(1)(b) (contract performance for paid attendees). Documented in the F6 § Compliance docs already.
  - **PII surfaces touched**: attendee emails (existing F6 surface), attendee names (existing), attendee company (existing), **attendee PDPA consent CLASSIFICATION** (NEW — classified at import time per FR-009 into `event_registrations.attendee_pdpa_consent_acknowledged BOOLEAN`. Raw consent text is NOT stored per PDPA minimization principle, Clarifications Session 2026-05-15 post-critique. Non-blocking on missing/non-consent per FR-009).
  - **RBAC**: admin-only routes guarded by `adminOnlyGuard` from F1; 404 surface-disclosure for non-admin per FR-035; manager/member roles get 403/404 respectively (matches F6 Phase 6).
  - **OWASP touched-surfaces**: A01 Broken Access Control (admin-only routes), A03 Injection (CSV parser hand-rolled — must enforce strict tokenization to prevent CSV formula injection per Excel `=cmd|...` attack vector — see research.md R3), A04 Insecure Design (PDPA consent capture without blocking import — documented as deliberate per FR-009).
  - **TLS 1.2+ / at-rest encryption**: Neon Postgres + Vercel Blob both encrypt at rest by platform default; TLS in transit enforced by Vercel Edge.
  - **Tenant isolation**: 2-layer (app branded `TenantId` from F2 + DB RLS+FORCE from F2). Reuses Phase 7's `runInTenantTx` infrastructure. **Cross-tenant integration tests REQUIRED (Review-Gate blockers per Principle I clause 3)** — v1 ships with TWO new tests on top of Phase 7's existing R-S01: `tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts` (EventCreate-adapter-mode cross-tenant probe) AND `tests/integration/events/error-csv-cross-tenant-isolation.test.ts` (signed-URL cross-tenant probe + `csv_import_cross_tenant_probe` audit emit assertion). Both Review-Gate blockers — not deferred.
  - **Audit log**: **3 new audit event types** — `csv_import_error_csv_downloaded` (Q4 — every signed-URL access), `csv_import_cross_tenant_probe` (high-severity per Principle I clause 4), `csv_import_event_mismatch_overridden` (critique pass-2 X-R2-1 — admin override of event-mismatch warning, severity=warn). Reuse Phase 7's `csv_import_completed` (extended with optional `sourceFormat`), `csv_import_row_failed`. ~~`csv_import_refund_review_signalled`~~ dropped per Clarifications Session 2026-05-15 post-critique Q2. **Total = 11 + 3 = 14 F6 audit events** post-feature (see `contracts/audit-port.md`).
  - **Super-admin impersonation**: n/a (F13 future).

- [X] **II. Test-First Development** — PASS
  - **TDD discipline**: every FR has ≥1 acceptance test author before implementation (US1–US5 = 13 acceptance scenarios + 10 edge cases). Phase 1 contract tests RED before adapter implementation lands.
  - **Coverage targets**: Application use-cases ≥80% line + 80% branch (matches Phase 7); **100% branch on adapter-mode header detection + Status filter** (security-adjacent — wrong Status filter could leak Cancelled attendees into quota count, a correctness + audit-trust issue). Domain types 100% line.
  - **Test inventory plan**:
    - **Unit** (`tests/unit/events/eventcreate-csv-adapter.test.ts`): header-detection heuristic (presence-of-6, fall-through, fast-check property), First+Last combine, mailto cleanup, payment-status inference table, Status filter, PDPA consent extraction
    - **Contract** (`tests/contract/events/csv-import-eventcreate-format.test.ts`): same HTTP outcomes as T090 but routed through EventCreate adapter mode; new 400 for "event not selected"; signed-URL endpoint contract
    - **Integration** (`tests/integration/events/eventcreate-csv-real-fixtures.test.ts`): upload BOTH committed CSV files (grant-thornton + AGM) on live Neon Singapore, assert 100% rows-Attending land, audit emit, idempotency receipts populated
    - **Integration** (`tests/integration/events/csv-import-records-history.test.ts`): create N imports, query history page response, verify pagination + access audit
    - **Integration** (`tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts`): EventCreate-format cross-tenant probe (extends R-S01 from Phase 7 to the new adapter mode)
    - **E2E** (`tests/e2e/csv-eventcreate-import.spec.ts`): full workflow on real fixtures — event-picker → upload → preview → confirm → result + error-CSV download (manual-gate per project convention)
    - **A11y** (extend `tests/e2e/eventcreate-a11y.spec.ts`): add scans for **3 new visual states** beyond Phase 7's 4 — (a) event-picker dropdown closed, (b) inline event-create modal open (P-R2-5), (c) event-mismatch warning dialog open (X-R2-1). Each runs `@axe-core/playwright` against the rendered state.
    - **Inline event-create modal tests** (closes critique pass-2 E-R2-5): unit test for `<EventCreateInlineModal>` component (open/close behavior + Zod validation + form-submit invokes reused `createEvent` use-case via mock); integration test that "modal create → event dropdown auto-selects newly-created event → import proceeds" — ~3 tests
    - **Event-mismatch safety net tests** (closes critique pass-2 X-R2-1): unit test for fingerprint computation (sorted, lowercased, only `Status=Attending` emails); contract test for the new `event_mismatch_warning` 200 response shape; integration test on live Neon for "upload to event A → upload same file to event B without force_proceed → returns warning with correct priorImports list → admin re-submits with force_proceed=true → import proceeds + audit emit `csv_import_event_mismatch_overridden`" — ~5 tests
  - **Critical paths 100% branch**: header detection (3 branches per FR-001 + fallback) · Status filter (FR-007) · Notes→payment_status inference (FR-008) · signed-URL generation + access audit (Q4)

- [X] **III. Clean Architecture** — PASS
  - **Layer mapping**:
    - Presentation: `src/app/(staff)/admin/events/import/page.tsx` (extended), `…/history/page.tsx` (NEW), `…/error-csv/[recordId]/route.ts` (NEW signed-URL endpoint), `src/components/events/event-picker.tsx` (NEW — includes inline "Create event" modal that reuses the existing F6 `src/modules/events/application/use-cases/create-event.ts` use-case verbatim — admin RBAC + Zod validation + audit emit all inherited, no new use-case introduced per critique P-R2-5), `src/components/events/csv-import-history-table.tsx` (NEW), `src/components/events/event-mismatch-warning-dialog.tsx` (NEW — closes critique X-R2-1; renders the prior-imports list and "Continue anyway" / "Cancel" actions)
    - Application: extend `src/modules/events/application/use-cases/import-csv.ts` with `eventId` input (event-picker); NEW use-cases `list-csv-import-records.ts` + `generate-error-csv-signed-url.ts`; NEW port `ErrorCsvStore` (Application contract for Blob adapter)
    - Domain: new branded types `CsvImportRecordId`, `ErrorCsvBlobUrl`; new value objects `EventCreateAdapterMode`, `PdpaConsentAcknowledged` (boolean classification — replaced `PdpaConsentText` per Clarifications Session 2026-05-15 post-critique)
    - Infrastructure: NEW `src/modules/events/infrastructure/eventcreate-csv-adapter.ts` (header detection + column mapping + payment inference + Status filter), NEW `src/modules/events/infrastructure/vercel-blob-error-csv-store.ts` (implements `ErrorCsvStore` port — wraps `@vercel/blob`)
  - **Dependency rule**: Domain has zero `next`/`drizzle`/`@vercel/blob` imports (enforced by existing ESLint rule on `src/modules/events/domain/**`). Application imports only Domain + Application ports. Infrastructure depends inward.
  - **Module barrel**: `src/modules/events/index.ts` re-exports new use-cases + types. ESLint `no-restricted-imports` already blocks deep imports.
  - **Composition root**: `src/lib/events-csv-import-deps.ts` (already exists, extended with new ports + Blob adapter factory).

- [X] **IV. Payment Security (PCI DSS)** — N/A — no payment surface touched. F4 cross-cutting dropped per Clarifications Session 2026-05-15 post-critique Q2; no F4 module changes in this feature.

### Core principle gates (6 / 6 evaluated)

- [X] **V. Internationalization (EN/TH/SV)** — PASS — estimated ~35 new EN keys × 3 locales = ~105 entries (refreshed post-Q5 cut: removed `admin.events.import.matchPreview.*`; added `admin.events.import.eventPicker.*` for inline modal + `admin.events.import.eventMismatch.*` for warning dialog from X-R2-1). Final namespace plan: `admin.events.import.eventcreate.*` (adapter labels) · `admin.events.import.eventPicker.*` (dropdown + inline modal) · `admin.events.import.eventMismatch.*` (warning dialog) · `admin.events.import.history.*` (history page) · `admin.events.import.errors.*` (problem-detail messages). TH-primary required for admin audit messages (Thai tax adjacency). SV translations follow chamber-terminology convention (kammaradministratör, etc.).

- [X] **VI. Inclusive UX (WCAG 2.1 AA + mobile-first)** — PASS — 3 new visual states need axe-core scans (event-picker dropdown, inline event-create modal per P-R2-5, event-mismatch warning dialog per X-R2-1) added to existing `eventcreate-a11y.spec.ts`. Mobile 320px breakpoint: event-picker + modal + dialog use existing F6 layout primitives + Radix UI Dialog (already a11y-compliant). **Reduced-motion** inherits from Phase 7 `motion-reduce:animate-none`.

- [X] **VII. Performance & Observability** — PASS
  - **Performance budgets**:
    - ~~Match-preview dry-run~~ — DROPPED (US3 cut)
    - Full import workflow p95 < 3 min wall-clock incl. admin reading (SC-001)
    - Error-CSV signed-URL endpoint p95 < 250ms
  - **Observability**:
    - 2 new OTel metrics: `eventcreate_csv_adapter_mode_detected_total{format}` (counter — track EventCreate vs. generic adoption per Q5/FR-025); `eventcreate_csv_error_csv_downloaded_total{tenant}` (counter — Q4 access frequency)
    - Reuse 4 existing Phase 7 metrics (csvImportCompleted / csvImportDurationSeconds / csvImportRateLimitFallback / csvImportAuditEmitFailed)
    - 1 new alert: "EventCreate adapter detection rate < 50% on uploads to tenants known to use EventCreate" (signals header drift)
    - 1 new pino structured log event: `f6_eventcreate_adapter_unknown_columns` (per-upload aggregate of columns we skipped — feeds future schema evolution insight, NOT a per-row log)

- [X] **VIII. Reliability** — PASS
  - **Error paths**: 7 use-case-level outcomes (`completed` / `timeout` / `invalid_header` / `unexpected_error` / `event_not_selected` / `event_not_found` / `event_not_owned_by_tenant`) + per-row outcomes (parse_failed / row_failed with `FailureStage` taxonomy from Phase 7 H5 hoist).
  - **Transactional boundaries**: per-batch outer tx + per-row SAVEPOINT (inherited from Phase 7 NEW-A ghost-row guard). No dry-run tx in v1 (match-preview dropped per Q5).
  - **Idempotency**: row hash key from Phase 7 (`sha256(event_external_id NUL email_lower NUL registered_at)`) — note `event_external_id` is now sourced from the admin-selected event (FR-003) not from the CSV. **Per-import advisory lock** `pg_advisory_xact_lock(hashtextextended('csv-import:' || tenantId || ':' || eventId, 0))` prevents two concurrent imports against the same event.
  - **Audit entries**: 12 events total (11 Phase 7 + 1 new `csv_import_error_csv_downloaded`).

- [X] **IX. Code Quality Standards** — PASS — TypeScript strict, ESLint clean, Conventional Commits with `[Spec Kit]` prefix, ≥1 reviewer (admin-only routes touching audit log require ≥2 with security signer per CLAUDE.md governance). Solo-maintainer substitute clause applies if no second reviewer (per v1.4.0).

- [X] **X. Simplicity (YAGNI)** — PASS — Zero new npm dependencies. Reuses 100% of Phase 7's audit, OTel, idempotency, RLS, rate-limit infrastructure. The EventCreate adapter is a thin (~250 LOC estimated) Infrastructure-layer transform; everything else is delta on existing Phase 7 surfaces. Match-preview and import-history are net-new features but each is a single use-case + single page + single API surface.

### Justified deviations (Complexity Tracking)

None — all 10 gates pass cleanly. The single "complexity" is the embedded-newline parser relax (Phase 7 strictly rejected per R8; this feature must accept per RFC 4180) — but this is a parser correctness fix, not a complexity increase. Documented in research.md R1.

---

## Project Structure

### Documentation (this feature)

```text
specs/013-csv-import-eventcreate-format/
├── plan.md                     # This file
├── research.md                 # Phase 0 — 7 decision records
├── data-model.md               # Phase 1 — entities + schema + migrations
├── quickstart.md               # Phase 1 — developer onboarding for this feature
├── contracts/
│   ├── csv-import-eventcreate-api.md   # Extended Phase 7 contract for EventCreate adapter mode + event_not_selected error
│   ├── csv-import-history-api.md       # GET /api/admin/events/import/history
│   ├── error-csv-signed-url-api.md     # GET /api/admin/events/import/<recordId>/error-csv → 307 redirect to signed Blob URL
│   └── audit-port.md           # Extension of F6 audit-port: 3 new event types
├── checklists/
│   └── requirements.md         # Already exists (5/5 clarifications resolved)
└── tasks.md                    # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── app/
│   ├── (staff)/admin/events/import/
│   │   ├── page.tsx                                   # EXTEND: add event-picker phase before upload phase
│   │   ├── loading.tsx                                # EXTEND: skeleton for event-picker
│   │   └── history/
│   │       ├── page.tsx                               # NEW: CSV import history table
│   │       └── loading.tsx                            # NEW: skeleton
│   └── api/admin/events/import/
│       ├── route.ts                                   # EXTEND: dryRun query param + event_id form field
│       ├── history/route.ts                           # NEW: GET history
│       └── [recordId]/error-csv/route.ts              # NEW: signed-URL redirect
├── components/events/
│   ├── csv-mapping-form.tsx                           # EXTEND: 4-phase wizard (event-picker → upload → preview → submitting/completed)
│   ├── csv-import-result.tsx                          # UNCHANGED
│   ├── event-picker.tsx                               # NEW: admin selects event + filename-hint fuzzy match
│   └── csv-import-history-table.tsx                   # NEW: paginated past imports table
├── modules/events/
│   ├── application/
│   │   ├── use-cases/
│   │   │   ├── import-csv.ts                          # EXTEND: dryRun param + event_id input + EventCreate adapter routing
│   │   │   ├── list-csv-import-records.ts             # NEW
│   │   │   └── generate-error-csv-signed-url.ts       # NEW: emit audit + 15-min signed URL
│   │   └── ports/
│   │       ├── error-csv-store.ts                     # NEW: ErrorCsvStore port (put/get/sign/delete)
│   │       └── audit-port.ts                          # EXTEND: csv_import_error_csv_downloaded event type
│   ├── domain/
│   │   ├── csv-import-record-id.ts                    # NEW: branded type
│   │   └── eventcreate-csv-format.ts                  # NEW: classifyPdpaConsent() classifier + adapter-mode discriminator
│   └── infrastructure/
│       ├── eventcreate-csv-adapter.ts                 # NEW: header detection + column map + payment infer + Status filter
│       ├── streaming-csv-importer.ts                  # EXTEND: support embedded-newline-in-quoted-cell (RFC 4180); add adapter-mode router
│       ├── vercel-blob-error-csv-store.ts             # NEW: implements ErrorCsvStore (private bucket + signed URL + TTL metadata)
│       ├── drizzle-csv-import-records-repo.ts         # NEW
│       └── pino-audit-port.ts                         # EXTEND: serialize new event type
├── lib/
│   └── events-csv-import-deps.ts                      # EXTEND: ErrorCsvStore wiring + history list factory
└── i18n/messages/{en,th,sv}.json                      # +30 keys × 3 locales = +90 entries

drizzle/migrations/
├── 0139_csv_import_records.sql                        # NEW: table + indexes + RLS+FORCE policies
├── 0140_event_registrations_attendee_pdpa_consent.sql # NEW: ALTER TABLE add column + backfill NULL
├── 0141_f6_csv_import_audit_event_types.sql           # NEW (T-extra, discovered at T008): audit_event_type enum ADD VALUE for 3 F6.1 events (csv_import_error_csv_downloaded / csv_import_cross_tenant_probe / csv_import_event_mismatch_overridden)
└── 0144_f6_event_created_audit_type.sql               # NEW (T026 full-impl): audit_event_type enum ADD VALUE 'event_created' for admin-manual event creation surface (closes the "no way to seed events" gap left by EventCreate API gating per project_eventcreate_api_gated memory)

tests/
├── contract/events/csv-import-eventcreate-format.test.ts       # NEW
├── unit/events/eventcreate-csv-adapter.test.ts                 # NEW
├── integration/events/eventcreate-csv-real-fixtures.test.ts    # NEW (uses docs/Attendee list/*.csv)
├── integration/events/csv-import-records-history.test.ts       # NEW
├── integration/events/csv-import-cross-tenant-eventcreate.test.ts  # NEW (Constitution I clause 3)
└── e2e/csv-eventcreate-import.spec.ts                          # NEW (manual-gate; reuses Phase 7 csv-fallback E2E pattern)

# axe scan extension
tests/e2e/eventcreate-a11y.spec.ts                              # EXTEND: 1 new visual state (event-picker)

docs/runbooks/
└── eventcreate-csv-import.md                                   # NEW: operator runbook (TTL sweep, signed-URL leaked recovery, header detection drift)
```

**Structure Decision**: F6 Phase 7's directory layout (`src/modules/events/`) is preserved verbatim. This feature adds 1 new bounded-context sub-folder pattern — the EventCreate adapter lives in `infrastructure/eventcreate-csv-adapter.ts` (sibling to `streaming-csv-importer.ts`), not as a new module. Rationale: the adapter is a thin format-translation layer, not a new bounded context — it has no Domain logic of its own and only exists to feed the existing `processAttendeeInTx` helper.

---

## Complexity Tracking

> **No Constitution violations.** All 10 gates pass cleanly. No entries.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |

---

## Re-evaluation after Phase 1 (post-design — 2026-05-15)

- [X] **Constitution Check still passing?** — YES. All 10 gates remain PASS. Phase 1 artifacts introduced no Constitution-impacting design choices beyond what plan.md already committed. **3** new audit event types (`csv_import_error_csv_downloaded` / `csv_import_cross_tenant_probe` / `csv_import_event_mismatch_overridden`) documented in `contracts/audit-port.md`; the `csv_import_error_csv_downloaded` event closes the PDPA Article 30 (record of processing) audit trail requirement that Q4's signed-URL pattern necessarily creates; `csv_import_event_mismatch_overridden` added by critique pass-2 X-R2-1 for FR-019c forensic trail. (`csv_import_refund_review_signalled` dropped per Clarifications Session 2026-05-15 post-critique Q2.)
- [X] **Are any contracts violating dependency rule?** — NO. The new `ErrorCsvStore` Application port (data-model.md § 4) has Domain types in its input/output only; the `VercelBlobErrorCsvStore` Infrastructure implementation depends inward on the port. No `@vercel/blob` types leak past Infrastructure. No F4 cross-module calls remain after Q2 cut — F4 module is untouched by this feature.
- [X] **Cross-tenant integration test design covers EventCreate adapter mode?** — YES. Two new integration tests are explicitly planned:
  - `tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts` — uploads an EventCreate-format CSV under Tenant B credentials, asserts Tenant A's `event_registrations` + `csv_import_records` tables remain empty (extends Phase 7 R-S01 to the adapter path).
  - `tests/integration/events/error-csv-cross-tenant-isolation.test.ts` — Tenant A admin requests Tenant B's `recordId/error-csv` endpoint, asserts 404 + `csv_import_cross_tenant_probe` audit emit. Both tests Review-Gate blockers per Principle I clause 3.
- [X] **Performance gates revisited?** — YES. Error-CSV signed-URL endpoint < 250ms p95 (Blob SDK is in-memory metadata call, not network round-trip per request). Full-workflow < 3min (SC-001) achievable on cross-region Neon based on Phase 7 200-row 54.6s baseline.
- [X] **No new Complexity Tracking entries** — design choices in Phase 0 + Phase 1 stayed within Constitution. The EventCreate adapter is a thin Infrastructure-layer transform; error-CSV storage matches F4 invoice PDF pattern; F4 cross-cutting + match-preview + CSV template all dropped per Clarifications Session 2026-05-15 post-critique.

---

## Operational notes (closes critique E5 + E14)

**Mid-import flag-flip behavior** (E14): the `FEATURE_F6_EVENTCREATE` master flag + `FEATURE_F6_EVENTCREATE_ADAPTER` sub-flag are both checked **ONCE** at request entry (top of the route handler). An import already in progress at flag-flip time completes normally — the use-case does NOT graceful-stop mid-batch because doing so would risk partial-state inconsistency (some batches committed, some rolled back, with no clean recovery semantics). New requests arriving after a flag-flip get 503 (master) or fall back to generic-CSV path (sub-flag). Operator runbook documents this: "flag-flip drains in seconds for new requests, but admins should expect any in-flight import to complete first."

**Concurrent operation invariants** (closes critique pass-2 E-R2-2): the per-(tenant, event) `pg_advisory_xact_lock(hashtextextended('csv-import:' || tenantId || ':' || eventId, 0))` lock guarantees: (1) **same-event same-tenant concurrent imports**: BLOCKED — the second admin waits on the lock; safe. (2) **different-events same-tenant concurrent imports**: PROCEED in parallel — two separate locks; total connection pool usage = 2 × `batchConcurrency` = 6 connections, within Neon Singapore default pool of 10. (3) **import + manual F6 admin-UI edit on the same registration**: race window exists; FR-019 ("re-upload always wins") covers the conflict resolution — the CSV import overwrites any concurrent admin edit, with both changes traceable in audit log. Multi-admin per-tenant coordination is a v1.x consideration when chamber count grows.

**TTL sweep cron failure monitoring** (E5): the daily cron-job.org trigger to `/api/internal/retention/sweep-error-csv-blobs` (05:00 Asia/Bangkok) MUST be configured with cron-job.org email alerting on **consecutive failures (≥2 days)**. Email goes to the maintainer-on-duty inbox. Manual fallback documented in `docs/runbooks/eventcreate-csv-import.md` (planned): "run `pnpm tsx scripts/sweep-error-csv-blobs.ts` from local if cron-job.org is offline; SLA target is blob deletion within 35 days max (5-day grace beyond the 30-day TTL — PDPA Section 37 minimization principle remains satisfied)."

---

## Outstanding pre-flag-flip operator gates (inherited from F6 Phase 7)

These gates remain from F6 Phase 7 and apply to the v1 ship of this feature:

- T091 manual E2E run on staging (`pnpm test:e2e --grep "csv" --workers=1`)
- SC-006 prod-region perf bench (`RUN_PERF_PROD_REGION=1 pnpm test:perf` on Singapore-resident runner)
- Maintainer co-sign on security checklist (CSV path is admin-only + audit-logged; PCI n/a)
- Cron-job.org dashboard entry for **new** Blob TTL sweep cron at `/api/internal/retention/sweep-error-csv-blobs` (daily 05:00 Asia/Bangkok; Bearer-auth)

---

*Phase 0 (research.md) and Phase 1 (data-model.md, contracts/, quickstart.md, agent context update) follow as separate artefacts in this directory.*
