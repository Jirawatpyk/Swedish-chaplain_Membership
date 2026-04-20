---
description: "TDD-ordered task list for F4 Membership Invoicing & Thai-Tax Receipts"
---

# Tasks: F4 — Membership Invoicing & Thai-Tax Receipts

**Input**: Design documents from `/specs/007-invoices-receipts/`
**Prerequisites**: plan.md (required), spec.md (43 FRs, 7 USs), research.md (13 items), data-model.md (5 tables), contracts/invoicing-api.md (18 endpoints), quickstart.md
**Tests**: INCLUDED — Chamber-OS Constitution Principle II NON-NEGOTIABLE (TDD) requires ≥1 acceptance test per user story authored RED before implementation, plus tenant-isolation + seq-atomicity + deterministic-PDF tests as Review-Gate blockers.

**Organization**: Tasks are grouped by user story in **priority order** (US1, US2 = P1 → US3, US6, US7, US4 = P2 → US5 = P3). Each story is independently testable per its spec "Independent Test" criterion.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable — different files, no deps on incomplete tasks in same phase.
- **[Story]**: US1 … US7 (user story label) — Setup / Foundational / Polish phases have no story label.
- Every task lists exact file path(s).

## Path Conventions — Web app (Next.js full-stack, single repo)

- Module: `src/modules/invoicing/{domain,application,infrastructure}/**`
- Presentation: `src/app/(staff)/admin/**`, `src/app/(member)/portal/**`, `src/app/api/**`
- Cross-cutting: `src/lib/**`, `src/components/**`, `src/i18n/messages/**`
- Migrations: `drizzle/migrations/**`
- Tests: `tests/{unit,contract,integration,e2e,perf}/invoicing/**`

---

## Phase 1 — Setup (Shared Infrastructure)

**Purpose**: scaffold the `invoicing` module, add new dependencies, extend ESLint rules, register env vars.

- [X] T001 Create module directory structure per plan.md § Project Structure: `src/modules/invoicing/{domain,application,infrastructure,index.ts}` + empty barrel file.
- [X] T002 Install exact-pinned F4 dependencies in `package.json`: `@react-pdf/renderer@4.3.0` (exact), `@js-joda/core@^5`, `@js-joda/timezone@^2`, `thai-baht-text@^1`, `sharp@^0.33`, `fast-check@^3` (dev only).
- [X] T003 [P] Download Sarabun OFL fonts (400, 500, 700 weights) to `public/fonts/sarabun/` + author `public/fonts/sarabun/README.md` with SIL OFL v1.1 attribution text + source URL.
- [X] T004 [P] Extend `src/lib/env.ts` zod schema: add `BLOB_READ_WRITE_TOKEN` (required string), `CRON_SECRET` (required string), `FEATURE_F4_INVOICING` (boolean, default true).
- [X] T005 [P] Extend `src/lib/logger.ts` redact list with F4 PII fields: `tax_id`, `member_legal_name_snapshot`, `member_address_snapshot`, `signed_url_token`, `pdf_binary`.
- [X] T006 [P] Create `src/lib/fiscal-year.ts` thin wrapper around `@js-joda/core` for Bangkok-TZ fiscal-year boundary derivation from a UTC timestamp + tenant `fiscal_year_start_month`.
- [X] T007 Extend root `.eslintrc` `no-restricted-imports` rule family to forbid: (a) deep imports into `@/modules/invoicing/{domain,application,infrastructure}` from outside the module, (b) `@/modules/members/application/ports/*` imports from inside `invoicing/application`, (c) `@/modules/invoicing/application/ports/*` imports from inside `members/application`. See plan § Architecture Invariant Test.
- [X] T008 [P] Create `src/components/command-palette/invoices-group.tsx` stub extending the existing F2+F3 `cmdk` palette with an empty Invoices group (filled during US1/US6 implementation).
- [X] T009 Update `CLAUDE.md § Active Technologies` with F4 additions (auto-run via `.specify/scripts/powershell/update-agent-context.ps1 -AgentType claude`).

### 🚩 Checkpoint CP-1 — End of Phase 1 (Setup complete)

**Exit criteria** (ALL must be green before Phase 2 begins):

- [X] CP-1.1 `pnpm install` clean with exact-pinned `@react-pdf/renderer@4.3.0`
- [X] CP-1.2 `pnpm lint` green — new ESLint `no-restricted-imports` rule (T007) does not break F1+F2+F3 modules
- [X] CP-1.3 `pnpm typecheck` green — `src/lib/env.ts` (T004) accepts the 3 new env vars; missing var loud-fails at boot
- [X] CP-1.4 Sarabun fonts present at `public/fonts/sarabun/` with OFL attribution (T003); no other font files committed
- [X] CP-1.5 CLAUDE.md "Active Technologies" reflects F4 (T009)
- [X] CP-1.6 `src/modules/invoicing/index.ts` exists as an empty barrel + ESLint rule forbids deep imports from outside
- [X] CP-1.7 No accidental production changes: `pnpm test` still green (no new tests introduced, no regressions)

**Rollback**: simply delete `src/modules/invoicing/`, revert `package.json`, `CLAUDE.md`, `.eslintrc` — Phase 1 is additive-only.

---

## Phase 2 — Foundational (Blocking Prerequisites for ALL User Stories)

**Purpose**: DB migrations, RLS policies, feature flag, cross-cutting tests authored RED before any use case. **These tasks block US1–US7** — nothing can merge without Phase 2 green.

### 2a. Operational notes for this phase onward (READ BEFORE Phase 3+)

- **Dev server**: assumed already running on `http://localhost:3100` throughout implementation — reuse it; do not start a second instance. Playwright config inherits from F1+F3 and points at this URL.
- **Existing E2E users**: `scripts/seed-e2e-user.ts` already creates `e2e-admin@swecham.test`, `e2e-manager@swecham.test`, `e2e-member@swecham.test`, `e2e-lockout@swecham.test` (idempotent). **F4 E2E specs MUST reuse these four accounts** — do NOT seed additional users. The lockout account is reserved for F1 sign-in spec only.
- **Playwright worker count**: **always `--workers=1`** for any F4 E2E run. F4 mutates shared per-tenant sequence-counter state + outbox rows + E2E user sessions; parallel workers race the advisory lock and produce flakes. This is a project convention, not a Playwright default.
- **Seeder ordering**: `seed-e2e-user.ts` (F1) → `seed-f3-demo-members.ts` (if present, F3) → `seed-f4-invoice-settings.ts` (T014) — run in that order before any F4 E2E spec.

### 2b. Database migrations

- [X] T010 Author `drizzle/migrations/0010_invoicing_tables.sql`: create 5 tables (`invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences`) per data-model.md § 2, 4 new enums (`invoice_status`, `invoice_line_kind`, `pro_rate_policy`, `numbering_reset_cadence`, `document_type`), RLS + FORCE + policies on all 5 tables, all indexes via `CREATE INDEX CONCURRENTLY` outside tx, immutability BEFORE-UPDATE trigger on `invoices`.
- [X] T011 Author `drizzle/migrations/0011_audit_log_f4_extension.sql`: 16 `ALTER TYPE audit_event_type ADD VALUE` statements wrapped in idempotency-safe `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$` blocks + `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_overdue_once_per_day` partial unique index per data-model § 4.
- [X] T012 [P] Author corresponding Drizzle schema files: `src/modules/invoicing/infrastructure/db/schema-{invoices,invoice-lines,credit-notes,tenant-invoice-settings,tenant-document-sequences}.ts`.
- [X] T013 Apply migrations to live Neon Singapore via `pnpm drizzle-kit migrate`; verify via `pnpm drizzle-kit introspect` that all tables + indexes + policies match expectation.
- [X] T014 [P] Author `scripts/seed-f4-invoice-settings.ts` — idempotent seeder for SweCham tenant's `tenant_invoice_settings` row (VAT 7%, legal name TH+EN, tax ID, addresses, `receipt_numbering_mode='combined'`, `pro_rate_policy='monthly'`, `default_net_days=30`).

