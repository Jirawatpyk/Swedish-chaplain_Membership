# Feature Specification: F3 — Member & Contact Management + Smart Features

**Feature Branch**: `005-members-contacts`
**Created**: 2026-04-15
**Status**: Draft
**Input**: User description: "Full Feature Member & Contact Management + Smart Feature"

## Summary

F3 delivers the **second Chamber-OS business feature**: the authoritative
directory of member companies and their contacts, plus the smart-chamber
surfaces that make day-to-day admin work feel effortless. Members are
company-level entities (not individuals); each member has one primary
contact and any number of secondary contacts. Plan assignment, turnover
thresholds, and age/duration rules (Start-up max 2 years, Thai Alumni
age ≤ 35) are enforced at the application layer with audit-trail
coverage. F3 also ships the inline-edit + bulk-action surface deferred
from F2 US7, the per-member timeline view, and the bundle-change
warning deferred from F2 D1.

**F2 carry-overs addressed**:
- **D1** (US3 AS4 Partnership bundle-change warning) → now backed by
  real member counts (see US3 AS7 below)
- **F2 US7** (Inline Edit + Bulk Actions) → shipped in US4

**MVP slice**: **US1 + US2 + US3** constitute the minimum Excel
replacement — admin can create, find, and edit a member with its
contacts. US4-US7 are smart-feature differentiators that can ship
incrementally within the same branch without delaying MVP handoff.
US5 (member self-service) ships only 3 real surfaces — Profile view,
Whitelisted-field edit, Colleague invite — any tab that depends on
F4/F5/F6/F7 is **hidden entirely in F3** (not rendered as a "coming
soon" placeholder) and unhidden feature-by-feature as dependencies
land.

## Clarifications

### Session 2026-04-15

- Q: Override reason structure for turnover/age/Start-up rule overrides → A: Required enum (`board_approved` / `pending_renewal_grace` / `data_correction` / `other`) + optional free-text note (max 500 chars); when `other` is chosen, the note becomes required.
- Q: Behavior when admin changes primary contact's email and that email is linked to an F1 user account → A: Kill all active sessions of the linked user immediately; new email cannot sign in until verified via an emailed token (24h TTL); old email is disabled at the same instant.
- Q: Field shape for `country` and `legal_entity_type` on Member → A: `country` = ISO 3166-1 alpha-2 enum (2-char code stored, localized name displayed); `legal_entity_type` = free text (max 100 chars) because it varies by country.
- Q: Maximum rows allowed in a single bulk action (US4) → A: 100 rows per batch; selections beyond 100 are blocked at the UI with a clear message instructing the admin to split the operation.
- Q: When is `tax_id` required on Member? → A: Required for Corporate tiers (Premium / Large / Regular / Start-up) and all Partnership tiers; optional for Individual and Thai Alumni. For members with `country = TH`, tax_id MUST pass the Thai 13-digit format check; non-Thai members use free-format validation only.
- Q2 refinement (post-critique 2026-04-15): the base Q2 answer (kill sessions + 24h new-email token + old-email disabled) is extended with (a) a **5-minute activation delay** on the new-email verification token and (b) a **dual-channel notification** email to the OLD address carrying a 48-hour revert token (see FR-012a item (vi), FR-012b, and § Security considerations). This hardens Q2 against the admin-impersonation ATO vector flagged by the round-1 critique.

## Security considerations

### Admin-impersonation ATO vector (FR-012a mitigation)

Admin-initiated primary-contact email change (Q2 + FR-012a) revokes
the linked user's sessions and dispatches a verification email to
the new address. Without compensating controls, a **compromised or
malicious admin** could redirect a member's login to an attacker-
controlled address and take over the account. Mitigations required
in F3:

1. **Dual-channel notification** — on every email change initiated
   by an admin, the system sends a best-effort notification to the
   **OLD** email address with a 48-hour single-use
   "This wasn't me — revert + freeze account" token. If the old-
   email holder clicks it within 48 hours, the change is rolled back
   (old email restored, new-email verification token invalidated,
   linked user sessions require password reset to resume) and a
   high-severity `member_email_change_reverted` audit event is
   emitted.
2. **Verification delay window** — the new-email verification token
   is valid only after a 5-minute delay from change commit, giving
   the old-email recipient time to act on (1) before the attacker
   can verify.
3. **High-severity audit** — every admin-initiated email change
   emits `member_contact_email_changed` at high severity (not info),
   alerting the maintainer on every occurrence until a threshold-
   based suppression rule is tuned in F9.
4. **Revert scenario (narrative)**: when the OLD-email recipient
   clicks the 48-hour revert token within window, the email change
   is rolled back atomically — old email restored on the contact
   and the linked F1 user, the new-email verification token is
   invalidated, the linked F1 user is flagged
   `requires_password_reset` (so the attacker cannot reuse the old
   password even if harvested), and a high-severity audit event
   `member_email_change_reverted` is appended. The acting admin is
   notified by a non-blocking banner on next sign-in. The revert
   endpoint is public (unauthenticated) because the victim has no
   active session — authorization is via the single-use, rate-
   limited token. See FR-012b + endpoint #16.
5. **Self-service email change (F3.1 follow-up)** — for `role=member`
   users, a self-service `/portal/edit/email` flow that requires
   verification from BOTH old and new addresses before commit is
   scoped as an F3.1 follow-up. It is NOT shipped in F3 because
   US5 whitelisted fields exclude email — email change remains
   admin-only in F3 baseline, with dual-channel notification as the
   compensating control.

### Outbox permanent-failure lockout recovery (FR-012a integrity)

If the FR-012a DB transaction commits but the after-commit email
dispatch fails permanently (Resend outage, disk full, misconfigured
env), the member is locked out — old email dead, new email
unverifiable. Mitigations required in F3:

1. Outbox dispatcher retries ≥ 5 attempts with exponential backoff
   (60s / 5m / 30m / 3h / 12h).
2. On permanent failure (all retries exhausted), emit a high-
   severity audit event `email_dispatch_failed` and a PagerDuty-
   equivalent alert to the maintainer.
3. Admin recovery path: a **"Re-send verification email" action** on
   the member detail page creates a fresh token + new outbox row,
   available whenever the last token has expired or the outbox row
   is marked `permanently_failed`.
4. Verification token TTL is **auto-refreshed** on every successful
   outbox dispatch attempt after the first — if Resend is out for
   23 hours and the message finally leaves on attempt 4, the token
   is regenerated with a fresh 24-hour window so the recipient has
   a full day to act.

### `notes` field cross-admin visibility

The admin-only `notes` field on Member can hold up to 4,000 chars of
free text. It is readable by every admin of the same tenant. To
limit misuse:

- `notes` MUST NOT be indexed by the `pg_trgm` search index used for
  the directory (FR-016) — admins must open the member detail view
  to read notes.
- `notes` MUST NOT appear in the GDPR self-service export (F9 scope
  — flag recorded for the F9 spec).
- `notes` is excluded from the logs redaction list only because it
  is opaque free text; admins are expected to avoid pasting PII and
  the F9 GDPR export carve-out is the safety net.

### Admin free-text audit fields (US7 archive `reason`, US3 `override_reason_note`)

Several audit event payloads carry admin-authored free-text strings
that share the same cross-admin visibility + PII-exposure posture as
the `notes` field above:

- **`member_archived.reason`** (US7 FR-005, ≤ 500 chars) — optional
  admin-authored context on why a member was archived. Stored verbatim
  in the audit payload.
- **`*.override_reason_note`** (FR-006a, ≤ 500 chars) — required on
  `board_approved` / `pending_renewal_grace` / `data_correction` /
  `other` overrides for turnover (FR-006), Start-up duration
  (FR-007), and Thai Alumni age (FR-008) rules. Stored on the
  originating audit event (`member_created`, `member_plan_changed`,
  `member_updated`, etc.).

All three fields (`notes`, `reason`, `override_reason_note`) MUST
inherit the identical F9 GDPR self-service export carve-out —
excluded from the member's own export because admins may reference
third parties or internal deliberations that the member has no right
to see. The F9 spec MUST enumerate these three fields explicitly so
the carve-out is not discovered per-field via codebase grep. Admins
MUST be warned in the relevant UI helpers to avoid pasting PII,
consistent with the existing `notes` convention.

**Out of scope** (deferred to later features, explicit YAGNI):
- Bulk CSV import (Phase 5 smart #13 or one-off migration script)
- At-risk scoring logic (F8 — F3 only reserves the UI slot)
- Benefit usage dashboard (F9 — depends on F6/F7 data)
- Invoice history per member (F4)
- Online renewal (F5)

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Admin creates a new member with its contacts (Priority: P1)

Admin staff onboard a new member company by capturing the legal entity,
choosing a membership plan for the current year, recording the turnover
bracket (which validates against the plan's turnover requirement), and
capturing at least one primary contact (name, work email, phone, role,
preferred language). Registration fee eligibility (THB 1,000 one-time
for new members) is flagged automatically. On save, the member appears
in the directory with status `active`, an audit event is written, and
the admin can immediately invite the primary contact to the member
portal.

**Why this priority**: Without member creation, no other F3+ feature
delivers value. This is the minimum slice that replaces the Excel
workflow for adding a new member.

**Independent Test**: An admin can open the staff portal, run the
"Create member" command, fill in one company + one primary contact,
save, and see the new member in the directory with the correct plan
assignment and audit event — without any other F3 user story being
implemented.

**Acceptance Scenarios**:

1. **Given** an admin is authenticated on the staff portal, **When**
   they open Create Member and submit `{company_name, country,
   turnover_thb, plan_id (Premium Corporate 2026), primary_contact:
   {name, email, phone, role, language=en}}`, **Then** the member is
   persisted with `status=active`, `registration_fee_eligible=true`
   (new member), the primary contact is persisted with
   `is_primary=true`, and an audit event `member_created` is appended.
2. **Given** the admin selects plan "Premium Corporate" which requires
   turnover > 100M THB, **When** they enter `turnover_thb=45000000`
   (45M), **Then** the form shows an inline validation warning
   "Turnover 45M THB does not meet Premium Corporate's >100M
   requirement — either choose Regular Corporate or confirm an
   override with a reason", and save is blocked until one of those
   paths is taken.
3. **Given** the admin selects plan "Thai Alumni", **When** the
   primary contact's birth year implies age > 35 at the plan start
   date, **Then** an inline warning appears "Thai Alumni is limited
   to members under 35 at plan start — verify eligibility or choose
   a different plan", and save requires an explicit override reason
   captured in the audit log.
4. **Given** the admin selects plan "Start-up", **When** the company
   `founded_year` implies the company is older than 2 years at plan
   start date, **Then** an inline warning appears and save requires
   an override reason.
5. **Given** a newly saved member with an email on the primary
   contact, **When** the admin clicks "Invite to portal", **Then** an
   invitation email is sent (via the F1 invite flow) scoped to the
   `member` role and linked to this member's `member_id`.
6. **Given** the admin opens the command palette (Cmd/Ctrl+K) from
   anywhere in the staff portal, **When** they type "new member" or
   "create member", **Then** the command palette offers "Create new
   member" as the top action and navigates to the Create Member form
   on selection.

---

### User Story 2 — Admin searches, filters, and opens the member directory (Priority: P1)

Admin staff need a fast, keyboard-friendly directory to locate any
member. The directory supports substring search across company name,
primary contact name, and primary contact email; filters on plan
tier, plan year, status (`active`, `inactive`, `archived`),
partnership tier, country, and an at-risk flag (UI slot only — real
scoring ships in F8). Each row shows company, plan + tier, primary
contact + email, status, last-activity timestamp, and a risk
indicator. Clicking a row opens the member detail page.

**Why this priority**: A directory without search is unusable above
~20 members. SweCham already has 131 members; TSCC scale is the
baseline.

**Independent Test**: An admin can open `/admin/members`, type a
partial company name, see filtered results in under 1 second, apply
a plan-tier filter, and click into a member detail page — without
any other US being implemented beyond US1 creation.

**Acceptance Scenarios**:

1. **Given** 131 members exist, **When** the admin types "Fog" in the
   directory search box, **Then** the result list narrows to members
   whose company name, primary contact name, or primary contact email
   contains "fog" (case-insensitive) within 500 ms perceived latency.
2. **Given** the admin applies filters `plan_tier=Premium Corporate`
   + `status=active` + `country=Thailand`, **When** the filters are
   committed, **Then** only members matching all three are shown and
   the URL reflects the filter state so it can be bookmarked/shared.
3. **Given** a member in the directory, **When** the admin clicks the
   row, **Then** the member detail page loads at `/admin/members/:id`
   showing company info, plan assignment + year, all contacts grouped
   by primary/secondary, registration/renewal history, and a
   "Timeline" tab (US6).
4. **Given** the admin opens the command palette (Cmd/Ctrl+K), **When**
   they type a member's company name, **Then** matching members
   appear as navigable results that deep-link to the member detail
   page on select.
5. **Given** the directory shows the at-risk column, **When** the real
   at-risk scoring module from F8 is not yet deployed, **Then** the
   column renders a neutral "—" placeholder with a tooltip
   "At-risk scoring available in F8"; the column MUST NOT throw or
   show stale/fake data.

---

### User Story 3 — Admin edits member details, plan, and contacts with bundle-change warning (Priority: P2)

Admin edits an existing member to update company info, change the
membership plan (including cross-tier changes and Partnership bundle
changes), or maintain contacts (add, remove, mark primary).
Cross-tier plan changes are allowed but surface warnings for
turnover/age/duration mismatches just like creation. When the edited
plan is a Partnership tier and the `includes_corporate_plan_id`
differs from the current setting, a confirmation dialog shows
**real member counts** quoting how many existing members on this
plan will keep their current bundled corporate benefits vs. new
signups getting the new bundle.

**Why this priority**: Members change plans at renewal, contacts
churn, company details drift. Editing is table-stakes but less
urgent than create/search because admins can work around its
absence short-term.

**Independent Test**: An admin can open an existing member, change
its plan from Regular Corporate to Premium Corporate, update the
primary contact's email, add a secondary contact, and save — with
validation warnings shown, audit events written, and the directory
reflecting the changes on reload.

**Acceptance Scenarios**:

1. **Given** an existing Premium Corporate member with 3 active
   contacts, **When** the admin changes the plan to "Regular
   Corporate" and `turnover_thb` is 30M (below Premium's threshold
   but within Regular's), **Then** save succeeds without a warning
   (downgrade is valid under the new plan) and the audit event
   `member_plan_changed` records `{old_plan_id, new_plan_id, reason?,
   actor_user_id}`.
2. **Given** an existing member, **When** the admin marks a
   secondary contact as primary, **Then** the previously primary
   contact is automatically demoted to secondary, and an audit event
   `member_primary_contact_changed` is written. Exactly one contact
   per member has `is_primary=true` at any time — enforced by a DB
   unique partial index.
3. **Given** an existing member with a primary contact and two
   secondary contacts, **When** the admin removes the primary
   contact, **Then** save is blocked with a validation error "A
   member must have at least one contact marked as primary — promote
   another contact first or cancel".
4. **Given** an admin is editing a Partnership plan member on a
   plan whose `includes_corporate_plan_id` is about to change (e.g.,
   Platinum bundles Premium Corporate → edit wants to bundle Large
   Corporate instead), **When** the admin clicks Save, **Then** a
   `BundleChangeWarningDialog` appears with text: "N existing members
   keep their current {current_bundle} benefits; new signups after
   this save will receive {new_bundle} benefits", where N is fetched
   live from the members table via
   `GET /api/plans/[year]/[planId]/affected-members`.
5. **Given** the bundle-change dialog is open, **When** the admin
   confirms, **Then** the PATCH fires with an audit event
   `plan_bundle_changed` referencing the affected member count at
   time of confirmation; **When** the admin cancels, **Then** no
   PATCH fires and the form remains in draft state.
6. **Given** a member whose primary contact's email is linked to an
   existing F1 user account with `role=member`, **When** the admin
   changes the primary contact's email, **Then** in a single
   transaction (a) the contact email is updated, (b) the linked
   user's email is updated, (c) **all active sessions of that user
   are revoked immediately**, (d) the old email is disabled for
   sign-in at the same instant, (e) a verification email with a
   24-hour single-use token (valid only after a **5-minute delay**
   from commit) is queued to the new address via the outbox, and
   (f) a **dual-channel notification email** with a 48-hour
   "this wasn't me — revert + freeze account" token is queued to
   the OLD address. The new email CANNOT sign in until the token
   is consumed. Audit events `member_contact_email_changed` (high
   severity) + `user_sessions_revoked` + `email_verification_sent`
   + `email_change_notification_sent_to_old_address` are appended.
7. **Given** the FR-012a transaction commits but the outbox
   permanently fails to deliver the verification email after the
   configured retry budget, **When** the admin clicks **"Re-send
   verification email"** on the member detail page, **Then** a
   fresh token + new outbox row are generated and the audit event
   `email_verification_resent` is appended. The member remains
   locked out until delivery succeeds, but recovery does not
   require a database operator.

*(The OLD-email recipient's revert-token flow triggered by an
admin-initiated email change is a non-admin action and is
documented as a security scenario in § Security considerations
below; see FR-012b for the functional requirement and endpoint #16
in `contracts/members-api.md` for the API contract.)*
8. **Given** the admin edits a Start-up member whose company
   `founded_year` implies the 2-year cap has been exceeded, **When**
   they attempt to keep the plan as Start-up, **Then** a warning
   surfaces and save requires an explicit override reason (per
   FR-006a) recorded to the audit log.

---

### User Story 4 — Inline edit + bulk actions on the member directory (Priority: P2)

Admins often need to edit one field across many members (e.g., switch
10 members from Regular to Premium Corporate at renewal, or change
status on a batch). The directory supports inline edit on
low-risk fields (status toggle, country, notes) and bulk actions
(change plan, archive, send portal invite) via multi-row selection.
This is the F2 US7 deferral materialised.

**Why this priority**: High productivity win but non-blocking — admins
can always edit one-at-a-time via US3. Ship after US1–US3 baseline.

**Independent Test**: An admin can select 3 rows in the directory,
pick "Archive selected" from the bulk-action menu, confirm in a
dialog, and see the 3 members moved to status=archived with audit
events per member — without US5/US6/US7 being built.

**Acceptance Scenarios**:

1. **Given** the directory shows the Status column with an inline
   editable cell, **When** the admin double-clicks a cell and
   switches from `active` to `inactive`, **Then** the change persists
   on blur, a toast confirms "Status updated", an audit event
   `member_status_changed` is written, and the row updates optimistically
   with rollback on server error.
2. **Given** 5 rows are selected via checkboxes, **When** the admin
   picks "Change plan → Regular Corporate 2026" from the bulk menu
   and confirms in the dialog, **Then** each member's plan is updated
   in a single transaction (or all-or-nothing if partial failure),
   `N` audit events `member_plan_changed` are written, and a toast
   summarises "5 members updated" with a link to the audit log.
3. **Given** 10 rows are selected, **When** the admin picks "Archive
   selected", **Then** the confirmation dialog lists the 10 company
   names (truncated with "…and N more" if > 5), requires an explicit
   "Archive 10 members" typed phrase or Enter confirmation per UX
   standards § 4 destructive-action rules, and on confirm archives
   all 10 with audit events.
4. **Given** inline edits or bulk actions encounter partial failure
   (e.g., 2 of 5 members fail a tenant RLS check), **Then** the
   transaction rolls back entirely (no partial commit), the toast
   shows an error with a retry action, and no audit events are
   written for the failed batch.
5. **Given** a non-admin role (manager or member) accesses the
   directory, **Then** inline edit and bulk actions are hidden
   (not just disabled), and the directory is read-only for manager
   and invisible for member (member sees `/portal` instead per US5).

---

### User Story 5 — Member self-service: view and edit own company profile (Priority: P2)

A signed-in member views their own company profile at `/portal`
(single-member scope — they cannot see other members). F3 ships
**only 3 real surfaces** for member self-service — anything that
depends on F4/F5/F6/F7 is hidden entirely, not rendered as a
"coming soon" placeholder:

1. **Profile view** — company info, plan + year, their own contact
   list. No invoice history (F4), no renewal history beyond audit-
   derived plan changes (US6 Timeline), no E-Blast history (F7),
   no event attendance (F6).
2. **Whitelisted-field edit** — primary contact info (name, phone,
   `preferred_language`), company `website`, and `description`.
   All other fields (plan, turnover, status, `tax_id`,
   `legal_entity_type`, `country`, email) are admin-only.
3. **Colleague invite** — invite a secondary contact via the F1
   invite flow scoped to their member.

**Why this priority**: The member portal placeholder from F1 needs
real content to be useful. This delivers the self-service slice of
R4's member persona.

**Independent Test**: A member signs in at `/portal`, sees only
their own company + contacts (no other members), updates their own
phone, saves, and sees a success toast — without being able to
access any admin route or see other tenants' data.

**Acceptance Scenarios**:

1. **Given** a member is signed in with `role=member` linked to
   `member_id=42`, **When** they navigate to `/portal`, **Then** they
   see their company profile, plan + year, their contact list, and
   recent renewal history; direct navigation to `/admin/**` or
   `/portal/members/99` (other member) returns 403 with the F1
   not-authorised template.
2. **Given** the member edits their phone number, **When** they
   save, **Then** the contact record updates, an audit event
   `member_self_updated` is written with `{member_id, actor_user_id,
   fields_changed: [phone]}`, and admin-only fields (plan, turnover,
   status) are absent from the submitted payload — the server
   rejects them with 403 if forged.
3. **Given** the member attempts to edit their plan via a crafted
   request, **Then** the server rejects with 403 and an audit event
   `member_self_update_forbidden` is written with the attempted
   payload (redacted of PII per logging rules).
4. **Given** the member wants to add a colleague as a secondary
   contact, **When** they complete "Invite colleague" with name +
   email + role, **Then** an F1 invitation is issued scoped to their
   `member_id`, and on acceptance the new user is bound to the same
   member with a new contact record.
5. **Given** the member's tenant has the read-only kill-switch
   enabled (`READ_ONLY_MODE=true`), **Then** edits return 503
   `read-only-mode` consistent with F1 behaviour; reads remain
   available.

---

### User Story 6 — Per-member timeline view (Priority: P3)

Every member detail page has a "Timeline" tab showing a chronological
feed of actions and lifecycle events: creation, plan changes, contact
changes, status transitions, portal invitations, override reasons,
self-service edits, and (when later features ship) invoices, payments,
E-Blasts, event attendance. The timeline is a read-only view over the
F1 append-only audit log, filtered to this member.

**Why this priority**: Smart-feature #8 differentiator, but the raw
audit log (US1–US5 writes) delivers value via plain search first.
Ship once foundational CRUD is stable.

**Independent Test**: Open any member detail page, click Timeline,
see ≥ 1 event per US1–US5 action performed against that member, with
stable chronological order, actor attribution, and correct i18n.

**Acceptance Scenarios**:

1. **Given** a member with 5 prior audit events (`member_created`,
   `member_plan_changed`, `member_primary_contact_changed`,
   `member_status_changed`, `member_self_updated`), **When** the admin
   clicks Timeline, **Then** all 5 events render newest-first with
   timestamp (ISO 8601 stored, formatted per user locale including
   BE display for `th-TH`), actor name (or "System" for cron-driven
   events), event type as a localised label, and a brief summary
   diff (e.g., "Plan changed from Regular Corporate → Premium
   Corporate").
2. **Given** the timeline contains many events, **When** the admin
   scrolls, **Then** pagination/infinite-scroll loads older entries
   in batches of 50 without blocking the main thread; the query
   remains tenant-scoped and member-scoped.
3. **Given** the signed-in user is a `member` (not admin), **When**
   they open their own timeline, **Then** they see only their own
   member events, and certain admin-only fields (override reasons,
   internal notes) are redacted.
4. **Given** reduced-motion is requested by the OS/browser, **Then**
   timeline scroll/reveal animations fall back to instant per UX
   standards § 2.2.

---

### User Story 7 — Soft-delete (archive) and undelete member (Priority: P3)

Admin can archive a member (set `status=archived`) instead of hard-
deleting to preserve history and invoices. Archived members are
hidden from the default directory view but accessible via a "Show
archived" filter; they can be restored by an admin via an Undelete
action within a 90-day window that is displayed on the archived
row. Hard delete is NOT exposed in the UI — it requires a manual
DB action with an audit note, consistent with F1's append-only
philosophy.

**Why this priority**: Prevents data loss from accidental deletion
(smart-feature #9 "Global Undo" foreshadow) but can be added after
core CRUD ships. Admins can hide members via `status=inactive` as
a short-term workaround.

**Independent Test**: Archive a member, verify it disappears from
the default directory, toggle "Show archived" and see it re-appear
with an Undelete button, click Undelete, verify it returns to
`status=active` and writes two audit events (`member_archived`
and `member_undeleted`).

**Acceptance Scenarios**:

1. **Given** an active member, **When** the admin selects "Archive"
   from the row menu and confirms, **Then** status becomes `archived`,
   `archived_at` is set to NOW(), an audit event `member_archived` is
   written with `{actor_user_id, reason?}`, and the row leaves the
   default directory view.
2. **Given** an archived member within 90 days of `archived_at`,
   **When** the admin clicks Undelete, **Then** status returns to
   `active`, `archived_at` clears, and an audit event
   `member_undeleted` is written.
3. **Given** an archived member older than 90 days, **When** the
   admin opens its detail page, **Then** the Undelete button is
   disabled with a tooltip "Archived > 90 days — contact platform
   admin to restore"; the data is still readable.
4. **Given** an archived member, **Then** member.primary_contact's
   linked F1 user account session is invalidated and the member
   cannot sign in at `/portal` (403 with a tenant-agnostic "account
   inactive" message — no information leak about why).

---

### Edge Cases

- **Duplicate company**: two admins create the same company name in
  parallel. The app SHOULD warn on exact company_name match within
  the same tenant + same country (soft-dedupe), but not block.
  Creation still succeeds if admin explicitly confirms.
- **Email already used by another tenant's contact**: same email may
  belong to different companies across tenants (a consultant working
  for 3 chambers). Unique constraint is `(tenant_id, email)`, not
  global.
- **Plan year mismatch**: creating a member mid-2026 against a
  2027 plan version (if future plans exist). Allowed only if the
  plan's `effective_from` ≤ creation date; otherwise blocked with
  "Plan {id} is not yet effective — choose a {currentYear} plan".
- **Primary contact demotion race**: two admins simultaneously mark
  different contacts as primary for the same member. Last-write
  wins at the DB level via the unique partial index; the losing
  writer gets a constraint violation surfaced as a user-friendly
  "Another admin changed the primary contact — refresh and retry".
- **Contact tied to a pending F1 invitation**: if an invitation is
  unredeemed and admin removes the contact, the invitation is
  revoked (audit `invitation_revoked`). If the invitation was
  already redeemed and the user exists, deletion disables the user
  account (soft-disable) rather than hard-deleting it.
- **Member without any contacts**: never allowed post-creation; US1
  requires primary on create, US3 blocks contact removal if it
  would leave zero.
- **Turnover of 0**: allowed (pre-revenue company) but triggers a
  warning for tiers that require a turnover band.
- **Thai Alumni age edge**: contact turns 36 during plan year. The
  system does NOT auto-terminate; instead the renewal flow (F8)
  will flag ineligibility. F3 captures `date_of_birth` only for
  contacts attached to Thai Alumni members.
- **Archived member with active invoices (F4+)**: F3 does not
  directly integrate with F4 invoices, but the archive action MUST
  NOT cascade-archive invoices. F4 will decide its own stance in
  its spec.
- **Cross-tenant probe**: any attempt to read/write a member with a
  `member_id` that exists in another tenant MUST return 404 (not
  403 or 401) from every endpoint, preserving the F2 tenant-
  isolation test pattern. An audit event
  `member_cross_tenant_probe` is recorded per attempt.
- **Emergency primary contact transfer** (e.g., primary dies or
  leaves the company): handled via the existing US3 AS2 flow — add
  a new contact if needed, then click "Promote to primary" on the
  intended contact; the previous primary is auto-demoted. No
  dedicated one-click wizard in F3 (YAGNI per Principle X — the
  1-click promote already handles the common "transfer to an
  existing secondary" case). Admin help copy on the member detail
  page documents this 2-step flow (`add contact → promote`).
  Re-evaluate a dedicated wizard in F3.1 if post-release feedback
  shows pain.
- **Invitation email bounce**: if the F1 invitation email for a new
  primary or colleague contact bounces (Resend event
  `email.bounced` consumed by the outbox dispatcher), the
  invitation is marked `failed`, a warning badge appears on the
  member row in the directory, an audit event `invitation_bounced`
  is appended, and admin sees a **"Re-send invite"** action on the
  contact row. Silent bounce = data integrity bug; this edge case
  MUST be covered by integration test.

## Requirements *(mandatory)*

### Functional Requirements

**Directory + CRUD**

- **FR-001**: System MUST allow admin and manager roles to view the
  member directory filtered by plan, tier, year, status, country,
  partnership tier, and at-risk flag (placeholder until F8).
- **FR-002**: System MUST allow admin role to create a new member
  with at least one primary contact in a single transaction.
- **FR-003**: System MUST enforce that every non-archived member
  has exactly one primary contact (unique partial index).
- **FR-004**: System MUST allow admin role to edit a member's
  company info, plan assignment, and contacts; manager role is
  read-only on all member surfaces.
- **FR-005**: System MUST allow admin role to archive and undelete
  a member within a 90-day window; hard delete is NOT exposed in
  the UI.

**Plan / turnover / age rules**

- **FR-006**: System MUST validate `turnover_thb` against the
  selected plan's turnover requirement and surface a warning (not a
  hard block) if mismatched; save proceeds only with an explicit
  override captured in the audit log per FR-006a.
- **FR-006a**: Every override (FR-006, FR-007, FR-008, US3 AS7) MUST
  capture `{override_reason_code, override_reason_note}` where
  `override_reason_code` is a required enum chosen from
  (`board_approved`, `pending_renewal_grace`, `data_correction`,
  `other`) and `override_reason_note` is an optional free-text field
  (max 500 chars) that becomes required when `override_reason_code
  = other`. Both fields are persisted on the audit event payload to
  enable F9 reporting aggregation by reason code.
- **FR-007**: System MUST validate that Start-up members' company
  founded-year is ≤ 2 years before plan start date, with the same
  warning + override pattern (FR-006a).
- **FR-008**: System MUST validate that Thai Alumni members' primary
  contact age is ≤ 35 at plan start, with the same warning +
  override pattern (FR-006a).
- **FR-009**: System MUST NOT auto-change a member's plan when
  turnover or age changes mid-year; a plan change is always an
  explicit admin action.
- **FR-009a**: System MUST require `tax_id` on Members assigned to
  any Corporate tier (Premium / Large / Regular / Start-up) or any
  Partnership tier (Diamond / Platinum / Gold) at create and edit
  time, and MUST allow `tax_id` to be omitted for Individual or
  Thai Alumni tiers. For members with `country = TH`, `tax_id`
  MUST match the Thai 13-digit format including the official
  checksum; for non-Thai members the field accepts free-format
  strings up to 50 chars.
  > **Amended (accepted decision — F3 UAT):** the "MUST require" clause above
  > was relaxed to **optional-by-tier**. A §86/4 buyer-TIN is only required for
  > VAT-registrant buyers, so a Corporate/Partnership member may be saved
  > without a `tax_id`; the format + checksum rule still applies when a value
  > IS provided. The validator + create/edit paths already implement this, and
  > UAT **TC-MBR-04** is the authority. (QA re-flagged the stale "required"
  > wording as BUG-027 — see docs/uat/qa-bug-triage-2026-07-05.md.)

**Bundle-change (F2 D1 carry-over)**

- **FR-010**: System MUST show a confirmation dialog with **real
  member counts** whenever a Partnership plan's
  `includes_corporate_plan_id` is changed, backed by a live query
  against the members table.

**Contacts + portal invitation**

- **FR-011**: System MUST allow admin role to add, edit, remove, and
  promote/demote contacts within a member; primary/secondary is a
  single flag.
- **FR-012**: System MUST issue a member-scoped F1 portal invitation
  when admin clicks "Invite to portal" on a contact.
- **FR-012a**: When a contact's email is edited and that contact is
  linked to an F1 user account, the system MUST atomically (single
  transaction) (i) update the contact email, (ii) update the linked
  F1 user's email, (iii) revoke every active session for that user,
  (iv) disable sign-in via the old email immediately, (v) enqueue
  via the outbox a verification email with a 24-hour single-use
  token to the NEW address (token valid only after a 5-minute
  delay from commit), and (vi) enqueue via the outbox a
  dual-channel notification email to the OLD address carrying a
  48-hour single-use "this wasn't me — revert + freeze account"
  token. Sign-in with the new email MUST be blocked until the
  verification token is consumed. Failure of any sub-step before
  commit rolls back the entire transaction; email send failures
  AFTER commit are handled by the outbox retry + permanent-failure
  recovery flow (see FR-012c).
- **FR-012b**: Clicking the OLD-address revert token within its
  48-hour window MUST roll back the email change atomically
  (restore old email on contact + linked F1 user, invalidate the
  new-email verification token, flag the linked F1 user as
  `requires_password_reset`) and emit the high-severity audit
  event `member_email_change_reverted`. Subsequent sign-in by the
  old-email user requires completing a password reset.
- **FR-012c**: When the outbox dispatcher exhausts its retry budget
  (≥ 5 attempts with exponential backoff 60s / 5m / 30m / 3h / 12h)
  for any F3-generated notification, the outbox row is marked
  `permanently_failed`, a high-severity audit event
  `email_dispatch_failed` is emitted, a maintainer alert fires,
  and a **"Re-send verification email"** admin action becomes
  available on the member detail page that creates a fresh token
  + new outbox row.

**Self-service**

- **FR-013**: System MUST allow `member`-role users to read their
  own company profile, plan, contacts, and renewal history at
  `/portal`.
- **FR-014**: System MUST allow `member`-role users to edit only
  the whitelisted fields (primary contact info, phone, company
  website, description, preferred language); attempts to edit
  restricted fields via forged payloads MUST be rejected with 403
  and audit-logged.
- **FR-014a**: The whitelist of member-self-editable fields MUST be
  declared as a **compile-time constant tuple** (`PORTAL_SELF_UPDATE_FIELDS`)
  in the Domain layer; the zod schema used by the self-service
  PATCH endpoint MUST be generated from this tuple so that adding
  or removing a field requires a single source-code change and is
  enforced by TypeScript. A unit test MUST assert that the zod
  schema's key set equals the tuple.
- **FR-015**: System MUST allow a signed-in member to invite a
  colleague as a secondary contact scoped to their own member.

**Search**

- **FR-016**: System MUST provide substring search across company
  name, primary contact name, and primary contact email; search
  MUST be case-insensitive and MUST return results within 500 ms
  perceived latency on directories of up to 5,000 members.
- **FR-017**: System MUST integrate member lookup into the global
  command palette (Cmd/Ctrl+K) with a dedicated "Members" section.

**Inline + bulk (F2 US7 carry-over)**

- **FR-018**: System MUST allow admin role to inline-edit low-risk
  fields (status toggle, country, notes) on the directory grid with
  optimistic update + server-rollback on error.
- **FR-019**: System MUST allow admin role to multi-select rows and
  apply bulk actions: change plan, archive, send portal invite;
  bulk actions MUST be transactionally all-or-nothing.
- **FR-019a**: System MUST cap a single bulk action at **100 rows
  per batch**. Attempting to confirm a bulk action with > 100
  selected rows MUST be blocked at the UI with a message
  instructing the admin to split the operation; the server-side
  endpoint MUST also reject batches > 100 with a 400-class error
  for defence-in-depth.
- **FR-019b**: System MUST apply a per-actor rate limit on the bulk
  action endpoint — **≤ 10 bulk operations per 10-minute window per
  admin user** — enforced via an Upstash Redis token bucket
  (reusing F1's rate-limit adapter). Exceeding the limit returns
  `429 rate_limited` and emits a high-severity audit event
  `bulk_action_rate_limit_exceeded` so compromised-admin blast
  radius is capped. Limits are per `(tenant_id, actor_user_id)`.

**Timeline**

- **FR-020**: System MUST expose a per-member timeline view filtered
  from the append-only audit log, paginated in batches of 50, newest-
  first.

**Tenant isolation (Principle I)**

- **FR-021**: System MUST enforce two-layer tenant isolation
  (application + Postgres RLS) on every member- and contact-scoped
  query. A cross-tenant integration test MUST prove that tenant A
  cannot read or write tenant B's members/contacts.
- **FR-022**: Any attempt to access a member belonging to another
  tenant MUST return 404 and MUST audit-log as
  `member_cross_tenant_probe` with `{attempted_member_id,
  actor_user_id, actor_tenant_id}`.

**Audit (Principle VIII)**

- **FR-023**: System MUST append an audit event for every member or
  contact mutation using at least these new event types:
  `member_created`, `member_updated`, `member_plan_changed`,
  `member_primary_contact_changed`, `member_status_changed`,
  `member_archived`, `member_undeleted`, `contact_created`,
  `contact_updated`, `contact_removed`, `member_self_updated`,
  `member_self_update_forbidden`, `member_cross_tenant_probe`,
  `plan_bundle_changed` (extends F2 rename),
  `member_contact_email_changed` (high severity),
  `user_sessions_revoked`,
  `email_verification_sent`,
  `email_change_notification_sent_to_old_address`,
  `member_email_change_reverted` (high severity),
  `email_verification_resent`,
  `email_dispatch_failed` (high severity),
  `invitation_bounced`,
  `bulk_action_rate_limit_exceeded` (high severity).
- **FR-023a**: The admin-only `notes` field on Member MUST NOT be
  covered by the directory search index (FR-016 pg_trgm GIN) and
  MUST NOT appear in the future GDPR self-service export (F9); this
  carve-out is declared here so F9 inherits it without discovery
  cost.

**Data lifecycle, GDPR, and privacy**

- **FR-027**: Archived members (soft-deleted via FR-005) MUST be
  retained for the full audit-log retention window (≥ 5 years per
  Principle VIII); beyond this window, a **hard-delete + audit
  redaction pipeline** is required — implementation deferred to
  **F9 GDPR self-service export + erasure**. F3 does NOT expose
  permanent deletion.
- **FR-028**: GDPR **right-to-erasure** requests targeting a member
  or contact MUST be satisfiable via the F9 GDPR export +
  erasure pipeline; F3 MUST NOT expose an erasure surface of its
  own. Admins receiving an erasure request in the F3 window route
  it to platform-admin tooling (F13).
- **FR-029**: F1's single-use token retention policy (reset tokens
  expired or redeemed are purged after 30 days) is inherited by
  F3's new token types (`email_verification`, `email_revert`) —
  same retention, same purge job.

**Admin convenience & data integrity UX**

- **FR-030**: Copy-to-clipboard affordances MUST be provided on
  the member detail view for `member_id`, primary contact `email`,
  and `tax_id` — one-click copy with a confirming toast.
- **FR-031**: On member create, if an exact `company_name` +
  `country` duplicate exists within the same tenant, the system
  MUST surface a **soft-dedupe warning dialog** showing the
  existing member's company name, plan, and status, with two
  actions: **"Proceed anyway"** (creates a distinct record) and
  **"Cancel — open existing instead"**. Creation is not blocked.
- **FR-032**: When a contact email collides with an existing
  contact email **in another tenant** (cross-tenant; same email
  consulting for multiple chambers), the system proceeds silently —
  **no warning is surfaced** because cross-tenant data leakage
  would violate Principle I. Per-tenant uniqueness is the only
  enforced constraint.

**Accessibility, UX, and Localization — inheritance and specifics**

- **FR-033**: F3 inherits every default from
  **`docs/ux-standards.md` § 15 enterprise checklist** unchanged —
  shimmer skeletons, sonner toasts, confirmation dialogs, idle
  warning, theming, focus management, keyboard navigation. Any
  deviation from a § 15 default requires an entry in plan
  § Complexity Tracking.
- **FR-034**: Empty-state requirements MUST distinguish three
  directory states: (a) **zero members** (onboarding CTA: "Add
  your first member" + illustration); (b) **filter yields zero**
  (clear-filters CTA + "No members match these filters" copy);
  (c) **server error** (retry button + localized error message).
  US7 "Show archived" is implemented as a third option on the
  status filter Select dropdown (`Active` / `Inactive` / `Archived`)
  rather than a standalone toggle — the dropdown is functionally
  equivalent (admin opts into the archived view explicitly) and
  avoids a redundant UI control. Default filter remains
  `[active, inactive]`; selecting `Archived` shows archived rows
  exclusively.
- **FR-035**: Required form fields MUST be indicated programmatically
  (`aria-required="true"`) **AND** visually (asterisk after label)
  **AND** enumerated once at form top ("* fields are required").
- **FR-036**: Autocomplete attributes MUST be set on common contact
  fields per HTML spec: `given-name`, `family-name`, `email`,
  `tel`, `organization` — improves screen-reader UX and browser
  autofill on mobile.
- **FR-037**: Every F3 page MUST set a unique `<title>` via Next.js
  metadata API (e.g., "Members · /admin", "Edit — Fogmaker AB ·
  /admin", "Timeline — Fogmaker AB · /admin") for browser tab,
  history, and screen-reader context.
- **FR-038**: The page `<html lang>` attribute MUST reflect the
  active locale (`en`, `th`, `sv`) via next-intl integration —
  inherited pattern from F1.
- **FR-039**: Manual screen-reader testing (NVDA or VoiceOver) on
  at least one admin surface + `/portal` landing MUST be performed
  on every release branch; results attached to the merge-gate
  security checklist.

**Bulk action and inline-edit UX specifics**

- **FR-040**: Bulk-action toolbar MUST appear as a sticky bar at
  the bottom of the directory when ≥ 1 row is selected, with
  **"N members selected"** counter + **"Clear selection"** +
  enabled bulk actions. Multi-row selection keyboard shortcuts:
  Shift+Click range; Ctrl/Cmd+Click additive; Space toggle; Ctrl+A
  select all on current page; explicit "Select all N matching"
  affordance to cover >1 page.
- **FR-041**: When a bulk action affecting 50-100 rows exceeds a
  perceived-latency threshold of 1 second, the UI MUST show a
  **determinate progress indicator** (N of 100 complete) driven
  by Server-Sent-Events or short-polling; below 1 s an optimistic
  update + final toast is sufficient.
- **FR-042**: Fields disallowed to the current role MUST be
  **hidden entirely** (not shown disabled) on member self-service
  forms to prevent "why can't I edit this?" confusion; hidden
  fields remain server-enforced via FR-014a.

**Discoverability and reduced-motion specifics**

- **FR-043**: Command palette result ordering MUST be:
  (a) exact-match by `company_name` or `contact_email`; then
  (b) prefix-match; then (c) substring; within each tier,
  newest-first by `last_activity_at`. Deterministic ordering is
  a correctness requirement (tests depend on it).
- **FR-044**: All motion / animation requirements honour
  `prefers-reduced-motion` — shimmer skeleton falls back to a
  static pulse; timeline reveal to instant; palette open/close
  to no-op; toast slide-in to instant appearance. Test spec
  listed in plan § Testing.

**Scope-deferred items (explicit roadmap — NOT F3 scope)**

- **ADOPT-01 (WCAG 2.2 opportunistic adoption in F3)**: F3 target
  remains WCAG 2.1 AA per Constitution v1.4.0, but F3 implementation
  MUST satisfy these 2.2 AA criteria opportunistically because
  retrofit cost is higher than new-build cost:
  - **2.4.11 Focus Not Obscured (Minimum)** — the FR-040 sticky
    bulk-action toolbar MUST include `scroll-margin-bottom` +
    appropriate `padding-bottom` on the scroll container so focus
    indicators are never hidden behind it. Verified by a keyboard-
    only E2E spec + visual regression.
  - **2.5.8 Target Size (Minimum)** — every interactive element
    (inline-edit cells, icon buttons, multi-select checkbox,
    palette result rows, close buttons, archive/undelete row
    actions) MUST be ≥ 24×24 CSS px. Enforced via axe-core rule
    `target-size` + a Playwright assertion that verifies measured
    computed style on a representative sample of elements.

  The remaining 2.2 AA criteria are satisfied by F3 design choices
  already and MUST be flagged "compliant-by-design" in the a11y
  checklist:
  - 2.5.7 Dragging Movements — F3 has no drag operations (multi-
    select is click-based per FR-040).
  - 3.2.6 Consistent Help — F3 introduces no help-system surface,
    so consistency cannot be violated; admin help copy
    (emergency primary-contact transfer, per spec Edge Cases) is
    inline-static, not a reusable help mechanism.
  - 3.3.7 Redundant Entry — multi-step forms preserve values via
    react-hook-form (no re-entry of already-provided data).
  - 3.3.8 Accessible Authentication (Minimum) — F1's email +
    password flow requires no cognitive puzzle / CAPTCHA /
    memory test; inherited unchanged by F3.
- **DEFER-01**: Formal Constitution upgrade to WCAG 2.2 AA target
  (retroactive F1+F2 audit + Constitution MINOR amendment PR).
  Scope: F3.x polish branch + Constitution v1.5.0 amendment. ADOPT-01
  delivers the high-value 2.2 criteria for F3's new surfaces without
  requiring the full governance upgrade; the formal target change
  happens when F1+F2 surfaces also get 2.2-audited.
- **DEFER-02**: RTL-friendliness (Arabic / Hebrew locale support).
  Scope: F12 White-label Branding — when a tenant with an RTL
  locale onboards.
- **DEFER-03**: VPAT / EN 301 549 conformance documentation. Scope:
  F10 Tenant Onboarding when public SaaS signup opens to EU public-
  sector customers.
- **DEFER-04**: CAPTCHA / bot-detection on the public revert-token
  endpoint #16. Current mitigation: single-use token + 5-attempt
  rate limit per token / 10 min. Revisit if real-world evidence
  of token-scanning botnets appears.
- **DEFER-05**: `app.current_tenant` postgres-setting key rotation
  procedure. Scope: F13 Super-Admin Console with platform-level
  credential rotation tooling.

**Accessibility, i18n, UX**

- **FR-024**: All F3 surfaces MUST meet WCAG 2.1 AA, support full
  keyboard navigation, and pass axe-core against the listed pages
  (`/admin/members`, `/admin/members/new`, `/admin/members/:id`,
  `/admin/members/:id/edit`, `/admin/members/:id/timeline`,
  `/portal`, `/portal/contacts/invite`).
- **FR-025**: All F3 surfaces MUST ship with EN + TH + SV i18n for
  every user-visible string; missing EN key fails the build,
  missing TH/SV fails release-branch CI.
- **FR-026**: All destructive actions (archive, bulk archive,
  contact remove) MUST follow UX-standards § 4.1 confirmation
  patterns (AlertDialog with explicit action label, Esc/Cancel
  always cancels).

### Key Entities

- **Member**: a company (legal entity) enrolled on one membership
  plan for one year at a time. Attributes include `tenant_id`,
  `member_id`, `company_name`, `legal_entity_type` (free text, max
  100 chars; e.g., "บริษัทจำกัด", "AB", "Ltd"), `country` (ISO
  3166-1 alpha-2 code, e.g., `TH`, `SE`, `US`), `tax_id` (required
  for Corporate + Partnership tiers, optional for Individual + Thai
  Alumni; Thai-country members must match the 13-digit format),
  `tax_id` (optional), `website`, `description`, `founded_year`,
  `turnover_thb`, `turnover_bracket` (derived), `plan_id`,
  `plan_year`, `registration_date`, `registration_fee_paid` (bool),
  `status` (`active`|`inactive`|`archived`), `archived_at`
  (nullable), `last_activity_at` (denormalized timestamp updated
  by the audit-log insert path — eliminates the need for a
  per-request audit-log join on the directory list endpoint),
  `created_at`, `updated_at`. Relationship: N contacts, 1 plan.
  **Note**: the previously-reserved `member_risk_flag` column is
  **deferred to F8** (at-risk scoring) — F3's directory renders a
  neutral placeholder in the at-risk column by reading a constant
  `null` until F8's migration adds the real column. Removed from
  F3 migration `0008` per critique P5/X3 (YAGNI under Principle X).
- **Contact**: a human attached to a member. Attributes include
  `tenant_id`, `contact_id`, `member_id`, `first_name`, `last_name`,
  `email` (unique per tenant), `phone`, `role_title`,
  `preferred_language` (`en`|`th`|`sv`), `is_primary` (bool),
  `date_of_birth` (only required for Thai Alumni eligibility),
  `linked_user_id` (nullable — set when invitation redeemed),
  `created_at`, `updated_at`. Relationship: 1 member, optional
  1 user account.
- **Plan Assignment History** (derived from audit, not a separate
  table): chronological record of `member_plan_changed` events
  reconstructed from the audit log for US6 timeline and F8 renewal
  analytics.
- **At-Risk Placeholder**: no column is reserved in F3. The
  directory at-risk column renders a constant neutral placeholder
  until F8 ships its own migration adding the column + scoring
  engine. Deferring avoids shipping dead columns (Principle X).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can create a new member with one primary
  contact in ≤ 90 seconds from opening the staff portal, on a
  standard business laptop on chamber office wifi.
- **SC-002**: The directory search returns results for any substring
  query in ≤ 500 ms perceived latency (p95) on a dataset of 5,000
  members.
- **SC-003**: 100% of the 131 existing SweCham members from the
  legacy Excel workbook can be re-entered or imported (via the
  optional one-off migration script) without schema changes.
- **SC-004**: Bulk-change-plan on 100 members (the FR-019a cap)
  completes in ≤ 5 seconds server-time, with audit events written
  for every affected member and zero partial-state failures in
  regression.
- **SC-005**: The cross-tenant isolation integration test
  (Principle I sub-clause 3, Review-Gate blocker) passes 10/10
  runs on live Neon Singapore, proving tenant A cannot read or
  write tenant B's members.
- **SC-006**: On the `/admin/members` page, p95 time-to-first-
  interaction (from palette keystroke or URL load to the first
  member row becoming clickable) is ≤ 2 seconds on the 131-member
  SweCham dataset and ≤ 3 seconds projected on a 5,000-member
  tenant (replaces the earlier unscopable post-release admin
  survey).
- **SC-007**: Member self-service portal edits complete in ≤ 3
  clicks from `/portal` landing for the 5 whitelisted fields;
  forbidden edits are rejected with a clear 403 message in every
  locale.
- **SC-008**: The F2 D1 bundle-change warning dialog shows the
  correct real member count within 200 ms of Save click for plans
  with up to 500 members assigned.
- **SC-009**: 100% of destructive actions (archive, bulk archive,
  contact remove) require an explicit confirmation and are
  reversible within 90 days via Undelete (for archive) or contact-
  restore during the same session.
- **SC-010**: On the pre-merge CI run for F3, the full F1 test suite
  (480 auth + RBAC tests) and the full F2 test suite (495 unit +
  contract + 163 integration + F2 E2E + a11y + i18n specs) all
  pass unchanged, demonstrating that F3 introduces no regressions
  in shipped modules.

## Assumptions

- F1 auth + RBAC (`admin`, `manager`, `member` roles) is available
  and provides session management, CSRF, and the invitation flow.
- F2 membership plans (`membership_plans` table with turnover
  requirements, age/duration caps, and `includes_corporate_plan_id`
  for Partnership) is available and exposes a public API/port for
  reading plan metadata.
- Postgres RLS and `runInTenant(ctx, fn)` pattern from F2 are in
  place; F3 reuses the same tenant-context infrastructure.
- Members are strictly **company-level** entities for SweCham's
  data; the data model supports `Individual` and `Thai Alumni` tiers
  where the "member" is effectively a single person but the record
  shape remains the same (company_name = person's display name for
  those tiers). No separate "individual member" entity is
  introduced.
- Bulk CSV import is **out of scope** (R6 decision, Phase 5 smart
  #13). A one-off migration script for the 131 existing members
  lives outside the product feature.
- The at-risk scoring logic is **out of scope** (F8). F3 only
  reserves the UI column and the nullable `member_risk_flag`
  column.
- Benefit-usage dashboard is **out of scope** (F9). The F3 timeline
  shows audit events only; benefit quota consumption comes later.
- Invoice history and payments are **out of scope** (F4/F5). F3
  shows a stubbed "Renewal history" section that renders audit-
  derived plan changes until F4 plugs in real invoices.
- Reasonable default — **one primary contact per member, ever**;
  multi-admin-contact model (two portal admins per member) is
  deferred.
- Reasonable default — **turnover changes never auto-change plan**;
  plan changes are always explicit admin actions with an optional
  override reason.
- Reasonable default — **email uniqueness is per-tenant, not
  global**; a consultant can hold portal access across multiple
  tenants under the same email.
- Reasonable default — **90-day undelete window**; beyond that,
  a platform-admin (F13) action is required.
- PDPA + GDPR apply jointly; the stricter rule governs every
  contact field, especially `date_of_birth` which is collected only
  for Thai Alumni eligibility and redacted in non-essential views.
