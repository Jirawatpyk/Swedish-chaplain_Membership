# Feature Specification: E-Blast Two-Sided Approval Workflow, Writing Tool Upgrade & Marketing Dashboard

**Feature Branch**: `119-eblast-approval-workflow`  
**Created**: 2026-09-17  
**Status**: Draft  
**Input**: User description: "3. Event & Marketing Module (get ready to enable). Please prepare this module so SweCham can test it and give feedback. It needs: (a) a dashboard for the marketing team to track e-blast/newsletter activity with status; (b) this approval flow: Member writes content + proposed schedule → sent to SweCham marketing to review → marketing formats/designs it → sent back to member to approve → if member rejects, it goes back to SweCham to fix → once member approves, SweCham is notified and confirms the final schedule."

## Context — what exists today and what this feature adds

The E-Blast benefit (F7) and the Events integration (F6) are both already live for SweCham. Today's
E-Blast flow is **one-sided**: a member writes content and proposes a send time → staff approve
(choosing send-now or a schedule) or reject with a reason → the system sends. Three properties of
today's flow make the requested process impossible:

1. Content is frozen the moment a member submits it; nobody — including marketing — can improve it.
2. A rejection is final; the member must start again from a blank draft.
3. The member never sees, let alone signs off, what is actually sent; and the member's proposed
   send time is silently replaced by whatever staff choose at approval.

Staff also learn about new submissions only by opening the review queue, and the queue shows status
but no delivery results, no "who has to act next", and no view of upcoming sends.

The staff portal's Engagement area already has three marketing surfaces: the **E-Blast review list**
(what is being sent and its status), **Events**, and — since feature 108 — a separate **Marketing
audience** page (who can receive E-Blasts: every contact, their marketing opt-in state, who changed
it and when). The audience question is therefore already answered and is **not** rebuilt here: the
dashboard in this feature is about E-Blast *activity*, and points to the Marketing audience page
for anything about *recipients*.

The request says "e-blast/newsletter", which can mean one thing or two. Every step of the requested
flow (a member writes, marketing formats, the member approves) is an E-Blast step. SweCham's own
E-Newsletter is a different thing: a separate Partnership benefit in the Membership Package
("promotion of corporate news in Newsletter", "hyperlinked logo in all E-Newsletters"), produced
outside the platform today. **Scope decision (2026-09-17)**: this feature covers the member E-Blast
only. That part is needed whichever reading SweCham confirms, so work starts on it now. The chamber
E-Newsletter is **out of scope** here and parked as a separate candidate feature,
`specs/120-chamber-newsletter/`, which is opened only if SweCham confirms they want it; it would
reuse this feature's editor, delivery, and dashboard. SweCham has been asked through a
scope-confirmation document (EN + TH).

A second finding changes the shape of the feature. The step "marketing formats/designs it" only
has value if marketing can do more to an E-Blast than the member can. Today the writing tool
offers bold, italic, underline, two list types and links; headings, quotes and dividers work but
have no buttons; images can be added only by the member and only after saving a draft (staff
cannot add images at all); the preview strips images and shows the bare text instead of the real
email; and the email itself is a fixed frame with the chamber's name as plain text, no logo, no
button, no banner. With that tool, marketing's "formatting" would be copy-editing that the member
could do themselves, and the sign-off round would be ceremony. A code-level audit (2026-09-18)
also found defects SweCham would hit on day one of testing — most seriously, choosing a template
after typing silently discards what was typed.

This feature therefore has three parts, all in scope: **(1)** the two-sided approval flow with
hand-off notifications and the tracking dashboard, built on the existing staff E-Blast list;
**(2)** an upgrade of the writing tool so marketing can genuinely design an E-Blast within the
platform's content-safety rules; **(3)** bringing every E-Blast screen up to the platform's UX
standard, fixing the defects found. It **extends the existing E-Blast flow** — it does not replace
it and does not create a parallel request system.

## Clarifications

### Session 2026-09-17 (`/speckit.specify`)

- Q: What does "e-blast/newsletter" cover — member E-Blasts only (A), also tracking member news for
  the chamber's newsletter (B), or authoring and sending the chamber's own newsletter from the
  platform (C)? → A: **Option A for this feature; the newsletter is parked as feature 120.** First
  answered C, then revised the same day after checking the Membership Package: E-Blast and
  E-Newsletter are separate benefits and the requested flow only fits an E-Blast. Option A is a
  strict subset of the full scope — it is needed whatever SweCham answers and the newsletter does
  not change its design — so 119 proceeds now without waiting. Which reading SweCham intends is
  still open (scope-confirmation document sent, EN + TH). If they want the chamber newsletter, it
  is specified as its own feature from the notes in `specs/120-chamber-newsletter/`; option B
  (a member news-submission workflow) was not selected.

### Session 2026-09-18 (maintainer, after the code-level exploration)

- Q: Is the current writing tool enough for the "marketing formats/designs it" step? → A: **No.**
  With today's tool marketing can do nothing a member cannot, so the step has no reason to exist
  (maintainer: "ถ้าระดับ 1 จะมี Market มาดูทำไม"). The writing-tool upgrade is part of 119.
- Q: Which design capabilities go in now — only what the system already supports, or also
  system-controlled design blocks? → A: **Both.** Tier 1 (expose supported formatting, staff
  images, alt text, a real preview) and a minimum Tier 2 set (call-to-action button, full-width
  banner image, chamber logo in the email header) are in 119 now. SweCham has still been asked for
  2–3 real past E-Blasts; those refine the block set, they do not gate it. Tier 3 (free colours and
  fonts, raw HTML, tables, embedded video) stays out.
- Q: Are the defects found by the audit fixed as a separate small PR or inside 119? → A: **Inside
  119**, as their own user story, so SweCham never tests against them.
- Q: Should the preview become a button that opens a pop-up? → A: **Both**: the inline preview
  stays but shows the real email and a proper empty state, and a Preview button opens a dialog
  with desktop and phone widths. The same preview is reused on the member's compare screen.
- Q: Are templates still needed? → A: **Kept, demoted to a starting point.** They are plain text
  skeletons today; they regain value once design blocks exist. Choosing one must never discard
  typed content.

