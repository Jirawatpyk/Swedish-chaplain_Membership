# Implementation Plan: F9 — Admin Dashboard + Directory + Timeline + Audit

**Branch**: `015-admin-dashboard` | **Date**: 2026-05-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-admin-dashboard/spec.md`

## Summary

F9 is the read-/projection-heavy **oversight & insight layer** over F1–F8 data. It
delivers six independently-shippable surfaces:

- **US1 (P1) Admin Operations Dashboard** — replaces the F1 placeholder at `/admin`
  with live KPIs, a "needs attention" area, an activity feed, smart insights, and an
  Engagement Score, served from a **cached per-tenant snapshot** (refreshed ~5 min +
  event-triggered) so it renders at **p95 < 1.5 s @ 5,000 members**.
- **US2 (P2) Audit Log Viewer** — a read-only, filterable, exportable viewer over the
  shared append-only `audit_log` (Principle VIII "fully queryable").
- **US3 (P3) Unified Member Timeline** — enriches the shipped F3 audit-only timeline
  into a multi-source union (audit + invoices + payments + events + broadcasts +
  renewals) via a `security_invoker` SQL view, keyset-paginated, role-redacted;
  member-facing parity at `/portal`.
- **US4 (P3) Benefit Usage Dashboard** — per-member, per-year consumption vs
  entitlement computed live from `benefitMatrix` + broadcast/event consumption;
  admin + portal.
- **US5 (P4) Directory + E-Book** — internal searchable directory, opt-in member
  listings (fixed field set), a deterministic **PDF E-Book** (reuses F4 react-pdf +
  Sarabun) and a **JSON** data export.
- **US6 (P4) GDPR Self-Service Export** — async per-member data archive (profile,
  contacts, invoices+PDFs, events, broadcasts, redacted audit subset) delivered via
  a **private, authenticated, time-limited** download.

**Technical approach**: a new `src/modules/insights/` bounded context owns dashboard
snapshots, smart insights, benefit usage, directory listings, and export-job
orchestration. The timeline enrichment extends the existing `members` module (where
the timeline already lives). The audit-query read use-case is added to the `auth`
module (which owns `audit_log`). Engagement Score is the **inverse of the shipped F8
`members.riskScore`** — no new scoring pipeline. Heavy artefacts (E-Book, GDPR
archive) are produced by a cron worker and stored in **private** Vercel Blob, served
through an authenticated proxy route. Every new table is `tenant_id`-scoped with
RLS+FORCE; every SQL view is `security_invoker = on` so base-table RLS applies.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Node 22 LTS — unchanged from F1–F8.
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · next-intl
(EN/TH/SV) · shadcn/ui + Tailwind v4 · `@tanstack/react-table` + `@tanstack/react-virtual`
(F3, reused) · `@react-pdf/renderer` + Sarabun fonts (F4, reused for E-Book) ·
`@vercel/blob` (F4, reused — **private mode** for F9 artefacts) · `pino` + `@vercel/otel`.
**No new runtime npm dependencies** (Constitution X) — dashboard visualisations use
CSS/SVG + shadcn primitives, not a charting library. *(Critique E9 — resolved
2026-05-25)*: `@vercel/blob` supports `access:'private'` (confirmed via Vercel docs),
so the private-delivery model needs no new dependency — at most a within-`^2` version
bump if the installed 2.3.3 types predate the `'private'` literal (see research.md R6).
**Storage**: Neon Postgres `ap-southeast-1` + Drizzle. **4 new tables**
(`dashboard_metrics_cache`, `smart_insight_dismissals`, `directory_listings`,
`export_jobs`) + **1 SQL view** (`member_timeline_v`, `security_invoker`). Vercel Blob
(private) for E-Book + GDPR archives. Migrations start at **0185**.
**Testing**: Vitest (unit/contract/integration against live Neon) · Playwright +
`@axe-core/playwright` (WCAG 2.1 AA) · MSW · `fast-check` (benefit-usage / engagement
projection invariants).
**Target Platform**: Vercel `sin1` (Fluid Compute, Node runtime) + Neon Singapore.
**Project Type**: Web application (Next.js App Router monorepo-style `src/` layout).
**Performance Goals**: Dashboard primary view **p95 < 1.5 s @ 5,000 members** (SC-002);
API interactive endpoints p95 < 400 ms (Constitution VII); web vitals LCP < 2.5 s /
INP < 200 ms / CLS < 0.1; audit viewer query stays interactive at tens of thousands
of events via keyset pagination.
**Constraints**: Two-layer tenant isolation (Principle I) on every surface; PII-read
auditing (FR-036); GDPR-export redaction (FR-029); timestamps Gregorian UTC, BE
display-only for `th-TH`; THB primary currency.
**Scale/Scope**: ~5,000 members/tenant target; members with 1,000+ timeline entries;
tens of thousands of audit events/tenant; 6 user stories across staff + member portals.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.4.2*

**NON-NEGOTIABLE gates**:

- [x] **I. Data Privacy & Security** — F9 reads **all member PII** for staff oversight.
  Lawful basis documented per surface (research.md §R10): legitimate interest (admin
  oversight), legal obligation (audit retention ≥5y), GDPR Art. 20 / PDPA portability
  (GDPR export). **Two-layer tenant isolation**: every new table carries `tenant_id`
  with RLS + FORCE; the `member_timeline_v` view is `security_invoker = on` so base-
  table RLS applies; all access goes through `runInTenant(ctx, tx)` (never the global
  `db` — see CLAUDE.md gotcha). A **mandatory cross-tenant integration test**
  (two tenants, read+write both directions, assert zero visibility) is planned for
  dashboard, audit query, timeline view, directory, and export (Review-Gate blocker).
  RBAC: every new route checks role policy (admin / manager-redacted / member-own).
  PII-read + export events audit-logged. TLS + at-rest encryption inherited.
- [x] **II. Test-First Development** — ≥1 acceptance test per user story authored before
  implementation. Coverage: Domain 100% line; Application ≥80% line+branch; **100%
  branch on security-critical paths** (audit-query redaction, GDPR-export tenant+role
  scoping, engagement projection, tenant-isolation guards). Integration tests hit live
  Neon. `fast-check` property tests for benefit-usage and engagement-inverse invariants.
- [x] **III. Clean Architecture** — new `src/modules/insights/` ships a public barrel
  (`index.ts`) + ESLint `no-restricted-imports` rule. Domain pure (no framework/ORM);
  Application orchestrates via ports; Drizzle/react-pdf/Blob types confined to
  Infrastructure. Cross-module reads (members.riskScore, plans.benefitMatrix,
  broadcasts/events consumption, auth.audit) go through each module's barrel. Timeline
  enrichment stays inside `members`; audit-query added to `auth` (owns `audit_log`).
- [x] **IV. Payment Security (PCI DSS)** — F9 touches **no card data**. It displays
  already-stored payment *metadata* (amount, method brand/last4) read-only; no PAN/CVV.
  GDPR archive bundles existing invoice PDFs (no card data). **SAQ-A scope unchanged.**

**Core principle gates**:

- [x] **V. Internationalization (EN/TH/SV)** — all new strings via i18n keys in
  `en/th/sv.json`; EN canonical (build-fails on missing EN; CI-blocks missing TH/SV).
  Dates/numbers/currency via `Intl.*`; `th-TH` shows Buddhist-Era display, storage UTC;
  THB primary. E-Book + export README localisable.
- [x] **VI. Inclusive UX (Mobile-first + WCAG 2.1 AA)** — layouts from 320px; dashboard
  KPI/insight cards keyboard-operable with visible focus; charts rendered as accessible
  SVG with text/`<table>` equivalents (no canvas-only data); `prefers-reduced-motion`
  respected; shimmer skeletons + empty/error states per `docs/ux-standards.md`; shared
  shadcn component library.
- [x] **VII. Performance & Observability** — dashboard p95 < 1.5 s via cached snapshot;
  keyset pagination on audit + timeline; new metrics (snapshot refresh duration/age,
  export-job queue depth + duration, audit-query latency) + SLOs in `docs/observability.md`;
  structured logs with request-id; no PII in metric labels.
- [x] **VIII. Reliability** — export jobs use an explicit state machine + idempotency
  key (no duplicate archives on retry); snapshot refresh runs in a transaction; audit
  viewer is strictly read-only over the append-only log; all error paths surfaced +
  audit-logged; new F9 audit event types enumerated (data-model.md §7).
- [x] **IX. Code Quality** — TS strict, ESLint clean, Conventional Commits, `[Spec Kit]`
  prefix. F9 is **security-sensitive (all PII)** → default ≥2 reviewers. **Solo-maintainer
  substitute applies** (5-check stack) — see Complexity Tracking #1.
- [x] **X. Simplicity (YAGNI)** — no new npm deps (Blob private-mode confirmed; at most a
  within-`^2` `@vercel/blob` bump); cache table not materialized view;
  Engagement Score = inverse of F8 risk (no new pipeline); fixed insight catalogue (no
  rule engine); public-directory + compliance-tracker + auto-upgrade deferred. Justified
  complexity in Complexity Tracking #2–#4.

**Result: PASS** (with 4 documented Complexity Tracking entries). No unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/015-admin-dashboard/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (internal ports + HTTP endpoints)
│   ├── application-ports.md
│   └── http-endpoints.md
├── checklists/
│   └── requirements.md  # /speckit.specify output
└── tasks.md             # /speckit.tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── modules/
│   ├── insights/                                   # NEW F9 bounded context
│   │   ├── domain/                                 # EngagementScore, BenefitUsage VO,
│   │   │                                           #   DashboardSnapshot VO, SmartInsight
│   │   │                                           #   catalogue, ExportJob state machine,
│   │   │                                           #   DirectoryListing policy — pure
│   │   ├── application/
│   │   │   ├── use-cases/                           # compute-dashboard-snapshot,
│   │   │   │                                        #   list-dashboard, list-smart-insights,
│   │   │   │                                        #   dismiss-insight, compute-benefit-usage,
│   │   │   │                                        #   search-directory, update-directory-listing,
│   │   │   │                                        #   generate-directory-ebook,
│   │   │   │                                        #   export-directory-json, request-data-export,
│   │   │   │                                        #   process-export-job, project-engagement-score
│   │   │   └── ports/                               # snapshot-repo, insight-dismissal-repo,
│   │   │                                            #   directory-repo, export-job-repo, audit-port,
│   │   │                                            #   pdf-render-port, blob-port, + source-reader
│   │   │                                            #   ports (members/plans/broadcasts/events/invoicing)
│   │   ├── infrastructure/
│   │   │   ├── db/schema-insights.ts                # 4 new tables (Drizzle)
│   │   │   ├── repos/                               # drizzle repos (thread tx via runInTenant)
│   │   │   ├── pdf/directory-ebook-document.tsx     # react-pdf template (reuse Sarabun + det-render)
│   │   │   ├── blob/private-blob-adapter.ts         # @vercel/blob private + proxy-signed token
│   │   │   └── audit/insights-audit-adapter.ts
│   │   ├── insights-deps.ts                         # composition root
│   │   └── index.ts                                 # public barrel
│   ├── members/                                     # EXTEND (timeline enrichment)
│   │   ├── application/use-cases/timeline-list.ts   # same signature; new source set
│   │   └── infrastructure/timeline/drizzle-timeline-repo.ts  # query member_timeline_v
│   └── auth/                                         # EXTEND (audit query reader)
│       ├── application/use-cases/audit-query.ts     # NEW read use-case (filter/paginate/redact)
│       └── index.ts                                 # export auditQuery
├── app/
│   ├── (staff)/admin/
│   │   ├── page.tsx                                 # REPLACE placeholder → operations dashboard
│   │   ├── audit/page.tsx                           # NEW audit log viewer
│   │   ├── directory/page.tsx                       # NEW directory + E-Book + JSON export
│   │   └── members/[memberId]/
│   │       ├── timeline/page.tsx                    # enriched (existing route)
│   │       └── benefits/page.tsx                    # NEW per-member benefit view (staff)
│   ├── (member)/portal/
│   │   ├── benefits/page.tsx                        # EXTEND → full benefit usage dashboard
│   │   ├── timeline/page.tsx                        # NEW member own timeline
│   │   └── account/data-export/page.tsx             # NEW GDPR self-service export
│   └── api/
│       ├── cron/insights/
│       │   ├── snapshot-refresh-coordinator/route.ts        # fan-out per tenant
│       │   ├── snapshot-refresh/[tenantId]/route.ts         # per-tenant snapshot compute
│       │   └── process-export-jobs/route.ts                 # async E-Book + GDPR worker
│       └── internal/exports/[jobId]/download/route.ts        # authenticated private-artefact proxy
├── components/
│   ├── dashboard/                                   # KpiCard, NeedsAttentionList, ActivityFeed, InsightsPanel
│   ├── audit/                                       # AuditTable, AuditFilters
│   ├── directory/                                   # DirectoryTable, VisibilityToggles
│   └── benefits/                                    # BenefitUsageCard, UnderUseWarning
└── config/nav.ts                                    # add Dashboard / Audit / Directory staff items (role-gated)

drizzle/migrations/                                  # 0185+ : F9 tables + RLS+FORCE + member_timeline_v
tests/
├── unit/insights/                                   # domain + projections (fast-check)
├── integration/insights/                            # live Neon, incl. cross-tenant isolation (Principle I)
├── integration/members/                             # timeline multi-source union
├── contract/                                        # audit-query, export-job, directory, dashboard ports
└── e2e/                                             # dashboard, audit, directory, timeline, benefits,
                                                     #   gdpr-export + @a11y + @i18n
scripts/
└── check-f9-schema.ts (optional)                    # RLS+FORCE + security_invoker guard (CI)
```

