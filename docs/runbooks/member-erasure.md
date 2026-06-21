# Member Erasure Runbook

**Status**: ACTIVE
**Owner**: Maintainer + DPO
**Last reviewed**: 2026-06-21 (COMP-1 US3-E — end-to-end DPO procedure + RoPA exit-dependency fulfilled)

## Purpose

GDPR Art. 17 + PDPA §33 grant data subjects a right to erasure. Chamber-OS
member erasure (`eraseMember`, `src/modules/members/application/use-cases/erase-member.ts`)
anonymises the member + contacts in place and re-drives the per-module cascades
(F1 linked logins, F6 event registrations, F7 broadcast content + deliveries,
F8 renewal cycles) under the erasure reason. The **authoritative-copy** erasure
(the controller's own database) is durable and atomic; `member_erased` is the
completion proof, emitted only when every blocking cascade reports clean.

This runbook is the DPO's **end-to-end member-erasure procedure** (§ DPO
procedure below) plus the deep reference for the **operational residuals** — the
parts of an erasure that cannot be guaranteed complete inside the atomic
transaction and need a DPO to watch a metric and, on failure, finish the job by
hand within the legal response window. The RoPA for this activity is
`docs/compliance/processing-records.md` § COMP-1 — Member Erasure.

---

## DPO member-erasure procedure (end-to-end)

Run these steps for every erasure request (GDPR Art. 17 / PDPA §33). The
**Art. 12 / §30 one-month clock starts at receipt** — see § H-1 for the SLA.

1. **Receive + log the request.** Record the DSR in your intake register with
   the data subject's identity, the member they relate to, and the **received
   date** (the clock start). Keep the subject's email here — after erasure it is
   gone from the database by design and is recoverable only from this record
   (needed for any manual sub-processor remediation, step 6).

2. **Verify identity (Art. 12).** Confirm the requester is the data subject (or
   an authorised representative) BEFORE erasing. Chamber-OS records *how* you
   verified in the erasure attestation (step 3): `verification_method` ∈
   {`verified_account_login`, `in_person`, `email_confirmation_loop`,
   `official_document`}. Do not proceed on an unverified request.

3. **Execute via the admin UI (US3-A).** As an **admin** (the page is admin-only
   — manager/member get 404), open the member at `/admin/members/[memberId]`,
   click **Erase member**, and complete the gated dialog: type-to-confirm the
   member number, choose the reason (`gdpr_erasure_request` |
   `pdpa_deletion_request`), tick **identity verified** + pick the
   `verification_method`, and add an optional note. Submitting emits the durable
   `member_erasure_requested` audit (the clock-start) and runs the cascade.

4. **Confirm completeness (US3-D evidence log).** Open
   **`/admin/compliance/erasure-log`**. Find the member's card and confirm:
   - `member_erased` is present (the completion proof — green/complete badge);
   - the **F1 `user_erased`** credential-erasure proof is shown (the linked
     login was anonymised);
   - the cascade outcomes look clean.
   If the card shows a **half-run** (requested, no `member_erased`) or **OVERDUE**
   badge, go to step 8.

5. **Note the 10-year tax legal hold (US3-B).** The member's **F4 tax documents
   are NOT erased now** — Thai RD §87/3 requires 10-year retention, which
   overrides erasure (GDPR Art. 17(3)(b)) until the window elapses. The
   `redact-expired-member-invoices` cron tombstones the buyer PII + purges the
   PDF bytes automatically at the 10-year boundary; the evidence log surfaces
   each `event_buyer_pii_redacted` outcome. **No manual action** — just record on
   the DSR ticket that the tax copy is held under the §87/3 legal obligation and
   will be minimised at the boundary.

6. **Check sub-processor propagation (US3-C).** The Resend audience-contact
   removal is **best-effort, non-blocking**. Watch the
   `member_subprocessor_erasure_total{resend_outcome}` alert (§ below). If it
   fired `failed`/`partial` for this member, run the **manual remediation
   procedure** (§ Sub-processor erasure propagation) within the H-1 window.

