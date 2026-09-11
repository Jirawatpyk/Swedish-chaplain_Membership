# Feature Specification: Member Portal — Approval Workflow for Member Changes

**Feature Branch**: `114-member-change-approval`
**Created**: 2026-09-11
**Status**: Tasked
**History**: specified + clarified 2026-09-11 · `spec-review-panel` 2026-09-11: GO WITH AMENDMENTS, amendments applied (`reviews/spec-review-panel-20260911.md`) · planned 2026-09-11 · checklist-gate gaps closed 2026-09-11 (FR-038–FR-040 added) · tasked 2026-09-11 (118 tasks; `/speckit.superb.review` added T115–T118)
**Input**: User description: "Member Portal – Approval Workflow for Member Changes. When a member edits their own info in the Member Portal, the change must NOT save immediately. Member submits a change → system sends email notification (who changed what). SweCham reviews the request in CRM → can Approve or Reject (with a reason if rejected). If Approved → Member Portal and CRM both update immediately with the new info (must stay in sync). If Rejected → change does not apply, member is notified with the reason. Also required: a history log of all changes — who changed what, when, and SweCham's approve/reject decision. This log should also be visible to SweCham so they can check it themselves."

## Overview *(context, non-normative)*

Today a member who edits their own details in the Member Portal (`/portal/edit`) has the change **applied the moment they press Save**. SweCham staff learn about it only if they happen to open the member's record or the audit log. SweCham has asked for the opposite: every member-initiated change to the member record is **held as a request**, staff are **told by email who changed what**, staff **approve or reject it** (a reason is mandatory on rejection), and only an approved change is written to the record — after which the Member Portal and the staff portal show the same new values because they read the same record. A **history log** of every request and every decision must exist and be visible to staff.

Because staff now verify before anything is applied, this feature also **widens what a member may propose**. Data a member can touch in the portal falls into three groups (decided in § Clarifications):

- **Group A — the person's own settings** (the contact's own preferred language for emails and notifications, alongside the member-level display-language setting already on the account page; and the existing email-change, colleague-invite, marketing opt-out and renewal-reminder flows). These keep working exactly as today and take effect immediately.
- **Group B — the member record** (contact name, phone, job title; company name, website, description, registered address, billing address). Every change here becomes a **change request** that staff decide **field by field**.
- **Group C — legal identity, tier and money** (tax ID, legal entity type, head office / branch, VAT registration, country, founded year, turnover, registered capital, plan, status, member number, dates, internal notes). Staff-only, as today; a member who needs one of these changed contacts the chamber.

In this document, **"CRM"** means the Chamber-OS staff portal (`/admin`), which is SweCham's system of record for members. There is no external CRM in scope (see § Assumptions).

## Clarifications

### Session 2026-09-11 (`/speckit.specify` — discussion with maintainer)

