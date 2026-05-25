# Feature Specification: F9 — Admin Dashboard + Directory + Timeline + Audit

**Feature Branch**: `015-admin-dashboard`
**Created**: 2026-05-25
**Status**: Draft
**Input**: User description: "F9 — Admin Dashboard + Directory + Timeline + Audit"

## Overview *(context, non-normative)*

F9 is the **oversight & insight layer** that sits on top of the operational data
created by F1–F8. F1–F8 *generate* membership, financial, event, communication,
and renewal data; F9 lets chamber staff (and, where appropriate, members) **see,
search, understand, and prove** what happened — without asking a developer to run
a query.

It delivers four staff-facing pillars plus their member-facing counterparts:

1. **Admin Dashboard** — the staff home page becomes a live operations dashboard:
   chamber health at a glance, pending actions, recent activity, and smart insights.
   (Replaces the F1 placeholder at `/admin`.)
2. **Directory** — a searchable internal member directory plus an exportable
   directory "E-Book" (PDF) and structured data export the tenant can publish on
   its own website.
3. **Timeline** — the existing F3 audit-only member timeline is enriched into a
   true multi-source relationship history (invoices, payments, events, broadcasts,
   renewals, profile changes), with filtering and large-history performance.
4. **Audit** — a queryable, exportable audit-log viewer so staff can answer
   "who did what, when, to which record" for compliance and incident response.

> **Scope note**: F9 is read-heavy and touches **all member PII**. Per the
> phases plan, it was flagged as potentially large enough to split. This spec
> keeps the four pillars together but structures each as an **independently
> shippable user story**, so they can be delivered incrementally on one branch.

## Clarifications

### Session 2026-05-25