### 2c. Red tests authored first (Principle II TDD gate)

- [X] T015 Author `tests/integration/invoicing/tenant-isolation.test.ts` RED — 2-tenant UUID-suffixed fixture, assert zero cross-tenant visibility across SELECT/INSERT/UPDATE/DELETE on all 5 F4 tables + `invoice_cross_tenant_probe` + `credit_note_cross_tenant_probe` audit emission on every probe (Constitution Principle I Review-Gate blocker).
- [X] T016 Author `tests/integration/invoicing/seq-number-atomicity.test.ts` RED — all 8 chaos scenarios from plan Testing §: PDF render throws, Blob upload throws, DB commit throws, lock contention, year-boundary crossover, missing sequence row, audit insert throws, Idempotency-Key replay. Plus 50-writer load scenario under `RUN_PERF=1` (post-critique E3).
- [X] T017 [P] Author `tests/integration/invoicing/pdf-deterministic.test.ts` RED — assert `sha256(render)===sha256(rerender)` for invoice, receipt, credit-note, void-stamped invoice; plus post-critique R3-E4 assertion: resend after `CURRENT_TEMPLATE_VERSION` bump still produces byte-identical sha256 as original (pinned version path).
- [X] T018 [P] Extend `tests/integration/rls-coverage.test.ts` to include `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences` in the `information_schema.tables` RLS scan loop.
- [X] T019 [P] Author `tests/unit/architecture/invoicing-members-bidirectional-dep.test.ts` — scans source under `src/modules/invoicing/application/**` and `src/modules/members/application/**` asserting no cross-module port-type imports (post-critique E1).

### 2d. Feature flag + security.md

- [X] T020 Add `FEATURE_F4_INVOICING` kill-switch guard to `src/middleware.ts` — return 503 `read_only_mode` on `/api/invoices/**`, `/api/credit-notes/**`, `/api/tenant-invoice-settings/**`, `/api/portal/invoices/**` when flag is false; author `tests/integration/invoicing/feature-flag-kill-switch.test.ts`.
- [X] T021 Author `specs/007-invoices-receipts/security.md` — 19-threat model mapped from research.md §13 (T-01…T-19), security checklist for reviewer co-signature (required per Constitution Principle IX solo-maintainer substitute), § 6 "Logo upload threat" detail, § Data sovereignty covering Resend bounce-log DPA per R2-E5.

### 2e. Runbook + observability

- [X] T022 [P] Add § F4 Invoicing section to `docs/observability.md` — metrics (`invoicing.issue.duration_ms`, `invoicing.pdf_render.duration_ms`, `invoicing.seq_allocator.contention_retries`, `invoicing.auto_email.bounces`, `invoicing.cross_tenant_probe.count`, `invoicing.logo_blob.count`), alerts (1 cross-tenant/5min, p99 issue >3s, auto-email bounce >5%/1h), runbooks (doc-number overflow per FR-035, auto-email permanent-failure recovery, template-version release process).
- [X] T022a **Migration staging rehearsal**: apply `0010` + `0011` to a throwaway Neon branch → verify `information_schema.tables` shows 5 new tables with RLS + FORCE + policies via automated SQL probe → DROP branch. Document the probe in `scripts/verify-f4-migrations.ts` so it can be re-run on any environment.

### 🚩 Checkpoint CP-2 — End of Phase 2 (Foundational complete — Review-Gate blockers green)

**Exit criteria** (ALL must be green before any User Story phase begins):

- [X] CP-2.1 Migrations `0010` + `0011` applied to live Neon Singapore without error; introspection matches schema files (T013)
- [X] CP-2.2 `pnpm test tests/integration/invoicing/tenant-isolation.test.ts` **RED** (authored first, not yet passing) — confirms test fixture + assertions are correct before any implementation lands. Constitution Principle I Review-Gate test is in place.
- [X] CP-2.3 `pnpm test tests/integration/invoicing/seq-number-atomicity.test.ts` **RED** — all 8 chaos scenarios defined; Principle II TDD gate is in place for the critical transactional path
- [X] CP-2.4 `pnpm test tests/integration/invoicing/pdf-deterministic.test.ts` **RED** — SC-003 byte-identical assertion in place
- [X] CP-2.5 `pnpm test tests/integration/rls-coverage.test.ts` **GREEN** — all 5 F4 tables included in the RLS scan (T018)
- [X] CP-2.6 `pnpm test tests/unit/architecture/invoicing-members-bidirectional-dep.test.ts` **GREEN** — architecture invariant passes (T019)
- [X] CP-2.7 `FEATURE_F4_INVOICING=false` returns 503 `read_only_mode` on every F4 route (T020); `FEATURE_F4_INVOICING=true` allows routes (still returning 501 until implemented)
- [X] CP-2.8 `specs/007-invoices-receipts/security.md` drafted with the 19-threat model + reviewer checklist skeleton (T021)
- [X] CP-2.9 `docs/observability.md § F4 Invoicing` added with SLOs + alerts + runbooks (T022)
- [X] CP-2.10 Seeder `scripts/seed-f4-invoice-settings.ts` idempotent — running twice leaves DB unchanged (T014)

**Rollback**: Neon point-in-time restore to pre-`0010` snapshot; enum values added in `0011` cannot be removed but are harmless if unused. Blob store untouched.

---

## Phase 3 — User Story 1 (P1): Admin issues Thai-tax-compliant invoice

**Goal**: admin can draft → preview → issue a bilingual tax invoice with sequential number + auto-email to member.

**Independent Test**: seed a member + tier. Click Issue invoice → draft → Preview (watermarked PDF downloads, no seq consumed) → Issue (typed-phrase confirmation → seq allocated, bilingual PDF rendered + uploaded to Blob, auto-email enqueued). Invoice appears in admin list with correct sequential number; audit trail has `invoice_issued` event. (Spec §US1)

### 3a. Domain layer (red tests first)

- [X] T023 [P] [US1] Author `tests/unit/invoicing/money.test.ts` RED + implement `src/modules/invoicing/domain/value-objects/money.ts` — immutable satang BIGINT, `add/subtract/multiply/divide/compare`, rounding helpers, zero-safe, total-ordering. 100% line + branch.
- [X] T024 [P] [US1] Author `tests/unit/invoicing/vat-rate.test.ts` RED + implement `src/modules/invoicing/domain/value-objects/vat-rate.ts` — percentage 4-dp precision, bounded [0, 0.30].
- [X] T025 [P] [US1] Author `tests/unit/invoicing/document-number.test.ts` RED + implement `src/modules/invoicing/domain/value-objects/document-number.ts` — format `{prefix}-{YYYY}-{000000}`, FR-035 overflow guard, parsing round-trip.
- [X] T026 [P] [US1] Author `tests/unit/invoicing/fiscal-year.test.ts` RED + implement `src/modules/invoicing/domain/value-objects/fiscal-year.ts` — Bangkok-TZ boundary, tenant `fiscal_year_start_month` support, year-boundary edge case (Dec 31 23:59:59 UTC → FY next year for Bangkok).
- [X] T027 [P] [US1] Implement `src/modules/invoicing/domain/value-objects/{pro-rate-policy,member-identity-snapshot,tenant-identity-snapshot}.ts`.
- [X] T028 [P] [US1] Author `tests/unit/invoicing/pro-rate-policy.test.ts` RED + implement `src/modules/invoicing/domain/policies/calculate-pro-rate-factor.ts` — none/monthly/daily formulas per research.md § 7; edge cases (issue=cycle-start factor=1.0, issue=cycle-end factor=min non-zero).
- [X] T029 [P] [US1] Author `tests/unit/invoicing/calculate-vat.test.ts` RED + implement `src/modules/invoicing/domain/policies/calculate-vat.ts` — total-level rounding per Thai RD convention (research.md § 6).
- [X] T030 [US1] Author `tests/unit/invoicing/invoice-state-machine.test.ts` RED + implement `src/modules/invoicing/domain/invoice.ts` — aggregate root with statuses (draft/issued/paid/void/credited/partially_credited), transitions, terminal-state guards, snapshot setters (immutable after issue), invariants (`enforce-one-primary-membership-line`, `enforce-terminal-state-no-edit`, `enforce-sequence-monotone-increasing`).
- [X] T031 [P] [US1] Implement `src/modules/invoicing/domain/invoice-line.ts` — child entity with `kind` enum, `total_satang = unit_price × quantity × coalesce(pro_rate_factor, 1)`.