- Q1: Which member-initiated changes go through approval? → A: **Everything in Group B, nothing in Group A.** Group A is the person's own preference or a flow with its own safeguard (email change has verify + revert; marketing opt-out is a legal right under GDPR Art. 21 / PDPA and cannot be made subject to approval). The gate covers the *member record*, whatever its field set is.
- Q2: Does the feature widen the set of fields a member may propose? → A: **Yes — Group B as listed in § Overview.** Added relative to today's self-service set: contact job title; company name; registered address; billing address (as one unit, including its country line). Decided **staff-only this round**: the tax block (tax ID, legal entity type, head office / branch code, VAT-registered), the member's country, turnover and registered capital — and, by the 2026-09-11 panel amendment (U1), founded year. Rationale recorded: the tax block is the *identity of the legal person* (a different tax ID is a different entity, handled by staff against DBD documents); country binds VAT and currency; turnover, capital and founded year drive tier eligibility (founded year is the Start-up tier's two-year age test), i.e. money. Opening any of them is a follow-up feature with its own tax review.
  - Sub-decision: phone → **gated** (maintainer accepted the recommendation; low risk either way, but SweCham asked for every record change to be reviewed).
  - Sub-decision: tax block → **staff-only**. Country → **staff-only**. The billing address's own country line travels with the billing-address group (a billing address is one unit; see § Assumptions).
- Q3: Is a decision made per request or per field? → A: **Per field, with every field pre-selected as approved.** The reviewer de-selects the fields they refuse; one reason covers the refused set; a single action records the whole decision. The common case (everything fine) stays one click; a member who got one field wrong is not forced to resubmit the fields that were fine. Address groups are decided as one row. "Approve with edits" (reviewer alters the proposed value) is out of scope — staff may edit the record directly after approving, which is attributed correctly today.

### Session 2026-09-11 (`/speckit.clarify`)

- Q: Who may approve or reject a member's change request — the existing "edit members" right (`members.write`) or a new dedicated right? → A: **The existing `members.write` right** (option A). Reviewers are therefore the tenant's admin and super_admin users today (manager and marketing hold read-only member rights and are neither reviewers nor notified); no permission-catalogue change. A dedicated "review member change requests" right (108 `contacts.marketing` precedent) is a one-hop follow-up if a tenant ever needs approve-without-edit.
- Q: Who in a member company may propose company-level fields (company name, website, description, registered address, billing address) — only the primary contact, or any contact with a portal login? → A: **Only the primary contact** (option A); every contact with a portal login may propose changes to **their own** contact fields (name, phone, job title). Follows the 108 model (the primary is accountable for the company record, receives the invoices, and is already the only one who may invite colleagues); a person keeps the right to rectify their own data (GDPR Art. 16). Consequences encoded: a secondary's edit form shows only their own fields with a "contact your primary contact" note for company fields; requests from different contacts never overlap in fields, so the uniqueness rule is **one pending request per submitting person** (not per member); decision emails go to the submitting person only.
- Q: When a member resubmits repeatedly (typo fixes), should submissions be rate-limited and/or staff emails coalesced, or does every resubmission email every reviewer? → A: **Both limits** (option A): at most **10 submissions per person per 24 hours** (beyond that the member is told to wait and the refusal is audited, as bulk-action rate limiting is today), and **no new staff email when the same person resubmits within 1 hour** of their last staff notification — the review link in every staff email opens *that person's current pending request*, never a specific superseded request, so an earlier email always lands on the latest values.

### Session 2026-09-11 (`spec-review-panel` — GO WITH AMENDMENTS, applied)

Full report: `reviews/spec-review-panel-20260911.md` (35 agents · 9 lenses · 1 confirmed · 11 refuted · ~110 unverified, carried to plan).

- Confirmed #12 (premise): the FR-013 self-review clause guarded an unreachable state — F1 § Q2 gives a staff person who is also a member a *separate* member account, `role-portal-mismatch` refuses a role crossing, and staff sessions are redirected off `/portal/**`. → Clause deleted; the boundary is recorded in § Edge Cases and § Out of Scope.
- Hygiene from the refuted findings: FR-011 / § Assumptions note that "of the tenant" is vacuous under single-tenant deployment until F10's `user_tenants`; FR-031 states the new-tenant default (off) and the flag → setting order; FR-037's alert threshold is bound to the one-month data-subject-request clock (GDPR Art. 12(3) / PDPA § 30); SC-002 is qualified for the coalescing case; the "malformed postal code" example is dropped (no such rule exists on any path).
- Unverified items the maintainer chose to verify and apply (option B): (U1) founded year moved to Group C — `startup-duration-policy.ts` makes it a Start-up tier eligibility input, the same ground that keeps turnover staff-only; (U2) Group A names the column — the contact's own `preferred_language` (email / notification language), distinct from the member-level `preferred_locale` display setting already on `/portal/account`; (U3) FR-001 closes the existing immediate-write path for Group B fields while the setting is on; (U4) FR-029 / FR-030 scope a person's portal history to their own requests plus company-level requests; (U5) FR-019 / FR-022 flag the registered address as tax-affecting when no billing address is set (it is then the § 86/4 buyer address); (U6) notification wording is at-least-once ("one notification queued") and the 10-per-24 h cap is counted from the durable request history, not a best-effort limiter; (U7) FR-007 defines the "nothing to submit" baseline (the current record; identical to the pending request → "already awaiting review") and US5's scenarios are renumbered; (U8) FR-026 states that seeing the queue / history / count needs `members.read` while deciding needs `members.write`.
- Carried to `/speckit-plan` as questions, not findings (report § "Unverified"): PII copies outside the request table (outbox `context_data`, audit payloads, the `member_id` trigger key on `last_activity_at`); tax-document edges (a draft invoice issued after approval; proposed legal name vs frozen tax ID); rate-limit / idempotency mechanics and the one-pending-per-person constraint; reuse costs (outbox enum, audit enum × 5 places, immutability-trigger exemption for the erasure scrub, settings update path); dashboard snapshot timing and nav-badge placement; loading / empty / error / permission states per surface; DPIA / RoPA update.

### Session 2026-09-11 (`/speckit.checklist` gap closure — AMENDMENT)

The six domain checklists (`checklists/{security,privacy,ux,reliability,operations,tax}.md`) surfaced requirement-text gaps; each is closed below with a default consistent with the decisions already recorded (no new product question was opened). Where the checklist item is plan-level, the closure lives in `plan.md` / `contracts/` and the item says so.

- **Who may withdraw** (security CHK005): only the submitting person, after a standard confirmation; never another contact, never staff (they reject). → FR-009.
- **Transport + idempotency** (security CHK016/017): route handlers under the platform guards, never Server Actions; submit honours `Idempotency-Key`. → FR-038.
- **Staff reads not audited** (security CHK023): consistent with member-record reads today, which emit no read event (measured: no `*_viewed` / `*_read` audit type exists); exports stay audited by the existing export path. → FR-026.
- **Reviewer account later disabled** (security CHK027, privacy CHK014): staff accounts are `active | disabled`, never deleted; the decision keeps the user id and recorded name, shown with a "deactivated" marker. → FR-026.
- **Platform flag OFF with data present** (security CHK028, operations CHK016): routes 404, no portal/nav/dashboard state, immediate path widened back, rows retained and decidable when the flag returns; migration + enum values + setting column are unflagged. → FR-039, § Assumptions "Rollout".
- **Lawful basis + transparency notice** (privacy CHK001/003): contract + legitimate interest; submission form carries an Art. 13 / PDPA § 23 notice; RoPA updated before the tenant switch. → FR-040, FR-010.
- **Reason/note as personal data** (privacy CHK009): shown to `members.read` staff and the submitting person only; scrubbed on erasure; exported with the person's data. → FR-014.
- **Restriction of a single rejected value** (privacy CHK013): handled through the DSR process + member-wide erasure tooling; per-request early scrub is out of scope. → FR-030, § Out of Scope.
- **Submitting contact removed while pending** (privacy CHK023, reliability CHK009): request stays; contact-field rows become undecidable ("contact removed", reject-only); company rows decidable; decision email skipped as recipient-gone. → FR-020, § Edge Cases.
- **Erasure is member-wide** (privacy CHK024): every request of the member is scrubbed together. → FR-030.
- **Races** (reliability CHK007/008): first committed transition wins for withdraw-vs-decide and replace-vs-decide; replacement only withdraws a request still pending at that instant. → FR-008, FR-017.
- **Proposed equals current at decision** (reliability CHK010): approve = no-op write, still recorded as approved; review page shows "already current". → FR-015, § Edge Cases.
- **States, persistence, keyboard, withdraw confirm** (ux CHK002/004/005/007/015): loading/empty/error/permission states per surface; last decision stays on the profile until dismissed (recorded per person) or replaced; resubmission may edit any Group B field; withdraw confirms; keyboard order and live regions specified. → FR-034, FR-010, FR-023, FR-009.
- **Reviewer fan-out bound** (operations CHK005): one notification per reviewer; > 20 reviewers per tenant out of scope this version (SweCham ≤ 5). → § Assumptions, § Out of Scope.
- **Tax touchpoints** (tax CHK002/003/004/006): the buyer block on tax documents (`legal_name`, `address`, `primary_contact_name`, branch fields) is built from the member record **at issue time** — so the **primary contact's name** is tax-affecting too, drafts created before an approval carry the values current at issue, a billing-address change never moves the staff-only branch designation, and a non-Thai billing country is flagged for staff to judge VAT treatment. → FR-019, FR-022, § Edge Cases.
- **Plan-level closures** (operations CHK011 spans, CHK016 rollback matrix, privacy CHK019 RoPA task): `contracts/notifications-and-audit.md` § 4, `quickstart.md` § 3, `plan.md` § Technical Context.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Member submits a change; nothing is applied; staff are notified (Priority: P1)

A signed-in member opens "Edit company details" in the Member Portal, changes one or more Group B fields, and presses Submit. Instead of the record changing, a **change request** is created that holds the proposed values next to the current values. The member sees a clear "Pending review" state showing exactly what they proposed. Within minutes, SweCham staff receive an email naming the member, the person who submitted, and each field with its current and proposed value, with a link to review it.

**Why this priority**: This is the core requirement — "the change must NOT save immediately" and "system sends email notification (who changed what)". Without it nothing else in the feature has meaning.

**Independent Test**: A member changes their phone number and their company's billing address and submits. The member record is unchanged in the staff portal; the member's portal shows a pending banner with both proposed values; a staff inbox receives one email listing the member, the submitter, both fields with old → new values, and a review link.

**Acceptance Scenarios**:

1. **Given** a member whose tenant requires approval, **When** they submit a change to any Group B field, **Then** the member record is not modified, a change request in state *pending* is created holding the proposed values, and the member is shown the pending state with the proposed values.
2. **Given** a change request was just created, **When** the notification is dispatched, **Then** every staff user entitled to review receives one email that states the member (company name + member number), the submitting person, the submission time, and each changed field with current and proposed value, and links to the review page — and nobody outside staff receives it.
3. **Given** a member submits a form in which no field differs from the current record, **When** they press Submit, **Then** no request is created and the member is told there is nothing to submit; **and Given** the proposed set is identical to that person's existing pending request, **Then** nothing is created or replaced and the member is told the change is already awaiting review.
4. **Given** a member submits a change, **When** any proposed value fails the validation that applies to a staff edit of the same field (for example an invalid phone number, an unsafe website address, an over-long company name or description), **Then** the request is refused with the field-level error and nothing is stored.
5. **Given** a member tries to include a Group C field or any other field outside Group B (a forged submission), **When** it is received, **Then** it is refused, no request is created, and the attempt is recorded exactly as forged self-service edits are recorded today.
6. **Given** a contact changes their own preferred language for emails and notifications (Group A, on the account page next to the display-language setting), **When** they save, **Then** it takes effect immediately with no request, exactly as today.
7. **Given** the tenant is in emergency read-only mode, **When** a member submits, **Then** they receive the standard read-only refusal and no request is created.
8. **Given** a contact who is not the primary contact, **When** they open the edit form, **Then** they see only their own contact fields (name, phone, job title) with a note to contact the primary contact for company details; **and When** such a contact submits a company-level field anyway (a forged submission), **Then** it is refused and recorded as in AS5.

---

### User Story 2 - Staff approve — in full or in part; approved fields apply everywhere at once; member is told (Priority: P1)

A staff reviewer opens the request from the email link or from the review queue and sees each proposed field as a row: current value, proposed value, and a selection that is **already set to "approve"** for every row. If everything is fine they confirm once. If one field is wrong they de-select that row, type a reason, and confirm — the other fields still go live. Approved values are written to the member record in one step. From that moment the Member Portal and the staff portal both show the new values; the request records the reviewer, the time and each field's outcome; the member receives one email saying which changes were applied and, if any, which were not and why.

**Why this priority**: The approve path is how a legitimate change reaches the record; "both update immediately and stay in sync" is an explicit requirement, and the per-field decision is what makes the workflow tolerable for both sides.

**Independent Test**: With a pending request holding a new phone number and a new company description, a reviewer de-selects the description, enters a reason, and confirms; reloading the staff member detail page and the member's portal profile both show the new phone number and the old description; the request shows *partially approved* with the reviewer, time, per-field outcome and reason; the member's inbox has one email listing the applied field and the refused field with the reason.

**Acceptance Scenarios**:

1. **Given** a pending request with every row left selected, **When** the reviewer confirms, **Then** all proposed values are applied to the member record together (never some of them), the request becomes *approved* with reviewer and time recorded, and the member is notified by email listing the applied changes.
2. **Given** a pending request with some rows de-selected, **When** the reviewer confirms with a reason, **Then** exactly the selected fields are applied together, the de-selected fields are not applied, the request becomes *partially approved* with each field's outcome and the reason recorded, and the member receives one email listing both sets.
3. **Given** a request was approved in full or in part, **When** the member opens their portal profile and a staff user opens the member's record, **Then** both show the same values with no further action from anyone.
4. **Given** a request was approved, **When** the member record's history is inspected, **Then** the applied change is attributed truthfully: proposed by the member (submitting person), applied on approval by the named reviewer — no entry claims a role its actor did not hold.
5. **Given** a field in a pending request was changed by staff directly after the member submitted (for example staff corrected the phone number themselves), **When** the reviewer opens the request, **Then** that row is visibly flagged as "changed since submitted" with the value the member saw, the value it holds now, and the proposed value, so the reviewer decides with full information; approval still applies the proposed value.
6. **Given** a request proposes a new company name or billing address — or a new registered address for a member that has no billing address on record (the registered address is then the buyer address printed on tax documents), **When** the reviewer opens it, **Then** those rows carry a visible "affects tax documents" flag, and approving them changes only documents issued afterwards — every already-issued invoice, receipt and credit note keeps the buyer details it was issued with.
7. **Given** two reviewers act on the same request at the same time, **When** both confirm a decision, **Then** exactly one decision is recorded; the second reviewer is told the request was already decided, by whom, and how.
8. **Given** a reviewer confirms the same decision twice (a double click or a retried request), **When** the second confirmation arrives, **Then** it is harmless: nothing is applied twice and no second decision or second queued notification is produced.
9. **Given** applying the approved fields fails for any reason, **When** the reviewer confirms, **Then** nothing is applied, no decision is recorded, the request stays *pending*, and the reviewer sees an error they can retry.
10. **Given** the member was archived after submitting, **When** a reviewer tries to approve any field, **Then** approval is refused with an explanation (archived members cannot be modified); the reviewer may reject the request or unarchive the member first.

---

### User Story 3 - Staff reject — some or all fields — with a reason; nothing rejected applies; member is told why (Priority: P1)

A reviewer decides one or more proposed values are wrong or inappropriate. They de-select those rows (or all of them) and must type a reason before they can confirm. The rejected values never reach the record; the request records each field's outcome, the reason, reviewer and time; the member receives an email with the reason and a link to edit and resubmit — the edit form opens prefilled with **only the rejected values**, so they correct rather than retype.

**Why this priority**: The reject path with a mandatory reason is explicitly required; without it members are left guessing and staff have no record of why.

**Independent Test**: A reviewer de-selects every row of a pending request and confirms with the reason "Please use the company's registered phone number"; the member record still shows the old values; the request shows *rejected* with that reason; the member's inbox has an email containing the reason verbatim and a link back to the edit form, which opens prefilled with the rejected values.

**Acceptance Scenarios**:

1. **Given** a pending request with at least one row de-selected, **When** the reviewer tries to confirm without a reason, **Then** the decision is not accepted and the reviewer is asked for a reason; with no row de-selected, no reason is asked for.
2. **Given** a pending request, **When** a reviewer de-selects every row and confirms with a reason, **Then** the member record is unchanged, the request becomes *rejected* holding the reason, reviewer and time, and the member is notified by email with the reason, in the member's preferred language for the surrounding text (the reason itself is shown as typed).
3. **Given** a request that was rejected in full or in part, **When** the member follows the "edit and resubmit" link, **Then** the reason is shown and the form is prefilled with exactly the rejected values (approved fields show their new, live values), so they can correct and resubmit as a new request — in which any Group B field may be edited again.
4. **Given** a decided request, **When** a reviewer tries to decide it again, **Then** the action is refused — a decision is final; a new request from the member is the only way forward.

---

### User Story 4 - A complete, visible history of requests and decisions (Priority: P2)

Every request and its outcome is kept permanently: who submitted, when, which fields with old and proposed values, and the decision — each field approved or rejected, by whom, when, and with what reason. Staff can see this history on each member's record and in a tenant-wide list they can filter; the member can see their own history in the portal.

**Why this priority**: Explicitly required ("a history log of all changes … visible to SweCham"). It is P2 only because the first three stories produce the entries; this story makes them findable.

**Independent Test**: After one fully approved and one partially approved request for a member, staff open the member's "Change requests" history and see both entries with submitter, time, field diffs, per-field outcome, reviewer, and reason; the tenant-wide list filtered to "partially approved" shows the second one; the member's portal shows the same two entries with the reason on the refused field.

**Acceptance Scenarios**:

1. **Given** a member with past requests, **When** staff open the member's record, **Then** they see every request for that member — pending, approved, partially approved, rejected, withdrawn — newest first, each with submitter, submitted time, field-by-field old → proposed values and outcome, reviewer, decision time and reason.
2. **Given** staff open the tenant-wide review queue, **When** they filter by outcome (pending / approved / partially approved / rejected / withdrawn), by member, or by date range, **Then** the list shows matching requests only, pending ones first by default, each with the member, the number of fields proposed, and how long it has been waiting.
3. **Given** a request entry, **When** a staff user views the member's timeline, **Then** the submission and the decision appear as timeline events alongside the member's other activity.
4. **Given** a contact with a portal login, **When** they open the request history in the portal, **Then** they see the requests they submitted themselves plus the company-level requests of their member — never another contact's own-field requests (a colleague's old and new name or phone) — with the same information staff see, except the reviewer's identity is shown as the organisation ("SweCham"), not a named person.
5. **Given** the history contains entries older than the platform's audit retention floor, **When** retention is evaluated, **Then** request history is kept at least as long as the audit trail it accompanies (≥ 5 years).
6. **Given** a member is erased under a data-subject erasure request, **When** the erasure runs, **Then** the personal data inside their change requests (proposed and previous names, phone numbers, addresses) is removed or replaced with the erasure sentinel exactly as other member PII is, while the fact that requests existed and were decided remains countable.
7. **Given** a member requests a copy of their data (data-subject access / portability), **When** the export is produced, **Then** it includes their change-request history.