7. **Acknowledge the out-of-reach copies.** Two copies cannot be erased by the
   controller and are accepted residuals (§ Documented residuals + the RoPA):
   **(a)** a GDPR-export ZIP the subject **already downloaded** to their own
   device; **(b)** pre-erasure data in **backup / PITR snapshots** (re-erased
   only on a restore). If the DSR specifically asks about these, explain the
   limitation honestly; they do not block closure of the controller-copy erasure.

8. **Handle a half-run (US2d reconciler).** A half-run means a blocking cascade
   (F1/F6/F7/F8) failed transiently. The **US2d reconciler cron** re-drives stuck
   erasures automatically (oldest-first) and will emit `member_erased` once the
   cascade clears — re-check the evidence log on the next cron tick. If the badge
   is **OVERDUE** (past the §30/Art. 12 window) it is a **reportable compliance
   gap** — escalate to the DPO/legal-counsel and investigate the stuck cascade
   (check `members_erasure_outcome_total{still_pending}` + the cascade logs)
   before the deadline lapses.

9. **Close + record proof.** Append the closure to the DSR ticket citing the
   `member_erasure_requested` + `member_erased` audit timestamps (visible on the
   evidence log) and any manual sub-processor remediation (step 6). The US3-D
   evidence log is the durable accountability artefact (GDPR Art. 5(2) / Art. 30).

---

## Sub-processor erasure propagation (COMP-1 US3-C)

GDPR Art. 17 + Art. 19 + PDPA §33 require the controller to propagate an
erasure to its **sub-processors** so the data subject's PII is removed from
their systems too. Chamber-OS has one sub-processor that holds member PII keyed
to a member: **Resend** (the member's email sits in the Resend *audiences* it
received broadcasts in). Stripe is a pure no-op today — there is no
member↔Stripe-customer model (F5 payments are ad-hoc Payment Intents, never
persisted Stripe Customers keyed to a member).

### How it works (so you can read the audit trail)

The cascade has two halves:

1. **In-tx capture (FAIL-LOUD).** Inside `eraseMember`'s atomic scrub tx, BEFORE
   the F7 delivery tombstone redacts the member's emails, the cascade reads the
   `(resend_audience_id, recipient_email_lower)` pairs the member received
   broadcasts in. This read is **fail-loud**: if it errors, the WHOLE erasure
   rolls back (the member stays un-erased and re-drivable). The pairs cannot be
   re-derived after the scrub — the tombstone redacts `recipient_email_lower`
   and `recipient_member_id` is always NULL in production.

2. **Post-commit propagation (BEST-EFFORT / NON-BLOCKING).** After the scrub tx
   commits, the cascade removes each captured pair from its Resend audience via
   `resendBroadcastsGateway.removeContactFromAudience(audienceId, email)`. The
   outcome is recorded in a `subprocessor_erasure_propagated` audit row + the
   `member_subprocessor_erasure_total{resend_outcome}` metric. A failure here
   does **NOT** flip `allCascadesClean` — `member_erased` is still emitted.

**Why non-blocking** (security + DPO sign-off, plan-review 2026-06-20): the
Resend-removal inputs are captured only in the first-pass atomic tx and are
**destroyed by the same erasure**. A US2d reconciler re-drive re-captures an
EMPTY set and can never retry the Resend removal. Blocking `member_erased` on a
first-pass Resend failure would only delay the completion proof by one
reconciler tick and then emit it anyway (over a vacuous empty-set re-drive),
while polluting the DPO log with a misleading second `ok` audit. So
`member_erased` reflects the controller's authoritative-copy erasure;
sub-processor propagation is tracked separately by its own audit + metric + this
runbook. This is **best-effort-ONCE**: a first-pass failure is finished by hand,
not auto-retried.

### Alert

Page the DPO on:

```
member_subprocessor_erasure_total{resend_outcome="failed"} > 0
member_subprocessor_erasure_total{resend_outcome="partial"} > 0
```

`resend_outcome` is a bounded enum `{ok, partial, failed}`. `failed` = every
captured pair failed to remove; `partial` = some removed, some failed. Both mean
the data subject's email still sits in ≥1 Resend audience and a future broadcast
could re-reach an erased member — a residual the DPO must close manually.

### Manual remediation procedure

When the alert fires:

1. **Identify the member + audiences.** Query the `subprocessor_erasure_propagated`
   audit for the failed member (run as `neondb_owner`, BYPASS RLS):

   ```sql
   SELECT
     occurred_at,
     payload ->> 'member_id'                       AS member_id,
     payload ->> 'resend_outcome'                  AS resend_outcome,
     payload ->> 'resend_contacts_removed_count'   AS removed,
     payload ->> 'resend_contacts_failed_count'    AS failed,
     request_id
   FROM audit_log
   WHERE tenant_id = '<TENANT_SLUG>'
     AND event_type = 'subprocessor_erasure_propagated'
     AND payload ->> 'member_id' = '<MEMBER_ID>'
   ORDER BY occurred_at ASC;   -- FIRST row is the authoritative outcome (see § Security cond-3)
   ```

   The audit row carries **NO email or audience id** (forbidden-fields
   hygiene — ids + outcome counts only). To find WHICH audiences still hold the
   member's email you must correlate: the adapter logs the failing
   `audienceId` (never the email) at `warn` with
   `cascade: 'subprocessor_resend'` + the `requestId` from the audit row. Grep
   the structured logs for that `requestId` to list the stuck `audienceId`s. The
   member's email is recoverable only from your offline DSR intake record (the
   member's own erasure request) — it is gone from the database by design.

2. **Remove the contact via the Resend dashboard.** For each stuck audience,
   open Resend → Audiences → the audience → remove the contact by the member's
   email (from the DSR intake record). A 404 / "not found" is success (already
   absent → the erasure goal holds).

3. **Record completion.** Append a manual completion note to the DSR ticket and
   the DPO evidence log (the US3-D evidence log — see § H-1), citing: the
   `subprocessor_erasure_propagated` audit row's `occurred_at` + `request_id`,
   the audiences remediated, and the completion timestamp. Do **not** re-run
   `eraseMember` to "fix" this — a re-drive cannot retry the Resend removal (the
   inputs are gone) and only writes a misleading second audit (§ Security
   cond-3).

### H-1 — remediation SLA (GDPR Art. 12(3) / PDPA §30)

The manual remediation MUST complete **within the SAME one-month erasure
window** as the original request — NOT "eventually". Bind the SLA clock to the
**`member_erasure_requested`** audit timestamp (the Art. 12 / §30 clock start),
which is the SAME timestamp the **US3-A admin attestation** is recorded against
and the SAME one the **US3-D evidence log** tracks. Cross-reference all three so
the sub-processor residual is closed inside the window the controller-copy
erasure already committed to:

- **PDPA §30** (Thailand-resident subjects): 30 days from receipt, extendable by
  30 days with written notice to the data subject.
- **GDPR Art. 12(3)** (EU/EEA-resident subjects): 1 month from receipt,
  extendable to 3 months total with notification within the first month.

Chamber-OS defaults to the tighter PDPA 30-day clock for dual-jurisdiction
subjects (matching `docs/runbooks/f6-manual-erasure.md`). A sub-processor
residual still open at the deadline is a **reportable compliance gap** — escalate
to the DPO before the window closes, do not let it lapse silently.

### Security cond-3 — the second `ok` audit is NOT proof of remediation

If `eraseMember` is re-driven for an already-erased member (e.g. the US2d
reconciler, or an admin retry), the in-tx capture now reads `[]` (the contacts
are already `removed_at`-stamped → no live emails → no audience pairs). The
cascade then writes a SECOND `subprocessor_erasure_propagated` row with
`resend_outcome:'ok', resend_contacts_removed_count:0` and does **not** call
Resend at all.

