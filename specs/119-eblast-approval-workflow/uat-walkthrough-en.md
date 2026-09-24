# E-Blast approval — SweCham UAT walkthrough (English)

**Feature**: F119 E-Blast two-sided approval (FR-035, US7, SC-005). Thai version:
`uat-walkthrough-th.md` — the two say the same thing; change them together.
**Written against**: branch `119-eblast-approval-workflow` at `1b06c1cd1` (2026-09-24).
**Who runs it**: two or more SweCham staff — one plays the **member**, one plays **marketing** —
with the maintainer on hand for the switch.

The goal is simple: take one test E-Blast through the whole flow — **submit → format → request
changes → re-format → approve → confirm schedule → sent** — and confirm that **no email reaches
anyone outside the staff-only list**. Track B then exercises the stages the main path does not
touch, so every stage has been seen at least once (US7-AS2).

---

## 1. Before you start — preconditions

All eleven must be true before step 1. They are the same list as `quickstart.md` § 4.

| # | Precondition | Why it matters |
|---|---|---|
| P1 | A **test member company** exists in production (for example "SweCham Internal Test") and is **in good standing** | A lapsed member can still open and decide on its own E-Blast, but cannot submit one |
| P2 | **Every participating staff address is added as a contact of that member**, opted in to marketing | The custom recipient list only accepts addresses that exist as contacts. **Without this, the list is refused and the trial stops at submit — the most likely day-one failure** |
| P3 | The test member has an **active portal login** on an address that is **not already a staff sign-in** (one email address can hold only one account) — for example a mailbox alias one participant reads. That address is also a contact of the member (P2) and is on the recipient list (P5) | Without an active portal login, "Send to member" is refused ("The member company has no portal user"). All member-side emails go to the member's approval contact — the contact linked to the login that submitted — so this must be that address |
| P4 | The test member's plan has **at least 3 E-Blasts** of allowance | Each trial E-Blast holds a place from submit until it is sent, rejected, withdrawn or expires |
| P5 | Every trial E-Blast uses the **Custom recipient list** audience and names only the P2/P3 addresses | Any other audience reaches real members |
| P6 | The participants include **every active marketing-role user** of SweCham (or, if there is none, every active administrator) | Hand-off emails go to that whole group, not only to the person running the trial |
| P7 | **Brand settings** are set (`/admin/settings/broadcasts/brand`: colour and postal address) | So the trial shows the logo header, the brand-coloured button and the real footer address |
| P8 | The **record of processing (RoPA)** has been updated | Required before the switch goes on |
| P9 | The maintainer has turned on `FEATURE_EBLAST_MEMBER_APPROVAL` in Vercel | Turning it on **is a production deploy — only the maintainer does it**. From that moment the marketing team is emailed about every real submission too, and "Start formatted version" is offered on every submitted E-Blast |
| P10 | Resend is on the Free plan: **at most two broadcasts in flight** at once | Run the trial E-Blasts one at a time. Formatting and approving use no Resend capacity — only the final send does |
| P11 | **Known gap**: the member's proposed send time is not stored on new submissions | At "Confirm schedule" the dialog says "The member did not propose a time." Use **Choose another time**. Note it on the record sheet as a known issue, not a new finding |

**How to tell who is who in this document**: **Member** = the P3 portal login. **Marketing** = a
staff user with the marketing role. **Observer** = whoever watches the inboxes.

**Keep the record sheet (§ 5) open while you go.** For every step, write down what you saw and
which inboxes received an email.

---

## 2. Track A — the main path (submit → sent)

Give the E-Blast an obvious subject, for example `[UAT A] Spring networking evening`.

### Step 1 — Submit (Member)

1. Sign in as the Member and open **E-Blasts → New** (`/portal/broadcasts/new`).
2. Write a subject and a short message.
3. Choose the audience **Custom recipient list** and enter only the P2/P3 addresses.
4. Pick a send time about a week ahead, then **Submit**.

**Expect**
- The member's E-Blast list shows the stage **Awaiting review**.
- As Marketing, `/admin/broadcasts` lists it as **Awaiting review**; the staff menu shows a
  waiting count.