---

### User Story 5 - Member withdraws or replaces a pending request (Priority: P2)

A member who realises they made a mistake can withdraw their pending request before staff decide, or open the edit form and submit corrected values — which replaces the pending request with a new one. Staff never review a stale request the member has moved on from.

**Why this priority**: Without it a member with a typo has to wait for a rejection they know is coming, and staff spend time on requests the member no longer wants.

**Independent Test**: A member submits a change, then withdraws it: the request shows *withdrawn*, staff see it as withdrawn in the queue, no decision is possible on it, and the member can submit a fresh request immediately.

**Acceptance Scenarios**:

1. **Given** a pending request, **When** the member withdraws it, **Then** it becomes *withdrawn*, it leaves the staff's pending list, no decision can be recorded on it, and it remains in history.
2. **Given** a pending request, **When** the same person submits a new set of values, **Then** the earlier request becomes *withdrawn* (marked as replaced) and the new one is that person's only pending request; staff are notified of the new request by a new email — unless one was sent for that person within the last hour, in which case no email is sent and the earlier email's link already opens the new request. A pending request from a *different* contact of the same member is untouched.
3. **Given** a person has created 10 requests within the last 24 hours (counted from the request history, so the cap holds even if any rate-limiting service is unavailable), **When** they submit again, **Then** the submission is refused with a message saying when they can try again, nothing is created or replaced, and the refusal is recorded.
4. **Given** a request was decided while the member was editing, **When** the member submits, **Then** the submission is treated as a brand-new request against the now-current values, and the member is shown the decision that landed in the meantime.
5. **Given** a member has a pending request, **When** they open the edit form, **Then** the form shows the pending proposed values as the starting point, with the current record values visible for comparison.

