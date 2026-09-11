# Implementation Plan: Member Portal — Approval Workflow for Member Changes

**Branch**: `114-member-change-approval` | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/114-member-change-approval/spec.md` (clarified 2026-09-11;
`spec-review-panel` GO WITH AMENDMENTS applied — `reviews/spec-review-panel-20260911.md`)
**Phase outputs**: [research.md](./research.md) · [data-model.md](./data-model.md) ·
[contracts/](./contracts/) · [quickstart.md](./quickstart.md)

## Summary

A member's edit of their record in the Member Portal no longer saves — it becomes a **change
request** (one pending per submitting person) that every reviewer (`members.write`: admin +
super_admin) is emailed about with the field-by-field old → proposed values. Reviewers decide it
**per field in one confirming action** (all fields pre-approved; one reason for the rejected set);
approved fields are applied to `members`/`contacts` in the same transaction as the decision, so the
portal and the staff record show the same values on the next read (they read one record). The
submitting person is emailed the outcome with the reason verbatim and a resubmit link prefilled with
exactly the rejected values. Every request and transition is an audit event and a timeline entry;
history is visible on the member record, in a tenant-wide queue, and (scoped per person) in the
portal. The gate is a per-tenant switch behind a platform flag; with either off, the F3 immediate
save is byte-for-byte unchanged.

Technical approach (research R1–R17): new tenant-scoped tables `member_change_requests` +
`member_change_request_fields` (RLS FORCE, partial unique index for one-pending-per-person) owned
by `src/modules/members`; three portal + five staff `/api/**` route handlers; the existing
`PATCH /api/portal/profile` narrowed to Group A while the gate is on; decisions applied via the
module's existing `*InTx` writers under one `runInTenant` with throw-to-rollback; two new outbox
notification types whose `context_data` carries ids only (diff rendered at send time); five new
audit events; a live "Needs attention" count on the F9 dashboard and a nav badge; gauges on the
existing per-tenant gauges cron (no new cron — 37/40 used). Zero new npm dependencies.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); Node 22 LTS — unchanged
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · next-intl · zod ·
react-hook-form · shadcn/ui (`AlertDialog` via the shared `ReasonConfirmationDialog`, table
primitives) · Resend transactional via the existing outbox. **Zero new npm dependencies**
(Constitution X)
**Storage**: Neon Postgres `ap-southeast-1` (Drizzle, hand-written SQL). DDL in migration `0300`
(`when: 1798543200000`): two new tables with RLS ENABLE+FORCE and the strict 0209 policy, one
boolean column on `tenant_member_settings`, `audit_event_type` +5, `notification_type` +2. No column
drops, no data backfill
**Testing**: Vitest unit/contract · live-Neon integration on the dev branch (two-tenant isolation,
×50 same-submitter race, ×2 concurrent decide, decision rollback, erasure scrub, cap with the
limiter absent) · Playwright + axe (`--workers=1`) · static gates (`check:multi-tenant`,
`check:audit-events`, `check:staff-page-guard`, `check:api-route-guard`, `check:actor-role-truth`,
`check:i18n`, `check:env-example`)
**Target Platform**: Vercel `sin1` (prod live at `swecham.dxtspace.com`), Node runtime route
handlers; native Vercel Cron (GET, UTC) — reuses the outbox dispatcher and the per-tenant gauges
tick; **no new cron job** (37 of 40 in use)
**Project Type**: Web application — existing modular monolith (`src/modules/*` bounded contexts;
App Router presentation in `src/app/(member)/portal/**` and `src/app/(staff)/admin/**`)
**Performance Goals**: submit p95 < 400 ms (one tx: FOR UPDATE + count + insert + audit + ≤ N outbox
rows, N = reviewers ≤ 5 at SweCham); decide p95 < 400 ms; queue list p95 < 400 ms at 5,000 rows
(indexed keyset — measured by the seeded pagination test, tasks T119); review page LCP < 2.5 s; dashboard count is one indexed `count/min` (< 20 ms);
staff notification within 5 min (SC-002) rides the existing 1-min outbox cadence
**Constraints**: prod is live with real members; every new query threads the `runInTenant` tx +
RLS FORCE; no PII in logs, audit payloads or sent outbox rows (ids + keys only; diff rendered at
send from the request rows); actor role = session role (`check:actor-role-truth`); `err()` never
returned inside a `runInTenant` callback (throw-to-rollback); flag OFF and setting OFF both leave
the F3 self-service path byte-identical; Buddhist Era display-only; issued tax documents never
change (buyer block frozen at issue — the feature only writes `members`/`contacts`)
**Scale/Scope**: 2 tables (+ `outcome_acknowledged_at`) · 1 settings column · 7 enum values · 1 migration · 8 use cases (submit, withdraw, decide, acknowledge, list, get-review, set-setting, count-pending) + 1 gate resolver
+ 4 Domain policies · 10 route handlers (5 portal, 5 staff) · 1 narrowed endpoint · 4 staff pages
(queue, review, settings card, member-record section) · 3 portal surfaces (edit-form gate mode,
pending/decision banner, history page) + 1 form move (language → account page) · 2 email
templates × 3 locales · 5 audit events · ~70 i18n keys × 3 · 1 nav item + badge slot · 1 dashboard
item · 6 metrics + 2 alerts · 1 env flag · 1 component promotion (`ReasonConfirmationDialog` →
`components/shell/`) · ~14 test files. SweCham today: 150 members / 0 secondary contacts with a
login (so the per-person scope is exercised by seeds, not prod)

## Constitution Check

*GATE: evaluated against Constitution v1.4.2 (all 10 principles) — pre-Phase-0 PASS, re-checked
post-Phase-1 design (§ Post-Design Re-check). No unjustified violation; one documented deviation
(solo-maintainer review substitute) in § Complexity Tracking.*

**NON-NEGOTIABLE gates**:

- [x] **I. Data Privacy & Security** — New processing: proposed and superseded values of contact
      name/phone/job title and company name/website/description/addresses, held until decided and
      retained with the member record. Lawful basis: performance of the membership contract /
      legitimate interest in an accurate member register (TH PDPA § 24(3)/(5), GDPR Art. 6(1)(b)/(f));
      the rectification right (Art. 16 / PDPA § 35) is served by the request itself plus the always-
      immediate staff channel (FR-021), and the one-month clock is backstopped by the FR-037 alert
      (7 d warn / 14 d page). Purpose limitation: request rows are read only by the review/history
      surfaces and the two emails. Minimisation: audit payloads and sent outbox rows carry ids and
      field keys, never values (R7, R8); portal history is scoped per person (FR-029, R15); the
      reviewer's identity is never shown to members. Erasure: scrub port on the atomic erasure tx
      + a table-scoped guard test (R10); DSAR export gains the section. RBAC: every route names its
      permission (`members.read` to see, `members.write` to decide/settings; portal routes
      `requireMemberContext` + own-contact/primary checks); denials audited. **Tenant isolation
      two-layer**: `runInTenant` tx on every repo method + RLS ENABLE/FORCE with the strict policy on
      both tables; both registered in `check:multi-tenant`; the mandatory two-tenant integration test
      probes reads *and* decides in both directions (SC-009); probes recorded as
      `member_cross_tenant_probe`. OWASP: broken access control (permission per route + baseline
      pins), IDOR (request id must belong to tenant; portal 404s outside the caller's scope — no
      existence leak), injection (Drizzle parameters; reasons/notes rendered escaped, never as
      markup), abuse (durable 10/24 h cap, R9), CSRF (route handlers under the proxy allow-list —
      no Server Actions, R5). TLS/at-rest: unchanged platform (Neon AES-256, Vercel TLS 1.2+).
      `pdpa-gdpr-compliance-officer` + `security-engineer` sign at the Review gate.
- [x] **II. Test-First Development** — Every user story's first task is its RED acceptance test
      (contract or integration): US1 submit-holds + staff email; US2 partial approve + sync + repeat
      no-op; US3 reject-all + prefill; US4 per-member/queue/portal-scope; US5 withdraw/replace/cap;
      US6 setting off/on + dashboard. Coverage: Domain 100% lines (state machine, `deriveOutcome`,
      `deriveScope`, `diffAgainstRecord`, field-rule parity); the four use cases + the gate resolver
      pinned 100% branches in `vitest.config.ts` (security-critical: PII write, RBAC, tenant);
      route handlers ≥ 80%. Cross-tenant integration test is a Review-gate blocker (I.3).
- [x] **III. Clean Architecture** — Domain: `domain/change-request/**` pure types + policies (no
      framework imports; ESLint rule enforces). Application: use cases orchestrate through ports
      (`ChangeRequestRepo` new; `MemberRepo`/`ContactRepo`/`AuditPort`/`EmailPort` existing; a
      `ReviewerDirectoryPort` for "active users holding `members.write`" implemented in
      Infrastructure over the auth users table); no ORM/HTTP imports. Infrastructure:
      `drizzle-change-request-repo.ts`, email templates, the scrub adapter; Drizzle types stay
      inside. Presentation: pages/routes call use cases through the members barrel only
      (`src/modules/members/index.ts` gains the exports; `no-restricted-imports` unchanged). One
      seam is composed in `src/lib/`: the reviewer list needs `users` (auth) — the adapter lives in
      `src/lib/members-change-request-deps.ts` like the existing `contact-marketing-deps.ts`
      pattern, not a members→auth internal import. Module ownership decided in R1.
- [x] **IV. Payment Security (PCI DSS)** — No payment surface touched; no card data; SAQ-A scope
      unchanged. The only money-adjacent effect is that approved company name / billing address
      values feed *future* invoices exactly as a staff edit does today; issued documents are frozen
      (FR-022, SC-012). `thai-tax-compliance-auditor` reviews the tax-affecting flag + the
      registered-address-as-buyer-address rule (FR-019).

**Core principle gates**:

- [x] **V. Internationalization (SV/EN/TH)** — ~70 keys × 3 locales (portal edit gate mode,
      pending/decision banner, history; staff queue, review table, decision dialog labels including
      the dynamic confirm text, settings card; nav; 5 audit labels with Thai script; 3 timeline
      keys; 2 email templates); `check:i18n` gates; dates via `formatLocalisedDate` (BE display-only
      for `th-TH`); reasons are shown as typed, never translated (spec § Assumptions).
- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Review table collapses to stacked cards
      < 640 px (address groups as a block); every row's selector is a labelled checkbox; the
      decision uses the shared `ReasonConfirmationDialog` (focus starts on Cancel, Escape cancels,
      spinner + stays open, destructive variant iff any rejection, `finalFocus` back to the confirm
      button); pending banner uses `role="status"`; queue rows have `aria-describedby` waiting-time;
      axe at 320 px on every new surface (`@a11y`); `enterprise-ux-designer` pass on the PR; section
      headings are real `<h2>` (portal pattern); no italic on Thai.
- [x] **VII. Performance & Observability** — Budgets stated in Technical Context; LCP < 2.5 s /
      INP < 200 ms / CLS < 0.1 on the queue + review pages (shimmer skeletons via `loading.tsx`);
      API p95 < 400 ms. Logging: pino with `requestId`, `tenantId`, hashed user id, request id —
      never values/reasons/emails. Metrics: 2 gauges + 3 counters + 1 histogram (contracts §4)
      emitted from the use cases and the existing gauges tick; 2 alerts bound to the DSR clock;
      every failing arm names itself in the `errorId` taxonomy. OTel spans on submit/decide.
      `docs/observability.md` § 14 added.
- [x] **VIII. Reliability** — Error paths enumerated per route (contracts: 403/404/409/422/429/500
      arms); transactions: submit = one `runInTenant` (lock previous pending → withdraw → insert →
      audit → outbox), decide = one `runInTenant` (FOR UPDATE request + member → re-validate → apply
      via `*InTx` → outcomes → audit → outbox) with `UseCaseAbort` throw-to-rollback, never
      `return err()` inside; idempotency: decide is keyed by request id + state check (identical
      repeat → recorded decision, no second effect), submit accepts `Idempotency-Key` like the
      profile route; audit events listed (contracts § 2) with true actors; read-only mode → 503 via
      the proxy; the durable cap needs no Redis.
- [x] **IX. Code Quality Standards** — TS strict, ESLint clean, Conventional Commits with
      `[Spec Kit]` on gate commits; `pnpm typecheck` + full `pnpm lint` as the last step before
      every commit (neither is in a gate); review: PII + RBAC + audit surface ⇒ ≥ 2 reviewers by
      default → **solo-maintainer substitute** (Complexity Tracking #1): the 6-check CI stack +
      `security-engineer`, `pdpa-gdpr-compliance-officer`, `reliability-guardian`,
      `drizzle-migration-reviewer`, `enterprise-ux-designer`, `thai-tax-compliance-auditor` agent
      passes + `whole-branch-reviewer` seam pass, security checklist co-signed by the staff-review
      agent and the maintainer.
- [x] **X. Simplicity (YAGNI)** — Reuses: members module, `*InTx` writers, outbox + dispatcher,
      audit trail + timeline view (no view change), `tenant_member_settings`, `NeedsAttentionList`,
      `ReasonConfirmationDialog`, `requirePagePermission`/`requireApiPermission`, existing gauges
      cron. Not built: a new module, a new permission key (Q1), a sync mechanism (one record), a
      notification mailbox setting, digests, real-time, bulk decisions, auto-approval rules,
      approve-with-edits, self-review detection (all in spec § Out of Scope). The two additions
      that are new shapes — a `badgeCount` slot on the nav item type and the component promotion to
      `shell/` — are each the smallest change that satisfies a spec requirement (FR-033, FR-034).

## Project Structure

### Documentation (this feature)

```text
specs/114-member-change-approval/
├── spec.md                                   # clarified + panel-amended
├── plan.md                                   # this file
├── research.md                               # Phase 0 — R1–R17 + V1–V4 verify-before-task items
├── data-model.md                             # Phase 1 — tables, keys, state machine, Domain types
├── contracts/
│   ├── portal-change-requests-api.md         # member routes + PATCH /profile narrowing
│   ├── admin-change-requests-api.md          # staff routes + tenant setting
│   └── notifications-and-audit.md            # outbox rows, audit events, timeline, metrics
├── quickstart.md                             # validation walkthroughs + cutover
├── checklists/requirements.md                # 16/16
├── reviews/spec-review-panel-20260911.md     # panel report (input to this plan)
└── tasks.md                                  # /speckit.tasks output — NOT created here
```

### Source Code (repository root)

```text
src/modules/members/
├── domain/
│   ├── change-request/
│   │   ├── change-request.ts                 # ChangeRequest, ProposedField, states/outcomes (R2, data-model §7)
│   │   ├── proposable-fields.ts              # Group B const tuple + target + tax-flag map (data-model §3)
│   │   ├── field-rules.ts                    # per-key zod rule = the staff form's rule (R14)
│   │   └── policies.ts                       # deriveOutcome · deriveScope · diffAgainstRecord · changedSinceSubmitted
│   └── portal-self-update-fields.ts          # split: PORTAL_IMMEDIATE_FIELDS (Group A) vs proposable (R6)
├── application/
│   ├── ports/
│   │   ├── change-request-repo.ts            # ChangeRequestRepo (all methods take tx)
│   │   ├── reviewer-directory-port.ts        # active users holding members.write (+ locale, email)
│   │   ├── change-request-scrub-port.ts      # erasure scrub (R10)
│   │   ├── email-port.ts                     # EmailNotificationType += 2
│   │   └── audit-port.ts                     # F3 union += 5
│   └── use-cases/
│       ├── change-requests/
│       │   ├── resolve-member-change-gate.ts # flag ∧ tenant setting → 'approval' | 'immediate'
│       │   ├── submit-change-request.ts      # R3, R8 coalescing, R9 cap
│       │   ├── withdraw-change-request.ts
│       │   ├── decide-change-request.ts      # R4 one tx, throw-to-rollback
│       │   ├── acknowledge-change-request.ts # R18 — submitter dismisses the shown decision
│       │   ├── list-change-requests.ts       # queue / per-member / portal (FR-029 scope in SQL)
│       │   ├── get-change-request-review.ts  # live current values + changedSinceSubmitted / alreadyCurrent / undecidable
│       │   ├── count-pending-change-requests.ts # dashboard item + nav badge (live count, oldest age)
│       │   └── set-member-change-approval-enabled.ts
│       ├── member-self-update.ts             # gate-aware whitelist (R6)
│       └── erase-member.ts                   # + scrub step (R10)
├── infrastructure/
│   ├── db/
│   │   ├── schema-change-requests.ts         # Drizzle tables (types stay here)
│   │   ├── schema-member-settings.ts         # + member_change_approval_enabled
│   │   └── drizzle-change-request-repo.ts
│   ├── adapters/
│   │   ├── change-request-scrub-adapter.ts
│   │   └── resend-email-port.ts              # + 2 notification types
│   └── email/
│       ├── change-request-submitted-staff-email.ts
│       └── change-request-decided-member-email.ts
├── members-deps.ts                           # wires the repo, scrub port, gate resolver
└── index.ts                                  # barrel += use cases + Domain types (85 → ~97 exports)

src/lib/
├── members-change-request-deps.ts            # composition: ReviewerDirectoryPort over auth users (III seam)
├── env.ts                                    # FEATURE_MEMBER_CHANGE_APPROVAL (zod boolean, default false)
└── metrics.ts                                # membersMetrics += 6 (contracts §4)

src/app/api/
├── portal/change-requests/
│   ├── gate/route.ts                         # GET
│   ├── route.ts                              # POST submit · GET history
│   ├── [id]/route.ts                         # GET
│   ├── [id]/acknowledge/route.ts             # POST dismiss the shown decision (FR-010)
│   └── current/route.ts                      # DELETE withdraw
├── portal/profile/route.ts                   # PATCH narrowed to Group A when gate = approval
├── admin/change-requests/
│   ├── route.ts                              # GET queue
│   └── [id]/route.ts · [id]/decide/route.ts  # GET review · POST decide
├── admin/members/[memberId]/change-requests/route.ts
├── admin/settings/member-changes/route.ts    # GET · PATCH
├── cron/outbox-dispatch/route.ts             # + 2 switch arms (read-at-send)
└── internal/metrics/broadcasts-gauges/route.ts  # generalised per-tenant gauges tick (+ members gauges) — V2

src/app/(member)/portal/
├── edit/page.tsx                             # gate-aware: Group B form → change request; language select removed
├── account/page.tsx                          # + contact email/notification language (Group A) beside PreferredLocaleForm
├── change-requests/page.tsx · loading.tsx · error.tsx   # history (FR-029)
└── profile/page.tsx                          # + pending / last-decision banner

src/app/(staff)/admin/
├── change-requests/page.tsx · loading.tsx · error.tsx          # queue (members.read)
├── change-requests/[id]/page.tsx · loading.tsx · not-found.tsx # review (decide iff members.write)
├── members/[memberId]/_components/member-change-requests-section.tsx
├── settings/member-changes/page.tsx                            # tenant switch card (members.write)
├── settings/page.tsx                                           # + category card
└── (home)/page.tsx                                             # + NeedsAttentionItem (live count)

src/components/
├── shell/reason-confirmation-dialog.tsx      # promoted from components/broadcast/ (re-export kept)
├── members/change-requests/
│   ├── portal-change-request-form.tsx        # Group B form (react-hook-form + zod from field-rules)
│   ├── pending-request-banner.tsx
│   ├── decision-outcome-banner.tsx           # last decision until acknowledged (FR-010)
│   ├── change-request-diff-table.tsx         # shared read-only diff (portal + staff)
│   ├── change-request-decision-table.tsx     # staff: pre-selected rows + dynamic confirm
│   └── change-request-status-badge.tsx
└── layout/staff-shell.tsx · src/config/nav.ts   # nav item `nav.staff.changeRequests` + badgeCount slot

src/i18n/messages/{en,th,sv}.json             # portal.changeRequests · admin.changeRequests · nav · audit.eventType · timeline.audit · email.changeRequest
drizzle/migrations/0300_member_change_requests.sql + meta/_journal.json
scripts/check-multi-tenant*.ts                # SCOPED_TABLES += 2
docs/observability.md                         # § 14 metrics + alerts
docs/runbooks/member-change-requests.md       # stuck queue, coalescing, cap, rollback

tests/
├── helpers/change-request-fakes.ts           # in-memory doubles for every port (an unstubbed method is an unexercised branch)
├── unit/members/change-requests/             # domain policies, field-rule parity, 8 use cases + gate resolver (100% branches on the six security-critical ones)
├── unit/auth/domain/audit-event.test.ts      # pinned count 37 → 42
├── unit/architecture/change-requests-no-server-actions.test.ts  # FR-038 guard with positive control
├── contract/portal/change-requests-*.test.ts # submit · gate · history · withdraw · replace · acknowledge · setting-off · flag-off; + profile.test.ts gains Group-B-forbidden cases
├── contract/members/admin-change-requests-*.test.ts · admin-member-changes-setting.test.ts
├── integration/members/change-requests-{repo,tenant-isolation,submit-atomicity,concurrency,decide-rollback,erasure-scrub,rate-cap,tax-document-immutability,queue-pagination}.test.ts
└── e2e/change-requests.spec.ts (@change-requests, @a11y, @i18n)
```

**Structure Decision**: One feature, one existing bounded context (`members`, R1) extended along
the module's existing seams (Domain policy → Application use case + ports → Infrastructure
Drizzle/email adapters), with presentation in the two existing route groups. No new module, no new
package. The only cross-module need — enumerating reviewers from the auth `users` table — is a
port implemented in a `src/lib/*-deps.ts` composition file, the pattern 108 used for
`contact-marketing-deps.ts`.

## Complexity Tracking

| Violation / deviation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **#1 Gate 9 / Principle IX — solo-maintainer substitute for ≥ 2 human reviewers** on a PII + RBAC + audit surface | No second human reviewer is available on this repo (Constitution v1.4.1/1.4.2 precedent) | Waiting for a second reviewer would block the launch-period feature indefinitely; the substitute is the 6 required CI checks + the named project-agent passes (security, PDPA/GDPR, reliability, migration, UX, tax) + `whole-branch-reviewer`, with the security checklist co-signed by the staff-review agent and the maintainer |
| **#2 Principle VI/VII — `badgeCount` slot added to the staff nav item type** | FR-033 requires the pending count in the navigation; the nav config has no badge concept | Rendering the count only on the dashboard was rejected: the spec names both surfaces, and a server-resolved optional field on the existing declarative item keeps `SurfaceGuard` / `staffNavAllowedHrefs` untouched — a parallel "nav decorations" registry would be a second source of truth for the same item |

No Principle I–IV, VIII or X deviation.

## Post-Design Re-check (after Phase 1)

- **I** — data-model.md carries the strict RLS policy on both tables, the `check:multi-tenant`
  registration, and the erasure scrub; contracts show ids-only payloads and the per-person portal
  scope; every route names its permission. PASS.
- **II** — quickstart § 2 lists the RED tests per story and the four live-Neon suites; research R16
  pins coverage. PASS.
- **III** — the source tree keeps Drizzle in `infrastructure/`, ports in `application/ports`,
  pure policies in `domain/`; the auth seam is composed in `src/lib/`. PASS.
- **IV** — no payment surface. PASS.
- **V–X** — as evaluated above; the two shape additions are recorded in Complexity Tracking. PASS.

**Risks carried into `/speckit.tasks`** (from research § "Carried"): V1 canonical website rule
(parity test depends on it) · V2 generalising the gauges cron without renaming `broadcasts_*`
metrics · V3 dispatcher read-at-send under the tenant tx · V4 the per-person scope is vacuous on
prod until the secondary import (tests seed it).

**Checklist-gate closure (2026-09-11)**: the six domain checklists raised 31 requirement-text gaps;
all are closed in the spec (Clarifications session "gap closure — AMENDMENT", FR-038–FR-040, FR-009/
010/014/015/017/019/020/022/023/026/030/034 amended) and in the plan artefacts: `outcome_acknowledged_at`
+ `POST …/acknowledge` (decision dismissal), `contact_removed` reject-only rows + `alreadyCurrent` +
`taxHint` on the review payload, the primary contact's name added to the tax-affecting set (the buyer
block's `primary_contact_name` is built at issue time), OTel span names, and the RoPA step + rollback
matrix in `quickstart.md` § 3. Lawful basis now lives in the spec (FR-040), not only here.

**Gate decision**: Constitution Check PASS on all 10 principles; two deviations justified.
Checklist gate complete — ready for `/speckit.tasks`.