- Every marketing inbox (P6) receives one "new E-Blast submitted" email carrying **only** the
  subject, the member company, the stage and a link — no message body.
- Nobody else receives anything.

### Step 2 — Format (Marketing)

1. Open the E-Blast from `/admin/broadcasts`. The **Approval round** card shows Whose turn:
   **Marketing** and Round: **Not sent to the member yet**.
2. Click **Start formatted version** and confirm **Start formatted version** in the dialog. (It
   warns that the E-Blast can no longer be approved as submitted.)

**Expect**: the stage is **In design**. The member's original sits beside the working copy,
read-only and unchanged.

3. Format the working copy: add an **H2 heading**, a **banner image** (with a description), and a
   **call-to-action button**. Add a short **Note to the member**.
4. Click **Save**.

**Expect**: "Saved at HH:MM".

5. Optional: **Send me a test copy**.

**Expect**: it arrives **only at your own address**, with the subject starting `[Test]`. The
stage does not change.

### Step 3 — Send to the member (Marketing)

1. Click **Send to member** and confirm **Send to member**. (Unsaved edits are saved first.)

**Expect**
- The stage is **Awaiting member approval**; Round **1**; Whose turn **Member**.
- The version can no longer be edited.
- The Member's address (P3) receives one "version ready for your approval" email, **in the
  member contact's language**, stating the timeline: a reminder on day 3, a final reminder on day
  7, a warning on day 23 and automatic closure on day 30.
- Nobody else receives anything.

### Step 4 — Request changes (Member)

1. As the Member, open the E-Blast from the list (it now reads **Awaiting your approval**).

**Expect**: a banner saying it is your turn and the date to respond by; the formatted version
**first**, the original beside it (on a phone: below it, on the same page); the note from the
chamber; the proposed and confirmed send times (both read "Not set" at this point — the proposal
because of P11, the confirmed time because marketing has not confirmed one yet).

2. Click **Request changes** and leave the reason empty, then confirm.

**Expect**: refused — "Tell the chamber what should change."

3. Enter a reason (for example "Please move the date into the heading") and confirm **Request
   changes**.

**Expect**
- Member side: the stage is **Changes requested**.
- Marketing inboxes receive an email with the subject, company, new stage and link — **not the
  reason**.
- On the staff page the reason is shown, attached to round 1.

### Step 5 — Re-format (Marketing)

1. Open the E-Blast. Click **Start formatted version** (this starts round 2).
2. Make the requested change, **Save**, then **Send to member**.

**Expect**
- Round **2**, stage **Awaiting member approval**.
- The Member receives a new "version ready" email.
- The history on both sides lists round 1 (the version and the change request) and round 2, oldest
  first.

### Step 6 — Approve (Member)

1. As the Member, open the E-Blast and click **Approve**.

**Expect**: the dialog says the chamber's marketing team will now confirm the send time and that
the content cannot change without a new approval. The note is optional (up to 500 characters).

2. Confirm **Approve**.

**Expect**
- Member side: **Approved — awaiting schedule**. Staff side: **Member approved — awaiting
  schedule**.
- Marketing inboxes receive an email (subject, company, stage, link).

### Step 7 — Confirm the schedule (Marketing)

1. Open the E-Blast and click **Confirm schedule**.

**Expect**: the dialog offers the send options. Because of P11 it says "The member did not propose
a time."

2. Choose **Choose another time**, set a time **at least 5 minutes ahead** (Bangkok time), and
   click **Confirm**.