### Session 2026-09-18 (`/speckit.clarify`)

- Q: When a member submits an E-Blast, or the work comes back to SweCham (member approved, member
  requested changes), which staff should receive the notification email? → A: **Only users with
  the `marketing` role; if the tenant has no such user, notify the tenant's admins instead.**
  Admins and super-admins still see the waiting count in the navigation and on the dashboard.
- Q: Where do the chamber's logo, brand colour and postal address used in the email header and
  footer come from? → A: **A per-tenant "Brand" settings page**: the logo (the same one already
  used on invoices — not uploaded twice), one primary colour (contrast-checked so text on it meets
  WCAG AA), and the chamber's postal address. Editable by holders of the existing E-Blast settings
  permission; every change audited. No full palette, no font choice.
- Q: If a member approves a formatted version and then changes their mind before the email is
  sent, what can they do? → A: **Withdraw their approval, with a reason, at any time before
  sending begins.** The E-Blast returns to "Changes requested by member", marketing is notified,
  and a confirmed schedule (if any) is cancelled. No new stage is added; withdrawing the whole
  E-Blast remains available as before.
- Q: If the member never responds after the final reminder, should the E-Blast close
  automatically? → A: **Yes — 30 days after the version was sent to the member**, with a warning
  to both sides on day 23. Closing frees the member's allowance place; a closed E-Blast cannot be
  reopened — the member submits again. Aligns with the existing 30-day draft lifetime.
- Q: May chamber templates contain design blocks and images, and where do template images come
  from? → A: **Yes to both.** A template may hold every block the tool offers, and images uploaded
  for a template are tied to that template under the same size, type, virus-scan and source rules.
  When a member starts from a template, its images come along into the member's draft by
  reference; the copy the member then edits is theirs.

### Session 2026-09-18 (`spec-review-panel`, 8 lenses, 26 agents — GO WITH AMENDMENTS)