**This second `ok`/removed:0 row is a VACUOUS empty-set no-op.** It is NOT
evidence that the Resend removal succeeded. The authoritative signal is the
**FIRST** pass's `resend_outcome` + the metric. An operator triaging the audit
log MUST read the EARLIEST `subprocessor_erasure_propagated` row for a member
(`ORDER BY occurred_at ASC`) and MUST NOT read a later `ok` as remediation of an
earlier `failed`. Manual remediation (§ above) is recorded in the DSR ticket /
evidence log, never inferred from a vacuous re-drive audit.

### Documented residual — best-effort-ONCE + un-enumerable audiences

Two limits are accepted by design (security-engineer + pdpa-gdpr-compliance-officer
sign-off, plan-review 2026-06-20):

1. **Best-effort-ONCE.** A first-pass Resend failure is NOT auto-retried — the
   capture inputs are destroyed by the same erasure, so a reconciler re-drive
   re-captures an empty set. Failure is closed by the manual procedure above,
   inside the H-1 window.

2. **Un-enumerable / historical audiences out of reach.** The capture derives
   audiences from the member's `broadcast_deliveries` rows (the audiences it
   *received broadcasts in*). A Resend audience the member was added to WITHOUT
   a recorded delivery, or an audience created/managed outside Chamber-OS, is
   not enumerable from our data and is not propagated automatically. If a DSR
   indicates such an audience exists, remediate it by hand via the Resend
   dashboard and note it on the ticket.

### H-2 — RoPA exit dependency (GDPR Art. 30(1)(e) / PDPA §39)

This residual was an **EXPLICIT US3-C → US3-E exit dependency** — now
**FULFILLED**. The RoPA (`docs/compliance/processing-records.md` § COMP-1 —
Member Erasure → "Sub-processor erasure propagation (US3-C) — RoPA exit
dependency (H-2)") names the Resend sub-processor relationship with its erasure
limitation, verbatim:

> **Resend (sub-processor):** best-effort-once erasure propagation
> (audience-contact removal on member erasure), un-enumerable historical
> audiences out of automated reach, manual remediation on failure within the
> Art. 12(3) / §30 response window.

This is the documented compensating control that makes the non-blocking cascade
design Art. 17(2) / Art. 19 compliant. **Do not drop it** from the RoPA on a
future edit — it is also recorded in the design's known-limitations section
(`docs/superpowers/specs/2026-06-19-member-erasure-us3-bcde-design.md`).

---

## Related

- **`/admin/compliance/erasure-log`** (US3-D) — the DPO evidence log: the
  accountability proof per member (requested + completion + `user_erased` +
  tax-redaction + sub-processor outcomes + half-run/overdue badge).
- **`docs/compliance/processing-records.md`** § **COMP-1 — Member Erasure** — the
  RoPA for this activity (scrub matrix, A–D lifecycle, retention, the full
  documented-residuals table, the H-2 Resend exit-dependency); § **F3 — Members
  & Contacts** is the underlying member-data RoPA.
- `src/modules/members/application/use-cases/erase-member.ts` — the use-case
  (capture site + post-commit cascade + the M-1 fail-loud asymmetry note).
- `tests/integration/members/erase-member-subprocessor-cascade.test.ts` — the
  capstone proof (happy, cross-tenant, re-drive empty-set, throw-path rollback).
- `docs/runbooks/f6-manual-erasure.md` — F6 event-registration manual erasure
  (the other manual DSR surface; same 30-day clock).
- `docs/runbooks/breach-notification.md` — for incidents where erasure fails or
  PII is leaked during processing.
- **Offline DSR register** (your intake spreadsheet / ticketing system) — where
  closed DSR tickets (incl. the subject's email + any sub-processor remediation
  evidence) are recorded. The in-repo accountability artefact is the **US3-D
  evidence log** above; there is no PII-bearing DSR log inside the repository by
  design.
