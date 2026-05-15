# Quickstart — CSV Import Primary Path + EventCreate Format Adapter

**Date**: 2026-05-15 · **Feature**: `013-csv-import-eventcreate-format`

This quickstart is for developers picking up the feature mid-stream OR pairing with the spec author. Assumes you have working knowledge of the Chamber-OS repo (CLAUDE.md is the authoritative project guide).

---

## Read order

1. **[spec.md](spec.md)** — what we are building + why (start here)
2. **[plan.md](plan.md)** — Technical Context + Constitution Check + project structure
3. **[research.md](research.md)** — 7 decision records resolving design ambiguities
4. **[data-model.md](data-model.md)** — entities, migrations, RLS policies, state machines
5. **[contracts/](contracts/)** — 4 HTTP/audit contracts driving the RED-phase test inventory
6. *(after `/speckit.tasks` runs)* `tasks.md` — TDD-ordered task list

---

## Required local setup beyond the F6 Phase 7 baseline

Everything from F1–F8 stack remains. New surfaces required:

1. **Vercel Blob private bucket** for error-CSV storage:
   ```bash
   # .env.local — add (or confirm) BLOB_READ_WRITE_TOKEN from Vercel project settings
   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…
   ```
   Already used by F4 invoice PDF — chamber-os production already has this. Local dev shares the F4 token.

2. **CRON_SECRET** (already set for F4 + F5 + F7 cron handlers) — gates the new TTL-sweep cron at `/api/internal/retention/sweep-error-csv-blobs`. No new env var.

3. **Feature flag**: `FEATURE_F6_EVENTCREATE` — same flag as Phase 6 + Phase 7. Defaults true in dev; staging gates pre-launch. No new flag.

4. **Real EventCreate fixtures** for integration testing: committed under `docs/Attendee list/`:
   - `EventCreate_Guestlist-grant-thornton-workshop.csv` (56 rows)
   - `EventCreate_Guestlist-swecham-annual-general-meeting-2026.csv` (84 rows)
   - These are committed in source control (they contain SweCham member PII — see CLAUDE.md note about `.xlsm`/`.xlsx` being blocked but THESE `.csv` files are explicitly allowed because they are AS-ALREADY-EXPORTED by EventCreate and intentionally part of the integration test corpus).

---

## Implementation order (high-level)

This follows TDD discipline + Constitution Principle II (failing tests first).

### Day 1 — Foundation

1. Drizzle migration `0139_csv_import_records.sql` — table + indexes + RLS+FORCE policies. Run + verify RLS via psql.
2. Drizzle migration `0140_event_registrations_attendee_pdpa_consent.sql` — ADD COLUMN BOOLEAN NULL.
2a. Embed in migration `0139_csv_import_records.sql`: column `attendee_fingerprint TEXT NULL CHECK (length = 16)` + index `idx_csv_import_records_tenant_fingerprint_uploaded_at` for FR-019b safety net query (critique pass-2 X-R2-1).
3. Domain types: `csv-import-record-id.ts` + `eventcreate-csv-format.ts` value objects (incl. `classifyPdpaConsent` helper).
4. Application port: `error-csv-store.ts`.

> Note: original Day-1 plan included migration `0141_invoices_refund_review_state.sql` for F4 cross-cutting; that migration is DROPPED per Clarifications Session 2026-05-15 post-critique Q2.

### Day 2 — RED phase

6. `tests/contract/events/csv-import-eventcreate-format.test.ts` — 20 contract tests (all RED).
7. `tests/contract/events/csv-import-history-api.test.ts` — 12 contract tests (all RED).
8. `tests/contract/events/error-csv-signed-url-api.test.ts` — 10 contract tests (all RED).
9. `tests/unit/events/eventcreate-csv-adapter.test.ts` — header detection + column map + payment infer + Status filter (RED).
10. `tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts` — Constitution Principle I clause 3 test (RED).

### Day 3-4 — GREEN — adapter + parser