- Confirmed #9/#5 (HIGH, premise): storing versions as separate records is not enough — the
  database rule that freezes a submitted E-Blast also freezes the body column the sender reads
  and the send time (exempt only on today's submit→approve edge), so the approved version could
  never reach the sender and the confirm/withdraw writes would be refused. → **FR-012a added,
  FR-017 extended**: the spec now owns the amendment of that rule, in the same migration as the
  new stages, with a direct-edit-still-refused test.
- Confirmed #7 (HIGH, blocker): letting the Brand page write the invoice logo would move a
  super-admin-only, tax-document control down to the admin tier. → **FR-041b rewritten**: the
  Brand page reads the logo and links to its existing page; only colour and address are writable.
- Refuted (do not re-raise): design blocks vs sanitiser, staff-only trial list, FR-015a raising
  at the database, proposal sent unapproved, "marketing role" inexpressible, image erasure vs
  template references, erasure missing new stages. Plan-time notes from these residuals are in
  `exploration-2026-09-18.md` § Panel carry-forwards.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Marketing formats a submitted E-Blast and the member signs it off (Priority: P1)

A member submits E-Blast content with a proposed send time, exactly as today. A marketing team
member opens it, and instead of only "approve" or "reject" can now start a **formatted version**:
they improve the subject and body (layout, wording, headings, links, images) while the member's
original stays untouched and visible alongside. When satisfied, marketing sends the formatted
version to the member, optionally with a note. The member is notified, opens the E-Blast in the
portal, sees a faithful preview of exactly what recipients would receive (including the chamber
header and footer) next to their original, and approves it. Marketing is notified, confirms the
final send time (the member's proposed time is shown and pre-selected), and the E-Blast is
scheduled and sent through the existing delivery path.

**Why this priority**: This is the core of the request. Without it, SweCham's real-world process
(marketing designs, member signs off) happens over private email with no record, and the platform
sends content the member never saw in its final form.

**Independent Test**: With one test member and one marketing user, submit an E-Blast, format it,
send it to the member, approve it as the member, confirm the schedule as marketing, and verify the
E-Blast that is delivered is identical to the version the member approved.

**Acceptance Scenarios**:

1. **Given** a submitted E-Blast, **When** a marketing user starts a formatted version and saves
   changes, **Then** the member's original content is unchanged and both versions are viewable by
   marketing.
2. **Given** a saved formatted version, **When** marketing sends it to the member, **Then** the
   E-Blast shows as "Awaiting member approval", the member receives a notification in their
   preferred language, and marketing can no longer edit that version.
3. **Given** an E-Blast awaiting member approval, **When** the member opens it in the portal,
   **Then** they see a faithful preview of the formatted version, their original for comparison,
   marketing's note, and the proposed send time.
4. **Given** the member approves the formatted version, **When** approval is recorded, **Then**
   the E-Blast shows as "Member approved — awaiting schedule", and marketing staff are notified.
5. **Given** a member-approved E-Blast, **When** marketing confirms the schedule, **Then** the
   member's proposed time is shown and pre-selected if it is still far enough in the future,
   marketing may keep it, change it, or send now, and the member is notified of the final time —
   with the difference called out when it is not the time they proposed.
6. **Given** a member-approved E-Blast, **When** it is sent, **Then** the subject and body
   delivered are exactly the version the member approved.
7. **Given** a submitted E-Blast that needs no formatting, **When** marketing chooses to approve
   it as submitted, **Then** today's behaviour applies unchanged (no member sign-off round,
   because the content is the member's own).

---

### User Story 2 - Member asks for changes and marketing fixes them (Priority: P1)

The member reviews the formatted version and is not happy — a wrong date, a logo they don't want,
a changed sentence. They choose "Request changes" and must say what is wrong. The E-Blast goes back
to marketing, who see the member's feedback next to the version it refers to, prepare a new
version, and send it back. The cycle repeats until the member approves, or either side ends it.

**Why this priority**: Without the way back, the first disagreement forces a cancel-and-start-over,
which is precisely today's pain. US1 alone is not shippable without it.

**Independent Test**: As the member, request changes with a comment on a formatted version; verify
it returns to marketing with the comment; send a second version; approve it; verify the second
version — not the first — is what is sent, and that the history shows both rounds.

**Acceptance Scenarios**:

1. **Given** an E-Blast awaiting member approval, **When** the member requests changes without
   giving a reason, **Then** the request is refused and the member is told a reason is required.
2. **Given** the member requests changes with a reason, **When** it is recorded, **Then** the
   E-Blast shows as "Changes requested by member", marketing staff are notified, and the member's
   feedback is shown to marketing attached to the version it was about.
3. **Given** changes were requested, **When** marketing sends a new version, **Then** it becomes
   round 2, the member is notified again, and the earlier version and feedback remain in the
   history for both sides.
4. **Given** several rounds have happened, **When** either side views the E-Blast, **Then** they
   see every version, who sent it and when, each piece of feedback, and the final approval, in
   order.
5. **Given** an E-Blast in any pre-send stage, **When** the member withdraws it or marketing
   rejects it with a reason, **Then** the flow ends, the other side is notified, and the member's
   annual E-Blast allowance is not reduced.
6. **Given** the member approved a version (and marketing may already have confirmed a send
   time), **When** the member withdraws their approval with a reason before sending begins,
   **Then** the E-Blast returns to "Changes requested by member", the send time is cancelled,
   marketing is notified, and the history shows the withdrawn approval and its reason.

---

### User Story 3 - Marketing has a real writing tool (Priority: P1)

A marketing user opens a submitted E-Blast to format it and finds a writing tool that lets them
do what a marketing person expects: headings, quotes, dividers, links with their own text, images
with a caption for screen readers, a call-to-action button, a full-width banner image, and the
chamber's logo at the top of the email — all without ever touching raw HTML or colours. The same
tool serves the member when they write their original. A preview shows the email exactly as a
recipient will see it, on a desktop and on a phone, and a test copy can be sent to the user's own
inbox. Everything the tool offers survives sending: nothing a user can add is silently removed
later.

**Why this priority**: Without it, marketing can do nothing a member cannot, and the approval round
in US1/US2 has no purpose. It is also a visible improvement for members on day one, independent of
the approval flow.

**Independent Test**: As marketing, format a submitted E-Blast using a heading, a banner image, a
paragraph, a call-to-action button and the chamber logo; preview it at desktop and phone width;
send a test copy; verify the test copy, the preview and the delivered email are identical and that
no element was stripped.

**Acceptance Scenarios**:

1. **Given** the editor, **When** a user looks at the toolbar, **Then** every formatting the
   platform will keep after sending (headings, quote, divider, lists, bold, underline, links,
   image, button, banner) has a visible control, and nothing the platform would later strip can
   be produced by a keyboard shortcut.
2. **Given** a user inserts an image, **When** the image is added, **Then** they are asked for a
   short description (alt text) and cannot finish without one.
3. **Given** a staff user is formatting a submitted E-Blast, **When** they add an image or a
   banner, **Then** it uploads and appears in the version, subject to the same size, type, virus
   and source rules as a member's image.
4. **Given** a user adds a call-to-action button, **When** they set its text and link, **Then**
   the button renders in the chamber's brand colours in the preview and in the delivered email;
   the user cannot choose colours or fonts.
5. **Given** the chamber has a logo on file, **When** any E-Blast is previewed or sent, **Then**
   the logo appears in the email header; without a logo, the chamber name appears as today.
6. **Given** the message is empty, **When** the compose page loads, **Then** the preview area
   shows an empty state, not a blank box.
7. **Given** a message with content, **When** the user opens the Preview, **Then** they see the
   complete email — header, body, footer with unsubscribe — and can switch between desktop and
   phone width; closing the preview returns focus to the Preview button.
8. **Given** the user's interface language is Thai, **When** they use the toolbar, **Then** italic
   is not offered.
9. **Given** a user saves a draft and then closes the page, **When** nothing changed since the
   save, **Then** no "unsaved changes" warning appears.

---

### User Story 4 - Marketing tracks every E-Blast on one dashboard (Priority: P2)

A marketing team member opens the E-Blast dashboard and immediately sees how many E-Blasts are in
each stage, which ones are waiting on **marketing** versus waiting on the **member**, which have
been stuck longest, what is scheduled to go out in the coming weeks, and how recently sent ones
performed (delivered, bounced, complained). They can filter by stage, member, and date, and open
any E-Blast from the list.

**Why this priority**: The second explicit request. It is P2 only because the workflow (US1/US2)
creates the stages the dashboard reports on; the dashboard is still valuable for today's statuses
alone.

**Independent Test**: Seed E-Blasts across all stages; open the dashboard as a marketing user and
verify counts per stage match, "whose turn" is correct for each row, stalled items are flagged,
upcoming sends are listed in time order, and sent items show delivery results.

**Acceptance Scenarios**:

1. **Given** E-Blasts in various stages, **When** a marketing user opens the dashboard, **Then**
   they see a count per stage, and selecting a stage filters the list to it.
2. **Given** any E-Blast in progress, **When** it appears in the list, **Then** the row shows the
   member, subject, current stage, whose turn it is (marketing or member), how long it has been in
   that stage, the round number, the proposed send time, and the confirmed send time if any.
3. **Given** an E-Blast has waited in any marketing-held stage longer than the review target, or
   on the member longer than the reminder threshold, **When** the dashboard loads, **Then** it is
   visibly flagged as stalled.
4. **Given** scheduled E-Blasts exist, **When** the user views upcoming sends, **Then** they are
   listed in send-time order so clashes on the same day are obvious.
5. **Given** a sent E-Blast, **When** it appears in the list or its detail, **Then** staff see
   recipients, delivered, bounced, and complained counts.
6. **Given** a user with read-only access (manager), **When** they open the dashboard, **Then**
   they see everything but cannot act.

---

### User Story 5 - Nobody has to poll: hand-off notifications and reminders (Priority: P2)

Marketing staff are notified when a member submits a new E-Blast (today they are not). When an
E-Blast has been waiting on the member for several days, the member gets a reminder. Marketing
always sees in-app how many items are waiting on them.

**Why this priority**: A two-sided flow stalls silently without it. It is separable from US1/US2
because those stories already notify at each approval/rejection hand-off.

**Independent Test**: Submit an E-Blast and verify marketing staff are notified; leave an E-Blast
awaiting member approval past the reminder threshold and verify exactly one reminder per threshold
is sent and nothing is auto-approved.

**Acceptance Scenarios**:

1. **Given** a member submits an E-Blast, **When** the submission is recorded, **Then** every
   marketing-role user in the tenant is notified — or the admins, when the tenant has no
   marketing-role user.
2. **Given** an E-Blast has awaited member approval for 3 days, **When** the reminder check runs,
   **Then** the member receives one reminder; a second and final reminder is sent at 7 days.
3. **Given** an E-Blast awaits member approval, **When** any amount of time passes, **Then** it is
   never approved automatically; on day 23 both sides are warned, and on day 30 it is closed as
   expired and the member's allowance place is freed.
4. **Given** items are waiting on marketing, **When** a marketing user is anywhere in the staff
   portal, **Then** the navigation shows how many are waiting.

---

### User Story 6 - Every E-Blast screen meets the platform's standard (Priority: P2)

Before SweCham tests, the E-Blast screens behave like the rest of the portal: nothing a user types
is lost without warning, every error is announced to assistive technology, every list has a proper
empty state and a loading skeleton that matches the real page, every page has an error boundary,
and the member can read the content of an E-Blast they submitted.

**Why this priority**: The audit found defects SweCham would hit in their first session. Fixing
them inside 119 means the trial tests the feature, not the defects.

**Independent Test**: Run the platform's UX checklist and an automated accessibility scan on every
E-Blast screen; type into the compose form, pick a template and confirm nothing is lost.

**Acceptance Scenarios**:

1. **Given** a member has typed a subject or message, **When** they pick a template, **Then** they
   are asked to confirm before their text is replaced.
2. **Given** a member submitted an E-Blast, **When** they open it from their list, **Then** they
   can read its subject and content, not only its status.
3. **Given** an E-Blast page fails to load, **When** the error occurs, **Then** the user sees the
   platform's standard error state with a retry, on every E-Blast route.
4. **Given** a screen reader user gets a validation error on the message, **When** focus lands on
   the editor, **Then** the error text is announced.
5. **Given** a staff user opens the compose-on-behalf form, **When** they work in it, **Then** it
   offers what the member form offers: drafts, images, the template picker, the member's
   allowance display, the subject counter, the preview and the unsaved-changes guard.
6. **Given** any E-Blast screen, **When** it is scanned for accessibility, **Then** it passes with
   zero serious or critical issues, and the toolbar is operable with arrow keys.

---

### User Story 7 - SweCham can trial the whole flow safely and give feedback (Priority: P3)

SweCham staff run the complete flow end to end — as a member and as marketing — before it is
offered to members, without any email reaching a real member's contacts, and with the ability to
switch the new flow off again without affecting E-Blasts already in the existing flow.

**Why this priority**: The request is explicitly "so SweCham can test it and give feedback". It is
P3 only in build order: it depends on US1–US6 existing.

**Independent Test**: With the new flow switched on, run the UAT walkthrough using a designated
test member and a recipient list made only of SweCham staff addresses; verify zero emails reach
anyone else; switch the flow off and verify today's flow behaves exactly as before.

**Acceptance Scenarios**:

1. **Given** the new flow is switched off, **When** members and staff use E-Blasts, **Then** the
   approve/reject flow behaves exactly as today (the upgraded writing tool and the screen fixes
   remain, as they are not governed by the switch).
2. **Given** the new flow is switched on, **When** SweCham follows the UAT walkthrough with a test
   member and a staff-only recipient list, **Then** every stage can be exercised and no email is
   delivered outside that list.
3. **Given** E-Blasts are mid-flow in a new stage, **When** the new flow is switched off,
   **Then** those E-Blasts are not lost or sent unapproved — they can still be completed or
   cancelled.

---

### Edge Cases

- **Member withdraws approval after the send time was confirmed**: the scheduled send is
  cancelled before it can run; if sending has already begun, the withdrawal is refused with a
  clear message and the send completes.
- **Marketing edits after the member approved**: any content change after member approval voids
  the approval and requires a new round. There is no path by which marketing-edited content is
  sent without the member having approved that exact version.
- **Proposed time already passed** by the time the member approves: marketing must pick a new
  time; the member is told the final time differs from their proposal.
- **Two marketing users format the same E-Blast at once**: the second save is refused with a clear
  "someone else changed this" message rather than silently overwriting; the list shows who last
  worked on it.
- **Member and marketing act at the same moment** (member approves while marketing withdraws the
  version, or member withdraws while marketing sends a version): exactly one action wins; the
  other party gets a clear "this E-Blast has changed" message.
- **Member's membership lapses or the member is put on a sending halt mid-flow**: the existing
  rules that block sending still apply at send time; marketing sees why it is blocked.
- **Member's allowance**: the E-Blast keeps its place in the member's annual allowance for the
  whole time it is in progress (any stage), so a member cannot start extra E-Blasts while one is
  in design; the allowance is only used up when the E-Blast is actually sent, and is freed by
  rejection, withdrawal, or failure — regardless of how many rounds happened.
- **Member requests erasure of their data mid-flow**: in-progress E-Blasts are cancelled as today,
  and every stored version and feedback comment is covered by the same redaction as the E-Blast
  itself.
- **Formatted content breaks the content rules** (unsafe markup, disallowed image source, over
  size): marketing's version is subject to the same content safety rules as a member's and cannot
  be sent to the member until it passes.
- **Member contact who submitted has left the company**: any authorised portal user of the same
  member company can review and approve.
- **A design block in an email client that cannot show it**: the call-to-action button and banner
  degrade to a plain link and a plain image; the message is never unreadable.
- **A very large image**: rejected with a clear message and the allowed limit; the user's text is
  untouched.
- **Image left without a description**: the block cannot be inserted; the prompt explains why.
- **A staff user adds an image to another member's E-Blast**: allowed only on the E-Blast they are
  formatting; the upload is tied to that E-Blast and refused otherwise.
- **A template's image is removed after members started from it**: the E-Blasts already started
  keep working (snapshot semantics as today); only new starts from the template are affected.
- **The chamber has no logo on file**: the email header shows the chamber name as today; marketing
  is told where to add a logo (the Brand settings page).
- **Brand colour too light for white text**: the setting is refused with the reason; the previous
  colour (or the platform default) stays in force.
- **Preview vs delivered email differ**: treated as a defect — the preview is generated from the
  same source as the sent email.
- **Member never responds**: reminders at day 3 and 7, an expiry warning to both sides at day 23,
  automatic close as "Expired — no member response" at day 30 (allowance place freed, no
  reopening). Until then it stays "Awaiting member approval", keeps its allowance place and is
  flagged as stalled; marketing may still reject it earlier with a reason.
- **Many rounds**: there is no hard cap, but the round number is visible on the dashboard so a
  long-running negotiation is noticed.
- **A staff user submits on the member's behalf** (existing proxy submission): the member sign-off
  round still applies whenever content was formatted; approval must come from the member side,
  never from the staff user who proxied.

## Requirements *(mandatory)*

### Functional Requirements

**Formatting & versions**

- **FR-001**: Marketing staff MUST be able to create a formatted version (subject and body) of a
  submitted E-Blast without altering the member's original submission.
- **FR-002**: The system MUST keep the member's original submission and every version that was
  sent to the member, each with who sent it and when, for the life of the E-Blast record.
- **FR-003**: A version MUST become read-only the moment it is sent to the member.
- **FR-004**: Marketing's formatted content MUST pass the same content safety and size rules that
  apply to member-written content before it can be sent to the member.
- **FR-005**: Marketing MUST NOT be able to change the E-Blast's audience; the audience remains
  the one the member chose.
- **FR-006**: Marketing MUST be able to attach an optional note to the member with each version.
- **FR-007**: Marketing MUST still be able to approve an E-Blast as submitted (no formatting, no
  member sign-off round) and to reject it with a reason, as today.

**Member sign-off**

- **FR-008**: The member MUST be able to see a faithful preview of the formatted version as
  recipients would receive it, alongside their original submission and marketing's note.
- **FR-009**: The member MUST be able to approve the version, optionally adding a short note.
- **FR-010**: The member MUST be able to request changes, and MUST provide a reason when doing so.
- **FR-011**: A request for changes MUST return the E-Blast to marketing with the feedback
  attached to the version it concerns; marketing MUST be able to send a further version, and the
  cycle MUST be repeatable.
- **FR-012**: The content that is sent MUST be exactly the version the member approved (or the
  member's own original on the approve-as-submitted path). Any content change after member
  approval MUST void that approval.
- **FR-012a**: The version the member approved MUST become the content the delivery path sends;
  the delivery path MUST NOT read content from any record that could differ from the approved
  version. The database rule that today freezes a submitted E-Blast's subject, body, audience,
  custom recipients and send time MUST be amended — in the same migration that introduces the
  new stages — to permit exactly two further post-submit changes: (a) promotion of the
  member-approved version into the sending record on the transition this feature defines for
  it, and (b) the marketing-confirmed send time (its confirmation, change, and its cancellation
  on withdrawal of approval) on the transitions this feature defines for those. Subject, body,
  audience and custom recipients MUST stay frozen on every other transition, and the send time
  MUST stay frozen everywhere else. A test MUST prove that a direct edit of a submitted E-Blast's
  subject, body or send time on any non-exempt transition is still refused by the database.
- **FR-013**: Only portal users of the member company that owns the E-Blast MUST be able to view,
  approve, or request changes on it. A staff user MUST NOT be able to give the member-side
  approval, including when the staff user submitted it on the member's behalf.
- **FR-014**: The system MUST NOT approve on the member's behalf after any period of inactivity.
- **FR-015**: The member MUST be able to withdraw the E-Blast, and marketing MUST be able to reject
  it with a reason, at any stage before sending begins; the other party MUST be notified.
- **FR-015a**: A member MUST be able to withdraw an approval they gave, with a reason, at any time
  before sending begins (including after marketing confirmed the schedule). The E-Blast MUST return
  to "Changes requested by member", any confirmed schedule MUST be cancelled, the withdrawal MUST
  be attached to the version it concerns, and marketing MUST be notified.

**Schedule**

- **FR-016**: The member's proposed send time MUST be preserved as proposed and remain visible to
  both sides throughout, separately from the confirmed send time.
- **FR-017**: After member approval, marketing MUST confirm the final send time (keep the proposal,
  choose another time, or send now), subject to the existing minimum lead time. Confirming,
  changing or cancelling the confirmed send time MUST remain possible on every pre-send stage
  this feature introduces; whether cancellation clears the confirmed time or only moves the
  E-Blast off the dispatchable stage is a design decision, but an E-Blast whose approval was
  withdrawn MUST NOT be dispatchable, and the database immutability rule MUST permit the write
  the chosen design needs (FR-012a).
- **FR-018**: The member MUST be notified of the confirmed send time, with an explicit indication
  when it differs from the time they proposed.

**Stages & allowance**

- **FR-019**: Each E-Blast MUST show exactly one stage at any time, from: Draft · Awaiting
  marketing review · In design · Awaiting member approval · Changes requested by member ·
  Member approved — awaiting schedule · Scheduled · Sending · Sent · and the closed outcomes
  (Rejected, Withdrawn/Cancelled, Expired — no member response, Failed).
- **FR-020**: An E-Blast in any in-progress stage MUST hold its place in the member's annual
  E-Blast allowance; the allowance MUST be consumed only when the E-Blast is sent and MUST be
  freed by rejection, withdrawal, expiry, or failure.

**Notifications**

- **FR-021**: The system MUST notify the next party at every hand-off: new submission → marketing;
  version sent → member; member approved → marketing; member requested changes → marketing;
  schedule confirmed → member; rejected or withdrawn → the other party.
- **FR-021a**: "Marketing" as a notification recipient means every active user holding the
  `marketing` role in the tenant; when no such user exists, the tenant's admins are notified
  instead. Other staff are never emailed for hand-offs but always see the in-app count (FR-023).
- **FR-022**: The system MUST send the member a reminder after 3 days and a final reminder after
  7 days of an E-Blast awaiting their approval, and no further reminders.
- **FR-022a**: An E-Blast that has awaited the member's decision for 30 days (counted from the
  moment the version was sent to them) MUST be closed automatically as "Expired — no member
  response", freeing the member's allowance place; both sides MUST be warned on day 23 and told
  on closing. A closed E-Blast MUST NOT be reopened; the member submits a new one. The clock
  always runs from the latest version sent to the member.
- **FR-023**: Staff MUST see an in-app count of E-Blasts waiting on marketing.
- **FR-024**: Member-facing notifications MUST be in the member's preferred language.

**Dashboard**

- **FR-025**: The dashboard MUST show a count of E-Blasts per stage, and selecting a stage MUST
  filter the list.
- **FR-026**: Each listed E-Blast MUST show member, subject, stage, whose turn it is, time in
  current stage, round number, proposed send time, confirmed send time, and last activity.
- **FR-027**: The dashboard MUST flag E-Blasts stalled in any stage where it is marketing's turn
  for longer than the review target, or on the member for longer than the reminder threshold.
- **FR-028**: The dashboard MUST list upcoming scheduled sends in send-time order.
- **FR-029**: For sent E-Blasts, staff MUST be able to see recipients, delivered, bounced, and
  complained counts.
- **FR-030**: The dashboard MUST be filterable by stage, member, and date range, and MUST be the
  same list staff already use for E-Blast review — not a second, parallel list.
- **FR-031**: The dashboard MUST cover every E-Blast that goes through the platform, whether the
  member submitted it or staff submitted it on the member's behalf. The chamber's own E-Newsletter
  is out of scope and does not appear on it.
- **FR-036**: The dashboard MUST NOT reproduce contact-level recipient data. It shows recipient
  *counts* only and links to the existing Marketing audience page for who the recipients are and
  their opt-in state.

**History & safety**

- **FR-032**: Both sides MUST be able to see the full history of an E-Blast: versions, feedback,
  approvals, and schedule decisions, in order, with who and when.
- **FR-033**: When two people act on the same E-Blast at once, exactly one action MUST succeed and
  the other MUST receive a clear message that the E-Blast changed.
- **FR-034**: With the new flow switched off, the approve/reject flow MUST behave as today (the
  writing tool and screen fixes of US3/US6 are not governed by the switch), and E-Blasts already
  in a new stage MUST remain completable or cancellable and MUST NOT be sent without the required
  member approval.
- **FR-035**: A written UAT walkthrough (EN + TH) MUST be delivered that lets SweCham exercise
  every stage using a test member and a staff-only recipient list.

**Writing tool**

- **FR-037**: Any user of the writing tool — a member on their original, staff on a formatted
  version — MUST be able to send a test copy to their own address only; a test copy MUST be marked
  as a test and MUST NOT change the E-Blast's stage, its version history, or any allowance.
- **FR-038**: The writing tool MUST offer a visible control for every kind of content the platform
  keeps after sending — headings, quote, divider, bulleted and numbered lists, bold, underline,
  links with editable link text, images — and MUST NOT let a user produce content (by shortcut or
  paste) that the platform later removes.
- **FR-039**: The writing tool MUST be the same for members writing an original and for marketing
  formatting a version, on the member compose screen, the staff compose-on-behalf screen and the
  template screens; the staff compose-on-behalf screen MUST offer drafts, images, the template
  picker, the member's allowance display, the subject counter, the preview and the
  unsaved-changes guard like the member screen.
- **FR-040**: Inserting an image MUST require a short text description; the description MUST be
  carried into the sent email. Images added by staff to an E-Blast they are formatting MUST pass
  the same size, type, virus-scan and source rules as a member's image and MUST be tied to that
  E-Blast (or, on the template screens, to that template — FR-046a).
- **FR-041**: The tool MUST offer system-controlled design blocks: a call-to-action button (text +
  link) and a full-width banner image. Their appearance (colours, fonts, spacing) is defined by
  the platform and the chamber's brand settings; a user MUST NOT be able to set colours, fonts,
  sizes, raw HTML or styling.
- **FR-041a**: Every E-Blast's email header MUST show the chamber's logo when one is on file and
  the chamber's name otherwise, automatically — it is not something a user adds or removes.
- **FR-041b**: The chamber's brand settings MUST be a single per-tenant settings page showing the
  logo, exactly one primary colour, and the chamber's postal address. The logo is the one already
  held for invoices and MUST be READ through a module interface — set once on its existing page,
  used in both places; the Brand page MUST NOT offer any control that uploads, replaces or clears
  it, and MUST link to the existing page, where changing the logo stays gated on the invoice
  settings permission (super-admin only, because the logo prints on issued tax documents). Only
  the primary colour and the postal address are writable from the Brand page, by holders of the
  existing E-Blast settings permission; the colour MUST be refused when white text on it would
  not meet WCAG AA contrast; every change MUST be audited with previous and next values. A
  contract test MUST assert that no route reachable with the E-Blast settings permission alone
  can write the invoice logo.
- **FR-041c**: The call-to-action button MUST use the primary colour from the brand settings; when
  none is set, a platform default colour applies. The email footer MUST show the chamber's postal
  address from the brand settings; while it is not set, the footer MUST show the chamber name only
  and the brand settings page MUST flag the address as missing.
- **FR-042**: Every design block MUST render identically in the preview and in the delivered email
  and MUST degrade to readable plain content in email clients that cannot show it.
- **FR-043**: The preview MUST show the complete email as a recipient receives it — header, body,
  footer with unsubscribe — in the recipient's likely widths (desktop and phone); the inline preview
  MUST show an empty state when the message is empty; a Preview control MUST open the full preview
  in a dialog that returns focus to the control on close. The same preview MUST be used on the
  member's compare screen (original vs formatted version).
- **FR-044**: Italic MUST NOT be offered when the user's interface language is Thai.
- **FR-045**: Saving a draft MUST clear the unsaved-changes state; a user who saved and changed
  nothing since MUST NOT be warned on leaving.
- **FR-046**: Templates MUST remain available as a starting point; choosing one while the subject
  or message is non-empty MUST ask for confirmation first; template use MUST be counted so adoption
  can be measured.
- **FR-046a**: A template MUST be able to contain every kind of content and design block the tool
  offers, including images. Images uploaded for a template MUST be tied to that template and pass
  the same size, type, virus-scan and source rules as E-Blast images. Starting an E-Blast from a
  template MUST carry its images into the draft by reference; a template later edited or deleted
  MUST NOT change E-Blasts already started from it.

**Screen quality**

- **FR-047**: Every E-Blast route MUST have an error state, a loading state that matches the real
  page's shape, and empty states from the platform's shared components.
- **FR-048**: Validation errors on the message MUST be programmatically associated with the editor
  so assistive technology announces them; the toolbar MUST follow the standard toolbar keyboard
  pattern (arrow keys between controls).
- **FR-049**: The member's E-Blast detail page MUST show the E-Blast's subject and content.
- **FR-050**: The compose screens MUST use a page width that fits the editor and the 600 px email
  preview side by side on large screens and stacked on small ones.
- **FR-051**: Every E-Blast screen MUST pass the platform's UX checklist and an automated
  WCAG 2.1 AA scan with zero serious or critical findings before the trial starts; translation
  keys that no screen uses MUST be removed and components that are never shown MUST be wired or
  deleted.

### Key Entities

- **E-Blast** (existing): a member's request to send one email to a chosen audience. Gains new
  in-progress stages, a preserved *proposed send time* distinct from the *confirmed send time*,
  and a round counter.
- **E-Blast Version**: one snapshot of subject + body. Version 0 is the member's original; each
  later version is a marketing-formatted one. Knows who authored it, when it was sent to the
  member, the accompanying note, and whether it is the approved version.
- **Member Decision**: the member's response to one version — approved (optional note), changes
  requested (mandatory reason), or approval withdrawn (mandatory reason) — with who decided and
  when.
- **Chamber Brand Settings**: one record per tenant — one primary colour and the postal address,
  plus a read-only view of the invoice logo (owned by invoice settings, never written here). Read
  by the email header, footer and call-to-action button; colour and address changed only from the
  Brand settings page, with audit.
- **Design Block**: a system-controlled piece of content a user can add — call-to-action button
  (text + link) and full-width banner image (image + description). The user supplies only the
  content; the platform defines the appearance. The chamber header (logo, or name when no logo is
  on file) is not a block: it is applied automatically to every E-Blast.
- **Hand-off Notification**: a message to the party who must act next, or a reminder.
- **Dashboard Stage Summary**: derived counts and ageing per stage; holds no data of its own.

### Chamber-OS cross-cutting requirements *(mandatory — answer each; "N/A because …" is an answer, a blank is not)*

- **Roles & permissions**: `marketing`, `admin`, `super_admin` can format, send versions to the
  member, reject, and confirm the schedule; `manager` is read-only on the dashboard and detail;
  `member` can view, approve, request changes on, and withdraw **only their own company's**
  E-Blasts. No new permission keys — the existing E-Blast read / write / send permissions cover
  the new staff actions (write = format and send to member; send = confirm schedule); the Brand
  settings page uses the existing E-Blast settings permission (admin tier). Member-side approval
  is never grantable to a staff role.
- **Tenant scope**: versions, member decisions, feedback text, and notifications are all
  tenant-scoped. Nothing about one tenant's E-Blasts may be visible to another tenant; within a
  tenant, one member company must never see another's E-Blasts, versions, or feedback (both
  directions need a probe test).
- **Locales**: all new staff and member screens, stage names, and notification emails in EN
  (canonical) + TH + SV. No tax document is produced. Send times are shown in the tenant's time
  zone; dates display in Buddhist Era for `th-TH` only and are stored as UTC.
- **Personal data**: E-Blast content and free-text feedback/notes may contain personal data;
  author and decider identities are recorded. Lawful basis: performance of the membership contract
  (delivery of the E-Blast benefit). Retention follows the parent E-Blast record. Erasure and
  export must reach every stored version, every feedback/note text and every image uploaded for
  the E-Blast, not only the current content; images of a withdrawn, rejected or erased E-Blast
  must not remain reachable. The record of processing needs an update before the flow is
  switched on for members.
- **Audit trail**: must be auditable — formatted version sent to member, member approved, member
  requested changes, approval voided by a later edit, schedule confirmed (with proposed vs
  confirmed time), approval withdrawn by the member (with the cancelled schedule, if any),
  rejected/withdrawn from a new stage, reminder sent, expiry warning sent, expired for no member
  response, test copy sent, brand settings changed (previous → next). Each with actor, true actor
  role, and time. Free-text reasons and content are not copied into the audit trail. A reviewer
  must be able to prove, for any sent E-Blast, which version was sent and who on the member side
  approved it.
- **Content safety (writing tool)**: the existing rule stands — no user-supplied styling, scripts,
  frames, forms or tables reach an email. Design blocks are the platform's own fixed markup with
  user-supplied text, link and image only; links keep the existing scheme allow-list; images keep
  the existing type, size, virus-scan and per-tenant source rules; the chamber logo is reused from
  the chamber's existing logo on file through a proper module interface, never fetched from a
  user-supplied address.
- **Money & tax**: N/A — no invoice, payment, or tax document is created or changed. The annual
  E-Blast allowance is a benefit entitlement, not a monetary amount (rules in FR-020).
- **Feature flag / kill-switch**: `FEATURE_EBLAST_MEMBER_APPROVAL`, default OFF, governs the
  approval round, its notifications and the dashboard stages. With it off, no new approval action
  is offered and today's approve/reject flow is unchanged. **Not behind the flag** (live for
  everyone on merge, by design): the writing-tool upgrade (US3) and the screen fixes (US6) — they
  improve today's flow and carry no member-approval semantics; a broken design block would be
  rolled back by deploy, so each block ships only with its preview and email rendering tested
  together. Also live regardless of the flag: the new stage values and storage for
  versions/decisions, the new audit and notification types, and the preserved proposed send time.
  The existing E-Blast master switch continues to disable everything.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For any E-Blast, a marketing user can tell its stage and whose turn it is within
  10 seconds of opening the dashboard.