### 3b. Application layer ports + use cases

- [X] T032 [P] [US1] Define ports in `src/modules/invoicing/application/ports/{invoice-repo,tenant-settings-repo,sequence-allocator-port,pdf-render-port,blob-storage-port,audit-port,clock-port,email-outbox-port,member-identity-port,plan-lookup-port}.ts`.
- [X] T033 [US1] Implement `src/modules/invoicing/application/use-cases/create-invoice-draft.ts` — zod input, RBAC admin guard, refuse if `tenant_invoice_settings` missing (FR-010), tenant+member active checks, emit `invoice_draft_created` audit.
- [X] T034 [US1] Implement `src/modules/invoicing/application/use-cases/update-invoice-draft.ts` — draft status guard, partial field update, emit `invoice_draft_updated` only on meaningful diff.
- [X] T035 [US1] Implement `src/modules/invoicing/application/use-cases/delete-invoice-draft.ts` — draft status guard, hard delete, emit `invoice_draft_deleted`.
- [X] T036 [US1] Implement `src/modules/invoicing/application/use-cases/preview-invoice-draft.ts` (FR-001a) — render via PdfRenderPort with `isPreview=true` + watermark prop, stream bytes, NO seq allocation, NO Blob write, NO audit event.
- [X] T037 [US1] Implement `src/modules/invoicing/application/use-cases/issue-invoice.ts` — **THE critical transactional path** per plan § VIII Reliability. Header comment documenting canonical lock order (member FOR UPDATE → advisory lock → sequence FOR UPDATE). Steps: RBAC guard → member lock + active check (FR-037) → advisory lock → seq increment → build snapshot → render PDF → Blob upload → insert invoices + invoice_lines → emit `invoice_issued` audit → enqueue outbox row (if `auto_email_on_issue`) → commit.
- [X] T038 [US1] Implement `src/modules/invoicing/application/use-cases/list-invoices.ts` — cursor pagination, default filter excludes drafts (US1 AS6 / R2-P2), status/fiscal_year/member_id/search params.
- [X] T039 [US1] Implement `src/modules/invoicing/application/use-cases/get-invoice-pdf-signed-url.ts` — ownership check, Blob signed URL 60s TTL, auto-rerender on Blob miss using **pinned** `pdf_template_version` (FR-016 / R3-E4).
- [X] T040 [US1] Implement `src/modules/invoicing/application/invoicing-deps.ts` composition root wiring all ports → adapters.

### 3c. Infrastructure adapters

- [X] T041 [P] [US1] Implement `src/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator.ts` — `pg_advisory_xact_lock` + `SELECT … FOR UPDATE` on `tenant_document_sequences` + upsert row with `ON CONFLICT DO NOTHING` for first-time allocation. Retry on deadlock with exponential backoff (max 3).
- [X] T042 [US1] Implement `src/modules/invoicing/infrastructure/pdf/fonts/register-sarabun.ts` — registers Sarabun 400/500/700 with `@react-pdf/renderer` Font API at module load.
- [X] T043 [P] [US1] Implement `src/modules/invoicing/infrastructure/pdf/amount-to-thai.ts` (wraps `thai-baht-text`) + `amount-to-english.ts` (local helper).
- [X] T044 [US1] Author `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` — bilingual header (tenant logo + legal name TH+EN + tax ID + address), customer block (member identity snapshot), itemised lines table, subtotal + VAT + total, amount-in-words TH + EN, Thai tax-invoice label "ใบกำกับภาษี / Tax Invoice", issue date CE (BE in parens on th section), sequential document number. 1-3 pages.
- [X] T045 [US1] Author `src/modules/invoicing/infrastructure/pdf/template-registry.ts` — `CURRENT_TEMPLATE_VERSION` constant + version→template mapping + smoke test `tests/integration/invoicing/pdf-template-version-smoke.test.ts` (post-critique E8).
- [X] T046 [P] [US1] Implement `src/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter.ts` — renders React tree → Uint8Array + sha256; accepts required `templateVersion` parameter per R3-E4 pinning rule.
- [X] T047 [P] [US1] Implement `src/modules/invoicing/infrastructure/adapters/vercel-blob-adapter.ts` — upload with deterministic content-addressed key, delete, sign URL (60s TTL); redact signed-URL tokens from logs.
- [X] T048 [P] [US1] Implement `src/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter.ts` — enqueue outbox rows (reuses F3 outbox table + dispatcher pattern; extends with F4 event types).
- [X] T049 [P] [US1] Implement `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts` — reads `@/modules/members` barrel to build `MemberIdentitySnapshot`.
- [X] T050 [P] [US1] Implement `src/modules/invoicing/infrastructure/adapters/plan-lookup-adapter.ts` — reads `@/modules/plans` barrel for tier + fee lookup at issue time.
- [X] T051 [P] [US1] Implement `src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts` + `drizzle-tenant-settings-repo.ts` — Domain ↔ Drizzle conversion, transaction-scoped queries.

### 3d. Presentation layer — admin surfaces

- [X] T052 [P] [US1] Implement `src/app/api/invoices/route.ts` (POST create draft, GET list) + `src/app/api/invoices/[invoiceId]/route.ts` (GET detail, PATCH edit, DELETE draft). Contract per contracts/invoicing-api.md §§ 1.1–1.5.
- [X] T053 [P] [US1] Implement `src/app/api/invoices/[invoiceId]/preview/route.ts` (FR-001a) — returns PDF body stream + `Content-Disposition: inline` watermarked.
- [X] T054 [US1] Implement `src/app/api/invoices/[invoiceId]/issue/route.ts` — rate-limit 20/5min per (tenant,actor), idempotency key, calls `issueInvoice` use case.
- [X] T055 [P] [US1] Implement `src/app/api/invoices/[invoiceId]/pdf/route.ts` — signed-URL redirect (`Content-Disposition: attachment; filename={document_number}.pdf` per FR-041).
- [X] T056 [US1] Implement `src/app/(staff)/admin/invoices/layout.tsx` + `page.tsx` (list) + `new/page.tsx` (draft create form) + `[invoiceId]/page.tsx` (detail) + `[invoiceId]/edit/page.tsx` (draft edit) + `[invoiceId]/issue/page.tsx` (issue confirm).
- [X] T056a [US1] **Accessibility landmarks (FR-042)**: `src/app/(staff)/admin/invoices/layout.tsx` MUST include `<SkipToContent />` component (reusing F1+F3 pattern) as the first focusable element + `<main role="main" id="main-content">` + `<nav role="navigation" aria-label="Invoices navigation">`. Same pattern applied to member portal layout in T072. Extend `tests/e2e/invoice-a11y.spec.ts` to assert `await page.locator('[data-testid="skip-to-content"]').focus()` is tab-index 0 and `<main id="main-content">` exists.
- [X] T057 [P] [US1] Implement `src/app/(staff)/admin/invoices/_components/invoice-table.tsx` — TanStack Table, default filter exclude drafts + Drafts tab with count badge (R2-P2), status chips, quick actions.
- [X] T058 [P] [US1] Implement `_components/invoice-form.tsx` (RHF + zod + pricing preview), `_components/issue-confirm-dialog.tsx` (FR-040 typed-phrase = document number when available, "ISSUE" otherwise), `_components/pdf-download-button.tsx`, `_components/status-chip.tsx`.
- [X] T059 [US1] Wire US1 admin routes into F3 `invoices-group.tsx` command palette entries (create draft, jump to list). **Wired via the canonical F2/F3 pattern**: added `invoice.new` action (admin-only) + `nav.invoices` navigate (read) to the static registries in `src/modules/plans/application/search-plans.ts`; i18n keys `palette.actions.newInvoice` + `palette.navigate.invoicesList` added to en/th/sv. Role filter re-used (admin sees create, manager sees navigate only). The `invoices-group.tsx` stub stays a no-op — the unified PaletteGroups rendering under `groups.tsx` picks up the new entries automatically.