---

### User Story 6 - Approval requirement is a tenant choice; pending work is visible at a glance (Priority: P3)

The chamber decides whether member self-service changes require approval. SweCham switches it on; a future tenant may leave it off and keep immediate-save behaviour. When it is on, staff can see how many requests are waiting — and how old the oldest is — from the admin dashboard and navigation, without opening the queue.

**Why this priority**: The platform serves more than one chamber (MTA+STD); a hard-wired approval gate would be wrong for a tenant that trusts its members. The dashboard count answers the F9 "action required" gap ("submitted for approval 2 days ago — nobody reviewed it because nobody knew"). Neither is needed for SweCham's first day.

**Independent Test**: With the tenant setting off, a member edit of a Group B field applies immediately and no request is created; with it on, the same edit creates a pending request and the admin dashboard's "action required" area shows "1 change request waiting".

**Acceptance Scenarios**:

1. **Given** the tenant setting is off, **When** a member saves an edit to a Group B field, **Then** the change applies immediately, is recorded as a self-service edit is today, and no request, queue entry or staff email is produced.
2. **Given** the setting is switched from on to off while requests are pending, **When** staff look at the queue, **Then** the pending requests remain and can still be decided; only new member edits bypass the queue.
3. **Given** the setting is on and requests are pending, **When** a staff user views the admin dashboard or the navigation, **Then** they see the number of pending requests and the age of the oldest, and can go straight to the queue.
4. **Given** the setting is changed, **When** the audit trail is inspected, **Then** the change of setting is recorded with who changed it and when.

---

### Edge Cases