- **SC-002**: 100% of sent E-Blasts whose content marketing changed were approved, in that exact
  version, by a user of the owning member company before sending — provable from the history
  with zero exceptions.
- **SC-003**: A member can review a formatted version and approve or request changes in under
  2 minutes, including on a phone.
- **SC-004**: The next party is notified within 5 minutes of every hand-off.
- **SC-005**: SweCham completes the full UAT walkthrough (submit → format → request changes →
  re-format → approve → confirm schedule → sent) with zero emails delivered outside the
  staff-only test list.
- **SC-006**: With the new flow off, every existing E-Blast acceptance test still passes
  unchanged.
- **SC-007**: No member ever sends more E-Blasts in a year than their plan allows, and no rejected,
  withdrawn, or multi-round E-Blast reduces the allowance by more than the one send.
- **SC-008**: The dashboard is usable (counts and first page of the list visible) within 2 seconds
  with 1,000 E-Blasts of history.
- **SC-009**: After the trial, SweCham marketing reports that they no longer need private email
  threads to agree content with a member.
- **SC-010**: A marketing user can turn a plain member submission into a formatted version with a
  heading, a banner, a call-to-action button and the chamber logo in under 10 minutes, without
  help.
- **SC-011**: For every kind of content the tool offers, zero elements are stripped or altered
  between the editor, the preview, the test copy and the delivered email — verified by an
  automated element-by-element comparison, not by eye.