**Structure Decision**: Web application with the established `src/modules/<context>`
Clean-Architecture layout. F9 introduces **one new bounded context** (`insights`) for
cohesive dashboard/insight/directory/export logic, **extends** `members` (timeline is
already there) and `auth` (owns `audit_log`). This keeps each change where the data is
owned and avoids a god-module. Presentation lives in `(staff)/admin/**` +
`(member)/portal/**`; async work in `api/cron/insights/**`; private downloads behind an
authenticated proxy route.

**Delivery slicing (Critique P1/X1)**: F9 is a large, all-PII surface. `/speckit.tasks`
MUST sequence delivery as two mergeable slices — **Slice A** = US1 (dashboard) + US2
(audit) + US3 (timeline) + US4 (benefits); **Slice B** = US5 (directory + E-Book) + US6
(GDPR export). This shortens the review blast radius per merge and lets the
highest-value surfaces ship first; the branch MAY be split if velocity slips.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| **Solo-maintainer substitute for Principle IX ≥2-reviewers** (F9 is security-sensitive — reads all PII + GDPR export) | No second human reviewer available; F9 must still ship under a high-assurance bar | Waiting for a 2nd reviewer blocks delivery indefinitely. Substitute = (1) ≥3 `/speckit.review` passes with decreasing severity; (2) ≥1 `/speckit.staff-review` (correctness+security+tests triangulation) + post-remediation round if any BLOCKER/CRITICAL; (3) coverage targets met + live-Neon integration on every security-critical use case; (4) DB-level defence-in-depth (RLS+FORCE + `security_invoker` views) so isolation holds even if app code is buggy; (5) fresh-agent post-remediation verification (not self-attestation). Maintainer co-signs `checklists/security.md` with the staff-review agent using the v1.4.2 footer template. |
| **New `insights` bounded context** (Principle X — added module surface) | F9's dashboard/insight/benefit/directory/export logic is cohesive, reused across staff+member portals, and orchestrates 5 source modules' barrels | Scattering F9 logic into members/plans/broadcasts/events would muddy those modules' boundaries and create cross-module write coupling. A single cohesive read-/projection module is the smaller long-term cost. |
| **Raw-SQL migration artefacts** — `member_timeline_v` (`security_invoker`) view + RLS+FORCE policies + `dashboard_metrics_cache` refresh semantics, hand-authored outside Drizzle's generator | Drizzle cannot emit views, `security_invoker`, or RLS policies; tenant isolation (Principle I, NON-NEGOTIABLE) requires them | Application-layer-only union/merge (no view) makes keyset pagination across 6 heterogeneous sources error-prone and re-derives RLS in app code; matview can't do event-triggered partial refresh and Drizzle can't manage it. Hand-written SQL migrations are already the repo norm (all prior RLS policies). |
| **Private Blob delivery via authenticated proxy** — deviates from F4's `access:'public'` content-addressed Blob | F9 GDPR archives + Directory E-Book bundle member PII; a guessable/public URL is unacceptable for a portability archive (Principle I / PDPA) | F4 invoices are individually tenant-scoped + access-checked at the route; reusing public Blob for a bundled PII archive would leak on URL disclosure. Private storage + short-lived signed token validated by an authenticated route is the minimal safe delivery. |

> **Note on Constitution version**: the plan-template header cites v1.0.0; the
> authoritative constitution is **v1.4.2** and the Constitution Check above is run
> against all 10 principles of v1.4.2 (incl. the Principle I tenant-isolation
> sub-clauses and the Principle IX solo-maintainer substitute).