- **Nothing changed**: the baseline for "nothing to submit" is the **current record**, not the pending proposal; a submission identical to the current record creates no request, and one identical to the person's existing pending request neither creates nor replaces anything (US1 AS3).
- **Field reverted back to the current value before submit**: only fields that actually differ are included in the request; a request with zero differing fields is not created.
- **Address groups**: a registered address and a billing address are each proposed, shown, decided and applied as **one unit** (all of the group's lines together), never line by line; a change to any line proposes the whole group.
- **Company name identical to another member's**: the same rules that apply to a staff edit of the company name apply to the proposal (validation at submit, and again at approval against the then-current data).
- **Invoice issued while a billing-address or company-name request is pending**: the document uses the record as it is at issue time; a later approval changes nothing on that document (US2 AS6).
- **Same member, two contacts with portal access submit**: their requests coexist — each person has at most one pending request, and requests from different people never overlap in fields (only the primary contact may propose company-level fields; every linked contact may propose only their own contact fields). Resubmitting replaces only the submitter's own pending request.
- **Primary contact changes while a request is pending**: a company-field request submitted by the former primary stays pending and decidable (it was valid when submitted); the review page shows the submitter's role at submission time. The new primary may submit their own request, which does not replace the former primary's.
- **Member archived while a request is pending**: approval is refused; reject or unarchive first (US2 AS10). The queue shows the archived state on the row.
- **Member erased while a request is pending**: the request's personal data is scrubbed with the rest of the member's data; the request is closed as withdrawn (system) and cannot be decided.
- **Reviewer who is, as a natural person, also a member's contact**: by F1 § Q2 such a person holds two unrelated accounts (one staff, one member, under different email addresses); the system holds no identity link between them and does not attempt to detect one. The review page shows the submitting person's name and role at submission; refraining from deciding a request for one's own company is chamber policy, not a system control (see § Out of Scope).
- **Staff edited the same field after submission**: shown as "changed since submitted" (US2 AS5); approval applies the proposed value.
- **Two reviewers decide concurrently / double submit**: exactly one decision; the other is told (US2 AS7, AS8).
- **Partial application failure**: applying the approved fields is all-or-nothing; on failure nothing is applied and no decision is recorded (US2 AS9).
- **Submitting contact removed or unlinked while pending**: the request stays in the queue; its contact-field rows are shown as "contact removed" and can only be rejected; company-level rows remain decidable; the decision email is skipped as recipient-gone and recorded; history keeps the submitter's name as recorded at submission (FR-020).
- **Proposed value already equals the current value at decision** (staff made the same change meanwhile): approving it is a no-op write, still recorded as approved; the review page marks the row "already current" (FR-015).
- **Withdraw races a decision / replacement races a decision**: the first committed transition wins; the other is refused with the state it found — `not_pending` or `already_decided` (FR-008, FR-017).
- **Primary contact proposes their own name**: the primary contact's name is printed as the buyer's contact person on tax documents, so that row carries the tax-affecting flag like company name and billing address (FR-019).
- **Non-Thai billing country proposed**: accepted as part of the billing-address group and flagged tax-affecting; whether the VAT treatment of future documents changes is the reviewer's call, not the system's (FR-019).
- **Resubmission burst**: a person may create at most 10 requests per 24 hours, counted from the durable request history (not from a best-effort rate limiter that fails open when its backing service is down); within that, resubmitting inside 1 hour of their last staff notification queues no further email (US5 AS2, AS3). The staff email link resolves to the person's *current* pending request, so a link from a superseded email never opens a withdrawn request.
- **Staff email cannot be delivered to one reviewer**: delivery to the others is unaffected; the failure is recorded as email dispatch failures are recorded today; the request remains reviewable in the queue.
- **No staff user is entitled to review** (misconfigured tenant): the request is still created and visible in the queue; a warning is recorded so operators notice; the member is not told anything is wrong.
- **Rejection reason is very long or contains formatting**: accepted up to the limit (FR-014), shown as plain text; nothing in it is rendered as a link or markup.
- **Member's preferred language for the decision email**: the email's surrounding text follows the member's preferred language (EN/TH/SV); the reviewer's reason is shown exactly as typed.
- **Tenant setting turned off with pending requests**: pending requests remain decidable (US6 AS2).
- **Cross-tenant attempt**: a staff user or member of tenant A can never see, decide or withdraw a request belonging to tenant B; such an attempt is recorded as a cross-tenant probe.

## Requirements *(mandatory)*

### Functional Requirements

**Scope of the gate**

- **FR-001**: When approval is required for the tenant, the system MUST hold every member-initiated change to a Group B field as a *change request* and MUST NOT modify the member record until a decision approves it. While the setting is on, **no immediate-write path for a Group B field may remain reachable by a member** — the existing immediate self-service update is narrowed to Group A, so that the gate cannot be bypassed by the pre-existing endpoint.
- **FR-002**: Group B — the fields a member may propose — MUST be exactly: for the submitting person's own contact record, first name, last name, phone, job title; for the company, company name, website, description, the registered address (address line 1, address line 2, sub-district, city, province, postal code — one unit) and the billing address (address line 1, address line 2, sub-district, city, province, postal code, country — one unit). This set MUST be declared as a compile-time constant in the Domain layer (extending F3 FR-014a) so that adding or removing a field is a single source-code change; any submitted field outside it MUST be refused and recorded as a forged self-service edit, exactly as today. **Who may propose what**: the company-level fields MAY be proposed only by the member's **primary contact**; the contact fields MAY be proposed by any contact with a portal login, for **their own** contact record only. A submission that breaks either rule MUST be refused and recorded as a forged self-service edit.
- **FR-003**: Group C — tax ID, legal entity type, head office / branch code, VAT registration, the member's country, founded year (a Start-up tier eligibility input), turnover, registered capital, plan, status, member number, registration date, billing cycle, auto-invoice enrolment and internal notes — MUST remain staff-only and MUST NOT be proposable by a member.
- **FR-004**: Group A — the contact's **own preferred language for emails and notifications** (the per-contact setting, which is a different setting from the member-level display language already edited on the account page) — MUST continue to save immediately, outside the request flow, and MUST be edited on the account page next to the display-language setting rather than on the change-request form; the existing email-change, colleague-invite, marketing opt-out and renewal-reminder flows are unchanged by this feature.

**Submission (member side)**

- **FR-005**: A change request MUST record: the tenant, the member, the submitting person, the submission time, and for each proposed field (or address group) the value at submission time and the proposed value.
- **FR-006**: Proposed values MUST pass the validation that applies to a staff edit of the same field before a request is created; a failed validation MUST create no request.
- **FR-007**: The baseline for a submission is the **current record**: a submission in which no field differs from it MUST create no request and MUST tell the member there is nothing to submit; a submission whose proposed set is identical to that person's existing pending request MUST create or replace nothing and MUST tell the member the change is already awaiting review.
- **FR-008**: A submitting person MUST have at most one *pending* request at a time; submitting again MUST replace that person's pending request (the earlier one becomes *withdrawn*, marked as replaced) and MUST notify staff about the new request only (subject to FR-011's coalescing rule). Pending requests from different contacts of the same member coexist. A person MUST NOT be able to create more than **10 requests in any 24-hour window**, counted from the durable request history itself (so the cap holds even when a best-effort rate-limiting service is unavailable); a submission beyond that MUST be refused with a message stating when they may try again, MUST create or replace nothing, and MUST be recorded in the audit trail as a rate-limit refusal. Replacement applies only to a request that is still *pending* at the instant of the replace; if it was decided meanwhile, the new submission is a new request and the member is shown that decision (US5 AS4; the race rule itself is FR-017's).
- **FR-009**: Only the submitting person MAY withdraw their own pending request — never another contact of the member and never staff (staff reject instead) — after a standard confirmation; a withdrawn request MUST remain in history and MUST NOT be decidable.
- **FR-010**: The member's portal MUST show the pending state with the proposed values next to the current values, and after a decision MUST show each field's outcome (applied value and time, or the reason and an "edit and resubmit" path prefilled with exactly the rejected values). The submission form MUST carry a short notice that the proposal is reviewed by chamber staff, is emailed to them, and is kept with the member record (GDPR Art. 13 / PDPA § 23), linking to the tenant's privacy notice. The last decision MUST stay visible on the member's profile until the submitting person dismisses it or submits a new request; the dismissal is recorded per person.

**Staff notification**

- **FR-011**: On creation of a request, the system MUST email every active staff user of the tenant who holds the members-write right (`members.write` — admin and super_admin today; this is the set "entitled to review" wherever the term appears; under single-tenant deployment "of the tenant" is simply every active such user, and F10's `user_tenants` scopes it per tenant), stating the member (company name and member number), the submitting person, the submission time, and each proposed field with current and proposed value, with a link to the review page. The email MUST go to staff only. The link MUST open the submitting person's *current* pending request (not a specific request id), and **no new email MUST be queued when the same person resubmits within 1 hour of their last staff notification** — the replaced request's email already leads to the live one. Delivery is at-least-once (a dispatcher retry may deliver a queued email twice); "one email" throughout this specification means one notification *queued*.
- **FR-012**: Notification emails MUST be queued with the request in the same unit of work and delivered by the existing after-commit dispatcher, so a delivery failure never undoes the request and is retried and recorded as other transactional emails are.

**Review and decision (staff side)**

- **FR-013**: Only a staff user holding the members-write right (`members.write`; no new permission is introduced) MUST be able to decide a pending request. No self-review rule is specified: a staff account can never be a portal submitter by construction — one `role` per user account, global case-insensitive email uniqueness, staff sessions are redirected off `/portal/**`, `/api/portal/**` refuses any non-member role, and a staff ↔ member role change is refused (`role-portal-mismatch`; F1 § Q2: a staff person who is also a member holds a *separate* member account). A reviewer's user id therefore never equals a submitter's user id, and a guard comparing them would be untestable dead code (see § Out of Scope).
- **FR-014**: A decision MUST be made **per proposed field (address groups as one unit)** in a **single confirming action**: every field is pre-selected as approved; the reviewer de-selects the fields to reject; a free-text reason of 1–1,000 characters, shown as plain text wherever it appears, MUST be required if and only if at least one field is rejected; an optional note under the same limit MAY accompany any decision. The reason and note are the member's personal data as well as the reviewer's words: they MUST be shown only to staff holding `members.read` and to the submitting person, MUST be scrubbed with the request on erasure, and MUST be included in the submitting person's data export.
- **FR-015**: Confirming a decision MUST apply all approved fields to the member record in a single all-or-nothing step and MUST record the decision (reviewer, time, per-field outcome, reason, note) in that same step; if applying fails, nothing is applied, no decision is recorded, and the request stays pending. An approved field whose proposed value already equals the current value at decision time MUST still be recorded as approved (a no-op write), so the outcome the member sees matches the decision.
- **FR-016**: A decided request MUST carry an outcome of *approved* (every field approved), *rejected* (every field rejected) or *partially approved* (mixed), and each proposed field MUST carry its own outcome.
- **FR-017**: A decision MUST be final: a decided or withdrawn request MUST refuse any further decision, and a repeated identical decision (retry, double-click) MUST be a harmless no-op that produces no second application, no second decision and no second queued notification. Where two transitions race — a withdrawal against a decision, a replacement against a decision — the first committed transition wins and the other MUST be refused with the state it found (`not_pending` / `already_decided`).
- **FR-018**: When two reviewers act on the same request concurrently, exactly one decision MUST be recorded and the other reviewer MUST be told who decided and how.
- **FR-019**: The review page MUST show current and proposed values side by side per field, MUST flag any field whose current value differs from the value the member saw at submission (showing all three values), MUST present each address group as one row, and MUST flag as affecting tax documents the company name, the billing address (including a non-Thai billing country, which the reviewer judges for VAT treatment), the registered address for a member with no billing address on record (it is then the buyer address printed on tax documents), and the first / last name proposed by the **primary** contact (printed as the buyer's contact person). A billing-address change MUST NOT alter the staff-only head-office / branch designation; the flag's hint MUST remind the reviewer to check it.
- **FR-020**: Approval MUST be refused for an archived member and for a member being erased; the reviewer MUST be told why and what they can do instead. A contact-field row whose contact has been removed or unlinked since submission MUST be shown as undecidable ("contact removed") and MAY only be rejected; the request's other rows remain decidable.
- **FR-021**: Staff edits made directly in the staff portal MUST continue to apply immediately and are not subject to this workflow.
- **FR-022**: Approving a company name, a billing address, a registered address or a primary contact's name MUST NOT alter any already-issued invoice, receipt or credit note; the buyer block is built from the member record at *issue* time, so a draft created before the approval and issued after it carries the approved values, and no document is ever rewritten.

**Member notification**

- **FR-023**: On every decision the system MUST queue for the submitting person **one** email (at-least-once delivery, as in FR-011) in the contact's own preferred language, listing the applied fields and the rejected fields, the reason verbatim when any field was rejected, and a link to edit and resubmit prefilled with exactly the rejected values. The resubmission is a new request: any Group B field may be edited again, approved fields start from their live values, and only the rejected values are prefilled.
- **FR-024**: Decision emails MUST be queued in the same unit of work as the decision and dispatched after commit, as in FR-012.

**History and visibility**

- **FR-025**: Every request and every state change on it (submitted, decided with per-field outcome, withdrawn, replaced, closed by erasure) MUST be recorded in the append-only audit trail with the true actor (the member's user for submit/withdraw, the reviewer's user for decisions, the system for erasure-driven closure) and MUST never state a role the actor did not hold.
- **FR-026**: Staff MUST be able to see, on each member's record, every request for that member with submitter, submission time, field-by-field old and proposed values and outcome, reviewer, decision time and reason. Seeing this history, the queue (FR-027) and the pending count (FR-033) requires the members-read right (`members.read` — manager and marketing included, read-only); deciding requires `members.write` (FR-013). Staff reads of requests are not audited, consistent with member-record reads today; exports remain audited by the existing export path. The reviewer's identity on a decision is retained with the record; if that staff account is later disabled, history still shows the recorded name with a "deactivated" marker.
- **FR-027**: Staff MUST be able to see a tenant-wide list of requests, pending first, filterable by outcome, member and date range, showing for each the member, the number of fields proposed, and the waiting time; a pending request older than 3 days MUST be visually flagged.
- **FR-028**: Submission and decision events MUST appear on the member's timeline (staff view and member's own portal timeline).
- **FR-029**: A contact with a portal login MUST be able to see, in the portal, the requests they submitted themselves and the company-level requests of their member — and MUST NOT see another contact's own-field requests — with the reviewer shown as the organisation rather than a named staff person.
- **FR-030**: Request history MUST be retained at least as long as the audit trail (≥ 5 years) and MUST be included in the data-subject access/portability export, scoped as in FR-029; on erasure, the personal data inside requests MUST be scrubbed with the member's other personal data while the existence and outcome of each request remain. Erasure is member-wide (every contact of the member), so every request of the member — including its reasons and notes — is scrubbed together. Early scrubbing of a single rejected proposal on a restriction or objection request is handled through the chamber's data-subject-request process and, where granted, the existing erasure tooling (see § Out of Scope).

**Tenant control and observability**

- **FR-031**: Whether member changes require approval MUST be a per-tenant setting, switchable by an admin, with its changes audited; when off, member edits to Group B fields MUST apply immediately and be recorded as self-service edits are today. The setting's initial value for a newly onboarded tenant is **off**; it has effect only once the platform feature flag is on (flag first, then setting). SweCham's setting is on at launch.
- **FR-032**: Pending requests already created MUST remain decidable after the setting is switched off.
- **FR-033**: When the setting is on, the admin dashboard and staff navigation MUST show the number of pending requests and the age of the oldest, linking to the queue.
- **FR-034**: All new surfaces (portal edit form, pending/decision states, staff queue, review page, history, emails) MUST be available in EN, TH and SV and MUST meet WCAG 2.1 AA; the confirming action MUST use the platform's confirmation-dialog pattern, with the destructive-style tier whenever at least one field is rejected, and the confirm button MUST state what will happen ("Approve all 4" / "Approve 3, reject 1" / "Reject all 4"). Each surface MUST define its loading (skeleton), empty, error and permission-denied states. Keyboard operation MUST be complete: every decision row is a labelled checkbox toggled with Space, focus order is rows → reason → confirm, and focus returns to the confirm control after the dialog closes; the pending banner, the decision outcome and the "nothing to submit" message MUST be announced through a live region; outcome badges and the tax-affecting flag MUST convey meaning by text or icon, never colour alone.
- **FR-035**: Requests MUST be isolated per tenant at both the application and database layers; any cross-tenant read or decision attempt MUST fail and be recorded as a cross-tenant probe.
- **FR-036**: Submissions and decisions MUST be refused with the standard read-only response while the emergency read-only mode is active.
- **FR-037**: The system MUST expose an operational count of pending requests and their oldest age so an alert can fire when requests go unreviewed; the thresholds are a **warning at 7 days** and a **page at 14 days** of pending age (set at the plan gate), so that a request is decided well within the one-month clock that applies to data-subject requests (GDPR Art. 12(3) / PDPA § 30) and the operational alarm doubles as the statutory backstop.

**Transport, flag and lawful basis** *(added at the checklist gate, 2026-09-11)*

- **FR-038**: All new member and staff actions MUST be HTTP route handlers under the platform's request guards — CSRF Origin allow-list, read-only mode, RBAC denial audit — never Server Actions. Submit MUST accept the platform's `Idempotency-Key` header with its standard semantics (same key + same body → the stored response; same key + different body → refused), so a client retry can never create two requests or two staff notifications.
- **FR-039**: The feature MUST ship behind a platform feature flag (default OFF). With the flag OFF: every new route answers 404, the portal shows no pending or decision state, the navigation and dashboard show no count, the immediate self-service path is widened back to today's field set, and stored requests are retained untouched and become decidable again when the flag returns. The migration, the enum values and the tenant setting column are unflagged and live on merge; the rollback matrix in `quickstart.md` lists them.
- **FR-040**: The processing is carried out on the basis of the membership contract and the chamber's legitimate interest in an accurate member register (GDPR Art. 6(1)(b)/(f); PDPA § 24(3)/(5)), for the purposes of reviewing member-proposed changes and keeping an accountable history of them; the record-of-processing entry MUST be updated before the tenant setting is switched on for any tenant.

### Key Entities *(include if feature involves data)*

- **Change Request**: a member's proposal to alter their record. Belongs to one tenant and one member; submitted by one person (the member-side user/contact); has a state — *pending*, *decided*, *withdrawn* (with a sub-reason: by member, replaced by a newer request, closed by erasure) — and, once decided, an outcome of *approved* / *partially approved* / *rejected*; carries submission time, decision time, reviewer, reason and note. Exactly one pending request may exist per submitting person; a member may therefore have several pending requests, one per contact, that never overlap in fields.
- **Proposed Field Change**: one row inside a request — the field (or address group), the value the member saw at submission, the proposed value, and after the decision its own outcome (approved / rejected) and applied time. A request has one or more of these; only fields that differ are stored. On review each is compared with the record's live value to detect "changed since submitted".
- **Decision**: the outcome recorded on a request in one action — reviewer, time, the per-field outcomes, one reason for the rejected set, an optional note. Final once recorded.
- **Tenant approval setting**: the per-tenant switch that turns the workflow on or off, with its own audit history.
- **Member record** (existing): the company and contact data the request targets; unchanged in shape by this feature.
- **Audit trail** (existing, append-only): receives one event per submission, decision, withdrawal, replacement and setting change, attributed to the true actor.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With approval on, 100% of member-initiated edits to Group B fields are held for review — no Group B value is ever applied to the record before an approving decision (verifiable by comparing record changes against decisions in the audit trail).
- **SC-002**: Staff receive the "who changed what" notification within 5 minutes of a member's submission in 99% of cases, and the email alone is enough to know the member, the submitter and every field's old and proposed value for the submission that generated it, without opening the system (after a coalesced resubmission the link opens the current values — SC-013).
- **SC-003**: A reviewer can go from opening the email to a recorded decision in under 60 seconds and no more than 3 interactions when every field is acceptable (open link → confirm → confirm dialog), and in under 2 minutes when one field must be rejected.
- **SC-004**: After a decision, the Member Portal and the staff portal show identical values on their next load — zero divergence, with no reconciliation step, because both read one record.
- **SC-005**: The member is notified of every decision within 5 minutes in 99% of cases; 100% of notices that include a rejected field contain the reviewer's reason.
- **SC-006**: A member whose request had one rejected field among several never has to re-enter an approved field: the resubmit form is prefilled with exactly the rejected values, and the approved values are already live.
- **SC-007**: 100% of requests have a complete history entry — submitter, submission time, field-level old/proposed values and outcome, reviewer, decision time and (for rejections) reason — and staff can find any request by member or outcome in under 30 seconds.
- **SC-008**: No pending request goes unnoticed: any request waiting more than 3 days is flagged in the queue and counted on the dashboard, and an operational signal exists for alerting.
- **SC-009**: Zero cross-tenant visibility or action on requests, proven by the mandatory two-tenant integration test in both directions.
- **SC-010**: All new member- and staff-facing surfaces pass the WCAG 2.1 AA scan with zero violations and have 100% EN/TH/SV message coverage.
- **SC-011**: With the tenant setting off, member edit behaviour is indistinguishable from an immediate save (the existing self-service edit regression suite passes; the widened fields save immediately and are audited).
- **SC-012**: Zero already-issued tax documents change as a result of an approved company-name or billing-address request (verifiable by comparing document buyer blocks before and after approvals).
- **SC-013**: No more than one notification email per submitting person per hour is queued for reviewers, and no person can create more than 10 requests in 24 hours, however many times they submit — counted from the request history, so both hold with the rate-limiting service unavailable.

## Assumptions

- **"CRM" is the Chamber-OS staff portal** (`/admin`). SweCham's member records live only in Chamber-OS; there is no external CRM to synchronise. "Portal and CRM stay in sync" is therefore satisfied structurally — both read the same record — and this spec makes that explicit rather than building a sync mechanism. If SweCham does use an external CRM for members, this assumption must be corrected before planning.
- **Reviewers** are exactly the staff users who may already edit members (`members.write`: admin and super_admin today). No new role or permission is introduced — decided in § Clarifications (2026-09-11); a dedicated right is a follow-up only if a tenant needs approve-without-edit.
- **Staff notification recipients** are all active staff users entitled to review, each in the tenant's default language; there is no per-tenant "notification mailbox" setting in this feature. A digest or a single shared mailbox can be added later without changing the workflow. "Of the tenant" is vacuous under single-tenant deployment — one tenant is deployed and staff accounts are cross-tenant by design (`docs/saas-architecture.md` § 4) — so the recipient set is simply every active admin / super_admin today; recipient enumeration becomes `user_tenants`-scoped at F10, which is an F10 checklist item. One notification is queued per reviewer; a tenant with more than 20 reviewers is out of scope for this version (SweCham has ≤ 5).
- **Approval notification to the member** is included even though only the rejection notice was explicitly requested; confirming that a change went live is the natural counterpart and costs nothing extra.
- **One pending request per submitting person** (replace-on-resubmit) rather than a stack of pending requests — simplest mental model for both sides; history keeps every replaced request. Because only the primary may propose company fields and every contact proposes only their own fields, two people's requests can never disagree about the same value.
- **Preferred language leaves the change-request form**: there are two distinct language settings today — the member-level display language already edited on the account page, and the contact's own email / notification language currently on the edit form. The latter moves to the account page next to the former and saves immediately; the change-request form contains Group B fields only, so one form never mixes "saves now" and "waits for review".
- **The billing address's country line belongs to the billing-address group** and is proposable with it, even though the member's own country field is staff-only: a billing address is one unit and a chamber member may legitimately be invoiced at an address abroad. If SweCham prefers the billing country locked too, it is a one-line change to the Group B constant.
- **Company name changes are rare and legitimate** (rebrand, legal rename) and staff verify them against DBD records before approving, as they do today when keying them in by hand; the request only structures what already happens by email.
- **Staff direct edits stay immediate** — the workflow gates member-initiated changes only.
- **Rollout**: the feature ships dark behind the platform's usual feature flag (FR-039) and is enabled per tenant by the setting in FR-031; SweCham's setting is turned on at launch. Turning the setting off is the first rollback layer, the flag the second — no code revert needed for either; only the migration, the enum values and the setting column are live on merge regardless of flag state. The move of the contact's language setting to the account page is a UI relocation that applies in both flag states (save semantics unchanged).
- **Retention** follows the audit floor (≥ 5 years); requests contain no financial or tax *document* data, so the 10-year tax class does not apply.
- **Reasons are plain text** in the reviewer's language; they are not translated for the member.
- **Existing building blocks are reused**: the after-commit email outbox, the append-only audit trail, the member timeline, the F9 dashboard "action required" area, the confirmation-dialog pattern, and the F7 E-Blast approval queue as the UX precedent for a staff review queue.

## Out of Scope

- Any external CRM integration or two-way synchronisation.
- Member proposals for Group C fields (tax ID, legal entity type, head office / branch, VAT registration, country, founded year, turnover, registered capital) — a follow-up feature with its own tax review and a "verify against DBD" step.
- Detecting or refusing "self-review" by a natural person who holds both a staff account and a member account. No person-identity link exists between accounts (F1 § Q2 separate accounts; `role-portal-mismatch` forbids a role crossing), so a system-enforced rule would need a cross-account identity model, which is its own feature with its own PII review.
- "Approve with edits" — a reviewer altering a proposed value before approving; staff edit the record directly after approving instead.
- Approval for changes made by staff.
- Approval for E-Blast submissions (already exists in F7) or for online payments, renewals, event registrations, or the email-address change (which has its own verify + revert flow).
- A per-tenant custom notification mailbox, digests, or in-app real-time notifications (smart-chamber feature #17) beyond the dashboard count.
- Bulk approve/reject across many requests.
- Automatic approval rules (for example "auto-approve phone changes").
- Per-request early scrubbing of a single rejected proposal (a restriction/objection request goes through the chamber's DSR process and the existing member-wide erasure tooling).
- Anonymising a *staff* reviewer's identity in history (staff accounts are disabled, never deleted; F1 governs staff accounts).
- Tenants with more than 20 reviewers (per-reviewer notification fan-out is not bounded beyond the staff roster in this version).