11. `eventcreate-csv-adapter.ts` Infrastructure — header detection, column mapping, name combine, mailto cleanup, payment infer, Status filter, PDPA consent extract.
12. `streaming-csv-importer.ts` — relax to RFC 4180 embedded-newline-in-quoted-cell (R1). Re-run Phase 7 parser tests to confirm no regression.
13. Drizzle repo `drizzle-csv-import-records-repo.ts`.
14. Vercel Blob adapter `vercel-blob-error-csv-store.ts` (implements `ErrorCsvStore` port).
15. Audit-port extension (2 new event types — `csv_import_error_csv_downloaded`, `csv_import_cross_tenant_probe` — + `csv_import_completed` `sourceFormat` payload extension).

### Day 5-6 — GREEN — use-cases + routes

16. Extend `import-csv.ts` use-case: `event_id` input + adapter routing + new outcomes (`event_not_selected` / `event_not_found` / `event_not_owned_by_tenant`). Cancellation detection emits existing F6 audit events; **no F4 cross-module call** (dropped per post-critique Q2); **no `dryRun` / `match_preview` path** (dropped per post-critique Q5).
17. New use-case `list-csv-import-records.ts`.
18. New use-case `generate-error-csv-signed-url.ts` (audit-emit gated on signed-URL success).
19. Route handlers:
    - `src/app/api/admin/events/import/route.ts` — extend (event_id form field + mode param)
    - `src/app/api/admin/events/import/history/route.ts` — new
    - `src/app/api/admin/events/import/[recordId]/error-csv/route.ts` — new
20. Composition adapter `src/lib/events-csv-import-deps.ts` — wire ErrorCsvStore + history factory.

### Day 7 — GREEN — UI

> **Cross-module dependency note**: F4 cross-cutting feature (refund-review badge + dismiss action + migration 0141) was DROPPED at the post-critique Q2 review. No F4-side changes in v1. If volume grows (chamber expansion / higher cancellation rate), revisit in v1.x using the original R7 design as reference.

21. `src/components/events/event-picker.tsx` — dropdown + filename-hint fuzzy match + **inline "Create event" modal** (P8/P-R2-5: reuses existing F6 `createEvent` use-case verbatim — no new use-case).
22. `src/components/events/event-mismatch-warning-dialog.tsx` — renders prior-imports list + "Continue anyway" (sets `force_proceed=true` and re-submits) / "Cancel" actions per FR-019b (critique pass-2 X-R2-1).
23. Extend `csv-mapping-form.tsx` — 4-phase wizard (event-picker → upload → submitting → completed) + warning dialog branch when outcome is `event_mismatch_warning`. Phase 7's structural 10-row preview retained inside the upload phase.
24. `src/components/events/csv-import-history-table.tsx` — paginated table with TanStack Table v8 (already used in F3).

### Day 8 — i18n + a11y

28. i18n keys: ~30 new EN keys × 3 locales = 90 entries under `admin.events.import.eventcreate.*`, `admin.events.import.matchPreview.*`, `admin.events.import.history.*`. Run `pnpm check:i18n` to verify parity.
29. Extend `tests/e2e/eventcreate-a11y.spec.ts` — 1 new visual state scan (event-picker).

### Day 9 — Integration + perf

30. `tests/integration/events/eventcreate-csv-real-fixtures.test.ts` — upload both committed CSV files on live Neon Singapore.
31. `tests/integration/events/csv-import-records-history.test.ts` — history list + pagination + access audit.
32. `tests/integration/events/error-csv-cross-tenant-isolation.test.ts` — Constitution I clause 3 for signed-URL route.
33. Re-run Phase 7 perf bench (`csv-import-perf.test.ts`) to confirm no regression in 1k-row import speed.

### Day 10 — Cron + observability + runbook

34. `src/modules/events/application/use-cases/sweep-expired-error-csv-blobs.ts` — TTL sweep.
35. `src/app/api/internal/retention/sweep-error-csv-blobs/route.ts` — Bearer-auth cron handler.
36. cron-job.org dashboard entry — daily 05:00 Asia/Bangkok.
37. OTel metrics in `src/lib/metrics.ts` — 2 new counters.
38. Pino structured logs — new `f6_eventcreate_adapter_unknown_columns` event.
39. `docs/runbooks/eventcreate-csv-import.md` — operator runbook (TTL sweep failure, signed-URL leak recovery, header detection drift).