**Expect**
- The stage is **Scheduled**.
- The Member receives an email with the confirmed time. (Because of P11 it will not carry the "this
  is not the time you proposed" line.)
- Optional check for the maintainer — the sending record now holds exactly the approved version:
  `SELECT b.subject = v.subject AND b.body_html = v.body_html FROM broadcasts b JOIN broadcast_versions v ON v.tenant_id = b.tenant_id AND v.id = b.approved_version_id WHERE b.broadcast_id = '<id>';`
  returns `true`.

### Step 8 — Sent (automatic)

Wait until the confirmed time, plus up to 5 minutes (the dispatcher runs every 5 minutes).

**Expect**
- The stage moves to **Sending**, then **Sent**.
- **Only** the P2/P3 addresses receive the E-Blast. It is the round-2 version the Member approved:
  heading, banner, button, the chamber logo (or name), the footer with the postal address and the
  unsubscribe link.
- The staff page shows recipients / delivered / bounced / complained; the member's page shows the
  **Delivery** card, which appears only once sending has begun.
- **Nobody outside the list received anything at any step.** This is the pass condition of
  SC-005.

---

## 3. Track B — the remaining stages

Run these on **new** trial E-Blasts (`[UAT B1]`, `[UAT B2]`, …), one at a time, using the same
preconditions. Each one frees its allowance place when it ends without being sent.

| # | What to do | Stage exercised | Expect |
|---|---|---|---|
| B1 | Submit; as Marketing, **Approve** it as submitted with a time a few minutes ahead | today's flow → Scheduled → Sent | No sign-off round. The history on both sides shows a single "Approved as submitted" entry with the staff user and the time |
| B2 | Submit; Marketing starts a formatted version, then **Reject** with a reason | In design → Rejected | The member is told, with the reason. The allowance place is freed |
| B3 | Take an E-Blast to **Scheduled** (Track A steps 1–7), then as the Member click **Withdraw approval** with a reason before the send time | Scheduled → Changes requested | The confirmed time is cancelled and the E-Blast is **not** sent; marketing is emailed; the history shows the withdrawal and its reason. Round number does **not** change |
| B4 | While an E-Blast awaits the member, as Marketing click **Reject**, or as the Member withdraw the whole E-Blast from its page | Awaiting member approval → Rejected / Cancelled | The other side is notified; the place is freed |
| B5 | With a version awaiting the member, change the brand colour | any | Nothing is voided; the next preview and the send use the new colour |
| B6 | As a **manager**, open `/admin/broadcasts` and an E-Blast | read-only | Everything is visible; no action button exists |

**Stages a one-day trial cannot reach in production**: the day-3 and day-7 reminders, the day-23
warning and the day-30 **Expired — no member response** closure run on a real calendar clock.
The maintainer demonstrates them on the **dev** environment with a back-dated clock
(`quickstart.md` § 1, US5 step 2) and shares the resulting emails. Never back-date a production
row.

---

## 4. If something goes wrong

- **Refused at submit with an error about the recipient list** → P2 is not done: an address on
  the list is not a contact of the test member.
- **"The member company has no portal user"** at Send to member → P3 is not done.
- **An email arrived somewhere it should not** → stop. Cancel the E-Blast from its staff page
  (**Cancel**, type the confirmation phrase, give a reason), write down the recipient and the time,
  and tell the maintainer. That is a failed SC-005.
- **No email arrived** → tell the maintainer; they check the outbox (runbook
  `docs/runbooks/eblast-approval.md` § Triage).
- **To stop the whole trial**: cancel the open trial E-Blasts. Turning the switch off is the
  maintainer's decision and is itself a production deploy; E-Blasts already in the new stages stay
  completable or cancellable after it.

---

## 5. Record sheet

Copy this table and fill one row per step.

| Step | Stage expected | Stage seen | Emails received (who) | Any email outside the list? | Pass / Fail | Notes |
|---|---|---|---|---|---|---|
| A1 Submit | Awaiting review | | | | | |
| A2 Format | In design | | | | | |
| A3 Send to member | Awaiting member approval (round 1) | | | | | |
| A4 Request changes | Changes requested | | | | | |
| A5 Re-format + send | Awaiting member approval (round 2) | | | | | |
| A6 Approve | Member approved — awaiting schedule | | | | | |
| A7 Confirm schedule | Scheduled | | | | | P11 known gap |
| A8 Sent | Sent | | | | | |
| B1–B6 | as in § 3 | | | | | |

**Feedback for the marketing team** (SC-009, SC-010): how long did formatting take (target under
10 minutes)? Could the member decide in under 2 minutes, including on a phone (SC-003)? Would you
still need a private email thread to agree the content?