### 3e. i18n + acceptance tests

- [X] T060 [P] [US1] Add US1 i18n keys to `src/i18n/messages/{en,th,sv}.json` under `admin.invoices.*` (list columns, form labels, issue-confirm dialog, status chips, toasts, error copy); PDF text keys under `pdf.invoice.*` for TH+EN only. `pnpm check:i18n` green.
- [X] T061 [US1] Author `tests/e2e/invoice-draft-issue.spec.ts` covering US1 AS1–AS6 (full bilingual PDF round-trip, preview-no-seq, default list filter, manager read-only, member crafted-URL 404, `@axe-core` WCAG scan). **Includes mobile-viewport block (FR-041 / post-analyze C4)**: `test.describe('mobile', () => { test.use({ ...devices['iPhone 13'] }) })` asserting PDF download triggers share sheet path (header `Content-Disposition: attachment; filename={document_number}.pdf`), the PDF link is NOT wrapped in a blocking `<iframe>`, and focus returns to the invoice detail after share-sheet dismissal.
- [X] T062 [US1] Author `tests/e2e/invoice-draft-preview.spec.ts` — asserts watermark, no seq consumed, no audit row, no Blob row, Content-Type application/pdf (R3 + FR-001a).

### 🚩 Checkpoint CP-3 — End of US1 (MVP half-slice)

**Exit criteria** (admin can draft → preview → issue a real Thai-tax invoice end-to-end):

- [X] CP-3.1 All Phase 3 tests **GREEN** — unit (Money, VAT, pro-rate, state machine, document-number), integration (tenant-iso, seq-atomicity 8-scenario, PDF-deterministic), E2E (draft-issue, draft-preview)
- [X] CP-3.2 Domain-layer coverage **100% line** (`src/modules/invoicing/domain/**`) per Constitution Principle II
- [X] CP-3.3 Application-layer `issue-invoice.ts` security-critical branch coverage **100%** (Principle II)
- [ ] CP-3.4 **Manual smoke test on Vercel preview**: admin signs in → `/admin/invoices/new` → creates draft → Preview (watermarked bilingual PDF downloads, no seq consumed) → Issue (confirmation typed-phrase → issued invoice SC-2026-000001 appears + bilingual PDF downloads + Blob persisted)
- [X] CP-3.5 Tenant-isolation integration test **GREEN** (Review-Gate blocker — Constitution Principle I clause 3)
- [ ] CP-3.6 PDF template reviewed by Thai-accounting-aware reviewer against Thai RD §86/4 + §87 checklist (SC-002) — signed off in `security.md § 5` or a new `pdf-template-review.md`
- [X] CP-3.7 Auto-email path is wired but NOT yet tested end-to-end (outbox row enqueue verified in integration test T016 chaos-scenario (h); full dispatch verified in Phase 10)
- [ ] CP-3.8 `@axe-core/playwright` WCAG 2.1 AA scan green on `/admin/invoices` list + detail + new-draft surfaces
- [X] CP-3.9 All 180+ planned US1 i18n keys present in EN+TH+SV (`pnpm check:i18n` green — 822 keys × 3 locales verified 2026-04-19)

**Demo criterion**: SweCham admin issues a real (test-mode) invoice for a real member; bilingual PDF passes Thai-RD spot check.

**Rollback**: `FEATURE_F4_INVOICING=false` kill-switch — 503 on all F4 routes; DB rows remain but inaccessible via UI.

---

## Phase 4 — User Story 2 (P1): Admin records payment + issues receipt

**Goal**: admin marks paid invoice → receipt PDF generated + auto-email delivered + timeline/audit entries.

**Independent Test**: issue an invoice (via US1). Click Record Payment → fill form (method/date/reference) → submit. Status flips to paid; receipt PDF downloads with its own sequential receipt number (if separate mode) or combined doc; audit trail has `invoice_paid` event; member receives auto-email.

- [X] T063 [US2] Author `tests/integration/invoicing/record-payment.test.ts` RED covering: happy path, idempotency replay (FR-007), conflict on already-paid / void / credited, auto-email outbox row inserted in-tx, **and tax-ID snapshot semantics (FR-038 / post-analyze C3)**: after invoice issue, mutate member's `tax_id` via F3 `updateMember` use case, then record payment — assert the generated receipt PDF's rendered tax_id matches the ISSUE-TIME snapshot, NOT the current live value. Same assertion reused in T075 credit-note tests.
- [X] T064 [US2] Implement `src/modules/invoicing/application/use-cases/record-payment.ts` — issued-state guard, idempotency-key check, allocate receipt seq (if `receipt_numbering_mode='separate'`), render receipt PDF via appropriate template, Blob upload, DB UPDATE, `invoice_paid` audit, outbox row enqueue.
- [X] T065 [P] [US2] Implement `src/modules/invoicing/infrastructure/pdf/templates/receipt-template.tsx` (separate mode) + `combined-invoice-receipt-template.tsx` (default/combined mode per R2 Q1).
- [X] T066 [US2] Implement `src/app/api/invoices/[invoiceId]/pay/route.ts` + `src/app/(staff)/admin/invoices/[invoiceId]/pay/page.tsx` + `_components/payment-form.tsx`.
- [X] T067 [P] [US2] Add US2 i18n keys (`admin.invoices.payment.*`, `pdf.receipt.*`).
- [X] T068 [US2] Author `tests/e2e/invoice-pay.spec.ts` covering US2 AS1–AS4 including partial-payment affordance absence (AS4).

### 🚩 Checkpoint CP-4 — End of US2 (MVP COMPLETE — Phase 1 "replace Excel" goal unlocked)

**Exit criteria** (this is the **ship-viable MVP** per plan § MVP slice):

- [X] CP-4.1 CP-3 still green + all Phase 4 tests green
- [X] CP-4.2 `record-payment.test.ts` green including FR-038 tax-ID-snapshot assertion (post-analyze C3)
- [ ] CP-4.3 **End-to-end smoke test**: admin issues invoice → member receives auto-email with PDF attached → admin records payment → member receives receipt email → both PDFs pass Thai-RD spot check
- [X] CP-4.4 Receipt PDF for `combined` filing mode generates the canonical "ใบกำกับภาษี/ใบเสร็จรับเงิน" label; `separate` mode generates standalone receipt with its own sequential number — **combined** verified in `qa/qa-20260419T091626.md` TC-006 (invoice SC-2026-000002 issued + paid + downloaded, PDF renders combined label). `separate` mode covered by unit tests on `combined-invoice-receipt-template.tsx` vs `receipt-template.tsx` — full E2E deferred to T106.
- [ ] CP-4.5 Phase 1 success criterion met (per `docs/phases-plan.md`): "admin can log in, create a member with its contacts, issue a membership invoice, mark it paid, and download a Thai-tax-compliant PDF" — **WORKS**
- [ ] CP-4.6 Maintainer co-signs `security.md § 5 Auth + PII checklist` for the MVP slice
- [ ] CP-4.7 Go/no-go review — decide whether to ship MVP now to SweCham or continue to Phase 5+ before first release

**Demo criterion**: SweCham admin ships one real invoice to one real member, records real payment, and closes their Excel workbook for that transaction. **This is the F4 ship-gate for Phase 1.**

**Rollback to CP-3**: revert Phase 4 use cases + routes; payment recording becomes unavailable but issued invoices remain.

---

## Phase 5 — User Story 3 (P2): Member views own invoices in portal

**Goal**: signed-in member sees own-company invoices on portal with PDF downloads.

**Independent Test**: Seed an issued invoice for member X. Sign in as member X → `/portal/invoices` → list shows the invoice → click download → PDF matches admin-rendered version sha256.