### Day 11 — E2E + ship gates

40. `tests/e2e/csv-eventcreate-import.spec.ts` — full workflow with Grant Thornton fixture (manual-gate; reuses Phase 7 csv-fallback E2E shared-context pattern).
41. Run `pnpm test:integration` → expect 100% green on live Neon Singapore.
42. Run `pnpm check:i18n` + `pnpm check:layout` + `pnpm typecheck` + `pnpm lint` → all green.
43. `/speckit-staff-review-run` — multi-agent pass.

---

## Wiring summary — what's reused vs. new

| Surface | Reused from F6 Phase 7 | New in this feature |
|---|---|---|
| Use-case orchestrator | `importCsv` (extended, not rewritten) | adapter routing + event-picker integration |
| Streaming parser | `streaming-csv-importer.ts` | Relax embedded-newline (R1) |
| Audit event types | 11 (incl. `csv_import_completed` extended) | 2 new (`csv_import_error_csv_downloaded`, `csv_import_cross_tenant_probe`). `csv_import_refund_review_signalled` originally planned but dropped per post-critique Q2 |
| OTel metrics | 4 existing | 2 new |
| Rate-limit | 5/hr per (tenant, actor) | Reused |
| RLS / FORCE policies | Phase 7 pattern | Applied to new `csv_import_records` |
| Tenant isolation | Branded `TenantId` + `runInTenantTx` | Inherits — new cross-tenant test for adapter path |
| Idempotency | `sha256(event_external_id NUL email_lower NUL registered_at)` | Reused; `event_external_id` now sourced from admin-selected event |
| Per-batch tx + SAVEPOINT | Phase 7 NEW-A pattern | Reused |
| Error CSV storage | n/a (Phase 7 had no persistence) | New: Vercel Blob + 30-day TTL + signed-URL |
| Match-preview dry-run | n/a | ~~DROPPED v1~~ per post-critique Q5 |
| Event linking | n/a (Phase 7 took event metadata from CSV columns) | New: pre-create event then select dropdown (Q1) |
| Cross-cutting F4 badge | n/a | ~~DROPPED v1~~ per post-critique Q2 |

---

## Pre-flag-flip operator checklist (inherited + new)

Inherited from Phase 7 — still applicable:
- [ ] T091-class manual E2E run on staging (full workflow with both committed fixtures)
- [ ] SC-006 prod-region perf bench (`RUN_PERF_PROD_REGION=1 pnpm test:perf`) on Singapore-resident runner
- [ ] Maintainer co-sign on security checklist (admin-only + audit-logged)

New for this feature:
- [ ] cron-job.org dashboard entry for `/api/internal/retention/sweep-error-csv-blobs` (daily 05:00 Asia/Bangkok; Bearer-auth via `CRON_SECRET`)
- [ ] Verify Vercel Blob bucket policy is private (no public read; signed-URL-only access)
- [ ] DPO sign-off on PDPA Article 23 retention notice (30-day error-CSV TTL captures Section 37 minimization principle)
- [ ] F4 module owner ack: invoice list UI updated, `Dismiss review` action wired
- [ ] OTel dashboard: 2 new metrics added to F6 board

---

## Where to ask if you get stuck

- **EventCreate format quirks**: open `docs/Attendee list/*.csv` in Excel; the column names + sample values are the source of truth.
- **F4 integration**: pair with F4 module owner before writing the cross-cutting code (data-model R7 for the contract).
- **Vercel Blob signed-URL semantics**: see F4 invoice PDF code at `src/modules/invoicing/infrastructure/vercel-blob-invoice-pdf-store.ts` for the pattern.
- **RLS + FORCE policies**: see F3 `members` table or F4 `invoices` table for the canonical pattern.
- **Cross-tenant integration tests**: see `tests/integration/events/tenant-isolation.test.ts` (extended with R-S01 in Phase 7 staff-review) for the pattern.

When in doubt, the CLAUDE.md memory at `~/.claude/projects/.../memory/MEMORY.md` has the project's hard-won lessons (E2E workers=1, no repeated heavy test runs, verify CPs before marking, etc.). Read the relevant entries before you start.
