---
description: "F9 task list — Admin Dashboard + Directory + Timeline + Audit"
---

# Tasks: F9 — Admin Dashboard + Directory + Timeline + Audit

**Input**: Design documents from `/specs/015-admin-dashboard/`
**Prerequisites**: plan.md, spec.md (6 user stories), research.md (R1–R12), data-model.md
(4 tables + `member_timeline_v` + 14 audit events), contracts/ (application-ports, http-endpoints)

**Tests**: INCLUDED — TDD is **NON-NEGOTIABLE** (Constitution Principle II). Each user
story authors failing tests (contract/integration/acceptance) **before** implementation.
Coverage: Domain 100% line · Application ≥80% line+branch · **100% branch on
security-critical paths** (audit redaction, GDPR scoping, tenant isolation, engagement
projection).

**Delivery slicing** (critique P1/X1): **Slice A** = US1–US4 (dashboard, audit, timeline,
benefits); **Slice B** = US5–US6 (directory + E-Book, GDPR export). Ship/review each slice
separately to bound the all-PII review blast radius.

**Format**: `[ID] [P?] [Story?] Description with file path` — `[P]` = parallelizable
(different files, no incomplete deps).

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Add `FEATURE_F9_DASHBOARD` (default false) + `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32 bytes) to the zod schema in `src/lib/env.ts` and `.env.local.example`
- [ ] T002 [P] Scaffold `src/modules/insights/` (`domain/`, `application/{use-cases,ports}/`, `infrastructure/{db,repos,pdf,blob,sources,audit}/`) + public barrel `src/modules/insights/index.ts`
- [ ] T003 [P] Add ESLint `no-restricted-imports` boundary rule for `src/modules/insights/**` (Domain/Application/Infrastructure deep-import block) in `eslint.config.mjs`
- [ ] T004 [P] Confirm `@vercel/blob` exposes `access:'private'` in the installed types; bump within `^2` if 2.3.3 predates the literal (`package.json`) [research R6]
- [ ] T005 [P] Create composition-root stub `src/modules/insights/insights-deps.ts` (`buildInsightsDeps()`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks ALL user stories. Migrations applied to live Neon + integration baseline before any story code (CLAUDE.md R8 gotcha).

- [ ] T006 Migration `0185_f9_dashboard_metrics_cache.sql` — table + RLS + FORCE + tenant policy in `drizzle/migrations/`
- [ ] T007 [P] Migration `0186_f9_smart_insight_dismissals.sql` — table + RLS+FORCE + unique `(tenant_id,insight_key,scope_ref,cycle_key)`
- [ ] T008 [P] Migration `0187_f9_directory_listings.sql` — table + RLS+FORCE + FK to `members`
- [ ] T009 [P] Migration `0188_f9_export_jobs.sql` — enums `export_kind`(incl `audit_export`)/`export_status` + table + RLS+FORCE + unique idempotency + `(tenant_id,status)` index
- [ ] T010 Migration `0189_f9_member_timeline_view.sql` — `CREATE VIEW member_timeline_v WITH (security_invoker = on)` + per-source keyset indexes (invoices/payments/events/broadcasts/renewals/audit) [data-model §9]
- [ ] T011 Migration `0190_f9_audit_indexes_and_stale_trigger.sql` — `audit_log` indexes `(tenant_id,event_type,timestamp DESC)`, `(tenant_id,actor_user_id,timestamp DESC)`, `(tenant_id,timestamp DESC)` + `AFTER INSERT` trigger flipping `dashboard_metrics_cache.stale` for relevant event types [R2-E1/E4]
- [ ] T011a Migration `0191_f9_audit_event_types.sql` — `ALTER TYPE <audit_event_type> ADD VALUE …` for the 14 F9 audit event types (data-model §7) **before any code emits them** [analyze H1; mirrors F8 enum extension]
- [ ] T012 Apply migrations 0185–0191 (`pnpm drizzle-kit migrate`) + run `pnpm test:integration` baseline GREEN before committing schema-referencing code
- [ ] T013 [P] Define 14 F9 audit event types + `InsightsAuditPort` (record/recordInTx) in `src/modules/insights/application/ports/audit-port.ts` [data-model §7]
- [ ] T014 [P] Extend `pnpm check:audit-events` to include the F9 event-type set (`scripts/`)
- [ ] T015 Drizzle schema for the 4 tables in `src/modules/insights/infrastructure/db/schema-insights.ts`
- [ ] T016 [P] Source-reader ports (`MemberSource`, `PlanSource`, `BroadcastConsumptionSource`, `EventConsumptionSource`, `InvoiceSource`) in `src/modules/insights/application/ports/source-ports.ts`
- [ ] T017 [P] Source-reader adapters that call each module's **public barrel** (no foreign-table imports) in `src/modules/insights/infrastructure/sources/*`
- [ ] T018 `check-f9-schema` CI guard (asserts RLS+FORCE on 4 tables + `member_timeline_v` is `security_invoker`) in `scripts/check-f9-schema.ts` + `package.json` script
- [ ] T019 [P] Cross-tenant isolation integration harness (2 tenants seeded, read+write both directions) in `tests/integration/insights/cross-tenant-isolation.test.ts` — **RED, Principle I Review-Gate blocker**

**Checkpoint**: Foundation ready — Slice A stories can begin.

---

## Phase 3: User Story 1 — Admin Operations Dashboard (P1) 🎯 MVP · Slice A

**Goal**: Replace the `/admin` placeholder with a live KPI dashboard (counts, YTD revenue, needs-attention, activity feed, smart insights, Engagement Score) served from a cached snapshot at p95 < 1.5 s.
**Independent Test**: Seed a tenant in known states; admin sees correct KPIs + needs-attention links + reverse-chron feed; manager sees finance-redacted variant; member is denied; empty tenant renders empty states.

### Tests (write first, ensure FAIL)

- [ ] T020 [P] [US1] Contract test `listDashboard` role projections (admin/manager/member) in `tests/contract/insights/dashboard.contract.test.ts`
- [ ] T021 [P] [US1] Unit test `projectEngagementScore` (inverse, band map, **null-last**) in `tests/unit/insights/engagement-score.test.ts`
- [ ] T022 [P] [US1] Integration test `computeDashboardSnapshot` counts/revenue/needs-attention/under-delivered vs seeded data in `tests/integration/insights/dashboard-snapshot.test.ts`
- [ ] T023 [P] [US1] E2E `@f9` dashboard: KPIs + needs-attention links + live feed + empty state + role access (admin/manager/member) in `tests/e2e/f9-dashboard.spec.ts`

### Implementation

- [ ] T024 [P] [US1] `EngagementScore` domain projection (100−risk, bands, null) in `src/modules/insights/domain/engagement-score.ts`
- [ ] T025 [P] [US1] `DashboardSnapshot` VO + fixed `SmartInsight` catalogue (3 keys) in `src/modules/insights/domain/{dashboard-snapshot,smart-insight}.ts`
- [ ] T026 [US1] `computeDashboardSnapshot` use-case (reads source ports; transactional upsert) in `src/modules/insights/application/use-cases/compute-dashboard-snapshot.ts`
- [ ] T027 [US1] `listDashboard` use-case (role projection + **cold-start lazy compute**, R1/E3) in `src/modules/insights/application/use-cases/list-dashboard.ts`
- [ ] T028 [US1] `listSmartInsights` + `dismissInsight` use-cases in `src/modules/insights/application/use-cases/`
- [ ] T029 [US1] `activityFeedQuery` — **live** last-N audit query, separate from snapshot (R2-E2/P2) in `src/modules/insights/application/use-cases/activity-feed-query.ts`
- [ ] T030 [US1] `SnapshotRepo` + `InsightDismissalRepo` drizzle impls (thread `tx` via `runInTenant`) in `src/modules/insights/infrastructure/repos/`
- [ ] T031 [US1] Wire `insights-deps.ts` (snapshot/insight/source/audit ports)
- [ ] T032 [US1] Dashboard page replacing placeholder (feature-flagged) in `src/app/(staff)/admin/page.tsx`
- [ ] T033 [P] [US1] Dashboard components `KpiCard` / `NeedsAttentionList` / `ActivityFeed` (polite live region) / `InsightsPanel` in `src/components/dashboard/`
- [ ] T034 [US1] Engagement Score column on admin members list (sortable/filterable, null-last, non-colour band) in `src/app/(staff)/admin/members/page.tsx` + component
- [ ] T035 [US1] Cron `snapshot-refresh-coordinator` + `snapshot-refresh/[tenantId]` routes in `src/app/api/cron/insights/`
- [ ] T036 [P] [US1] i18n keys EN/TH/SV for dashboard + insights + under-delivery; BE display for `th-TH`
- [ ] T037 [US1] Metrics `snapshot_refresh_duration_ms` + `snapshot_age_seconds` in `src/lib/metrics.ts`; emit `dashboard_viewed` + `smart_insight_dismissed`; **insight action/dismiss counter** (SC-012 measurement, analyze M2)
- [ ] T038 [US1] Nav item Dashboard (role-gated) in `src/config/nav.ts`

**Checkpoint**: US1 fully functional + independently testable (MVP).

---

## Phase 4: User Story 2 — Queryable Audit Log Viewer (P2) · Slice A

**Goal**: Read-only, filterable, exportable viewer over the append-only `audit_log`.
**Independent Test**: Seeded audit events filter correctly by type/actor/target/date, newest-first, role-redacted payload (actor identity visible to managers), export reproduces the filtered set, no mutation path, tenant-scoped.

### Tests (write first, ensure FAIL)

- [ ] T039 [P] [US2] Contract test `auditQuery` filters + keyset + redaction map in `tests/contract/auth/audit-query.contract.test.ts`
- [ ] T040 [P] [US2] Integration test tenant scope + per-event redaction map + actor-visible-to-manager in `tests/integration/auth/audit-query.test.ts`
- [ ] T041 [P] [US2] E2E `@f9` audit viewer: filter, export, read-only, manager redaction in `tests/e2e/f9-audit.spec.ts`

### Implementation

- [ ] T042 [US2] `auditQuery` use-case (filters, keyset `(timestamp,id)`, p95<1s@50k) in `src/modules/auth/application/use-cases/audit-query.ts`
- [ ] T043 [US2] Per-event-type **redaction map** (FR-011 sensitive categories) in `src/modules/auth/application/audit-redaction.ts`
- [ ] T044 [US2] Audit reader repo (keyset over `audit_log`, tenant-scoped) in `src/modules/auth/infrastructure/`
- [ ] T045 [US2] Export `auditQuery` + `auditExport` via `src/modules/auth/index.ts` barrel
- [ ] T046 [US2] `auditExport` — sync stream with ≤10k row cap → async `audit_export` fallback (R2-E2)
- [ ] T047 [US2] Audit viewer page in `src/app/(staff)/admin/audit/page.tsx`
- [ ] T048 [P] [US2] `AuditTable` + `AuditFilters` components in `src/components/audit/`
- [ ] T049 [P] [US2] i18n keys audit + dual timestamp (UTC + locale-local) rendering
- [ ] T050 [US2] Emit `audit_log_queried` + `audit_log_exported`; metric `audit_query_duration_ms`; Nav item Audit (role-gated) in `src/config/nav.ts`

**Checkpoint**: US1 + US2 work independently.

---

## Phase 5: User Story 3 — Unified Multi-Source Timeline (P3) · Slice A

**Goal**: Enrich the F3 audit-only timeline into a 6-source union with filtering, keyset pagination, role redaction, and member-portal parity.
**Independent Test**: Seeded multi-source member shows interleaved chrono stream; filters narrow by source/date/actor; 1,000+ entries paginate at p95<500ms/page; member sees own redacted timeline only.

### Tests (write first, ensure FAIL)

- [ ] T051 [P] [US3] Integration test `member_timeline_v` union ordering across 6 sources in `tests/integration/members/timeline-multisource.test.ts`
- [ ] T052 [P] [US3] Integration test keyset cursor correctness for identical `occurred_at` across sources (`ref_id` tiebreak) (R2-E7)
- [ ] T053 [P] [US3] E2E `@f9` timeline filters + member-own redaction in `tests/e2e/f9-timeline.spec.ts`

### Implementation

- [ ] T054 [US3] Swap timeline repo to query `member_timeline_v` (keyset) in `src/modules/members/infrastructure/timeline/drizzle-timeline-repo.ts`
- [ ] T055 [US3] Extend `timelineList` input with `{source?,from?,to?,actorKind?}` filters, signature preserved, in `src/modules/members/application/use-cases/timeline-list.ts`
- [ ] T056 [US3] Timeline i18n mapping `(source,payload)→timeline.<source>.<eventKind>` + legacy summary fallback in `src/components/members/timeline-client.tsx`
- [ ] T057 [US3] Member portal own-timeline page in `src/app/(member)/portal/timeline/page.tsx`
- [ ] T058 [P] [US3] Filter UI + virtualization (TanStack Virtual) timeline component
- [ ] T059 [P] [US3] i18n keys `timeline.<source>.<eventKind>` EN/TH/SV (all 6 sources)

**Checkpoint**: US1–US3 work independently.

---

## Phase 6: User Story 4 — Member Benefit Usage Dashboard (P3) · Slice A

**Goal**: Per-member, per-(calendar-tenant-tz)-year consumption vs entitlement, with the ≥25pt under-use warning. Member + staff views.
**Independent Test**: Seeded plan + consumption shows correct used/entitlement per benefit, last-used date, unlimited shown as active, warning fires at 25pt gap; year boundary correct.

### Tests (write first, ensure FAIL)

- [ ] T060 [P] [US4] Unit test benefit aggregation = mean of quantifiable ratios excluding unlimited + 25pt warning (fast-check) in `tests/unit/insights/benefit-usage.test.ts`
- [ ] T061 [P] [US4] Integration test membership-year boundary (Dec-31 vs Jan-1, tenant-tz) in `tests/integration/insights/benefit-year-boundary.test.ts` (R2-E5)
- [ ] T062 [P] [US4] E2E `@f9` benefit dashboard (member + admin variants) in `tests/e2e/f9-benefits.spec.ts`

### Implementation

- [ ] T063 [US4] `BenefitUsage` domain VO (ratios, unlimited handling, calendar-tenant-tz year) in `src/modules/insights/domain/benefit-usage.ts`
- [ ] T064 [US4] `computeBenefitUsage` use-case (plans + broadcast + event consumption) in `src/modules/insights/application/use-cases/compute-benefit-usage.ts`
- [ ] T065 [US4] Member benefit page (extend) in `src/app/(member)/portal/benefits/page.tsx`
- [ ] T066 [US4] Staff member benefit page in `src/app/(staff)/admin/members/[memberId]/benefits/page.tsx`
- [ ] T067 [P] [US4] `BenefitUsageCard` + `UnderUseWarning` components (non-colour bars) in `src/components/benefits/`
- [ ] T068 [US4] Emit `member_benefit_viewed` (staff reads) + **member self-view counter** (SC-012 adoption measurement, analyze M2); i18n keys EN/TH/SV

**Checkpoint**: **Slice A complete** (US1–US4) — review/ship as the first increment.

---

## Phase 7: User Story 5 — Directory + E-Book (P4) · Slice B

**Goal**: Internal searchable directory, opt-in listings (fixed field set + logo), deterministic PDF E-Book, JSON export.
**Independent Test**: Staff search all; published outputs include only listed members + chosen fields (email hidden by default); E-Book deterministic; JSON contains exactly opt-in listings.

### Slice B shared export infrastructure (used by US5 + US6)

- [ ] T069 [US5] `PrivateBlobPort` + `private-blob-adapter` (put private + sign single-use token + delete) in `src/modules/insights/infrastructure/blob/private-blob-adapter.ts`
- [ ] T070 [US5] `ExportJob` domain state machine (incl `processing→failed` reclaim, R2-E2) + `ExportJobRepo` in `src/modules/insights/domain/export-job.ts` + repo
- [ ] T071 [US5] `processExportJob` worker use-case + per-(tenant,job) advisory lock in `src/modules/insights/application/use-cases/process-export-job.ts`
- [ ] T072 [US5] Cron `process-export-jobs` route (claim + TTL sweep + stuck reclaim) in `src/app/api/cron/insights/process-export-jobs/route.ts`
- [ ] T073 [US5] Authenticated download proxy (session + RBAC + single-use token + expiry; Blob URL never exposed) in `src/app/api/internal/exports/[jobId]/download/route.ts`

### Tests (write first, ensure FAIL)

- [ ] T074 [P] [US5] Integration test directory publication (only listed + chosen fields, email hidden) in `tests/integration/insights/directory.test.ts`
- [ ] T075 [P] [US5] Integration test logo pipeline (re-encode + EXIF strip, reject oversize/non-image, original never served) in `tests/integration/insights/logo-upload.test.ts` (FR-025a)
- [ ] T076 [P] [US5] E2E `@f9` directory search + visibility toggles + E-Book generate + download in `tests/e2e/f9-directory.spec.ts`

### Implementation

- [ ] T077 [US5] `DirectoryListing` domain (fixed field set + visibility policy, default private/email-hidden) in `src/modules/insights/domain/directory-listing.ts`
- [ ] T078 [US5] `searchDirectory` + `updateDirectoryListing` use-cases + `DirectoryRepo` (thread tx)
- [ ] T079 [US5] Logo upload pipeline (`sharp` re-encode/EXIF strip → private blob) in `src/modules/insights/infrastructure/sources/logo-upload.ts`
- [ ] T080 [US5] `generateDirectoryEbook` use-case (→ `export_jobs`) + react-pdf E-Book document (tenant-default locale, Sarabun) in `src/modules/insights/infrastructure/pdf/directory-ebook-document.tsx`
- [ ] T081 [US5] `exportDirectoryJson` use-case (opt-in only, chosen fields, nested JSON)
- [ ] T082 [US5] Directory admin page in `src/app/(staff)/admin/directory/page.tsx` + visibility settings under `src/app/(member)/portal/profile/`
- [ ] T083 [P] [US5] `DirectoryTable` + `VisibilityToggles` + logo upload control components in `src/components/directory/`
- [ ] T084 [US5] i18n keys directory + E-Book labels; Nav item Directory (role-gated) in `src/config/nav.ts`
- [ ] T085 [US5] Emit `directory_listing_updated` / `directory_ebook_generated` / `directory_json_exported` / logo set-remove; export-job metrics

**Checkpoint**: US5 functional; shared export infra ready for US6.

---

## Phase 8: User Story 6 — GDPR Self-Service Export (P4) · Slice B

**Goal**: Member self-service (and admin-on-behalf) data archive with redacted audit subset, delivered via private single-use download.
**Independent Test**: Member exports own data only; archive has all categories + README + manifest; audit subset = member-performed ∪ member-targeted with third-party PII stripped; admin-on-behalf attributed.

### Tests (write first, ensure FAIL)

- [ ] T086 [P] [US6] Integration test archive contents + **audit-subset redaction** (100% branch on scoping) in `tests/integration/insights/gdpr-export.test.ts`
- [ ] T087 [P] [US6] Integration test member-cannot-export-others + admin-on-behalf attribution in `tests/integration/insights/gdpr-authz.test.ts`
- [ ] T088 [P] [US6] E2E `@f9` portal export request → notification → single-use download in `tests/e2e/f9-gdpr-export.spec.ts`

### Implementation

- [ ] T089 [US6] `requestDataExport` use-case (idempotent; own-only / admin-on-behalf) in `src/modules/insights/application/use-cases/request-data-export.ts`
- [ ] T090 [US6] GDPR archive builder (profile/contacts/invoices+PDFs/events/broadcasts/audit-subset/README/manifest) in `src/modules/insights/infrastructure/sources/gdpr-archive-builder.ts`
- [ ] T091 [US6] Audit-subset query (member-performed ∪ member-targeted + third-party redaction) + handle archived/erased subject (FR-032a)
- [ ] T092 [US6] Wire `processExportJob` for `gdpr_member_archive` kind
- [ ] T093 [US6] Portal data-export page in `src/app/(member)/portal/account/data-export/page.tsx`
- [ ] T094 [US6] README localisation (requester locale) + manifest (neutral) + localised notifications
- [ ] T095 [US6] Emit `data_export_requested/generated/downloaded/failed/expired`

**Checkpoint**: **Slice B complete** (US5–US6) — review/ship as the second increment.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T096 [P] i18n parity: `pnpm check:i18n` GREEN for all F9 keys (EN canonical, TH+SV present); BE display verified
- [ ] T097 [P] a11y: `pnpm test:e2e --grep "@a11y" --workers=1` on all F9 surfaces (non-colour bands, polite live region, form labels, reduced-motion)
- [ ] T098 [P] Perf: EXPLAIN-backed tests — dashboard p95<1.5s@5k (SC-002), audit query p95<1s@50k (FR-008), timeline page p95<500ms (FR-016)
- [ ] T099 [P] Observability: add F9 SLOs + alert thresholds to `docs/observability.md`; verify no PII in metric labels
- [ ] T100 [P] Runbook: append F9 cron section (snapshot + export) to `docs/runbooks/cron-jobs.md`
- [ ] T101 cron-job.org coordinator config documented (snapshot-refresh */5 + process-export-jobs */5, Bearer CRON_SECRET) — ship-day gate
- [ ] T102 **Cross-tenant isolation suite GREEN** across dashboard/audit/timeline/directory/export (Principle I Review-Gate blocker; T019 closure)
- [ ] T103 [P] Update CLAUDE.md Recent Changes + add `src/modules/insights/**` to module list
- [ ] T103a Extend `vitest.config.ts` 100%-branch coverage include with the F9 security-critical use-cases (audit-query redaction, GDPR export scoping, tenant-isolation guards, engagement projection) [analyze M1, Constitution II/IX]
- [ ] T104 Full CI: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:f9-schema && pnpm check:audit-events && pnpm test:integration && pnpm test:e2e`
- [ ] T105 Co-sign `checklists/security.md` (solo-maintainer substitute footer, v1.4.2) at Review gate

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **BLOCKS all stories**. Migrations (T006–T012) before any schema-referencing code.
- **Slice A**: US1 (P3) → US2 (P4) → US3 (P5) → US4 (P6). All depend on Foundational; independently testable.
- **Slice B**: US5 (P7) ships the **shared export infra (T069–T073)** that **US6 (P8) depends on**. Both depend on Foundational; deliver/review as one slice.
- **Polish (P9)** → after the stories in scope are complete.

### Story independence

- US1–US4 are mutually independent (each independently testable); recommended order is priority order.
- US6 depends on US5's export infrastructure (T069–T073) — both are Slice B, delivered together.

### Within each story

- Tests authored + **failing** before implementation (Constitution II).
- Domain → Application (use-cases) → Infrastructure (repos/adapters) → Presentation → cron/metrics/i18n.

### Parallel opportunities

- Setup T001–T005 all `[P]`.
- Foundational migrations T007–T009 `[P]` (T006/T010/T011 touch shared/ordered SQL; T012 gates).
- Per-story: all test tasks `[P]`; domain VOs `[P]`; components `[P]`.
- With capacity, US1–US4 can be built in parallel after Foundational.

---

## Parallel Example: User Story 1

```bash
# Tests first (all parallel):
Task: T020 Contract test listDashboard role projections
Task: T021 Unit test projectEngagementScore (null-last)
Task: T022 Integration test computeDashboardSnapshot
Task: T023 E2E @f9 dashboard

# Then domain (parallel):
Task: T024 EngagementScore projection
Task: T025 DashboardSnapshot VO + SmartInsight catalogue
```

---

## Implementation Strategy

- **MVP** = Setup + Foundational + **US1** (dashboard). Stop, validate, demo.
- **Slice A** (US1–US4) = first reviewable/shippable increment → `/speckit.verify` → `/speckit.review` (security co-sign) → optional flag-flip.
- **Slice B** (US5–US6) = second increment (directory + GDPR) → review → flag-flip.
- Flag everything behind `FEATURE_F9_DASHBOARD`; tables + cron ship dark first.

## Notes

- `[P]` = different files, no incomplete deps. `[USx]` maps to spec user stories.
- Every repo method threads `tx` from `runInTenant` — never the global `db` (CLAUDE.md gotcha).
- Apply each migration + run integration before committing schema-referencing code (CLAUDE.md R8).
- `--workers=1` mandatory on `pnpm test:e2e`.
- Total: **107 tasks** across 9 phases (Slice A: T001–T068 incl. foundation + T011a; Slice B: T069–T095; Polish: T096–T105 + T103a). Two tasks added post-`/speckit.analyze` (T011a audit-enum migration H1, T103a vitest coverage config M1).