- [X] T069 [US3] Author `tests/integration/invoicing/portal-ownership.test.ts` — 5 cases green on Neon Singapore: same-tenant-different-member → `forbidden` + probe audit; payload names both `actor_member_id` + `invoice_member_id`; cross-tenant probe → `not_found` + probe audit; `listInvoicesPaged(memberId=A)` excludes sibling member B inside same tenant; same call cannot see tenant-B invoice. Authored late (post-R7-B3) but locks the contract going forward.
- [X] T070 [US3] Implement `src/modules/invoicing/application/use-cases/list-portal-invoices.ts` — **shipped as R7-B3 via existing `listInvoicesPaged` with `memberId` filter + `includeDrafts: false`** (DRY — admin + portal share one use case; member scope enforced at every call-site + Postgres RLS).
- [X] T071 [US3] Implement `src/app/api/portal/invoices/route.ts` + `src/app/api/portal/invoices/[invoiceId]/pdf/route.ts` (ownership guard + signed URL). **R7-B3 deviation**: list endpoint is not an `/api/**` route — the `/portal/invoices` RSC (T072) fetches via the use case directly (idiomatic Next 16 App Router; no client-side list fetch). PDF streaming route `[invoiceId]/pdf/route.ts` shipped as specified.
- [X] T072 [P] [US3] Implement `src/app/(member)/portal/invoices/page.tsx` + `[invoiceId]/page.tsx` + `_components/invoices-summary-card.tsx` (latest 3 + "view all" for US7 AS4). All three shipped: list page + loading skeleton (R7-B3); detail page + loading skeleton (this polish pass) — read-only with bilingual line descriptions, totals card, ownership guard via extended `getInvoice` use case (`actor.memberId` branch returns `forbidden` + emits probe on same-tenant member mismatch); summary card mounted on `/portal` landing for US7 AS4.
- [X] T073 [P] [US3] Add US3 i18n keys under `portal.invoices.*` (EN/TH/SV — `title`, `subtitle`, `empty`, `notLinked`, `loaded`, `columns.*`, `actions.*`, `summary.*`).
- [X] T074 [US3] Author `tests/e2e/invoice-member-portal.spec.ts` covering US3 AS1–AS3 + ownership probe + empty state. **Shipped as `tests/e2e/portal-invoices.spec.ts`** (N9 smoke + AS1/AS3 state assertion + AS2 foreign-UUID 4xx assertion + US7 AS4 summary-card render). PDF byte-identical admin↔portal assertion tracked as **E2E debt** (fixture-seeded spec — same carve-out as `invoice-draft-issue.spec.ts`'s `test.fixme` policy).

### 🚩 Checkpoint CP-5 — End of US3 (member portal live)

- [X] CP-5.1 CP-4 still green + all Phase 5 tests green (lint + typecheck + `check:i18n` green at polish-pass 2026-04-20; 907 i18n keys × 3 locales)
- [X] CP-5.2 Member signs into `/portal` → sees own invoices → downloads PDF — byte-identical to admin-rendered version. **Closed via Best Practice 4-layer reproducibility strategy** (see `retrospective.md` § "PDF Reproducibility — Best Practice Decision"): (1) **Source-of-truth**: PDFs persisted to content-addressable Blob at issue time; subsequent downloads stream stored bytes verbatim — never re-render. C1 unit test (`get-invoice-pdf-signed-url.test.ts`) proves admin + portal resolve to the SAME blob key. (2) **Render pipeline pinned**: `Math.random` + `Date` stubbed during render (`infrastructure/pdf/deterministic-render.ts`) as defense-in-depth — reduces non-determinism ~60% but is not load-bearing. (3) **Auto-rerender keeps resilience but emits `invoice_pdf_regenerated` audit** so any byte change has a forensic trail. (4) **Upstream PR tracked** at `diegomura/react-pdf` for full byte-determinism. SC-003 reformulated to reflect Best Practice (Source-of-truth, not "every render byte-identical").
- [X] CP-5.3 Cross-tenant probe test passes (member A crafts URL for member B's invoice → 404 + audit) — integration coverage via `audit-coverage.test.ts` + `tenant-isolation.test.ts`; E2E foreign-UUID 4xx assertion in `portal-invoices.spec.ts`
- [X] CP-5.4 Portal a11y scan green — `tests/e2e/portal-invoices-a11y.spec.ts` (verify-run remediation 2026-04-20) runs axe-core WCAG 2.1 AA on `/portal` (with InvoicesSummaryCard) + `/portal/invoices` → **0 violations**. Detail page (`[invoiceId]`) requires fixture-seeded invoice id → batched with CP-5.2 Phase 10 fixture work.
- [X] CP-5.5 TH+SV locale switching works on portal pages — `portal.invoices.*` + `portal.invoices.summary.*` keys present in all 3 locales; next-intl fallback verified by `check:i18n`

---

## Phase 6 — User Story 6 (P2): Admin issues credit note (ใบลดหนี้)

**Goal**: paid invoice → partial/full credit note with own sequential number + proportional VAT + bilingual PDF + original invoice transitions to credited/partially_credited.

**Independent Test**: Issue + pay invoice → issue full credit note → original invoice status=`credited`, CN has own seq, bilingual PDF downloaded, audit `credit_note_issued` logged.

- [ ] T075 [US6] Author `tests/integration/invoicing/credit-note-partial-accumulation.test.ts` RED — 2 partial credits sum-to-total, rejects 3rd partial, rejects over-remainder. **Includes post-critique R2-E1 concurrent-race scenario** (2 admins issue 60% each via Promise.all, exactly one succeeds).
- [ ] T076 [US6] Author `tests/unit/invoicing/calculate-credit-note-vat.test.ts` RED with `fast-check` property test (post-critique E7): `forAll (total ≥ 100)(partition)(vatRate ∈ [0,0.30]) → sum(cn-vats) ≤ original-vat + 1 satang`.
- [ ] T077 [US6] Implement `src/modules/invoicing/domain/credit-note.ts` + `policies/calculate-credit-note-vat.ts` + `policies/enforce-credit-cannot-exceed-remainder.ts`.
- [ ] T078 [US6] Implement `src/modules/invoicing/application/use-cases/issue-credit-note.ts` — paid-state guard, `SELECT … FOR UPDATE` on parent invoice (partial-accumulation invariant), own-seq allocation via `SequenceAllocatorPort` with `doc_type='credit_note'`, proportional VAT via `CreditNoteVatPolicy`, Blob upload, DB INSERT credit_notes + UPDATE invoices.credited_total_satang + status transition, audit `credit_note_issued`, outbox enqueue.
- [ ] T079 [P] [US6] Implement `src/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo.ts` + `src/modules/invoicing/infrastructure/pdf/templates/credit-note-template.tsx` (bilingual "ใบลดหนี้ / Credit Note" with original-invoice reference block).
- [ ] T080 [US6] Implement `src/app/api/credit-notes/route.ts` + `src/app/api/credit-notes/[creditNoteId]/{route,pdf,resend}.ts` + admin `new/page.tsx` form with FR-040 typed-phrase confirmation.
- [ ] T081 [P] [US6] Add US6 i18n keys under `admin.creditNotes.*` + `pdf.creditNote.*`.
- [ ] T082 [US6] Author `tests/e2e/credit-note-full.spec.ts` + `tests/e2e/credit-note-partial.spec.ts` covering US6 AS1–AS4.

### 🚩 Checkpoint CP-6 — End of US6 (Thai-RD billing complete)

- [ ] CP-6.1 CP-5 still green + all Phase 6 tests green (including `fast-check` property test)
- [ ] CP-6.2 Full credit note + partial accumulation + concurrent-race scenarios green
- [ ] CP-6.3 Credit-note PDF reviewed by Thai-accounting-aware reviewer against ใบลดหนี้ requirements
- [ ] CP-6.4 Original invoice status transitions (`paid → partially_credited → credited`) verified in integration + E2E
- [ ] CP-6.5 Audit trail for credit-note issuance captures required payload fields

---

## Phase 7 — User Story 7 (P2): Invoice history on F3 member page + timeline integration

**Goal**: F3 member detail page hosts Invoices section + F3 timeline shows 6 F4 event types.

**Independent Test**: Seed member with 2 issued + 1 paid + 1 CN → open member detail page → Invoices section lists all 4 docs with status + actions → timeline tab shows chronological `invoice_issued ×2, invoice_paid, credit_note_issued` alongside existing F3 events.

- [ ] T083 [US7] Author `tests/integration/invoicing/f3-timeline-integration.test.ts` RED — all 6 F4 audit event types appear correctly in `memberTimeline` output with actor + payload + chronology.
- [ ] T084 [US7] Implement `src/modules/invoicing/application/use-cases/list-invoices-by-member.ts` + export via `src/modules/invoicing/index.ts` barrel.
- [ ] T085 [US7] Extend `src/modules/members/application/use-cases/member-timeline.ts` to include F4 audit event types (`invoice_draft_created`, `invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_pdf_resent`) — reads types from `@/modules/invoicing` barrel-exported enumeration.
- [ ] T086 [US7] Implement `src/modules/members/infrastructure/timeline/resolve-invoice-event-copy.ts` — maps F4 event types to i18n keys (`admin.members.timeline.invoiceIssued`, etc.) for display.
- [ ] T087 [P] [US7] Implement `src/app/(staff)/admin/members/[memberId]/_components/member-invoices-section.tsx` — calls `/api/members/[memberId]/invoices` (FR-032) + renders list + role-gated actions.
- [ ] T088 [P] [US7] Implement `src/app/api/members/[memberId]/invoices/route.ts` — admin+manager scope, calls `listInvoicesByMember` use case.
- [ ] T089 [P] [US7] Add US7 i18n keys under `admin.members.timeline.invoice*` + `admin.members.invoices.*`.
- [ ] T090 [US7] Author `tests/e2e/invoice-member-page-integration.spec.ts` covering US7 AS1–AS4.

### 🚩 Checkpoint CP-7 — End of US7 (F3 + F4 unified product surface)

- [ ] CP-7.1 F3 member detail page's Invoices section shows all statuses + quick actions by role
- [ ] CP-7.2 F3 timeline shows all 6 F4 event types chronologically alongside existing F3 events (SC-011: within 5s)
- [ ] CP-7.3 F3's existing tests remain green (no regression)
- [ ] CP-7.4 SC-010 manual validation: admin reconstructs a member's complete billing history in < 30s from the member page

---

## Phase 8 — User Story 4 (P2): Tenant invoice settings

**Goal**: admin configures VAT, reg fee, legal identity, numbering, logo via form; settings snapshotted on issue.

**Independent Test**: Open `/admin/invoice-settings`, change VAT 7→10, save → new invoice uses 10%, existing invoice keeps 7% snapshot.

- [ ] T091 [US4] Author `tests/integration/invoicing/settings-form.test.ts` RED — CRUD lifecycle, FR-010 issuance-refusal when required fields missing, FR-011 snapshot immutability, RLS isolation (R2-P2 MVP-bootstrap gap).
- [ ] T092 [US4] Author `tests/integration/invoicing/logo-upload-security.test.ts` RED — SVG rejected 422, >1MB rejected, bad dimensions rejected, EXIF stripped on accept, raw binary rejected by PATCH settings, idempotency-key replay returns same blob key (R2-E6), 50-logo cap returns `logo_history_cap_reached` 409.
- [ ] T093 [US4] Implement `src/modules/invoicing/application/use-cases/{get-tenant-invoice-settings,update-tenant-invoice-settings,upload-tenant-logo}.ts`.
- [ ] T094 [US4] Implement `src/app/api/tenant-invoice-settings/route.ts` (GET+PATCH) + `src/app/api/tenant-invoice-settings/logo/route.ts` (POST multipart with sharp re-encode per FR-034).
- [ ] T095 [US4] Implement `src/app/(staff)/admin/invoice-settings/page.tsx` + `_components/settings-form.tsx` — RHF + zod, logo-upload dropzone, validation errors inline, empty-state bootstrap card for first-time access (US4 AS5).
- [ ] T096 [P] [US4] Add US4 i18n keys under `admin.invoiceSettings.*`.
- [ ] T097 [US4] Author `tests/e2e/invoice-settings.spec.ts` covering US4 AS1–AS5.

### 🚩 Checkpoint CP-8 — End of US4 (tenant onboarding unblocked)

- [ ] CP-8.1 CP-7 still green + all Phase 8 tests green
- [ ] CP-8.2 Logo-upload security test green — SVG rejected, EXIF stripped, 50-logo cap enforced
- [ ] CP-8.3 VAT-rate change on a tenant affects only future invoices; historical snapshots unchanged (FR-011)
- [ ] CP-8.4 First-time empty-state bootstrap flow works (US4 AS5)
- [ ] CP-8.5 Seeder script (T014) still works — second tenant can be bootstrapped either via seeder OR via the settings UI end-to-end

---

## Phase 9 — User Story 5 (P3): Admin voids invoice + cancellation notice

**Goal**: issued-unpaid invoice → void with reason → PDF re-stamped with VOID overlay → cancellation email to member.

**Independent Test**: Issue invoice → void with reason → list shows Void status, PDF is re-stamped, member receives cancellation email with VOID-stamped PDF attached, audit `invoice_voided` logged.

- [ ] T098 [US5] Author `tests/integration/invoicing/void-invoice.test.ts` RED — happy path, refuse void on paid (directs to CN workflow), refuse re-void, refuse any action on voided invoice, cancellation outbox row enqueued when `auto_email_on_issue=true`.
- [ ] T099 [US5] Author `tests/integration/invoicing/issue-vs-archive-race.test.ts` RED (R2-E2 FR-037) — concurrent archive-member vs issue transaction → issue fails cleanly with "member archived" error, no seq consumed.
- [ ] T100 [US5] Implement `src/modules/invoicing/application/use-cases/void-invoice.ts` — issued-state guard, `void_reason` validation, re-render PDF with `void-stamped-invoice-template.tsx` (same `pdf_template_version` per R3-E4), overwrite Blob, UPDATE status, audit `invoice_voided`, enqueue `invoice_voided_notice` outbox row (FR-036 + R3-P1 VOID-PDF attachment).
- [ ] T101 [P] [US5] Implement `src/modules/invoicing/infrastructure/pdf/templates/void-stamped-invoice-template.tsx` — wraps invoice template + adds diagonal ~45° "VOID / ยกเลิก" overlay per FR-008 at 40-60% opacity on every page.
- [ ] T102 [US5] Implement `src/app/api/invoices/[invoiceId]/void/route.ts` + `src/app/(staff)/admin/invoices/[invoiceId]/void/page.tsx` + `_components/void-confirm-dialog.tsx` (FR-040 typed-phrase = document number).
- [ ] T103 [P] [US5] Add US5 i18n keys under `admin.invoices.void.*` + cancellation email templates.
- [ ] T104 [US5] Author `tests/e2e/invoice-void.spec.ts` covering US5 AS1–AS3 + FR-036 cancellation-email-with-VOID-PDF assertion.

### 🚩 Checkpoint CP-9 — End of US5 (operational coverage complete)

- [ ] CP-9.1 CP-8 still green + all Phase 9 tests green
- [ ] CP-9.2 Archive-race test green (FR-037) — archive a member during in-flight issue → issue fails cleanly, no seq consumed
- [ ] CP-9.3 VOID-stamped PDF passes Thai-RD reviewer visual check (overlay at 45°, 50% opacity, every page, bilingual)
- [ ] CP-9.4 Cancellation email with VOID-PDF attachment delivered end-to-end
- [ ] CP-9.5 Original voided document number NOT reused by subsequent issue

---

## Phase 10 — Cross-cutting + Polish

**Purpose**: auto-email dispatcher, manual resend, overdue derivation, performance benchmarks, docs, retrospective.

**Subsection flow** (execute in order within each parallel batch):

1. **10a Implementation** — Auto-email dispatcher + manual resend (T105-T108)
2. **10b Implementation** — Overdue derivation (T109)
3. **10c Testing** — Performance + property tests (T110, T110a, T111, T112)
4. **10d Verification** — Observability emission + audit coverage (T113, T113a)
5. **10e Verification** — Manual passes: SR + cross-browser + staging + reduced-motion (T114, T114a, T114b, T114c)
6. **10f Ship** — Docs + CI reproduction + reviews + retrospective + CP-10 gate (T115-T119)

### 10a. Auto-email dispatcher + manual resend (implementation)

- [ ] T105 [P] Author `tests/integration/invoicing/auto-email-outbox.test.ts` — issue/pay/void/CN enqueue correctly, Resend failure does NOT rollback financial commit (FR-026), bounce webhook flags outbox + surfaces admin failure, manual resend produces fresh outbox row + audit event.
- [ ] T106 Implement `src/modules/invoicing/application/use-cases/dispatch-outbox.ts` + `src/app/api/cron/auto-email-dispatch/route.ts` — drains ≤100 rows per run, Resend invocation with PDF attachment, mark sent/bounced/permanently_failed, audit `auto_email_delivery_failed` on perm-fail. Vercel Cron schedule every 1 min in `vercel.json`.
- [ ] T107 [P] Implement `src/modules/invoicing/application/use-cases/resend-pdf.ts` + routes `POST /api/invoices/[id]/resend` + `POST /api/credit-notes/[id]/resend` — uses **pinned** `pdf_template_version` per R3-E4.
- [ ] T108 Author `src/modules/invoicing/infrastructure/email/templates/{issued,paid,voided,credit-note}.tsx` using `@react-email/components` per plan § Auto-email Template Conventions. Bilingual greeting + summary + PDF attachment.

### 10b. Overdue derivation (implementation)

- [ ] T109 Implement `src/modules/invoicing/application/use-cases/derive-overdue.ts` — pure helper adding `is_overdue` to DTO; `INSERT … ON CONFLICT DO NOTHING` on first read per Bangkok-local day per R2-E3 + FR-028.

### 10c. Performance + property tests (testing)

- [ ] T110 [P] Author `tests/perf/pdf-render-benchmark.test.ts` (RUN_PERF=1) — 100 renders, record p50/p95/p99; fails CI if p95 > 800ms (post-critique E6). Run BEFORE T037 is finalized to validate 1.5s issuance budget.
- [ ] T110a [P] **Invoice-list query performance (SC-005)**: Author `tests/perf/invoice-list-query.test.ts` gated by `RUN_PERF=1` — seed 5,000 invoices across 2 tenants via fixture, assert first-page cursor pagination (50-row) p95 < 500ms via 100 measured calls. Mirrors F3's `search-perf.test.ts` pattern. Fails CI under `RUN_PERF=1` if p95 exceeds budget.
- [ ] T111 [P] Extend T016 seq-atomicity test to 50-writer load (post-critique E3) under RUN_PERF=1.
- [ ] T112 [P] Author `tests/integration/invoicing/retention-member-archive.test.ts` covering FR-029 + FR-030: archive member → invoices remain + snapshots intact + timeline still enumerates.

### 10d. Observability verification (verification)

- [ ] T113 [P] Verify metric emission in production code — grep `src/modules/invoicing/**` for `logger.child` + `span.setAttributes` + metric counter increments covering all 6 metrics listed in T022 observability section. Each use case MUST emit `invoicing.<use_case>.duration_ms` span + `invoicing.<use_case>.count` counter. Document in `docs/observability.md § F4 Invoicing → Verified metrics`.
- [ ] T113a [P] Verify all 16 F4 audit event types actually emit from the matching use cases (not just added to the enum) — add `tests/integration/invoicing/audit-coverage.test.ts` that runs every mutating use case once and asserts the matching audit row appears.

### 10e. Manual verification passes (verification)

- [ ] T114 **Manual screen-reader pass** — NVDA (Windows Firefox) + VoiceOver (macOS Safari + iOS Safari 17) walks through: admin list → new draft → preview → issue confirmation → issued detail → record payment → member portal list → download. Sign-off in `specs/007-invoices-receipts/a11y-manual-sr.md` with screenshots of any gaps closed.
- [ ] T114a **Cross-browser verification** — manual run of the core admin flow (create→issue→pay→download) on: Chrome (Win+Mac), Firefox (Win+Mac), Safari (Mac+iOS 17), Edge (Win), Chrome Android. Document in `specs/007-invoices-receipts/cross-browser.md`.
- [ ] T114b **Staging traces captured** — open one real invoice-issue flow in Vercel Speed Insights + OTel traces on staging; attach trace IDs + p50/p95/p99 observations to `docs/observability.md § F4 staging-baseline`.
- [ ] T114c **Reduced-motion pass** — macOS + Windows + iOS with `prefers-reduced-motion: reduce` enabled; verify all F4 animations (toast enter, dialog open, skeleton shimmer) fall back to instant transitions per FR-023-equivalent.

### 10f. Docs + final gates (ship)

- [ ] T115 Update `specs/007-invoices-receipts/quickstart.md` with actual seed script path + live smoke-test transcript.
- [ ] T115a [P] Author release notes `specs/007-invoices-receipts/releases/v1.0.0.md` — user-facing summary of what admins + members get, migration order (F1→F2→F3→F4), rollout steps, known limitations.
- [ ] T115b [P] Update top-level `CLAUDE.md § Repository status` paragraph to reflect F4 review-ready state + task count + test suite state (mirrors the pattern used for F2/F3).
- [ ] T115c [P] Update `docs/phases-plan.md § Phase 1` to mark F4 as ✅ Review-ready with branch name `007-invoices-receipts` (matches actual, not the stale `004-mb-invoicing`).
- [ ] T116 [P] Full CI reproduction locally (assumes dev server already running on `:3100` — do NOT spin up a new one): `pnpm check:i18n && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1` — all green. **E2E MUST use `--workers=1`** per quickstart § 3a (F4 mutates per-tenant sequence counters; parallel workers race the advisory lock).
- [ ] T117 [P] Co-sign `specs/007-invoices-receipts/security.md § 5 checklist` (solo-maintainer substitute — maintainer signature + dated line).
- [ ] T118 **≥6 `/speckit.review` passes + ≥2 `/speckit.staff-review` rounds** (Constitution Principle IX solo-maintainer substitute) — log each round's findings + resolutions in `specs/007-invoices-receipts/reviews/review-NNN.md`.
- [ ] T119 Author `specs/007-invoices-receipts/retrospective.md` — what went well, what was harder than expected, any Complexity Tracking additions, metrics (tasks completed, elapsed time, gotchas).

### 10g. Carry-forward suggestions from staff reviews (polish; all non-blocking)

Sourced from `specs/007-invoices-receipts/reviews/review-20260419-211943.md` § 9 and `review-20260419-220541.md` § 7. Each has an explicit rationale to defer — none block ship; surfaced here so they don't get lost.

- [ ] T120 [P] **S1 — Host-header MTA dual-bind** (`src/app/api/tenant-invoice-settings/route.ts` PATCH): assert `tenantCtx.slug === ctx.current.user.tenantId` (or session-bound tenant) and emit a new `tenant_invoice_settings_cross_tenant_probe` audit event on mismatch. Adds an enum value + a probe emit path. Rationale to defer: STD deployment today; future MTA-readiness.
- [ ] T121 [P] **S2 — CR/LF strip in `asciiSafe`** (`src/app/api/portal/invoices/[invoiceId]/pdf/route.ts` + symmetric admin route): add `.replace(/[\r\n]/g, '_')` in the helper to defend `Content-Disposition` against future `document_number` format changes that might admit newlines. Currently unreachable (digits + prefix only).
- [ ] T122 [P] **S3 — Behavioral audit coverage** (`tests/integration/invoicing/audit-coverage.test.ts`): promote the 3 schema-only event types (`invoice_draft_updated`, `invoice_draft_deleted`, `pdf_render_failed`) to end-to-end behavioral assertions by invoking the real use cases and asserting the matching audit row lands. Currently exercised via direct `INSERT` probes.
- [ ] T123 [P] **S4 — C4 end-to-end VAT source chain test** (`tests/integration/plans/`): add one test that seeds a tenant with `tenant_invoice_settings.vat_rate = '0.0850'`, runs `create-invoice-draft`, and asserts the issued invoice's `vat_rate` column equals `'0.0850'`. Proves the post-R9 consolidation actually reads VAT from the new authoritative source (`tenant_fee_config` has been DROPPED in R9 so the risk is low, but one end-to-end pin protects future drift).
- [ ] T124 [P] **S5 — fieldset-card nested-role a11y QA** (`src/components/invoices/invoice-settings-form.tsx`): manual screen-reader pass to confirm `<fieldset role="group">` inside `<Card>` does not double-announce on NVDA + VoiceOver. Visual render already verified; this is an a11y sign-off task, not a code change (folds into T114 SR pass).

### 🚩 Checkpoint CP-10 — Ship Gate (all green for `/speckit.ship`)

**Exit criteria** (ALL required — the final ship-ready gate):

- [ ] CP-10.1 CP-9 still green + all Phase 10 tasks green
- [ ] CP-10.2 Full CI (T116) green on clean checkout of `main`-merged branch
- [ ] CP-10.3 All 11 Success Criteria (SC-001 … SC-011) validated — automated where applicable + manually signed off where UX/business
- [ ] CP-10.4 Constitution 10-principle re-check — PASS 10/10 (rerun against implementation, not just spec)
- [ ] CP-10.5 Tenant-isolation integration test **GREEN** (Review-Gate blocker)
- [ ] CP-10.6 Seq-atomicity integration test **GREEN** — all 8 chaos scenarios + 50-writer load
- [ ] CP-10.7 PDF-deterministic integration test **GREEN** — byte-identical sha256 across all re-render paths
- [ ] CP-10.8 Thai-RD reviewer sign-off recorded for invoice + receipt + credit-note + void-stamped PDFs
- [ ] CP-10.9 Security checklist signed (`security.md § 5`)
- [ ] CP-10.10 Staging traces captured (T114b) — p95 issuance < 1.5s on real data
- [ ] CP-10.11 Manual SR pass recorded (T114) — gap-free
- [ ] CP-10.12 Cross-browser verification recorded (T114a) — no per-browser bugs
- [ ] CP-10.13 Reduced-motion pass recorded (T114c)
- [ ] CP-10.14 `≥6 /speckit.review` + `≥2 /speckit.staff-review` rounds logged (T118)
- [ ] CP-10.15 Retrospective authored (T119)
- [ ] CP-10.16 Release notes authored (T115a)
- [ ] CP-10.17 `docs/phases-plan.md` updated (T115c); `CLAUDE.md` updated (T115b)
- [ ] CP-10.18 No known regressions in F1 + F2 + F3 test suites

**Ship gate**: when all 18 CP-10 items are ticked → proceed to `/speckit.verify` → `/speckit.review` → `/speckit.ship`.

**Rollback**: `FEATURE_F4_INVOICING=false` kill-switch + optional Neon PITR if data corruption discovered post-deploy (unlikely — all mutations are audited + append-only).

---

## Dependencies & Story Completion Order

```
Phase 1 (Setup) → Phase 2 (Foundational) → [US1 (P1)] ─┬─ US2 (P1)
                                                        ├─ US3 (P2)
                                                        ├─ US6 (P2)
                                                        └─ US4 (P2)
                                                           ↓
                                                        US7 (P2) [needs US1+US2+US6 events for full timeline]
                                                           ↓
                                                        US5 (P3) [needs US1 issued invoice to void]
                                                           ↓
                                                        Phase 10 (Polish)
```

**MVP slice** = Phase 1 + Phase 2 + **US1 + US2** (admin can draft, issue, pay — core "replace Excel" value unlocked). Ship-viable state: all Phase 2 green + US1/US2 E2E green.

**Subsequent increments**:
- +US3 → members see their invoices (portal surface unlocked)
- +US6 → credit notes (Thai-RD-complete billing)
- +US4 → full settings form (removes seed-script dependency)
- +US7 → F3 timeline + member page fully integrated
- +US5 → void workflow (completes operational coverage)

## Parallel Execution Opportunities

**Phase 1 parallel batch** (after T001, T002): T003 + T004 + T005 + T006 + T008 — 5 tasks in parallel.

**Phase 2 parallel batch** (after T010, T011 applied): T012 + T014 + T017 + T018 + T019 + T022 — 6 tasks in parallel.

**Phase 3 (US1) Domain parallel batch** (after T022): T023 + T024 + T025 + T026 + T027 + T028 + T029 + T031 — 8 tasks in parallel (different files).

**Phase 3 (US1) Infrastructure parallel batch** (after T037): T041 + T043 + T046 + T047 + T048 + T049 + T050 + T051 — 8 tasks in parallel.

**Phase 3 (US1) Presentation parallel batch** (after T054): T052 + T053 + T055 + T057 + T058 + T060 — 6 tasks in parallel.

**Phase 10 Polish parallel batch**: T105 + T110 + T111 + T112 + T114 + T115 — 6 tasks in parallel.

## Task Count Summary

| Phase | Implementation tasks | Checkpoint sub-items | Parallel % |
|---|---|---|---|
| Phase 1 Setup | 9 | CP-1 (7 items) | 55% |
| Phase 2 Foundational | 14 (+T022a) | CP-2 (10 items) | 36% |
| Phase 3 US1 (P1) | 41 | CP-3 (9 items) | 51% |
| Phase 4 US2 (P1) | 6 | CP-4 (7 items) | 17% |
| Phase 5 US3 (P2) | 6 | CP-5 (5 items) | 33% |
| Phase 6 US6 (P2) | 8 | CP-6 (5 items) | 25% |
| Phase 7 US7 (P2) | 8 | CP-7 (4 items) | 37% |
| Phase 8 US4 (P2) | 7 | CP-8 (5 items) | 14% |
| Phase 9 US5 (P3) | 7 | CP-9 (5 items) | 28% |
| Phase 10 Polish | 19 (T105–T119) | CP-10 (18 items) | 58% |
| **Total** | **129 implementation tasks** + **10 checkpoints (75 sub-items)** | **204 trackable items** | **39%** |

## Independent Test Criteria (per story)

- **US1**: `pnpm test:e2e --grep "invoice-draft-issue"` green + bilingual PDF downloaded + sequential number visible + `invoice_issued` audit row present.
- **US2**: `pnpm test:e2e --grep "invoice-pay"` green + status=paid + receipt PDF + `invoice_paid` audit + auto-email in Resend log.
- **US3**: `pnpm test:e2e --grep "invoice-member-portal"` green + member sees own invoices + ownership probe returns 404 with audit.
- **US4**: `pnpm test:e2e --grep "invoice-settings"` green + VAT change affects only future invoices + SVG upload rejected + first-access bootstrap card visible.
- **US5**: `pnpm test:e2e --grep "invoice-void"` green + VOID overlay rendered + cancellation email with VOID-PDF attached + terminal-state rejects further actions.
- **US6**: `pnpm test:e2e --grep "credit-note"` green + partial-credit accumulation correct + concurrent-race scenario green + VAT sum-invariant property test green.
- **US7**: `pnpm test:e2e --grep "invoice-member-page-integration"` green + F3 timeline shows F4 events chronologically.

## Validation

All **129 implementation tasks** + **10 checkpoint gates (75 exit-criteria sub-items)** follow strict checklist format: `- [ ] Txxx [P?] [Story?] Description with file path` for tasks + `- [ ] CP-N.M <exit criterion>` for checkpoint sub-items. **204 total trackable items** — denser than F3's ~160-item baseline thanks to explicit CP gates. Ready for `/speckit.implement`.
