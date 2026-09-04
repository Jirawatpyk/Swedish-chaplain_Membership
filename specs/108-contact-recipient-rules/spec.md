# Feature Specification: Contact Recipient Rules — Primary-only money emails + secondary contacts as marketing recipients

**Feature Branch**: `108-contact-recipient-rules`
**Created**: 2026-09-04
**Status**: Tasked
**Input**: User description: "Tier A and Tier B + ปิดช่องโหว่ หรือ รูรั่ว ทั้งหมด" — i.e. implement Tier A (harden the primary-contact-only rule for money emails) and Tier B (secondary contacts receive marketing) from `docs/contacts-primary-secondary-gap-analysis.md`, and close every gap that analysis found (H1, H2, G1–G9). Tier C (bulk import of secondary contacts) is a separate follow-on feature and is **out of scope** here.

## Overview *(context, non-normative)*

SweCham/TSCC stated the contact model they need:

> Primary Contact is locked to one contact per member. Only this person receives invoices, receipts, payment notifications and payment follow-ups. Secondary contacts (many per member) receive marketing emails, newsletters and event news only — never payment or invoice emails.

The 2026-09-04 gap analysis found that the platform implements the money half of this rule almost correctly, but with leaks, and implements the marketing half **inverted**: E-Blasts today go to the primary contact only, and secondary contacts receive nothing.

This feature makes the two rules true without exception:

1. **Money emails reach the current primary contact and nobody else.** Today the recipient of receipts, cancellation notices, credit notes and resends is frozen at invoice-issue time, so after a primary-contact change those emails go to a former primary (now a secondary). The payment processor may also be handed the address of whichever portal user clicked "Pay". A primary can be lost entirely through a concurrent promote/remove race.
2. **Every contact of an eligible member receives marketing broadcasts**, subject to unsubscribe, a staff-controlled per-contact opt-out, and self-exclusion of the sending member. Audience size must be shown truthfully and must scale without silent truncation.

The tax-document buyer identity stays frozen at issue (it is part of the document). Only the **delivery address** becomes live.

## Clarifications

### Session 2026-09-04 (gap-analysis review with maintainer)

- Q: Does the primary contact still receive marketing broadcasts? → A: **Yes, unchanged.** Recipient set = primary + all secondaries.
- Q: Default marketing eligibility for secondary contacts, and lawful basis? → A: Maintainer asked for a recommendation; adopted: **opt-out model** — every non-removed contact of an eligible member is a marketing recipient unless (a) the address is on the suppression list, or (b) staff have turned marketing off for that contact. Lawful basis: B2B contacts of member companies in professional capacity — TH PDPA §24(5) legitimate interest; GDPR Art. 6(1)(f) with Art. 14 notice (already modelled) and Art. 21 objection via one-click unsubscribe. To be reviewed by the PDPA/GDPR compliance reviewer at the plan gate.
- Q: May a secondary contact who has a portal login view, download and pay invoices? → A: Maintainer asked for a recommendation; adopted: **yes, keep view + pay**. The primary invited them, and invoices are company documents. The two leaks (resend response discloses the primary's address; payment processor receives the payer's address) are closed by this feature. Notification emails always go to the primary.
- Q: Same person as a contact at two member companies? → A: **Unsure.** Decision: keep the per-tenant email uniqueness rule for this feature (relaxing it touches portal login binding, bounce handling, attendee matching and unsubscribe attribution). Revisit with import data (Tier C).
- Q: Audience ceiling? → A: 5,000 per broadcast is probably enough for SweCham, **but the system must scale normally** — no silent truncation, truthful counts, one ceiling defined in one place, and larger audiences flow through the existing large-broadcast batching path.
- Q: Stripe Dashboard "Successful payments" customer email? → A: Not actionable now (account is in Test mode; Stripe sends no customer receipts in Test mode). Add to the Live-mode switch checklist; this feature makes the outcome independent of that setting anyway.

### Session 2026-09-04 (`/speckit.specify` clarification questions)

