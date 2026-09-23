# 120 — Chamber Newsletter (PARKED — not a specification yet)

**Status**: PARKED, 2026-09-17. No branch, no `spec.md`, nothing planned or built.
**Opens when**: SweCham confirms they want the chamber's own E-Newsletter authored and sent from
Chamber-OS (scope option B or C in the scope-confirmation document sent 2026-09-17).
**If SweCham confirms Option A only**: delete this directory.
**Depends on**: feature 119 (`specs/119-eblast-approval-workflow/`) — reuses its editor, content
rules, test-copy, delivery path and the marketing dashboard.

## Why this is separate from 119

SweCham's request said "e-blast/newsletter". Every step of the flow they described has a member who
writes and approves the content, which only a member **E-Blast** has — that is feature 119, and it is
needed whatever SweCham answers. The chamber's own **E-Newsletter** is a different product: no owning
member, no allowance, no member sign-off. In the 2026 Membership Package it is a separate
Partnership-only benefit ("Promotion of corporate news in Newsletter", "Hyperlinked logo in all
E-Newsletters"); today the platform only records those two benefits as yes/no plan switches and
delivers nothing for them. Keeping it out of 119 lets 119 go through clarify → plan → implement with
no "pending confirmation" part inside it.

The text below was written for 119 while it briefly covered the full scope. It is **input for
`/speckit.specify`**, not an approved spec: renumber, re-validate and re-clarify it when 120 opens.
FR/SC numbers are the ones it had inside 119.

## Draft user story

### User Story 1 - Marketing writes and sends the chamber's own newsletter (Priority: P1)

A marketing team member starts a new **chamber newsletter** — not on behalf of any member. They
can start from a saved template, write and design it with the same editor and content rules as an
E-Blast, choose the audience, preview it exactly as recipients will see it, and send a test copy to
their own inbox. When happy, they schedule it or send it now. It goes only to contacts who are
eligible for marketing email and have not opted out, carries the same unsubscribe link, and does
not touch any member's E-Blast allowance. It appears on the dashboard next to member E-Blasts,
clearly labelled as a newsletter.

**Why this priority**: It is the whole of this feature. It is independent of feature 119's member
approval round — a chamber newsletter has no member to sign it off.

**Independent Test**: As a marketing user, create a newsletter from a template, send a test copy
to yourself, schedule it to a staff-only recipient list, and verify it is delivered with chamber
sender details and an unsubscribe link, that no member's allowance changed, and that it shows on
the dashboard as a newsletter with its delivery results.

**Acceptance Scenarios**:

1. **Given** a marketing user, **When** they start a new newsletter, **Then** no member has to be
   selected and the newsletter is recorded as belonging to the chamber.
2. **Given** a newsletter draft, **When** the user requests a test copy, **Then** it is delivered
   only to the requesting user's own address, marked as a test, and nothing else changes.
3. **Given** a finished newsletter, **When** a user with the right to send schedules it or sends
   it now, **Then** it enters "Scheduled" directly — there is no member sign-off stage — after a
   confirmation that states the recipient count and that sending cannot be undone once started.
4. **Given** a newsletter is sent, **When** recipients are resolved, **Then** contacts who opted
   out, unsubscribed, or are otherwise ineligible for marketing email receive nothing, exactly as
   for an E-Blast.
5. **Given** any number of newsletters are sent, **When** a member checks their E-Blast allowance,
   **Then** it is unchanged.
6. **Given** a recipient replies to a newsletter, **When** the reply is sent, **Then** it goes to
   the chamber's configured marketing reply address, not to any member.
7. **Given** a newsletter on the dashboard, **When** it is listed, **Then** it is labelled
   "Newsletter", shows "Chamber" as the owner, shows only the stages that apply to it (Draft,
   Scheduled, Sending, Sent, Cancelled, Failed), and can be filtered for separately.
8. **Given** a signed-in member, **When** they use the portal, **Then** they never see chamber
   newsletters in their own E-Blast list.

## Draft edge cases

- **Newsletter with no eligible recipients**: scheduling is refused with a clear reason, as for an
  E-Blast today.
- **A newsletter and member E-Blasts are due at the same time**: sending capacity is shared. A
  newsletter must never cause a member's scheduled E-Blast to fail or be dropped; at worst one of
  them is delayed, and the delay is visible on the dashboard.
- **A staff user who may write but not send** prepares a newsletter: they can save and test it,
  but only a user with the right to send can schedule it.
- **A newsletter is cancelled after scheduling**: allowed until sending begins, same cut-off as an
  E-Blast; nothing is charged to anyone.

## Draft functional requirements

- **FR-031**: The dashboard MUST cover both member E-Blasts and chamber newsletters in one list,
  label each item's kind, and allow filtering by kind. For a newsletter the owner is shown as the
  chamber, "whose turn" is always marketing, and only the stages that apply to a newsletter are
  shown.

**Chamber newsletter**

- **FR-037**: Staff MUST be able to create a newsletter that belongs to the chamber, with no
  member selected, using the same editor, saved templates, content safety rules, and size limits
  as an E-Blast.
- **FR-038**: A newsletter MUST NOT reserve, consume, or otherwise affect any member's E-Blast
  allowance, and MUST NOT appear in any member's portal.
- **FR-039**: A newsletter MUST be sent only to contacts eligible for marketing email; every
  existing opt-out, unsubscribe, and suppression rule MUST apply to it exactly as to an E-Blast,
  and it MUST carry the same unsubscribe link and chamber identification.
- **FR-040**: A newsletter MUST have no member sign-off stage; a user with the right to send
  schedules it or sends it now, after a confirmation stating the recipient count and that sending
  cannot be undone once it starts. It MUST be cancellable until sending begins.
- **FR-041**: Replies to a newsletter MUST go to a chamber reply address configured per tenant;
  a newsletter MUST NOT be schedulable while that address is not configured.
- **FR-042**: Staff MUST be able to send a test copy of a newsletter, and of a formatted E-Blast
  version, to their own address only; a test copy MUST be marked as a test and MUST NOT change the
  item's stage, its version history, or any allowance.
- **FR-043**: A newsletter MUST NOT cause a member's scheduled E-Blast to fail or be dropped when
  both are due; any delay MUST be visible on the dashboard.

## Draft entity

- **Chamber Newsletter**: a mailing that belongs to the chamber (tenant) instead of a member. Same
  content, audience, schedule, and delivery results as an E-Blast, but no owning member, no
  allowance, no member sign-off, and a chamber reply address.

## Draft success criteria

- **SC-010**: A marketing user can produce a newsletter from a saved template, send themselves a
  test copy, and schedule it in under 15 minutes.
- **SC-011**: 0 contacts who opted out or unsubscribed receive a newsletter, and 0 member
  allowances change as a result of any newsletter.

## Cross-cutting notes

- **Roles & permissions**: no new permission keys expected — writing and testing a newsletter uses
  the existing E-Blast write permission, scheduling or sending uses the existing send permission,
  configuring the chamber reply address uses the existing admin-tier E-Blast settings permission.
  Members never see newsletters.
- **Personal data (newsletter)**: a newsletter processes recipients' email addresses for direct
  marketing on the same basis, with the same objection/unsubscribe rights, as an E-Blast — the
  difference is that the chamber, not a member, is the sender, which the record of processing
  must state before the newsletter is switched on.
- **Audit trail**: newsletter created, test copy sent, scheduled, cancelled, sent, reply address
  changed (previous → next).
- **Feature flag**: its own switch, `FEATURE_CHAMBER_NEWSLETTER`, default OFF, independent of 119's
  `FEATURE_EBLAST_MEMBER_APPROVAL`.
- **Money & tax**: N/A.

## Draft assumptions

- **The newsletter reuses the E-Blast machinery** (editor, templates, content rules, audience
  choices, scheduling, delivery, unsubscribe, delivery results). The genuinely new things are: a
  mailing with no owning member, no allowance accounting for it, and a chamber reply address.
- **No second approver for newsletters**: whoever holds the right to send may schedule their own
  newsletter after the confirmation step. SweCham's marketing team is small; a four-eyes rule is
  a candidate question for `/speckit.clarify`, not a default.
- **Member news and partner logos are placed by hand**: marketing writes members' corporate news
  and partner logos into the newsletter themselves. A workflow for members to submit news items
  (clarification option B) and automatic logo placement by plan tier are out of scope.
- **Delivery may be sliced**: the approval round (US1, US2, US4), the dashboard (US3), and the
  newsletter (US5) are independently shippable, so SweCham can start testing the approval round
  before the newsletter exists.
- **Sending capacity is a dependency, not a build item**: the current email-provider plan limits
  how many mailings can be in flight and how many contacts it can hold; a regular newsletter to
  all contacts may require a plan upgrade before go-live.

## Open questions for SweCham (carry into `/speckit.clarify` when 120 opens)

1. Which tool sends the chamber newsletter today, and does SweCham want to move it into Chamber-OS?
   (Question 1 of the scope-confirmation document — this is the question that opens or closes 120.)
2. Does a newsletter need a second staff approver before sending? (Default: no.)
3. May a newsletter go to non-members, such as event attendees? (Default: no — same audience
   choices as an E-Blast.)
4. Scope option C: should the platform record which Partners' news and logos appeared in each
   issue, so the two Partnership benefits have proof of delivery? A light version: marketing ticks
   the members featured, and the system lists the Partners currently entitled to a logo.
5. How often is the newsletter sent, and to roughly how many contacts? (Decides the email-provider
   plan upgrade — the current free plan holds 1,000 contacts and three segments.)
6. Which reply address should chamber newsletters use?
7. Should Partner logos be placed automatically by plan tier? (Drafted as out of scope.)

## Explicitly not in the draft

A member news-submission workflow (scope option B on its own), a public newsletter archive,
recurring/automatic issues, open/click analytics.
