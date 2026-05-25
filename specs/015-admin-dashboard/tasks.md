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

- [X] T001 [P] Add `FEATURE_F9_DASHBOARD` (default false) + `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32 bytes) to the zod schema in `src/lib/env.ts` and `.env.local.example` — done 2026-05-25: secret is `.optional()` + cross-field-required when `FEATURE_F9_DASHBOARD=true` (mirrors F6 salt idiom; keeps F9-dark + local Slice-A boot clean); exposed as `env.features.f9Dashboard` + `env.insights.exportDownloadTokenSecret` (`?? null`). `.env.example` block appended.
- [X] T002 [P] Scaffold `src/modules/insights/` (`domain/`, `application/{use-cases,ports}/`, `infrastructure/{db,repos,pdf,blob,sources,audit}/`) + public barrel `src/modules/insights/index.ts` — done 2026-05-25 (barrel is `export {}` until first export lands).
- [X] T003 [P] Add ESLint `no-restricted-imports` boundary rule for `src/modules/insights/**` (Domain/Application/Infrastructure deep-import block) in `eslint.config.mjs` — done 2026-05-25 (added insights pattern block + added `src/modules/insights/**` to cross-module ignores). NOTE: flat-config shadow block (events-brand, `files: src/**`) still shadows this at runtime — a source-scan architecture test backstops it (add alongside T017a).
- [X] T004 [P] Confirm `@vercel/blob` exposes `access:'private'` in the installed types; bump within `^2` if 2.3.3 predates the literal (`package.json`) [research R6] — done 2026-05-25: installed 2.3.3 `dist/index.d.ts` already exposes `access: 'public' | 'private'` on `put`/`get`. No bump needed.
- [X] T005 [P] Create composition-root stub `src/modules/insights/insights-deps.ts` (`buildInsightsDeps()`) — done 2026-05-25 (exposes `systemClock` + stub `buildInsightsDeps()`; located under `infrastructure/` per plan source tree). typecheck + lint GREEN.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: Blocks ALL user stories. Migrations applied to live Neon + integration baseline before any story code (CLAUDE.md R8 gotcha).

- [X] T006 Migration `0185_f9_dashboard_metrics_cache.sql` — table + RLS + FORCE + tenant policy + chamber_app GRANT + rollback SQL. Applied to live Neon 2026-05-25.
- [X] T007 [P] Migration `0186_f9_smart_insight_dismissals.sql` — table + RLS+FORCE + unique `(tenant_id,insight_key,scope_ref,cycle_key)` + insight_key CHECK + GRANT. Applied. NOTE: scope_ref is `NOT NULL DEFAULT ''` (sentinel) so the unique index dedupes tenant-wide dismissals (NULLs would be distinct).
- [X] T008 [P] Migration `0187_f9_directory_listings.sql` — table + RLS+FORCE + composite FK `(tenant_id,member_id)` to `members` + website-scheme/description-length CHECKs + GRANT. Applied.
- [X] T009 [P] Migration `0188_f9_export_jobs.sql` — enums `export_kind`(incl `audit_export`)/`export_status` + table + RLS+FORCE + unique idempotency + `(tenant_id,status)` index + GRANT. Applied.
- [X] T010 Migration `0189_f9_member_timeline_view.sql` — `CREATE VIEW member_timeline_v WITH (security_invoker = on)` (6-source UNION ALL) + 7 per-source keyset indexes [data-model §9]. Applied + verified `security_invoker=on`. DISCOVERY: `member_id`/`ref_id` emitted as TEXT (not uuid) — `payments.member_id` is uuid-in-DB + `payments.id` is ULID-text + audit payload member_id is text; uniform UNION type requires text (documented in migration header).
- [X] T011 Migration `0190_f9_audit_indexes_and_stale_trigger.sql` — 3 `audit_log` composite indexes + `AFTER INSERT` trigger `trg_f9_flag_dashboard_stale` flipping `dashboard_metrics_cache.stale` (SECURITY INVOKER, `event_type::text` compare so a non-enum label can't break audit inserts; fires on member_created/status_changed/archived/plan_changed/payment_succeeded/broadcast_approved) [R2-E1/E4]. Applied.
- [X] T011a Migration `0191_f9_audit_event_types.sql` — `ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS …` for the 14 F9 audit event types (data-model §7) [analyze H1]. Applied + verified 14/14.
- [X] T012 Apply migrations 0185–0191 — **DONE** (`pnpm db:migrate` → all 7 applied to live Neon; `pnpm check:f9-schema` PASS). Integration baseline 2026-05-25 — **F9 VERIFIED CLEAN**:
  - Stale-trigger proven harmless: fires on every `audit_log` insert yet broke ZERO audit-writing tests (F4 timeline / F6 webhook_rolled_back / broadcasts cross-tenant probe / payments OOB-refund all GREEN). Its UPDATE matches 0 rows under RLS with no tenant context → cannot error; F9 makes zero changes to audit_log read semantics. **No failure references any F9 artifact.**
  - Pre-existing non-F9 red #1 (~29 tests, FIXED on this branch per user OK): F8 seed helper `tests/integration/helpers/seed-f8-plan.ts:62` defaulted `description: {en:''}` (PR #24) → violates F7.1a constraint `membership_plans_description_en_non_empty` (migration 0174, PR #27). Fixed default → `{ en: 'F8 Test Plan' }`; previously-failing subset re-run = 37/38 GREEN.
  - Pre-existing non-F9 red #2 (1 test, REPORTED, NOT fixed — out of scope): `tests/integration/broadcasts/us3-tenant-isolation.test.ts:165` seeds `payload: { memberId }` (camelCase) but `MemberRepo.findLastPlanChangedAt` (drizzle-member-repo.ts:911) queries `payload->>'member_id'` (snake_case) → returns null. 1-line test-seed typo, fails identically on main, unrelated to F9.
  - NOTE: full-suite re-run after the seed-helper fix not repeated (avoid heavy re-runs); subset re-verified GREEN + change is low-risk (only affects seedF8 callers omitting a description). Recommend one final full `pnpm test:integration` before Slice-A ship.
- [X] T013 [P] Define 14 F9 audit event types + `InsightsAuditPort` (record/recordInTx) in `src/modules/insights/application/ports/audit-port.ts` [data-model §7] — done 2026-05-25: typed discriminated union (no-PII payloads), all 5y retention; Infra adapter `infrastructure/audit/insights-audit-adapter.ts` writes raw SQL to shared `audit_log` w/ `retention_years` (mirrors F5). typecheck+lint GREEN.
- [X] T014 [P] Extend `pnpm check:audit-events` to include the F9 event-type set (`scripts/check-audit-event-count.ts`) — done 2026-05-25: `checkF9Parity()` asserts migration 0191 ADD VALUEs ↔ `F9_AUDIT_EVENT_TYPES` (both 14). F9 part prints `OK — 14 match`. NOTE: script overall exits 1 on a **pre-existing F5 prose drift** (canonical 20 vs stale "22"/"18" in specs/009 docs) — unrelated to F9, untouched F5 docs, not in default pre-push. Edit is behavior-preserving for F5; F5 cleanup = separate PR.
- [X] T015 Drizzle schema for the 4 tables in `src/modules/insights/infrastructure/db/schema-insights.ts` — done 2026-05-25: byte-faithful to migrations 0185–0188; registered in `drizzle.config.ts` (R022 anti-DROP). typecheck+lint GREEN.
- [X] T016 [P] Source-reader ports (`MemberSource`, `PlanSource`, `BroadcastConsumptionSource`, `EventConsumptionSource`, `InvoiceSource`) in `src/modules/insights/application/ports/source-ports.ts` — done 2026-05-25: interfaces grounded in FR-001/002/019/021 + data-model R1/R2; each annotated w/ backing barrel export + gaps. typecheck+lint GREEN.
- [~] T017 [P] Source-reader adapters in `src/modules/insights/infrastructure/sources/*` — **MemberSource + InvoiceSource DONE** 2026-05-25, both compose from EXISTING barrels (zero members/invoicing surgery; all F9 code stays in insights): `member-source-adapter.ts` (`directorySearchWithCount`+`buildMembersDeps`) + `invoice-source-adapter.ts` (`listInvoices`+`computeIsOverdue`+`makeListInvoicesDeps`; sums `Invoice.total.satang` for paid, counts overdue issued). Both verified via T022 integration (live Neon, empty-invoice case GREEN — adapter+pagination runs cleanly). **PENDING**: `BroadcastConsumptionSource` (eblast `computeQuotaCounter`; awaiting-approval count needs a NEW broadcasts barrel export), `EventConsumptionSource` (`getEventAttendeesByMember` filtered cultural), `PlanSource` (`getPlan`) — all couple to US4 benefit aggregate / a broadcasts export. **Follow-up**: a non-zero revenue/overdue integration assertion needs invoice seeding (deferred — adapter logic is type-checked + the empty path is live-verified).
- [~] T017a [P] Contract tests for inter-module boundaries [analyze R2-M1] — **DEFERRED with T017** (adapters must exist to test conformance against real barrels).
- [X] T018 `check-f9-schema` CI guard (asserts RLS+FORCE on 4 tables + 4 policies + `member_timeline_v` is `security_invoker` + 2 export enums + 14 audit event types + stale trigger) in `scripts/check-f9-schema.ts` + `pnpm check:f9-schema`. Run 2026-05-25 → PASS.
- [X] T019 [P] Cross-tenant isolation integration harness in `tests/integration/insights/cross-tenant-isolation.test.ts` — done 2026-05-25: **10/10 GREEN on live Neon** (READ/UPDATE/DELETE/INSERT-spoof probes on the 3 FK-free F9 tables + own-row-visible sanity). Principle I DB-layer guarantee proven. `directory_listings` (member+plan FK chain) → US5; `member_timeline_v` → US3; audit-query → US2; aggregate closure → T102.

**Checkpoint**: Foundation ready — Slice A stories can begin.

---

## Phase 3: User Story 1 — Admin Operations Dashboard (P1) 🎯 MVP · Slice A

**Goal**: Replace the `/admin` placeholder with a live KPI dashboard (counts, YTD revenue, needs-attention, activity feed, smart insights, Engagement Score) served from a cached snapshot at p95 < 1.5 s.
**Independent Test**: Seed a tenant in known states; admin sees correct KPIs + needs-attention links + reverse-chron feed; manager sees finance-redacted variant; member is denied; empty tenant renders empty states.

### Tests (write first, ensure FAIL)

- [X] T020 [P] [US1] Contract test `listDashboard` role projections (admin/manager/member) — done 2026-05-25, 5 unit tests GREEN in `tests/unit/insights/list-dashboard.test.ts` (mocked; member-forbidden + admin-full + manager-finance-redacted + cold-start-recompute + recompute-fail→snapshot_unavailable). `listDashboard` opens no direct DB tx (repo self-scopes) so it's fully unit-testable.
- [X] T021 [P] [US1] Unit test `projectEngagementScore` (inverse, band map, null score, clamp) in `tests/unit/insights/engagement-score.test.ts` — done 2026-05-25, 12 tests GREEN (TDD: authored RED before T024). NOTE: null-LAST sort is a presentation concern (members-list column T034), not the pure projection; the projection returns null for un-scored members and the column sorts nulls last.
- [~] T022 [P] [US1] Integration test `computeDashboardSnapshot` vs seeded data in `tests/integration/insights/dashboard-snapshot.test.ts` — **DONE for Increment 1** 2026-05-25, 2/2 GREEN on live Neon (8 members seeded by status+band → counts {total:8, active:6, atRisk:3} + at_risk_followup insight + dismissal suppression verified). revenue/overdue/under-delivered assertions pending Increment 2 (InvoiceSource).
- [X] T023 [P] [US1] E2E `@f9` dashboard in `tests/e2e/f9-dashboard.spec.ts` — done 2026-05-25, **9/9 GREEN** across chromium + mobile-safari + mobile-chrome (1.3m, `--workers=1`): admin sees KPIs + needs-attention links (asserts hrefs) + insights + activity feed + THB revenue + "As of" freshness; manager finance-redacted (no THB in KPI region); member denied (redirected off /admin). Structure/role assertions (not brittle counts), runs vs the seeded swecham tenant. Confirms mobile-first responsive too.

### Implementation

- [X] T024 [P] [US1] `EngagementScore` domain projection (100−risk clamp, band inversion, null) in `src/modules/insights/domain/engagement-score.ts` — done 2026-05-25, 12/12 GREEN. Pure (no imports). `RiskBand`→`EngagementBand` map: critical→critical, at-risk→warning, warning→moderate, healthy→healthy.
- [X] T025 [P] [US1] `DashboardSnapshot` VO + fixed `SmartInsight` catalogue (3 keys) in `src/modules/insights/domain/{dashboard-snapshot,smart-insight}.ts` — done 2026-05-25, 5/5 GREEN. Catalogue `INSIGHT_KEYS` + per-insight `INSIGHT_CATALOGUE` granularity (membership_year | iso_week); drift-guarded against migration 0186 CHECK. `DashboardSnapshot` carries money as satang string (JSONB no-bigint) + `emptySnapshot()` for FR-006.
- [~] T026 [US1] `computeDashboardSnapshot` use-case in `src/modules/insights/application/use-cases/compute-dashboard-snapshot.ts` — **Increment 1 + 2 DONE** 2026-05-25: reads `MemberSource` (counts by status + at-risk) + `InvoiceSource` (YTD paid revenue + overdue count, calendar-year-in-tenant-tz) → builds `DashboardSnapshot` → filters dismissed insights (in-tx via `isDismissedInTx`) → upserts cache (`runInTenant`). 2/2 integration GREEN. **Still pending**: `broadcastsAwaitingApproval` (needs broadcasts barrel count export), `underDeliveredBenefitCount` + 2 quota insights (US4 benefit aggregate) — emitted as 0/empty with fields present. Also DONE: synced Drizzle `auditEventTypeEnum` (auth/schema.ts) with the 14 F9 values (F5/F7 precedent).
- [X] T027 [US1] `listDashboard` use-case (role projection + **cold-start lazy compute**, R1/E3) in `src/modules/insights/application/use-cases/list-dashboard.ts` — done 2026-05-25: member→forbidden, admin→full, manager→finance-redacted (`ytdPaidRevenueSatang` null), cold-start→`recompute` lazy compute, compute-fail→`snapshot_unavailable`; emits best-effort `dashboard_viewed` PII-read audit (FR-036). `DashboardView` + `ProjectedDashboard` types. Refactored `SnapshotRepo.readInTx(tx)` → `read(ctx)` (self-scoping) so the read path needs no direct `runInTenant`. 5 unit tests GREEN; `makeListDashboardDeps` + barrel exports.
- [~] T028 [US1] `listSmartInsights` + `dismissInsight` use-cases in `src/modules/insights/application/use-cases/` — **dismissInsight DONE** 2026-05-25 (+ `cycleKeyFor` domain helper, 5 unit tests GREEN): use-case (RBAC staff-only/member-forbidden + invalid-key guards + idempotent write + atomic `smart_insight_dismissed` audit) → `InsightDismissalRepo` port + `makeDrizzleInsightDismissalRepo` (ON CONFLICT DO NOTHING) + `makeDismissInsightDeps` + barrel exports. 2 unit (guard branches) + 3 integration (live Neon: write/audit, idempotent replay, manager-allowed) GREEN. typecheck+lint clean. **PENDING**: `listSmartInsights` (reads snapshot.topInsights minus dismissals) — depends on `computeDashboardSnapshot` (T026).
- [X] T029 [US1] `activityFeedQuery` — **live** last-N audit query, separate from snapshot (R2-E2/P2) — done 2026-05-25, 3/3 integration GREEN. Built the auth-side reader (`listRecentAuditEvents` use-case + `auditReadAdapter`, RLS-scoped via `runInTenant`, SEPARATE from the append-only `auditRepo`) + auth barrel export; insights `ActivityFeedSource` port + `activity-feed-adapter` (calls auth barrel, Principle III) + `activityFeedQuery` use-case (staff-only, member-forbidden). Integration verifies newest-first + RLS isolation (tenant B's event absent) + limit + forbidden. NOTE: the shared test DB's null-tenant_id legacy audit rows surface to all tenants per the existing `audit_log_tenant_isolation` policy (pre-existing F2 behaviour) — the feed correctly scopes non-null rows to the tenant.
- [~] T030 [US1] `SnapshotRepo` + `InsightDismissalRepo` drizzle impls — **DONE** 2026-05-25: `makeDrizzleSnapshotRepo` (read + upsert via PK ON CONFLICT, clears stale + refresh_started_at) + `makeDrizzleInsightDismissalRepo` (dismiss ON CONFLICT DO NOTHING + isDismissedInTx). Both thread `tx` via `runInTenant`. **PENDING refinement**: the `refresh_started_at` **claim-marker** concurrency guard (cold-start vs cron double-compute, analyze R2-L2) — column exists + cleared on upsert, but the claim/skip logic lands with T027 (listDashboard cold-start) + T035 (cron). Double-compute is idempotent/safe in the interim.
- [ ] T031 [US1] Wire `insights-deps.ts` (snapshot/insight/source/audit ports)
- [X] T032 [US1] Dashboard page replacing placeholder (feature-flagged) in `src/app/(staff)/admin/page.tsx` — done + **BROWSER-VERIFIED via Playwright** 2026-05-25 on :3100 (FEATURE_F9_DASHBOARD=true): admin sees KPIs (Total 49 / Active 49 / At-risk 6 / **Paid revenue THB 1,475,915**), Needs-attention (Overdue 1 + links), Smart insights ("6 at-risk members need follow-up"), Recent-activity feed (newest-first incl. `dashboard viewed by admin`), "As of" freshness. Manager → **revenue redacted to "—"** (FR-007), counts visible. No-session → redirects to /admin/sign-in (auth guard). **0 console errors.** This ALSO proved the non-zero InvoiceSource path (revenue/overdue from real invoices) that the T022 integration couldn't cover. Components rendered inline (T033 refactor follow-up).
- [X] T033 [P] [US1] Dashboard components `KpiCard` / `NeedsAttentionList` / `ActivityFeed` (polite live region) / `InsightsPanel` in `src/components/dashboard/` — done 2026-05-25: extracted the 4 inline sections into pure presentational server components (display-ready props; page keeps data+format/i18n). `/admin/page.tsx` refactored to compose them. typecheck + lint clean. **BROWSER-VERIFIED via Playwright** — refactored page renders identically (manager: KPIs incl. revenue "—", needs-attention links, insights, activity feed), 0 console errors.
- [X] T034 [US1] Engagement Score column on admin members list (non-colour band) in `src/components/members/members-table.tsx` — **added** 2026-05-25: display column projecting engagement from the existing `member_risk_flag` (score + band), rendered as numeric score + text band label (non-colour, FR-035); null → "—". i18n `columns.engagement` + `engagementBand.*` in EN/TH/SV (check:i18n OK). typecheck + lint clean. **G1 done 2026-05-25** — projection moved SERVER-SIDE to the page row-mapping (`src/app/(staff)/admin/members/page.tsx`) using the canonical `projectEngagementScore` (`@/modules/insights`); the client cell now only renders the ready `{score,band}` value via a type-only `EngagementBand` import (erased at build — no insights server-graph leak into the client component, barrel-guard clean). Sort/filter reuses the existing server-side `?risk_band=` param. **BROWSER-VERIFIED via Playwright** 2026-05-25: correct inversion — risk 40/Warning → "60 Moderate", risk 65/At-risk → "35 Watch", risk 78/Critical → "22 Critical" (non-colour text), 0 console errors. **e2e @f9 + @a11y T097 6/6 GREEN** post-G1 (members page renders + axe-clean across 3 platforms).
- [X] T035 [US1] Cron `snapshot-refresh-coordinator` + `snapshot-refresh/[tenantId]` routes in `src/app/api/cron/insights/` — done 2026-05-25: both `verifyCronBearer` (constant-time) + `FEATURE_F9_DASHBOARD` 200-skipped guard (no retry-storm dark-launch) + `runtime='nodejs'` + call the tested `computeDashboardSnapshot`; failures log + return 200 (cron-job.org-safe). Coordinator refreshes the deployed tenant (single-tenant MVP; multi-tenant fan-out + stale-prioritisation deferred to F10). Per-tenant route validates `[tenantId]` via `asTenantContext`. typecheck + lint clean. **Follow-up**: a contract test for the 401/skipped/ok paths + cron-job.org config (T101).
- [X] T036 [P] [US1] i18n keys EN/TH/SV for dashboard + insights — done 2026-05-25: `admin.dashboard.*` added to all 3 locales (title/subtitle/asOf/empty/kpi/needsAttention/insights/activity); `check:i18n` OK (3157 keys parity). Dates render via `Intl.DateTimeFormat(locale)`; THB via `Intl.NumberFormat`. (BE-display for th-TH is `Intl`-driven at render — verify in-browser with T023.)
- [X] T037 [US1] Metrics in `src/lib/metrics.ts` — **done 2026-05-25** (typecheck + 29 unit + lint GREEN): added `insightsMetrics` (cardinality-safe, no PII labels) → `snapshot_refresh_duration_ms` (histogram) + `snapshot_refresh_total` (counter, ok/failed) wired into both cron routes; `dashboard_viewed_total` wired into `listDashboard`; `insight_dismissed_total` (SC-012 / analyze M2) wired into `dismissInsight`. (`dashboard_viewed` + `smart_insight_dismissed` AUDIT events already emit via the use-cases.) SLOs/alerts now documented in `docs/observability.md` §25 (T099 ✓). **Intentionally deferred**: `snapshot_age_seconds` observable gauge (needs a scrape-time per-tenant DB read; staleness already bounded by FR-005 cadence + SC-013).
- [X] T038 [US1] Nav item Dashboard (staff nav — admin + manager) in `src/config/nav.ts` — already present (the `/admin` Dashboard item with `LayoutDashboardIcon` exists in `staffNavConfig`); the F9 dashboard replaces that route's content. No nav change needed.

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
- [ ] T050 [US2] Emit `audit_log_queried` + `audit_log_exported`; metric `audit_query_duration_ms`; Nav item Audit (staff nav — admin + manager) in `src/config/nav.ts`

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
- [ ] T073a [P] [US5] Contract test for the download-proxy authorization matrix — 401 no-session · 403 wrong subject/tenant · 404 unknown · 409 not-ready · 410 expired/swept · single-use token invalidation — in `tests/contract/insights/export-download.contract.test.ts` [analyze R2-M2, security-critical]

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
- [ ] T084 [US5] i18n keys directory + E-Book labels; Nav item Directory (staff nav — admin + manager) in `src/config/nav.ts`
- [ ] T085 [US5] Emit `directory_listing_updated` / `directory_ebook_generated` / `directory_json_exported` / logo set-remove; export-job metrics

**Checkpoint**: US5 functional; shared export infra ready for US6.

---

## Phase 8: User Story 6 — GDPR Self-Service Export (P4) · Slice B

**Goal**: Member self-service (and admin-on-behalf) data archive with redacted audit subset, delivered via private single-use download.
**Independent Test**: Member exports own data only; archive has all categories + README + manifest; audit subset = member-performed ∪ member-targeted with third-party PII stripped; admin-on-behalf attributed.

### Tests (write first, ensure FAIL)

- [ ] T086 [P] [US6] Integration test archive contents + **audit-subset redaction** (100% branch on scoping) + **manifest checksum validates** (SC-008, analyze R2-L4) in `tests/integration/insights/gdpr-export.test.ts`
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
- [X] T097 [P] a11y (E2): `pnpm test:e2e --grep "@a11y T097" --workers=1` — **done 2026-05-25, 6/6 GREEN** (chromium + mobile-safari + mobile-chrome × /admin + /admin/members) via new `tests/e2e/f9-a11y.spec.ts` (AxeBuilder wcag2a/aa/21a/21aa, fail on serious/critical). Scan surfaced + fixed **2 pre-existing F8 `aria-prohibited-attr` violations** on the members page (engagement column itself was clean): (1) risk-not-computed `<span>` — removed redundant prohibited `aria-label` (visible text "Not yet scored" is the accessible name; tooltip wired via aria-describedby; WCAG 2.5.3 satisfied); (2) `RiskScoreBadge` — added `role="img"` to make its `aria-label` valid (badge pattern, inner spans aria-hidden, SR experience preserved). Dashboard `/admin` had zero violations. Remaining a11y surfaces (audit/timeline/directory) ship with US2–US4.
- [~] T098 [P] Perf (E1 partial): index-existence guard **done 2026-05-25** — `scripts/check-f9-schema.ts` now asserts all 10 perf-critical indexes present (3 audit_log composites + 7 timeline keyset indexes; `pnpm check:f9-schema` → "F9 perf indexes 10/10" PASS). **PENDING**: full EXPLAIN-backed p95 measurements (dashboard <1.5s@5k SC-002, audit <1s@50k FR-008, timeline <500ms FR-016) — deferred to post-seed-scale verify; numeric CPs NOT yet measured so not claimed.
- [X] T099 [P] Observability (F1): **done 2026-05-25** — added `docs/observability.md` §25 (F9): metrics catalogue (`snapshot_refresh_duration_ms`, `snapshot_refresh_total`, `dashboard_viewed_total`, `insight_dismissed_total`), SLO budgets, and alert thresholds. Verified no PII in metric labels (cardinality-safe: tenant slug + outcome only, no member/actor identifiers).
- [ ] T100 [P] Runbook: append F9 cron section (snapshot + export) to `docs/runbooks/cron-jobs.md`
- [ ] T101 cron-job.org coordinator config documented (snapshot-refresh */5 + process-export-jobs */5, Bearer CRON_SECRET) — ship-day gate
- [ ] T102 **Cross-tenant isolation suite GREEN** across dashboard/audit/timeline/directory/export (Principle I Review-Gate blocker; T019 closure)
- [ ] T103 [P] Update CLAUDE.md Recent Changes + add `src/modules/insights/**` to module list
- [X] T103a Extend `vitest.config.ts` 100%-branch coverage include with the F9 security-critical use-cases — **done 2026-05-25**: added F9 per-file thresholds — `engagement-score.ts` / `insight-cycle-key.ts` / `smart-insight.ts` at full 100% (statements/branches/functions/lines) + `list-dashboard.ts` at branches:100 (role-projection guard). Verified via `pnpm test:coverage`: all tests pass, ZERO insights threshold errors, F9 100% pins hold. Audit-query redaction + GDPR export scoping thresholds deferred to US2/US4 when those use-cases land. [analyze M1, Constitution II/IX]
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
- Total: **109 tasks** across 9 phases. Added post-`/speckit.analyze`: R1 — T011a (audit-enum migration H1), T103a (vitest coverage config M1); R2 — T017a (inter-module contract tests M1), T073a (download-proxy authz contract test M2).