- Q1: Which membership statuses are eligible for marketing broadcasts? Today no status filter is applied (archived members' primaries still receive E-Blasts). → A: **`active` only** (option A). Matches the SweCham wording "member" and spec 010 FR-015; closes the archived leak; win-back of lapsed members belongs to renewal reminders, which already reach them. A future "lapsed members" segment would need its own lawful basis.
- Q2: Do secondary contacts that already exist at cutover become marketing recipients immediately? → A: **Yes, all of them** (option A), on the basis that they were added by the member's own primary contact or by staff under an Art. 14 attestation, the lawful basis is legitimate interest for B2B contacts, and every broadcast carries one-click unsubscribe. Two conditions adopted: a staff pre-flight list before the first send (FR-027a) and a PDPA/GDPR compliance review at the plan gate. Estimated population: at most a few dozen (the round-3 import carried ~131 members / ~164 contacts). A live prod count was attempted read-only but blocked by the session's command classifier; confirm at plan time.

### Session 2026-09-04 (`/speckit.clarify`)

- Q: Which staff roles may switch a contact's marketing state on/off? → A: **A new dedicated right, "manage contact marketing audience", granted to admin, super_admin and marketing** (option B). It is an audience-management action, not a PII edit, so the marketing role keeps its read-only stance on contact PII while owning the audience. Requires a permission-catalogue addition (currently pinned at 41 keys; the "40" in older comments is stale), role-bundle updates and the pinned-count test change.
- Q: Does a staff or self opt-out also apply to the custom-list segment, or only to member-based segments? → A: **Applies to every segment, custom list included** (option A). At submit time the system silently drops opted-out addresses from a custom list and tells the sender how many were dropped (no whole-submission rejection). Opt-out is a person's expressed preference, like unsubscribe; sender self-exclusion remains bypassable by the custom list because that is the sender's own choice.
- Q: Is the pre-flight list (FR-027a) a one-off cutover screen or a permanent surface? → A: **A permanent staff page, "Marketing audience"** (option A): every contact in the tenant with its marketing state, filterable by member, state and primary/secondary, with the on/off switch inline. The pre-flight review is that page filtered to "secondary, currently on". It doubles as the review surface for the later bulk import (Tier C) and gives the marketing role a working surface for its new right.
- Q: What happens when an archived member with no primary contact is unarchived? → A: **Unarchive is refused until a primary exists** (option A): the unarchive step lets staff pick one of the remaining contacts as primary, or create a new contact as primary, in the same action. No "active member without a primary" state is ever created, so FR-010 holds without exception for non-archived, non-erased members.
- Q: May the primary contact switch marketing off for themselves? → A: **Yes, like any other contact** (option A). The right to object to direct marketing (GDPR Art. 21, PDPA) belongs to the person, not the company, and the unsubscribe link already allows it. Money emails to the primary are never affected; the member page shows the primary as "billing: yes, marketing: off". D2 ("primary still receives marketing") is therefore a default, not a mandate.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Money emails always reach the current primary contact (Priority: P1)

An admin changes a member's primary contact (promotes a different person, or the primary changes their email address). From that moment, every payment-related email for that member — receipt on payment, cancellation notice, credit note, and any resend of an invoice, receipt or credit note, including for invoices issued before the change — goes to the new primary contact and to nobody else. The buyer details printed on already-issued tax documents do not change.

**Why this priority**: This is the "No changes to this rule" half of the requirement, and today it is violated on live money paths. Prod is live with real members and money.

**Independent Test**: Issue an invoice while contact A is primary; promote contact B; pay, void, credit-note and resend. Every email lands in B's inbox, none in A's, and the PDF buyer block still shows the identity captured at issue.

**Acceptance Scenarios**:

1. **Given** an invoice issued while contact A was primary, **When** an admin promotes contact B to primary and the invoice is then paid, **Then** the receipt email is sent to B only, and the invoice's recorded buyer identity is unchanged.
2. **Given** the same invoice, **When** an admin voids it, issues a credit note against it, or resends its PDF (invoice, receipt or credit note), **Then** each email is sent to B only.
3. **Given** the primary contact changes their own email address, **When** any money email for an earlier invoice is sent afterwards, **Then** it goes to the new address.
4. **Given** a secondary contact with a portal login pays an invoice online, **When** any email address is shared with the payment processor, **Then** it is the primary contact's address, and the secondary receives no payment or receipt email from the system.
5. **Given** a secondary contact with a portal login requests "resend invoice" from the portal, **When** the request succeeds, **Then** the email goes to the primary contact and the confirmation shown to the requester does not reveal that address.
6. **Given** a member with no primary contact (for example after a data-erasure), **When** a money email would be sent, **Then** no email is sent to any address, the skip is recorded, and staff see a visible warning on the invoice and on the member page until a primary exists.
7. **Given** any money email, **When** it is sent, **Then** it has exactly one recipient and no copies (CC/BCC) go to other contacts.

---

### User Story 2 - Exactly one primary contact, always (Priority: P1)

Staff manage a member's contacts from the member page. Whatever they do — add, edit, promote, remove, even two admins acting at the same moment — a non-archived member always ends up with exactly one primary contact. Attempts that would break this are refused with a clear "refresh and retry" message.

**Why this priority**: Every rule in this feature hangs on "the" primary contact existing. Today a concurrent promote + remove can leave a member with none, and the domain rule that encodes "exactly one" is not enforced anywhere.

**Independent Test**: Run promote(Y) and remove(Y) concurrently 100 times on seeded members; every run ends with exactly one primary and one of the two operations refused.

**Acceptance Scenarios**:

1. **Given** member M with primary P and secondary Y, **When** admin A promotes Y while admin B removes Y at the same time, **Then** either Y is primary and the removal is refused, or Y is removed and the promotion is refused — M never has zero or two primaries.
2. **Given** the current primary contact, **When** an admin attempts to remove it, **Then** the removal is refused with guidance to promote another contact first.
3. **Given** an archived member, **When** its contacts are managed, **Then** the exactly-one rule is relaxed exactly as it is today for archived members and re-applies on unarchive.
4. **Given** an archived member whose contacts were all removed or demoted, **When** an admin unarchives it, **Then** the unarchive is refused until the admin designates one remaining contact, or a newly created contact, as primary in the same step; after that the member is active with exactly one primary.
5. **Given** an erased member, **When** the erasure completes, **Then** the member has no primary by design and is excluded from every email path (money and marketing).

---

### User Story 3 - Secondary contacts receive marketing broadcasts (Priority: P1)

A member submits an E-Blast to "All members" (or to selected tiers). Every contact of every eligible member — primary and secondary alike — receives one copy, except people who unsubscribed, contacts that staff have switched off, and all contacts of the sending member. Newsletters and event news sent through broadcasts therefore reach the whole audience the chamber has a relationship with, not just one person per company.

**Why this priority**: This is the inverted half of the requirement; without it the marketing team's list (Tier C) would have nowhere to go.

**Independent Test**: Seed member M (primary P, secondaries S1, S2, S3 where S1 unsubscribed and S2 switched off by staff) plus sending member N; send "All members" from N; P and S3 receive exactly one copy each; S1, S2 and all of N's contacts receive nothing.

**Acceptance Scenarios**:

1. **Given** eligible member M with primary P and secondaries S1 and S2, **When** a broadcast to "All members" is sent, **Then** P, S1 and S2 each receive exactly one copy.
2. **Given** S1 previously unsubscribed, **When** the broadcast is sent, **Then** S1 receives nothing and P and S2 receive it.
3. **Given** staff switched marketing off for S2, **When** the broadcast is sent, **Then** S2 receives nothing.
4. **Given** member M is the sender, **When** M's broadcast is sent, **Then** none of M's contacts receive it.
5. **Given** member M is not eligible (inactive, archived, erased, or currently halted from broadcasts), **When** the broadcast is sent, **Then** none of M's contacts receive it.
6. **Given** a tier-filtered broadcast, **When** it is sent, **Then** the same contact rules apply to members of the selected tiers only.
7. **Given** S1 clicks unsubscribe in a broadcast, **When** the unsubscribe completes, **Then** the suppression is recorded against S1's address with attribution to member M and contact S1, and the member page shows S1 as unsubscribed.
8. **Given** the custom-list and recent-event-attendee segments, **When** they are used, **Then** their composition rules are unchanged, but a contact switched off by staff or by themselves is dropped from them as well.
9. **Given** a member pastes a custom list that includes S2 (switched off by staff) and S1 (unsubscribed), **When** they submit, **Then** both addresses are dropped, the sender is told "2 addresses were excluded by recipient preference" without naming them, and the rest of the list proceeds.
10. **Given** the sending member's reply-to address, **When** recipients reply, **Then** replies still go to the sending member's primary contact.

---

### User Story 4 - Staff see and control who receives what (Priority: P2)

On the member page, and across the whole tenant on a new Marketing audience page, staff can tell at a glance which contact is the primary (the one that receives invoices and payment emails) and, for every contact, whether they currently receive marketing: on, switched off by staff, or unsubscribed by the person. Staff holding the "manage contact marketing audience" right (admin, super_admin and marketing roles) can switch marketing on or off per contact; this right does not let the marketing role edit any other contact detail. They cannot override a person's own unsubscribe.

**Why this priority**: Makes the new rule operable and auditable. Without it, staff cannot answer "why did/didn't this person get the E-Blast?"

**Independent Test**: Open a member page; each contact shows a billing badge (primary only) and a marketing state; toggle a secondary off, send a broadcast, confirm exclusion; toggle back on, confirm inclusion; attempt to toggle on an unsubscribed contact, confirm it stays excluded with an explanation.

**Acceptance Scenarios**:

1. **Given** a member page, **When** it loads, **Then** the primary contact carries the Primary badge with the "receives invoices and payment emails" descriptor and every non-removed contact shows a marketing state of on / off (by staff) / off (by contact) / unsubscribed.
2. **Given** staff holding the marketing-audience right, **When** they switch marketing off for a contact, **Then** the change is recorded in the audit trail with the actor, and the contact is excluded from the next send.
3. **Given** a contact switched off by staff, **When** staff switch it back on, **Then** it is included in the next send.
4. **Given** a contact whose address is on the suppression list, **When** staff attempt to switch marketing on, **Then** the contact stays excluded and the interface explains that the person's unsubscribe takes precedence.
5. **Given** a staff user without the marketing-audience right (for example a manager), **When** they view the member page, **Then** they see the states but cannot change them.
6. **Given** a signed-in marketing-role user, **When** they switch a contact's marketing state, **Then** it succeeds, while any attempt by that user to edit the same contact's name, email or phone is still refused.
7. **Given** the feature has just been enabled and no member-based broadcast has been sent under the new rule yet, **When** staff open the Marketing audience page filtered to "secondary, currently on", **Then** every existing secondary contact that will newly become a recipient is listed grouped by member, each with a switch-off control, and switching one off takes effect on the next send.
8. **Given** the Marketing audience page, **When** a marketing-role user filters by member "Acme Co." and state "off", **Then** only Acme's switched-off contacts are shown with who switched them off and when, and the count matches the rows.
9. **Given** a tenant with 20,000 contacts, **When** staff open the Marketing audience page, **Then** it loads a first page of 50 results with LCP under 2.5 seconds and paginates the rest.

---

### User Story 5 - Audience size is truthful and scales (Priority: P2)

When a member composes a broadcast, the estimated number of recipients shown is the real number, whatever the audience size. A broadcast is never silently sent to fewer people than the audience: it is either sent to everyone resolved or refused with the true count and the ceiling, or routed through the existing large-broadcast batching path when that is enabled.

**Why this priority**: Adding secondaries multiplies audience size; today the audience is silently cut at 5,000 before the ceiling check, and no count is shown at compose time.

**Independent Test**: Seed an audience of 6,200 eligible contacts; compose shows 6,200; submission outcome is deterministic per the configured ceiling; nothing is truncated.

**Acceptance Scenarios**:

1. **Given** an audience of 6,200 eligible contacts and a ceiling of 5,000 with batching disabled, **When** the member composes and submits, **Then** compose shows 6,200 and the submission is refused with the count and the ceiling.
2. **Given** the same audience with the large-broadcast batching path enabled, **When** the member submits, **Then** the broadcast is accepted and every one of the 6,200 recipients receives one copy.
3. **Given** an audience of 4,900 contacts, **When** 300 secondary contacts are added to eligible members, **Then** compose shows 5,200.
4. **Given** an audience of 20,000 contacts, **When** the member opens compose, **Then** the count appears within the compose page's normal loading time.

---

### User Story 6 - A contact manages their own marketing preference in the portal (Priority: P3)

A contact signed in to the member portal, the primary contact included, can see whether they receive the chamber's marketing broadcasts and can switch it off for themselves. They cannot change other contacts' preferences, and the primary contact cannot switch off money emails (there is no such control).

**Why this priority**: Strengthens the consent story and reduces support load, but unsubscribe links already provide the legally required opt-out.

**Independent Test**: Sign in as a secondary contact; the profile page shows "Marketing: on"; switch off; the next broadcast excludes that contact; the member page shows "off (by contact)".

**Acceptance Scenarios**:

1. **Given** a signed-in contact, **When** they open their profile, **Then** they see their own marketing state and a control to switch it off or on.
2. **Given** a contact switches off, **When** the next broadcast is sent, **Then** they are excluded, and staff see the state as "off (by contact)" with the timestamp.
3. **Given** a signed-in contact, **When** they view the company's other contacts, **Then** they cannot change those contacts' preferences.
4. **Given** the signed-in primary contact switches their own marketing off, **When** the company's next invoice is issued and paid and the next broadcast is sent, **Then** the invoice and receipt still reach the primary and the broadcast does not; the member page still shows the Primary badge on that contact, now with marketing off.

---

### Edge Cases

- **Primary changes while a money email is already queued for delivery**: the recipient is fixed at the moment the message is queued; a change after queueing does not rewrite queued messages. Documented and accepted (queue latency is minutes).
- **Member has secondaries but no primary** (invariant breached out-of-band, or erased): money emails are not sent (US1 scenario 6); marketing still reaches the secondaries only if the member is otherwise eligible — an erased member is never eligible.
- **Member has no contacts at all**: excluded from every send; the existing "member missing recipient" signal fires so staff can fix the record.
- **Unsubscribed address re-added later as a new contact** (after the old one was removed): stays suppressed; the new contact shows "unsubscribed".
- **Staff opt-out vs personal unsubscribe**: unsubscribe always wins; staff cannot re-enable a suppressed address.
- **Opted-out contact on a custom list**: dropped silently at submit with a count shown to the sender (FR-022a); the sender never learns which addresses or why beyond "recipient preference".
- **Same address deduplicated**: if an address would appear twice in one audience (for example via the custom list plus a member segment), exactly one copy is sent.
- **Removed (soft-deleted) contacts** never receive anything and never count.
- **Sender halted for complaints**: a member currently halted from broadcasting stays excluded as a recipient, as today.
- **Card payments**: no email address is shared with the payment processor today; this stays so. PromptPay must use the primary's address.
- **Admin resend surfaces** continue to show the recipient address to staff; only the portal response is redacted.
- **Dormant "alternative recipient" capability** on resend: removed or hard-guarded so no path can redirect a money email to a non-primary address.
- **Archived member unarchived with zero primaries**: unarchive is refused until a primary exists; the unarchive action itself offers to designate one of the remaining contacts, or to create a new contact, as primary in the same step (FR-014). The member never sits in "active + no primary".

## Requirements *(mandatory)*

### Functional Requirements

**A. Money emails go to the current primary contact only**

- **FR-001**: Every payment-related email for a member — invoice issued, receipt / payment confirmation, cancellation (void) notice, credit note (including credit notes raised from a refund), and every resend of those documents, including retried or replayed deliveries — MUST be addressed solely to the member's primary contact **as it stands when the message is queued for delivery**, including for documents issued before a primary-contact change.
- **FR-001a**: For an invoice whose buyer is not a member (an event-fee invoice with a buyer email typed by staff at issue), the recipient is the buyer email captured on the document; FR-001 applies only to invoices that belong to a member.
- **FR-001b**: The system MUST send to the primary contact's address exactly as recorded. A bounced or invalid primary address MUST NOT cause a redirect to any other contact; it is surfaced through the existing bounce indicators on the member page, and the remedy is to correct the primary contact's address.
- **FR-002**: The buyer identity recorded on an issued tax document MUST remain frozen at issue time; recipient resolution MUST NOT modify it.
- **FR-003**: When a member has no primary contact at the moment a money email would be queued, the system MUST NOT send it to any other address, MUST record the skipped send as the audit event `auto_email_skipped_no_recipient` (document id, event type, member id; never an address) in the same transaction as the triggering action — a failure to record aborts the action like every other money audit — and MUST show staff a non-dismissible warning banner at the top of the affected invoice page and of the member page ("No primary contact — payment emails are not being sent") until a live primary contact exists. Staff MUST be able to resend once fixed; no automatic re-send occurs.
- **FR-004**: Any email address the system shares with the online-payment processor for a member's payment MUST be the member's primary contact address, regardless of which portal user initiates the payment.
- **FR-005**: A portal-initiated resend MUST NOT disclose the recipient address to the requester; the confirmation MAY say the document was sent to the company's primary contact.
- **FR-006**: The system MUST NOT provide any path that redirects a money email to a non-primary address. Any existing dormant capability to override the recipient MUST be removed or made unreachable.
- **FR-007**: Money emails MUST have exactly one recipient; no copies MUST be sent to other contacts.
- **FR-008**: Renewal reminders and payment follow-ups MUST continue to resolve the primary contact live (regression guard; already correct today).
- **FR-009**: Every lookup of "the primary contact" for email purposes MUST ignore removed contacts.

**B. Exactly one primary contact**

- **FR-010**: Every non-archived, non-erased member MUST have exactly one primary contact at all times. Concurrent contact operations MUST NOT produce zero or two primaries; the operation that would break the rule MUST be refused with a retry message, not silently applied.
- **FR-010a**: The invariant MUST be guaranteed below the application as well (a database-level check evaluated at commit). Introducing that guarantee MUST first verify that no existing non-archived, non-erased member already violates it; if any does, the rollout MUST stop before the guarantee is installed (a failed deployment is the intended outcome), and the operator fixes those members first. The verification reports counts only.
- **FR-011**: Removing the current primary contact MUST be refused with guidance to promote another contact first.
- **FR-012**: The rule in FR-010 MUST be verified on every contact mutation that can change which contact is primary or whether a primary exists (add, promote, remove, unarchive); edits that cannot affect primacy (name, phone, language) are exempt.
- **FR-013**: Erasure remains the one sanctioned way for a member to end with no primary; such a member MUST be excluded from all email paths.
- **FR-014**: Unarchiving a member that has no primary contact MUST be refused unless a primary is designated in the same action: staff choose one of the member's remaining (non-removed) contacts, or create a new contact, as primary, and the unarchive and the designation succeed or fail together. Designating a removed contact MUST be refused; if the designated contact is removed concurrently, the whole action MUST fail with a retry message. The designation MUST be audited like any promote.

**C. Marketing broadcasts reach every eligible contact**

- **FR-020**: Member-based audiences ("All members" and tier-filtered) MUST resolve to every non-removed contact — primary and secondary — of every eligible member.
- **FR-021**: An eligible member is one whose membership status is **active**, that is not erased, and that is not currently halted from broadcasts. Inactive (lapsed) and archived members, and all of their contacts, MUST be excluded from member-based audiences. (Today no status filter is applied at all, so archived members' primaries still receive E-Blasts; this closes that leak. Win-back of lapsed members stays with renewal reminders, not broadcasts.)
- **FR-022**: A contact MUST be excluded from a member-based audience when any of the following holds: the contact is removed; its address is on the tenant's suppression list; staff have switched marketing off for it; the contact has switched marketing off for themselves; or it belongs to the member submitting the broadcast (self-exclusion covers all of the sender's contacts, not just the primary).
- **FR-022a**: The suppression-list, staff opt-out and self opt-out exclusions in FR-022 MUST apply to **every** segment type, including the custom list and recent-event-attendees. For a custom list, opted-out addresses MUST be dropped at submit time and the sender MUST be told how many were dropped (never which); the submission is not rejected on that account. Sender self-exclusion does NOT apply to the custom list (unchanged).
- **FR-022b**: The compose screen MUST tell the sender that they and their colleagues will not receive their own broadcast (replacing the current "your primary contact email is excluded" wording).
- **FR-023**: The resolved recipient list MUST contain each email address at most once.
- **FR-024**: An unsubscribe by any contact MUST be honoured for that address on every later send and MUST be recorded with attribution to the member and the specific contact.
- **FR-025**: A personal unsubscribe MUST take precedence over any staff setting; staff MUST NOT be able to re-enable a suppressed address.
- **FR-026**: Custom-list and recent-event-attendee audiences keep their existing composition rules (bring-your-own list ≤100 known addresses; attendees of events in the last 90 days) and are otherwise unaffected, except for the opt-out exclusions in FR-022a.
- **FR-027**: Default eligibility is opt-out: a contact is a marketing recipient unless excluded by FR-022. This applies equally to contacts created after this feature ships and to every secondary contact that already exists at cutover; no contact starts switched off and no backfill of preference state is required.
- **FR-027a**: Before the first member-based broadcast is dispatched under the new rule, staff MUST be able to review every secondary contact that will newly become a recipient, grouped by member, with a per-contact switch-off control on the same screen. This review is performed on the Marketing audience page (FR-035) using the pre-flight preset (secondary, currently on, member eligible) by a user holding the marketing-audience right (marketing or admin). The first dispatch MUST NOT be technically blocked on the review; the review is an operational step recorded in the go-live checklist with the date and the reviewer.
- **FR-028**: The reply-to address of a member-submitted broadcast MUST remain that member's primary contact.
- **FR-029**: The existing "member missing recipient" signal MUST fire when an eligible member has no eligible contact at all, and MUST NOT fire merely because a member has secondaries but no primary.

**D. Staff and contact controls**

- **FR-030**: Staff holding a new dedicated right, "manage contact marketing audience" (granted to admin, super_admin and marketing roles), MUST be able to switch marketing on or off per contact from the member page; each change MUST be audited with actor, contact and new state. The right MUST NOT confer any other contact edit capability.
- **FR-030a**: The permission catalogue, role bundles and their pinned-count test MUST be updated for the new right; page and API denial behaviour follows the existing RBAC conventions (pages 404, APIs 403, anonymous 401, denial audited with the actor's real role).
- **FR-030b**: The staff toggle and the portal self-toggle MUST be rate-limited per user (60 changes per minute) with the limit consumed before the change is attempted; excess requests receive the standard 429 response. Both MUST require the `Idempotency-Key` header exactly like the existing contact-mutation and unarchive routes; a replayed key returns the first outcome without a second audit entry.
- **FR-030c**: Switching a contact off or on MUST NOT require a confirmation dialog; switching off MUST offer a 10-second Undo in the confirmation toast (existing undo pattern); switching on takes effect immediately.
- **FR-031**: The member page MUST show, for every non-removed contact, the existing "Primary" badge (the term "billing contact" is not used in the interface; the badge carries the descriptor "receives invoices and payment emails") and its marketing state: on, off (by staff), off (by contact), or unsubscribed.
- **FR-031a**: When the suppression list cannot be read, the marketing state MUST render as "status unavailable" (neither on nor off) on every surface that shows it; a send is never affected because dispatch re-resolves suppression itself.
- **FR-031b**: The reasons a contact does not receive a broadcast MUST use one shared vocabulary on the member page, the audience page and the count feedback: member inactive, member archived, member erased, member halted, contact removed, off by staff, off by contact, unsubscribed, sender's own contact, member has no eligible contact.
- **FR-032**: A signed-in portal contact MUST be able to view and switch their own marketing preference; they MUST NOT be able to change another contact's preference, and other contacts' marketing states are not shown in the portal. Changes MUST be audited.
- **FR-033**: There MUST be no control that switches money emails off for the primary contact. The primary contact MAY switch marketing off for themselves (portal or unsubscribe link) exactly like any other contact; doing so MUST NOT affect any money email, and the member page MUST still show the Primary badge on that contact with marketing off.
- **FR-034**: Staff without the marketing-audience right MUST see the states read-only.
- **FR-035**: A permanent staff page, **Marketing audience**, MUST list every non-removed contact in the tenant with: member name, contact name, primary/secondary, membership status of the member, marketing state (on / off by staff / off by contact / unsubscribed / status unavailable) and, where applicable, who changed it (staff display name, or "the contact") and when. It MUST be filterable by member, primary/secondary, marketing state and member eligibility, MUST show the count of rows matching the current filters, and MUST offer the on/off switch inline for holders of the marketing-audience right (read-only badge for others, no disabled control). Viewing requires the existing contact-read right; changing requires the marketing-audience right. Default view: member eligibility on, sorted by member name then contact name; a pre-flight preset (secondary, on, eligible) is reachable from the page header. It MUST be reachable from staff navigation for admin, super_admin and marketing (and, read-only, for manager, who already holds the existing contact-read right), and MUST paginate (50 rows per page) for tenants with tens of thousands of contacts; cross-page "select all" is out of scope.
- **FR-035a**: The Marketing audience page MUST NOT expose contact details beyond name, email and the fields in FR-035; it is an audience surface, not a PII export. Downloading it is out of scope (the existing directory export right governs exports). The page introduces no new class of data egress: every role that can open it can already browse the same contacts through the member directory.
- **FR-035b**: The page MUST define three empty states — no contacts in the tenant, no rows match the filters (with a clear-filters action), and suppression status unavailable (rows shown, states as "status unavailable") — and a loading state whose skeleton matches the table's column count.
- **FR-035c**: The page MUST work from 320 px using the same treatment as the members directory: the table scrolls horizontally inside its own container (never the page), the contact name and marketing state columns stay visible first, the switch stays reachable and at least 24×24 px, and long SV/TH labels wrap rather than truncate.

**E. Audience size and scale**

- **FR-040**: The recipient count shown at compose time MUST equal the number of recipients that would be dispatched at that moment, for audiences of any size up to the tenant ceiling. The count MUST refresh when the segment changes and MUST be announced to assistive technology.
- **FR-040a**: Count and submit responses MUST carry numbers only (count, ceiling, exceeded, excluded-by-preference, members-without-recipient) — never addresses, member ids or contact ids.
- **FR-040b**: If the count cannot be computed, the compose screen MUST show "count unavailable" (never a stale or partial number); submission remains possible because the server recomputes the audience at submit and refuses it there if the ceiling is exceeded.
- **FR-041**: The system MUST NOT silently truncate an audience. A submission whose audience exceeds the ceiling MUST be refused with the true count and the ceiling, unless the large-broadcast batching path is enabled, in which case it MUST be accepted and every recipient MUST receive one copy. A failure while assembling the audience (for example one page of a paged read) MUST abort with an error, never yield a partial audience.
- **FR-042**: The audience ceiling MUST be defined in exactly one place and enforced consistently at count, submit and dispatch.
- **FR-043**: Resolving an audience MUST complete within 400 ms (p95) at 5,000 contacts and within 3 seconds at 20,000 contacts, both for the compose-time count and at submit.
- **FR-044**: Building the delivery audience at the provider MUST be resumable: the resolved recipient list is fixed at the first delivery attempt, progress is persisted (per recipient, or per provider import job), each scheduled run works within its time budget and later runs continue where the previous stopped, no recipient is added twice, and the broadcast is sent only when every recipient has been added and the provider's own counts confirm it. A build that makes no progress for 30 minutes MUST be flagged for staff attention through the existing stuck-broadcast reconciliation. Any transient recipient list persisted for this purpose MUST be deleted when the broadcast completes or fails and MUST be covered by the member-erasure cascade.
- **FR-045**: Turning the new audience rule off (operator flag) MUST restore the previous primary-only audience for later sends. Broadcasts already delivered cannot be recalled; an incident under the new rule (wrong audience) or under the money rule (email to a former primary) MUST be recorded with the affected broadcast or document ids and reported to the tenant's admin contact, with the remedy (flag off / resend to the correct primary) named in the runbook.

**F. Cross-cutting**

- **FR-050**: All new user-facing text (badges, states, warnings, confirmations) MUST be available in EN, TH and SV.
- **FR-051**: New controls and indicators MUST meet WCAG 2.1 AA (keyboard operable, state announced, target size).
- **FR-052**: New per-contact data and every new query MUST be tenant-scoped, with a cross-tenant isolation test.
- **FR-053**: New audit event types MUST be added: `contact_marketing_opted_out` and `contact_marketing_opted_in` (payload: member id, contact id, source staff|self), and `auto_email_skipped_no_recipient` (document id, event type, member id). The existing unsubscribe events gain the contact id. Retention 5 years. Audit-count gates and the three-locale labels MUST be updated.
- **FR-053a**: No audit payload, log line, count response or toast introduced by this feature may contain an email address; identifiers and hashes only.
- **FR-054**: No secondary contact may receive a money email through any path introduced or modified by this feature (verified by a recipient-path inventory test covering every send path catalogued in the gap analysis, with inputs: primary promoted after issue, primary email changed after issue, secondary pays online, secondary triggers a portal resend).
- **FR-055**: The record of processing MUST be updated for the new processing activities (per-contact marketing preference; marketing to secondary contacts of member companies) with the lawful basis and a short legitimate-interest assessment, before the audience rule is switched on.
- **FR-056**: On member erasure the per-contact marketing preference fields carry no personal data once the contact is scrubbed and are retained as-is; the contact reference on a suppression record is removed while the email-keyed suppression itself is kept (existing behaviour). A staff user id recorded on a preference change is retained after that user's erasure because the audit trail, not the field, is the authoritative record.

### Key Entities

- **Member**: the company/organisation; has a membership status, tier and eligibility for broadcasts; owns contacts.
- **Contact**: a person at a member; exactly one per member is the primary contact (the one that receives invoices and payment emails); carries a marketing state (on by default; may be switched off by staff or by the contact, each with who/when); may be removed (soft-deleted).
- **Marketing suppression**: an address-level record that the person unsubscribed or complained; now also attributes the member and the specific contact when known; always wins over staff settings.
- **Tax document buyer identity**: the buyer details frozen on an issued invoice / credit note; unchanged by this feature.
- **Money email**: a transactional message tied to a document or payment; its single recipient is resolved from the current primary contact when queued.
- **Broadcast audience**: the resolved, deduplicated set of contact addresses for a member-based segment; has a truthful count and a single ceiling.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across every catalogued money-email path (invoice, receipt, void, credit note, all resends, renewal reminders, dunning, tier-upgrade), 0 emails are addressed to a non-primary contact in the acceptance scenarios of US1, including the promote-after-issue and email-change cases.
- **SC-002**: Under 100 concurrent promote/remove races per member, 0 members end with zero or two primary contacts.
- **SC-003**: For a seeded tenant, 100% of eligible contacts (primary + secondaries, minus suppressed / switched-off / sender's own) receive exactly one copy of an "All members" broadcast; 0 ineligible contacts receive it.
- **SC-004**: The recipient count shown at compose equals the dispatched count for audiences of 100, 5,000 and 20,000 contacts; a 20,000-contact audience is counted in under 3 seconds.
- **SC-005**: Staff can read a contact's marketing state without opening any dialog, and change it in at most 2 interactions from the member page.
- **SC-006**: 100% of unsubscribes by secondary contacts are honoured on the next send and are attributed to the member in the staff view.
- **SC-007**: A secondary contact who pays online and who triggers a portal resend receives 0 money emails and sees 0 primary-contact addresses in responses.
- **SC-008**: No regression in existing invoice, payment, renewal and broadcast suites; all quality gates and audit-count gates pass.
- **SC-009**: Contacts of inactive and archived members receive 0 copies of any member-based broadcast (today they receive them).
- **SC-010**: Before the first send under the new rule, staff can review 100% of newly eligible secondary contacts on one screen (the Marketing audience page) and switch any of them off in at most 2 interactions each.
- **SC-011**: The Marketing audience page answers "who will receive the next All-members broadcast?" with a count that equals the compose-time recipient count (before sender self-exclusion) for the same tenant state.

## Assumptions

- Primary contacts continue to receive marketing broadcasts by default (maintainer decision D2); like any contact they may opt out of marketing without affecting money emails (clarify Q5).
- Only members with status `active` are marketing-eligible (Q1, option A); existing secondary contacts become recipients at cutover without backfill (Q2, option A).
- Per-tenant email uniqueness for contacts is kept; one person cannot be a contact at two member companies in this feature (D4).
- Secondary contacts with a portal login keep view, download and pay access to invoices (D5); only the two disclosure/routing leaks are closed.
- Card payments share no email with the payment processor today; this is unchanged. PromptPay shares the primary's address.
- The audience ceiling stays at its current value; the feature makes it consistent and non-truncating rather than raising it (D6). Larger audiences use the existing large-broadcast batching path when enabled.
- The gap analysis' G3 (per-tenant unique email) and G8 (no per-contact flag) are addressed respectively by "keep" and by the opt-out state introduced here; H1, H2, G1, G2, G4, G5, G6, G7, G9 are closed by the requirements above.
- Bulk import of secondary contacts (Tier C), XLSX support, relaxing the unique-email rule, and role-based portal billing access are out of scope and tracked separately.
- The existing one-click unsubscribe, suppression list and unsubscribe token remain the opt-out mechanism; this feature adds attribution and a per-contact state, not a new consent flow.
- Renewal reminder and dunning paths already resolve the primary live; they receive regression tests only.
- One new permission right ("manage contact marketing audience") is added for admin, super_admin and marketing; all other contact edits keep their existing right.
- **No resubscribe flow in this feature.** The suppression list stays authoritative: a contact who unsubscribed via an email link sees "unsubscribed" in the portal and gets no "switch on" control (FR-032's "on" applies only to a contact who switched themselves off in the portal, never to a suppressed address). Lifting a suppression, if ever needed, is a separate consent-flow feature.
- No new subprocessor or cross-border transfer is introduced (Resend, Stripe, Neon, Vercel unchanged); existing SCC / PDPA §28 documentation covers the feature.
- Behaviour of the email outbox during the emergency write-freeze (read-only mode) is unchanged and out of scope.
- The new audience rule's flag is removed after a "clean week": at least two member-based sends under the new rule with zero misrouting reports, bounce and complaint rates within the existing alert thresholds, and zero stuck audience builds.
- Thai typography rules from `docs/ux-standards.md` apply to every new badge and hint (no italic on Thai text; muted colour reserved for empty sentinels, never for links or states).

## Related specifications to amend

This feature deliberately reverses or narrows earlier decisions. Each MUST receive an `AMENDMENT` block (house precedent: PR #335 in the broadcast spec) in the PR that ships the behaviour it describes (tasks T107 → PR-A, T108 → PR-B, T109 → PR-D, T080 → PR-C), so no earlier spec states something prod no longer does:

- `specs/010-email-broadcast/spec.md` — Clarifications Q8 and FR-015 / FR-015c ("primary contact only; secondary contacts are NOT recipients"); Q16 self-exclusion ("the submitter's primary contact email" → all of the submitter's contacts); FR-002 (h) and FR-016a audience ceiling wording (no silent truncation; batching path); the "member missing primary contact email" edge case (redefined by FR-029).
- `specs/014-email-broadcast-advance/f71b-backlog.md` — US3 "Per-contact opt-in (default FALSE, backfill TRUE for primaries)" is superseded by the opt-out model here (FR-027); its promotion criterion (b) is satisfied by the SweCham request of 2026-09-04.
- `specs/005-members-contacts/spec.md` — FR-003 ("exactly one primary contact") is now enforced on every mutation and against races (FR-010–FR-012); FR-011 ("primary/secondary is a single flag") gains the per-contact marketing state.
- `specs/007-invoices-receipts/spec.md` — FR-038 buyer-identity snapshot: clarify that the snapshot fixes the document buyer, not the email recipient (FR-001 / FR-002).
- `specs/016-rbac-permissions/spec.md` — permission catalogue grows by one right ("manage contact marketing audience") and the marketing bundle gains it (FR-030 / FR-030a); the pinned catalogue goes from 41 to 42 keys. The reserved-but-unenforced `contacts.read` key gains its first surface (the Marketing audience page, read-only view).