- **SC-012**: Zero cases of typed content lost without a confirmation, across template selection,
  navigation and draft saving.
- **SC-013**: Every E-Blast screen passes the platform UX checklist and an automated WCAG 2.1 AA
  scan with zero serious or critical findings.

## Assumptions

- **Extend, don't duplicate**: the feature builds on the existing E-Blast record, review list,
  content editor, content safety rules, delivery path, and allowance rules. A separate "content
  request" system was considered and rejected — it would duplicate the editor, the queue, the
  allowance accounting, and the audit trail.
- **Versioning preserves the "frozen after submit" principle**: the member's submission stays
  immutable; marketing's work is a new version rather than an edit of the member's words. This
  keeps the original guarantee (nobody can alter what a member submitted) while allowing
  formatting.
- **Member sign-off is required only when content changed**: if marketing approves as submitted,
  the content is the member's own and no sign-off round is needed. Whether SweCham wants the
  sign-off round to be mandatory for every E-Blast is a candidate question for `/speckit.clarify`.
- **The member gives feedback; marketing makes the fix.** The member does not edit the formatted
  version themselves (matches the requested flow: "if member rejects, it goes back to SweCham to
  fix").
- **Marketing has the final word on schedule**, per the requested flow; the member can still
  withdraw before sending if the final time is unacceptable.
- **The Marketing audience page (feature 108) is reused, not extended.** Recipient eligibility and
  opt-out rules stay exactly as 108 defined them and are applied at send time as today; the
  member-approval round approves *content*, not the recipient list. The dashboard sits beside the
  audience page in the same navigation area, so marketing has one place for "what is going out"
  and one for "who receives it".
- **Delivery may be sliced**: the writing tool and screen fixes (US3, US6), the approval round
  (US1, US2, US5) and the dashboard (US4) are independently shippable. The tool and the fixes
  go first: they improve today's flow immediately and the approval round is pointless without
  the tool.
- **The minimum design-block set was chosen without SweCham's samples.** Call-to-action button,
  full-width banner and chamber logo header are what nearly every chamber E-Blast uses; SweCham's
  2–3 real past E-Blasts (requested) may add or reorder blocks but are not expected to remove any.
  A block SweCham's samples show is unneeded is dropped at `/speckit.plan`, not built.
- **Design blocks carry content, the platform carries appearance.** This keeps the existing
  content-safety model (no user styling) and guarantees every E-Blast looks like it came from the
  chamber. Free colour/font/size choice, raw HTML paste, tables and embedded media are rejected
  deliberately: they break across email clients and defeat the safety rules.
- **The tool upgrade and the screen fixes are not behind the feature flag.** They are improvements
  to the live tool; gating them would leave SweCham testing the approval round on the old tool.
- **A test copy goes only to the requesting user's own address** and is marked as a test; both
  members and staff may request one, since they use the same tool (resolved by the maintainer
  without a question — override at `/speckit.plan` if unwanted).
- **A draft started by staff on a member's behalf belongs to the staff user until submitted**: the
  member does not see it, it holds no allowance place, and it expires like any draft (resolved by
  the maintainer without a question).
- **"Events" needs no build in this feature**: the Events integration and the E-Blast module are
  both already switched on for SweCham; the requested work is entirely on the marketing side.
- **Delivery results are delivered / bounced / complained.** Open and click tracking remain out
  of scope (deferred in the E-Blast backlog) — the request asks to track *status*, not campaign
  performance.
- **Staff hand-off emails go to the `marketing` role** (admins only as a fallback when the tenant
  has none); a shared team mailbox and a per-tenant recipient setting are not in scope.
- **Safe trial uses what exists**: the existing custom recipient list lets SweCham send only to
  their own addresses; no separate "test mode" is built.
- **Single switch**: one platform flag governs the new flow; a per-tenant setting is unnecessary
  because marketing chooses per E-Blast whether to format or approve as submitted.
- **Reminder thresholds (3 and 7 days), the expiry warning (day 23) and expiry (day 30), and the
  marketing review target (the existing 48-hour target)** are fixed defaults, not configurable in
  this version.
- **Out of scope**: SweCham's own E-Newsletter in any form — parked as feature 120 (authoring,
  sending, a member news-submission workflow, tracking the two Partnership newsletter benefits),
  open/click analytics, attachments, free colour/font/size pickers, raw HTML paste-through,
  tables and embedded video in the writing tool, autosave (drafts stay manual), a comment thread
  beyond one note per version and one reason per decision, member editing of the formatted
  version, staff changing the audience, automatic approval on timeout (automatic *expiry* is in
  scope; approval never is), per-version side-by-side text diff highlighting.