- Q: Derived-metric freshness strategy for the dashboard & benefit-usage figures? → A: Cached/materialized snapshot, refreshed on a short cadence (~5 min) **plus** event-triggered refresh on key actions (payment, approval, status change); the "as of" time is shown.
- Q: Measurable performance target for the dashboard primary view? → A: p95 < 1.5 s for full interactive render at a 5,000-member tenant.
- Q: Delivery model for exports (audit, Directory E-Book, GDPR archive)? → A: Hybrid — small filtered audit exports stream synchronously; the Directory E-Book and GDPR archive are generated asynchronously (background job → notification + time-limited signed link).
- Q: Interchange format for the Directory structured data export? → A: JSON (structured/nested; suitable for the tenant's website to consume programmatically).
- Q: Threshold that triggers the benefit under-use warning? → A: When (elapsed-year % − consumed %) ≥ 25 percentage points (gap-based, scales across the year).
- Q: How is the Engagement Score surfaced and computed? → A: Sortable + filterable on the member list, also shown on member profile + dashboard; computed as the inverse of the shipped F8 at-risk score (0–100 with health bands), reusing F8 signals rather than a new pipeline.
- Q: Which audit events go into a member's GDPR export archive? → A: Both member-performed and member-targeted events, with third-party PII and internal-only annotations redacted via the standard role projection.
- Q: What is the member-controllable directory listing field set? → A: A fixed, individually toggle-able set — name, tier, industry/category, short description, website, logo, location (city/country), public contact (name + email or contact-form); default private with email default-hidden. (Not per-tenant configurable in F9.)
- Q: How large is the starter Smart-Insight catalogue at launch? → A: A fixed starter set of ≥3 insight types (unused E-Blast quota; under-used event/cultural tickets; at-risk members needing follow-up), each dismissible — no general rule engine in F9.
- Q: (critique X3) GDPR member self-service export at launch, or admin-on-behalf only? → A: **Keep member self-service** (US6 as specced); the leaked-link risk is mitigated by the single-use, short-TTL download token (critique E4).
- Q: (critique E5) Does a manager see staff actor identities in the audit viewer/export? → A: **Yes** — actor identity (the staff member who acted) is internal operational information visible to admins and managers; role-based redaction applies to sensitive *payload* PII fields, not to actor identity.
- Q: (critique R2-P1) What does "membership year" mean for benefit-quota counting? → A: **Calendar year in the tenant timezone** for F9 (anniversary-based deferred).
- Q: (critique R2-P2) How is the aggregate "consumed %" for the under-use warning computed? → A: **Mean of the used ÷ entitlement ratio of each quantifiable benefit**, excluding unlimited/active-only benefits; no quantifiable benefits → no warning.
- Q: (critique R2-P3) Is directory logo upload in F9 scope? → A: **Kept in scope** (user decision 2026-05-25) — with an explicit safe image pipeline (MIME/size/dimension limits, server re-encode + EXIF strip via F4's `sharp`, audit-logged). See FR-025a.
- Q: (checklist i18n) What locale is the Directory E-Book rendered in? → A: **Tenant's default display locale** (EN for SweCham); field labels localised, member-entered content as authored; Sarabun embed handles TH-locale tenants. (FR-026)
- Q: (checklist i18n) What locale for the GDPR export README / notifications? → A: README in the **requester's locale** (EN fallback); `manifest.json` locale-neutral (English keys); "export ready" notification in the **recipient's locale**. (FR-029/030)
- Q: (checklist i18n) How is the multi-source timeline localised? → A: stable i18n key namespace `timeline.<source>.<eventKind>` resolved in presentation from the view's `source`+`payload`; legacy `audit_log.summary` is fallback only. (FR-014)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin Operations Dashboard (Priority: P1)

A chamber administrator signs in and lands on `/admin`. Instead of a static
placeholder, they see a live overview: how many members are active / at-risk /
overdue, year-to-date paid revenue, how many benefits are going unused, what
needs their attention right now (broadcasts awaiting approval, overdue invoices,
at-risk members), a feed of recent activity across the chamber, and a short list
of smart insights ("5 members haven't used their E-Blast quota this year").

**Why this priority**: This is the single most-visited staff screen and the
feature's centerpiece. It turns scattered data from F1–F8 into a decision surface
and is the page the board/treasurer judge the platform by. It delivers value
even if no other pillar ships.

**Independent Test**: Seed a tenant with members, invoices, broadcasts, and
events in known states; sign in as admin; verify the dashboard renders correct
counts/metrics, the "needs attention" items link to the right records, and the
activity feed reflects the most recent events. Verify a manager sees a
finance-redacted variant and a member cannot reach the page.

**Acceptance Scenarios**:

1. **Given** a tenant with 120 members (90 active, 18 at-risk, 12 overdue) and
   ฿2.4M paid YTD, **When** an admin opens `/admin`, **Then** the dashboard shows
   those headline counts and the YTD revenue figure, each as a labelled metric.
2. **Given** 3 broadcasts awaiting approval and 12 overdue invoices, **When** the
   admin views the "Needs attention" area, **Then** both are listed with counts
   and each links to the corresponding filtered list.
3. **Given** recent activity (a payment, a new contact, a sent reminder), **When**
   the admin views the activity feed, **Then** the most recent events appear in
   reverse-chronological order with actor, action, and relative time.
4. **Given** a manager (read-only on finance) signs in, **When** they open the
   dashboard, **Then** revenue/financial figures are presented per their role and
   no finance-restricted drill-down is exposed.
5. **Given** a member signs in, **When** they navigate to `/admin`, **Then** access
   is denied (they are routed to their member portal).
6. **Given** a tenant with zero data (fresh onboarding), **When** the admin opens
   the dashboard, **Then** each section shows a friendly empty state, not an error
   or a "0 / NaN" artefact.

---

### User Story 2 - Queryable Audit Log Viewer (Priority: P2)

A chamber administrator needs to answer a compliance or incident question: "Who
changed this member's tier last month?" / "Show me every failed sign-in in the
last 7 days." / "Export all role changes for our auditor." They open an audit-log
viewer, filter by event type, actor, target record, and date range, read the
results, and export the filtered set.

**Why this priority**: The constitution requires the audit log to be **fully
queryable** (Principle VIII). Today audit events are written but only readable via
direct DB access. This is the compliance backbone and is required before the
platform can be trusted with "all PII" oversight. It is independent of the
dashboard.

**Independent Test**: Seed a known sequence of audit events across types and
actors; open the audit viewer as admin; verify each filter narrows results
correctly, results are read-only and ordered newest-first, sensitive fields are
redacted per role, and an export reproduces exactly the filtered set.

**Acceptance Scenarios**:

1. **Given** audit events of many types exist, **When** the admin filters by event
   type "role_changed" and a date range, **Then** only matching events within that
   range are shown, newest first.
2. **Given** a specific member record, **When** the admin filters by that target
   record, **Then** every audit event referencing that record is shown regardless
   of who performed it.
3. **Given** a filtered result set, **When** the admin chooses "Export", **Then** a
   file is produced containing exactly the filtered events with their timestamps in
   UTC and a human-readable local-time rendering.
4. **Given** a manager opens the audit viewer, **When** results contain
   finance/PII-sensitive payload fields, **Then** those fields are redacted per the
   manager role's projection.
5. **Given** an attempt to edit or delete an audit entry from the viewer, **When**
   any such action is attempted, **Then** it is impossible — the log is append-only
   and the viewer is strictly read-only.
6. **Given** a tenant boundary, **When** an admin queries the audit log, **Then**
   only their own tenant's events are ever returned (no cross-tenant leakage).

---

### User Story 3 - Unified Multi-Source Member Timeline (Priority: P3)

When staff open a member profile, they want the **complete relationship history**
in one chronological stream: joined, tier changes, invoices issued/paid, payments,
events attended, e-blasts sent, renewal reminders, profile edits. Today's F3
timeline shows only audit-log events; F9 unifies all sources and adds filtering
(by type, date range, actor) and smooth performance for long histories.

**Why this priority**: A consolidated timeline is a known differentiator and
directly supports the "understand this member in 10 seconds" workflow. It builds on
the shipped F3 timeline rather than replacing it, so it is lower-risk than P1/P2
but high-value.

**Independent Test**: Seed a member with invoices, payments, event registrations,
broadcasts, and audit events spanning several months; open the member timeline;
verify all sources appear interleaved in correct chronological order, filters
narrow by source/date/actor, and a member viewing their own timeline sees the same
stream with role-appropriate redaction and cannot see other members' timelines.

**Acceptance Scenarios**:

1. **Given** a member with events across invoices, payments, events, and
   broadcasts, **When** staff open the timeline, **Then** all sources are merged
   into one reverse-chronological stream with a clear icon/label per source.
2. **Given** a long history (1,000+ entries), **When** staff scroll, **Then** the
   timeline loads additional entries smoothly without freezing the page.
3. **Given** the filter controls, **When** staff filter to "invoices only" and a
   date range, **Then** only invoice-related entries within range are shown.
4. **Given** a member viewing `/portal` their own timeline, **When** the stream
   renders, **Then** they see their own history with sensitive internal annotations
   (e.g. override reasons, staff notes) redacted, and never another member's data.
5. **Given** a source system has no entries for a member, **When** the timeline
   renders, **Then** the absent source simply contributes nothing (no error, no
   empty placeholder rows).

---

### User Story 4 - Member Benefit Usage Dashboard (Priority: P3)

A member (or an admin acting on their behalf) wants to see, for the current
membership year, how much of each quantifiable benefit they have used versus their
entitlement: E-Blasts used / quota, cultural tickets used / quota, directory
listing status, logo/banner scheduling status. Warnings highlight under-use ("at
62% of the year you've used 33% of your benefits") with deep links to act.

**Why this priority**: This is the flagship "members feel they get their money's
worth" feature and a renewal-retention lever. It is independent of the timeline and
audit pillars and reuses existing plan/broadcast/event data.

**Independent Test**: Seed a member on a plan with known quotas and known
consumption (broadcasts sent, event tickets used); open the benefit dashboard as
both the member and an admin; verify each benefit shows correct used/entitlement,
the under-use warning triggers at the right threshold, and deep links route to the
correct action (e.g. compose E-Blast).

**Acceptance Scenarios**:

1. **Given** a member on a plan granting 6 E-Blasts who has sent 2, **When** they
   open their benefit dashboard, **Then** "E-Blast" shows 2 / 6 with last-used date
   and a "compose new" deep link.
2. **Given** a member who has used 33% of benefits at 62% through the year, **When**
   the dashboard renders, **Then** an under-use warning is shown with suggested
   actions.
3. **Given** an unlimited or non-quantified benefit (e.g. "all-employee event
   discount"), **When** the dashboard renders, **Then** it is shown as
   available/active rather than as a numeric quota.
4. **Given** an admin opens a specific member's benefit view, **When** it renders,
   **Then** it matches what that member sees, plus admin-only actions (send
   reminder / suggest usage).
5. **Given** the membership year rolls over, **When** the dashboard renders for the
   new year, **Then** quotas reflect the new year's entitlement and prior-year
   consumption is not counted against it.

---

### User Story 5 - Member Directory + Directory E-Book Export (Priority: P4)

Staff need a searchable internal directory of members (by name, industry, tier,
location, keyword) and the ability to produce the annual **Directory E-Book** (a
formatted PDF of listed members) plus a structured data export the tenant can feed
into its own public website. Members control whether they are listed and which
contact details are shown.

**Why this priority**: The directory and its annual E-Book are concrete,
recurring chamber deliverables, but they depend on member opt-in data and a
formatted-document generator, so they sit behind the operational pillars.

**Independent Test**: Seed members with mixed visibility opt-in and varied
industry/tier/location; perform directory searches and verify only opt-in members
appear in published outputs while staff can search all; generate the E-Book and
verify listed members appear with their chosen fields; produce the data export and
verify it contains exactly the opt-in listings with chosen fields only.

**Acceptance Scenarios**:

1. **Given** members with industry and tier metadata, **When** staff search the
   internal directory by keyword + tier, **Then** matching members are listed with
   their directory fields.
2. **Given** members who have opted in vs out of being listed, **When** the
   Directory E-Book is generated, **Then** only opted-in members appear, each with
   only the fields they chose to expose.
3. **Given** a member who hides their contact email, **When** their listing is
   produced, **Then** the email is omitted (or replaced with a contact-form
   indicator) in published outputs.
4. **Given** the structured data export, **When** it is produced, **Then** it
   contains exactly the opt-in listings and chosen fields, suitable for the tenant's
   own website to consume.
5. **Given** the E-Book is generated, **When** staff download it, **Then** it is a
   formatted document with the chamber branding and a deterministic, reproducible
   layout.

> **Resolved (2026-05-25)**: The Directory pillar is **internal staff directory +
> downloadable PDF E-Book + structured data export only**. There is **no public,
> unauthenticated online directory surface** in F9 — the tenant publishes the
> exported data on its own website. A hosted public online directory is **deferred
> to F14**. (Aligns with "Chamber-OS is NOT a public website/CMS" and the
> smart-feature #20 reframe as "export + optional widget".)

---

### User Story 6 - GDPR Self-Service Data Export (Priority: P4)

A member exercises their right to data portability: from their portal settings they
request "export my data" and receive a downloadable archive of their profile,
contacts, invoices (records + PDFs), event attendance, broadcasts, and the audit
events relevant to them, with a README and integrity manifest. Admins can also
produce the same export on a member's behalf for a data-subject request.

**Why this priority**: GDPR Article 20 / PDPA portability is a compliance
obligation, but the volume of such requests is low and it reuses data the other
pillars already surface, so it is sequenced last.

**Independent Test**: For a seeded member, trigger the export; verify the archive
contains each expected section with the member's own data only, the manifest
checksums validate, and the download link expires after the stated window. Verify
an admin can produce the same archive for a data-subject request and the action is
audit-logged.

**Acceptance Scenarios**:

1. **Given** a member with profile, contacts, invoices, events, and broadcasts,
   **When** they request a data export, **Then** an archive is produced containing
   each section with only that member's data.
2. **Given** the export contains invoice PDFs, **When** the archive is opened,
   **Then** the PDFs are included and a README explains each file.
3. **Given** an export is produced, **When** the member is notified, **Then** the
   download is delivered via a signed link that expires after the stated window (or
   an in-portal download), and the request + delivery are recorded in the audit log.
4. **Given** an admin handles a data-subject request, **When** they generate the
   export for a member, **Then** the same archive is produced and the action is
   attributed to the admin in the audit log.
5. **Given** a member requests another member's data, **When** the request is
   evaluated, **Then** it is refused — a member may only export their own data.

---

### Edge Cases

- **Empty tenant / fresh onboarding**: every dashboard section, directory, timeline,
  and audit view must render a friendly empty state, never an error or a divide-by-
  zero / NaN artefact.
- **Very large data sets**: a tenant with tens of thousands of audit events or a
  member with thousands of timeline entries must remain responsive (pagination /
  incremental loading), and exports must complete or stream without timing out.
- **Stale derived metrics**: dashboard counts and benefit-usage figures are derived
  from many sources; the spec must define how fresh they are and how a user knows
  the "as of" time so they don't act on stale numbers.
- **Role-based redaction**: a manager (finance read-only) and a member must see
  appropriately redacted variants of the dashboard, audit viewer, and timeline; the
  same engine must not leak finance figures or staff-only annotations to the wrong
  role.
- **Tenant isolation under load**: all queries (dashboard, audit, timeline,
  directory, export) must be tenant-scoped; a cross-tenant probe must return nothing
  and be auditable.
- **Localisation & calendar**: all dates render in the viewer's locale (EN/TH/SV);
  Thai surfaces display Buddhist-Era years for users while storage stays Gregorian
  UTC; currency renders per locale with THB primary.
- **Member opts out of directory after the E-Book was generated**: a previously
  generated/exported artefact is a point-in-time snapshot; new exports must reflect
  the current opt-out.
- **Deleted/archived member**: timeline, audit, and directory must handle archived
  members gracefully (history still viewable to staff where lawful; not listed in
  published directory). GDPR export of an archived member still succeeds (on-behalf);
  an erased member's export reflects only lawfully-retained (pseudonymised) records and
  never resurrects erased PII (FR-032a).
- **Concurrent activity during dashboard view**: the activity feed should reflect
  reasonably recent events without requiring a full page reload to be useful.

## Requirements *(mandatory)*

### Functional Requirements

#### Admin Dashboard (US1)

- **FR-001**: The system MUST replace the staff home (`/admin`) with an operations
  dashboard that presents, for the current tenant, headline membership counts
  (total, active, at-risk, overdue), year-to-date paid revenue, and an indication
  of unused/under-delivered benefits.
- **FR-002**: The dashboard MUST present a "needs attention" area aggregating
  actionable items (e.g. broadcasts awaiting approval, overdue invoices, at-risk
  members), each with a count and a link to the corresponding filtered list.
- **FR-003**: The dashboard MUST present a recent-activity feed, in
  reverse-chronological order, showing actor, action summary, related record link,
  and a relative timestamp, sourced from recent audit events for the tenant. The
  activity feed MUST reflect near-real-time activity (served from a live query of the
  most recent events, **not** from the periodically-refreshed KPI snapshot, so a
  just-occurred event is visible without waiting for the next snapshot refresh). Feed
  updates MUST be announced via a **polite** live region and MUST NOT steal keyboard
  focus or re-order items the user is interacting with.
- **FR-004**: The dashboard MUST present a short list of **smart insights** —
  rule-derived suggestions surfaced from existing data — each dismissible. F9 ships a
  **fixed starter catalogue of at least 3 insight types**: (1) members with unused
  E-Blast quota, (2) members with under-used event/cultural tickets, (3) at-risk
  members needing follow-up. A general/extensible rule engine is out of scope for F9.
- **FR-005**: The dashboard MUST display each metric's "as of" freshness so users
  do not act on stale derived numbers. Derived metrics MUST be served from a cached
  snapshot refreshed on a short cadence (target ~5 minutes) and additionally
  refreshed on key state-changing events (e.g. payment recorded, broadcast approved,
  member status change); the displayed "as of" time MUST reflect the snapshot, and
  staleness MUST NOT exceed the cadence under normal operation.
- **FR-006**: The dashboard MUST render correct, non-erroring empty states for a
  tenant with no data in any given section.
- **FR-007**: The dashboard MUST present role-appropriate variants: admins see all
  metrics; managers see a finance-redacted variant per their role; members MUST NOT
  be able to access the staff dashboard.
- **FR-007a**: The system MUST present an **Engagement Score** (0–100, with health
  bands) per member, **computed as the inverse of the F8 at-risk score** (reusing F8
  signals, not a separate scoring pipeline). The score MUST be **sortable and
  filterable on the staff member list** and displayed on the member profile and the
  dashboard. It is staff-facing (not shown to members).

#### Audit Log Viewer (US2)

- **FR-008**: The system MUST provide a staff-facing audit-log viewer that lists
  audit events for the current tenant, newest first, with keyset pagination for large
  volumes. A filtered audit-query page MUST return at **p95 < 1 second for a tenant with
  at least 50,000 audit events** (the quantified target behind US2's "under 30 seconds"
  human task time).
- **FR-009**: The viewer MUST support filtering by event type, acting user, target
  record/entity, and date range, individually and in combination.
- **FR-010**: The viewer MUST be strictly read-only; it MUST NOT permit editing or
  deleting any audit entry (the log is append-only).
- **FR-011**: The viewer MUST redact sensitive **payload** fields according to the
  viewing user's role via a **defined redaction map** (per audit-event-type field
  allow/deny list), so redaction is objectively testable rather than judgement-based.
  "Sensitive payload fields" are: (a) **internal-only annotations** — override reason
  codes/notes, staff notes; and (b) **third-party personal data** — PII of members /
  contacts other than the viewer's own (for the member role). Managers/members never see
  payload fields outside their projection. **Actor identity** (the staff member who
  performed an audited action) is internal operational information visible to admins
  **and** managers; it is NOT subject to the payload-redaction projection.
- **FR-012**: The viewer MUST allow exporting the currently filtered result set to a
  downloadable file, preserving UTC timestamps plus a human-readable local-time
  rendering, and the export action itself MUST be audit-logged.
- **FR-013**: All audit queries MUST be tenant-scoped at both the application and
  database layers; cross-tenant access MUST be impossible and any probe MUST be
  auditable.

#### Multi-Source Member Timeline (US3)

- **FR-014**: The system MUST enrich the existing member timeline so it merges
  entries from member profile/audit changes, invoices, payments, event
  registrations, broadcasts, and renewal activity into one chronological stream. Each
  source/event-kind MUST map to a **stable localised i18n key** (namespace
  `timeline.<source>.<eventKind>`) with defined interpolation parameters; the timeline
  data source supplies `source` + structured `payload` and the presentation layer
  resolves the key so all six sources render consistently in EN/TH/SV (legacy
  `audit_log.summary` is a fallback display value only).
- **FR-015**: The timeline MUST support filtering by source type, date range, and
  actor (staff vs member vs system).
- **FR-016**: The timeline MUST remain responsive for members with very large
  histories (1,000+ entries) via keyset-paginated incremental loading, with each
  additional page returning at **p95 < 500 ms**; no full-history load is required to
  render the first page.
- **FR-017**: The timeline MUST be available to staff for any member and to members
  for their own history only, with role-appropriate redaction of internal
  annotations.
- **FR-018**: The timeline MUST tolerate any source contributing zero entries
  without error or placeholder noise.

#### Benefit Usage Dashboard (US4)

- **FR-019**: The system MUST present, per member for the current membership year, a
  consumption-vs-entitlement view for each quantifiable benefit (at minimum
  E-Blasts and cultural/event tickets), including last-used date where applicable.
- **FR-020**: The benefit view MUST represent unlimited/non-quantified benefits as
  available/active rather than as a numeric quota.
- **FR-021**: The benefit view MUST surface an under-use warning when, for the
  current membership year, the elapsed-year percentage minus the **aggregate consumed
  percentage** is **≥ 25 percentage points** (e.g. 62% of the year elapsed with only
  33% of benefits used → 29-pt gap → warn), with suggested actions / deep links. The
  aggregate consumed percentage is the **mean of the consumption ratio (used ÷
  entitlement) of each *quantifiable* benefit** (e.g. E-Blasts, cultural tickets);
  unlimited / active-only benefits are **excluded** from the aggregate (they have no
  ratio). A member with no quantifiable benefits never triggers the warning.
- **FR-022**: The benefit view MUST be visible to the member (own benefits) and to
  staff (any member), with staff-only actions available in the staff variant.
- **FR-023**: The benefit view MUST scope consumption to the **current membership year**,
  defined for F9 as the **calendar year in the tenant's timezone** (consistent with the
  benefit-usage model in `docs/smart-chamber-features.md`), and MUST NOT count prior-year
  usage against the current year. (If plans later become anniversary-based, the year
  definition is revisited — out of scope for F9.)

#### Directory + E-Book (US5)

- **FR-024**: The system MUST provide a staff-searchable internal directory of
  members filterable by at least name, tier, industry, location, and free-text
  keyword.
- **FR-025**: Members MUST be able to control their directory visibility (listed or
  not) and toggle exposure of each field in a **fixed listing field set**: name,
  tier, industry/category, short description, website, logo, location (city/country),
  and a public contact (name + email *or* contact-form). Default MUST be private
  (opt-in to be listed) with the contact email default-hidden. The field set is fixed
  for F9 (not per-tenant configurable).
- **FR-025a**: Logo upload (in scope for F9, critique R2-P3) MUST go through a safe
  image pipeline: accept only image MIME types (PNG/JPEG/WebP) within a size cap (e.g.
  ≤2 MB) and bounded dimensions; the server MUST **re-encode and strip EXIF/metadata**
  (reusing the F4 `sharp` approach) before storing the result in Blob; the original
  upload MUST NOT be served. Logo set/remove actions MUST be audit-logged. The logo
  appears in published outputs only when the member toggles its visibility on.
- **FR-026**: The system MUST generate a downloadable, deterministically formatted
  Directory E-Book (PDF) containing only opted-in members with only their chosen
  fields and the chamber branding. The E-Book MUST be rendered in the **tenant's
  default display locale** (EN for SweCham), with field **labels** localised to that
  locale; member-entered content (name, description) is rendered as authored. (Thai-
  font rendering reuses the F4 Sarabun embed so a TH-locale tenant renders correctly.)
- **FR-027**: The system MUST produce a structured **JSON** data export of opt-in
  listings (chosen fields only), with nested/optional fields preserved, suitable for
  programmatic consumption by the tenant's own website.
- **FR-028**: Published outputs (E-Book, export) MUST honour per-member field-level
  hiding (e.g. hidden email omitted or replaced with a contact indicator).

#### GDPR Self-Service Export (US6)

- **FR-029**: Members MUST be able to request an export of their own personal data
  (profile, contacts, invoices + PDFs, events, broadcasts, relevant audit events) as
  a single downloadable archive with a README and an integrity manifest. The audit
  subset MUST include **both events the member performed and events targeting the
  member's records**, with third-party PII and internal-only annotations (e.g.
  override reasons, staff notes) **redacted** via the standard role projection so no
  other data subject's information leaks into the archive. The README MUST be rendered
  in the **requester's locale** (the member's, or the admin's for an on-behalf request)
  with EN fallback; the `manifest.json` is machine-readable and **locale-neutral**
  (English keys + checksums).
- **FR-030**: Export delivery MUST be via a time-limited signed link or in-portal
  download, and both the request and the delivery MUST be recorded in the audit log.
  The "export ready" notification (and any async-job notifications) MUST be localised
  to the recipient's locale.
- **FR-031**: Admins MUST be able to produce the same export on a member's behalf for
  a data-subject request, attributed to the admin in the audit log.
- **FR-032**: A member MUST NOT be able to export any data other than their own.
- **FR-032a**: An **archived** (but not erased) member MUST still be exportable — data-
  subject portability rights persist after archival; staff produce the export
  on-behalf. Where a member has exercised **erasure**, the export reflects only data
  lawfully retained (e.g. pseudonymised audit/financial records kept for the statutory
  retention period), and the system MUST NOT resurrect erased PII to satisfy an export.

#### Cross-cutting (all stories)

- **FR-033**: All F9 surfaces MUST be tenant-scoped at the application and database
  layers; no query may return another tenant's data.
- **FR-034**: All F9 surfaces MUST present localised content in EN, TH, and SV, with
  dates/numbers/currency formatted per locale; Thai surfaces MUST display
  Buddhist-Era years while persisted timestamps remain Gregorian UTC. F9 MUST reuse the
  **established platform glossary terms** (e.g. member, tier, E-Blast, invoice, receipt)
  consistently across all three locales, matching the existing F1–F8 translations rather
  than introducing divergent synonyms.
- **FR-035**: All F9 surfaces MUST meet the platform accessibility standard
  (keyboard operable, screen-reader labelled, sufficient contrast, reduced-motion
  respected) and the platform UX standard (loading skeletons, empty/error states,
  toasts for actions). Status that conveys meaning — Engagement Score bands and
  benefit-usage levels — MUST NOT rely on **colour alone**: a text label and/or
  icon/shape MUST also encode it (WCAG 1.4.1). All form controls (audit filters,
  directory-visibility toggles, logo upload) MUST have programmatic labels and
  screen-reader-announced validation/error messaging.
- **FR-036**: Reads of PII-bearing surfaces (member views, exports) and all export
  actions MUST be audit-logged to a degree sufficient to demonstrate who accessed
  whose data.
- **FR-037**: Export delivery follows a **hybrid** model: small filtered audit-log
  exports MUST stream synchronously within the request budget; the Directory E-Book
  and the GDPR data archive MUST be produced **asynchronously** via a background job
  that, on completion, notifies the requester and provides a time-limited signed
  download link (per FR-030). No export may silently fail — failures MUST surface to
  the requester and be audit-logged.

> **Resolved (2026-05-25) — Smart-intelligence depth = "Balanced"**: F9 delivers the
> four named pillars **plus** Engagement Score (#15, the positive-framed inverse of
> the F8 at-risk score) surfaced on the dashboard and member list, the Activity Feed
> (#17), and GDPR self-service export (#21). A full Smart Insights rule engine (#19),
> Partnership Benefit Compliance Tracker (#18), and Auto Tier-Upgrade Suggestions
> (#16) are **deferred** to a later iteration. FR-004 covers a **starter** insight
> set (a small fixed catalogue of rule-derived suggestions), not a general rule
> engine.

> **Resolved (2026-05-25) — Member-portal counterparts = in scope**: F9 delivers the
> member-facing halves of US3 (member's own enriched timeline at `/portal`), US4
> (member's own benefit-usage dashboard), and US6 (GDPR self-export in portal
> settings). The org KPI dashboard (US1) and the audit-log viewer (US2) remain
> **staff-only**.

### Key Entities *(include if feature involves data)*

- **Dashboard Snapshot (derived)**: a computed, point-in-time roll-up of tenant
  metrics (membership counts by status, YTD revenue, benefit under-delivery,
  pending-action counts) with an "as of" timestamp. Derived from members, invoices,
  payments, broadcasts, events, renewals — not authored directly.
- **Activity Feed Item (derived)**: a recent, tenant-scoped event projected from the
  audit log for display (actor, action summary, related record, time).
- **Smart Insight**: a rule-derived suggestion for staff (e.g. "5 members have unused
  E-Blast quota"), with a dismissal state per tenant/user.
- **Audit Event (existing)**: the append-only record of a security/data action
  (actor, action type, target, tenant, timestamp, payload). F9 reads and projects
  these; it never writes outside the existing audit-logging conventions (plus its
  own new event types for F9 reads/exports).
- **Timeline Entry (derived)**: a normalised, source-tagged item in a member's
  chronological history, unioned from audit events, invoices, payments, event
  registrations, broadcasts, and renewals.
- **Benefit Usage (derived)**: per member, per membership year, the consumption vs
  entitlement of each quantifiable benefit, derived from plan entitlements and
  consumption signals (broadcasts sent, tickets used).
- **Directory Listing**: a member's published profile over a fixed field set (name,
  tier, industry/category, short description, website, logo, location, public
  contact) plus a listed/not-listed opt-in flag and a per-field exposure toggle;
  default private, email default-hidden.
- **Directory E-Book (artefact)**: a generated, formatted PDF of opt-in listings at
  a point in time.
- **Data Export Archive (artefact)**: a generated per-member archive of their
  personal data with README and integrity manifest, for GDPR portability.
- **Engagement Score (derived, in scope)**: a 0–100 health score per member with
  health bands, computed as the positive-framed inverse of the F8 at-risk score
  (reusing F8 signals). Sortable/filterable on the staff member list; shown on the
  member profile and dashboard; staff-facing only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A chamber administrator can answer "how healthy is the chamber right
  now?" (active vs at-risk vs overdue members, YTD revenue, items needing
  attention) within **10 seconds of opening `/admin`**, without navigating away.
- **SC-002**: The dashboard's primary view renders at **p95 < 1.5 seconds** (full
  interactive render) for a tenant of at least **5,000 members**, and clearly shows
  the "as of" freshness of derived numbers.
- **SC-003**: A staff member can locate a specific past action (e.g. "who changed
  this member's tier last month") via the audit viewer in **under 30 seconds**
  using filters, with zero developer/database involvement.
- **SC-004**: An auditor request ("export all role changes for the year") is
  satisfied by a self-service filtered export in **under 2 minutes**, with
  timestamps that are unambiguous (UTC + local rendering).
- **SC-005**: For a member with a multi-source history, **100% of relationship
  events** that exist in invoices, payments, events, broadcasts, and audit appear in
  the unified timeline in correct chronological order.
- **SC-006**: A member can see their current-year benefit usage versus entitlement
  for every quantifiable benefit on their plan, and the figures **match an
  independent manual reconciliation** of consumption signals.
- **SC-007**: The Directory E-Book and structured export contain **only opt-in
  members and only their chosen fields** — verified as zero leakage of opted-out
  members or hidden fields across a representative sample.
- **SC-008**: A member's GDPR data export is produced and downloadable within the
  stated window, contains **every category** of their data, and its integrity
  manifest validates.
- **SC-009**: Across all F9 surfaces, a cross-tenant access attempt returns **zero**
  records from another tenant (verified by an isolation test) and is recorded as an
  auditable probe.
- **SC-010**: All F9 surfaces pass the platform accessibility bar (WCAG 2.1 AA) and
  render fully in EN, TH (Buddhist-Era display), and SV with no missing strings.
- **SC-011**: Role redaction holds: a manager and a member each see **no
  finance/PII field outside their role's projection** on the dashboard, audit
  viewer, and timeline (verified by per-role assertions).
- **SC-012** *(adoption / value KPI, tracked post-launch)*: within the first
  membership year after launch, **≥ 50% of active members** have viewed their own
  benefit-usage dashboard at least once, and staff act on (or dismiss) **≥ 70%** of
  surfaced smart insights — evidence the feature changes behaviour, not just exists.
- **SC-013** *(rollback trigger)*: the feature is rolled back by flipping
  `FEATURE_F9_DASHBOARD` off if, in production, the dashboard error rate exceeds **2%**
  of loads over a 15-minute window, **or** snapshot age p95 exceeds **15 minutes** (3×
  the refresh cadence), **or** any cross-tenant leak is detected — reversible in
  seconds without a code deploy.

## Assumptions

- **Builds on F1–F8 shipped data**: F9 is read-/projection-heavy and consumes data
  produced by F1 (auth/audit), F2 (plans/entitlements), F3 (members/contacts +
  existing timeline), F4 (invoices/receipts), F5 (payments), F6 (events), F7
  (broadcasts), F8 (renewals/at-risk). No new operational write surfaces beyond
  directory visibility settings, insight dismissals, and export requests.
- **Timeline is an enhancement, not a rebuild**: the F3 audit-based member timeline
  (`/timeline`, `timelineList`, role redaction) already exists; F9 extends its
  source set and filtering rather than replacing it.
- **Dashboard replaces the F1 placeholder** at `/admin` (whose own code comments
  earmark it for "F9 — unified admin dashboard + audit log viewer").
- **Three roles unchanged** (admin full, manager finance-read-only, member
  self-service); F9 adds read surfaces, not new roles.
- **Derived-metric freshness**: dashboard/benefit figures may be computed on a
  near-real-time or periodically refreshed basis (exact strategy is a planning
  decision); the spec only requires that freshness is shown and numbers are correct
  as of that time.
- **Directory default is private**: members are not listed unless they opt in;
  field exposure is member-controlled.
- **PII sensitivity & review gate**: F9 reads all member PII, so it is a
  security-sensitive feature requiring ≥2 reviewers with one signing the security
  checklist, per project governance.
- **Tenant isolation pattern**: F9 uses the established tenant-scoped data-access
  pattern (application context + database row-level scoping); every query is
  tenant-bound.
- **Localisation/calendar conventions**: storage is Gregorian UTC; Buddhist Era is
  display-only for Thai surfaces; THB is the primary currency.
- **Public online directory is out of scope** (resolved 2026-05-25, deferred to
  F14); F9's directory output is internal + downloadable PDF E-Book + structured
  export for the tenant's own site.
- **Smart-depth = "Balanced"** (resolved 2026-05-25): engagement score + activity
  feed + GDPR self-service export are in scope; full insights rule engine,
  compliance tracker, and auto-upgrade suggestions are deferred.
- **Member-portal counterparts are in scope** (resolved 2026-05-25): member's own
  timeline, own benefit dashboard, and own GDPR export ship in F9; the org KPI
  dashboard and audit viewer stay staff-only.
- **Member portal information architecture** (critique R2-P4): the member surfaces have
  defined homes + nav entries so they are discoverable, not orphaned — own benefits at
  `/portal/benefits`, own timeline at `/portal/timeline`, **directory-visibility settings
  under `/portal/profile`**, and **GDPR data export under `/portal/account`**. Staff
  surfaces add Dashboard / Audit / Directory nav items (role-gated).
- **Scale headroom & revisit trigger** (checklist perf CHK017): F9 is designed and
  measured to the SC-002 target of **5,000 members/tenant** (current SweCham ≈131). The
  caching/index strategy is expected to hold to roughly that order of magnitude; if any
  tenant approaches **~20,000 members**, the snapshot/partition/index strategy MUST be
  revisited (e.g. incremental snapshot, source-side aggregates) before it becomes the
  bottleneck. This is the explicit 10x-growth revisit trigger.

## Dependencies

- **F1** — authentication, RBAC, and the append-only audit log (source for the audit
  viewer, activity feed, and timeline audit entries).
- **F2** — membership plans and benefit entitlements (source for benefit quotas).
- **F3** — members, contacts, and the existing timeline component being enriched.
- **F4** — invoices/receipts (revenue metrics, timeline, GDPR export, benefit
  reconciliation).
- **F5** — payments (revenue/timeline).
- **F6** — events/registrations (benefit consumption + timeline).
- **F7** — broadcasts/E-Blasts (benefit consumption + timeline).
- **F8** — renewal/at-risk signals (dashboard counts, engagement score, timeline).
