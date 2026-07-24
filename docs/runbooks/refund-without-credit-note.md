# Runbook — Refund with no §86/10 ใบลดหนี้ (credit-note waiver)

**Severity**: none (planned operator action at month close, not an incident)
**Owner**: Operator + the chamber's accountant
**Triggered by**: audit event `refund_credit_note_waived` (10-year retention) · metric `refunds.credit_note_waived.count{tenant, reason}`
**Related code**: `src/modules/invoicing/domain/refund-credit-note-requirement.ts` · `src/modules/payments/application/use-cases/issue-refund.ts` · `_finalize-succeeded-refund.ts` · `drizzle/migrations/0268_refund_credit_note_waiver.sql`

> This runbook is referenced by filename as `runbook_url` inside the
> `refund_credit_note_waived` audit payload. **Do not rename it** without
> updating `src/modules/payments/application/ports/audit-port.ts` — a 10-year
> retention row would then point at nothing.

---

## Background — when a refund legitimately owes no credit note

A refund normally issues a §86/10 ใบลดหนี้ that reduces the original §86/4
ใบกำกับภาษี. Two states make that impossible, and in both the correct action is
to return the money and record WHY no credit note exists:

| `credit_note_waiver_reason` | Ground |
|---|---|
| `invoice_voided` | The invoice was voided. The VOID stamp already reversed the document, so no live §86/4 remains for a §86/10 to reduce — and void is irreversible, so refusing the refund would strand settled member money permanently. |
| `section_105_receipt` | The buyer was issued a §105 ใบเสร็จรับเงิน, never a §86/4 ใบกำกับภาษี. §86/10 วรรคสอง requires a credit note to carry the **number and date of the original ใบกำกับภาษี**, and there is none to cite. |

**§86/10 binds the SELLER.** It is a condition on the VAT-registered seller that
issued the original tax invoice; it imposes no condition on the buyer. Do **not**
restate this as "the buyer has no input VAT to reverse" — that framing is wrong,
and applied consistently it would break the membership path, which issues valid
§86/4 documents (and therefore valid credit notes) to non-registrant buyers under
the 066 relax.

### What migration 0268 guarantees

- `refunds_succeeded_iff_documented` — a refund is `succeeded` **iff** it has a
  `processor_refund_id` **and** (a `credit_note_id` **or** a
  `credit_note_waived_at`). A succeeded refund can never be undocumented.
- `refunds_cn_xor_waived` — never both. One instrument per refund, so a
  reversal can never be counted twice.
- `refunds_waived_at_requires_reason` — a waiver always says why.

### "No credit note" does NOT mean "no VAT adjustment"

For `section_105_receipt`, the sale carried 7% output VAT and fed
รายงานภาษีขาย / ภ.พ.30 for its tax month. Refunding the money does not undo that
filing, and **this system performs no adjustment**. It records the waiver so the
adjustment is discoverable — that is the entire purpose of this runbook.

The application deliberately does not tell anyone how to file. See
§ Open questions.

---

## Step 1 — Find every waived refund in a tax month (read-only)

Run as `neondb_owner` (which has `rolbypassrls`) in the Neon SQL editor. As
`chamber_app` you **must** `SET app.current_tenant = '<slug>';` first — `refunds`
and `invoices` are RLS **ENABLE + FORCE**, so without it you get **zero rows** and
would wrongly conclude nothing was waived.

Month boundaries are **Asia/Bangkok** — ภ.พ.30 is a Thai calendar month.

### Query A — the waived-refund register

```sql
SELECT
  r.tenant_id, r.id AS refund_id,
  r.credit_note_waiver_reason,               -- 'invoice_voided' | 'section_105_receipt'
  r.credit_note_waived_at,
  (r.credit_note_waived_at AT TIME ZONE 'Asia/Bangkok')::date AS refund_date_th,
  r.amount_satang AS refunded_satang,
  r.processor_refund_id, r.initiator_user_id, r.payment_id, r.invoice_id,
  i.status              AS invoice_status_now,
  i.invoice_subject,                         -- 'event' on every section_105 row
  i.document_number,                         -- §86/4 stream
  i.receipt_document_number_raw,             -- the §105 ใบเสร็จรับเงิน number
  i.issue_date, i.payment_date, i.paid_at,   -- payment_date = the §78/1 tax point
  i.total_satang, i.subtotal_satang, i.vat_satang,
  i.vat_rate_snapshot, i.vat_inclusive,
  i.credited_total_satang,                   -- stays 0 on a waived refund
  i.member_identity_snapshot->>'legal_name' AS buyer_name,
  i.member_identity_snapshot->>'tax_id'     AS buyer_tax_id
FROM refunds r
JOIN invoices i
  ON i.tenant_id = r.tenant_id
 AND i.invoice_id = r.invoice_id             -- invoices PK is (tenant_id, invoice_id)
WHERE r.status = 'succeeded'
  AND r.credit_note_waived_at IS NOT NULL
  AND r.credit_note_waived_at >= TIMESTAMPTZ '2026-07-01 00:00:00+07'
  AND r.credit_note_waived_at <  TIMESTAMPTZ '2026-08-01 00:00:00+07'
ORDER BY r.tenant_id, r.credit_note_waived_at;
```

Two traps worth stating, because both have bitten this codebase:

- **There is no `invoices.id` column.** The PK is `(tenant_id, invoice_id)`.
  `docs/runbooks/out-of-band-refund.md` contains `JOIN invoices i ON i.id = …`,
  which throws `42703` mid-incident. Do not copy that join.
- **Filter on `credit_note_waived_at`, never on `credit_note_waiver_reason`.**
  The reason is written at Phase-A insert while the row is still `pending`, and
  it survives a FAILED settlement — it records the decision, not the outcome.
  Filtering on the reason lists money that never moved.

### Query B — pairing against the ภ.พ.30 period

The output VAT was declared in the month of the **tax point** (`payment_date`),
which is usually **not** the month the refund happened.

```sql
SELECT
  to_char(i.payment_date, 'YYYY-MM')                                        AS vat_declared_month,
  to_char(r.credit_note_waived_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')   AS refund_month,
  count(*)                                                                  AS refunds,
  sum(r.amount_satang)                                                      AS refunded_satang
FROM refunds r
JOIN invoices i ON i.tenant_id = r.tenant_id AND i.invoice_id = r.invoice_id
WHERE r.status = 'succeeded'
  AND r.credit_note_waived_at IS NOT NULL
  AND r.credit_note_waiver_reason = 'section_105_receipt'
GROUP BY 1, 2
ORDER BY 1, 2;
```

This aggregate is for **orientation only**. Hand the accountant the per-row
figures from Query A — do not file off a rolled-up number.

### Query C — audit vs row (intent ≠ settlement)

The waiver audit fires at **intent**, in Phase A, while the row is still
`pending`. A refund that later failed at Stripe still left a
`refund_credit_note_waived` row behind. Counting audit rows therefore
**overstates** money returned.

```sql
SELECT a.payload->>'refund_id' AS refund_id,
       a.payload->>'waiver_reason' AS waiver_reason,
       a.timestamp AS decided_at,            -- audit_log uses "timestamp", NOT created_at
       r.status, r.credit_note_waived_at
FROM audit_log a
LEFT JOIN refunds r
  ON r.tenant_id = a.tenant_id
 AND r.id = a.payload->>'refund_id'
WHERE a.event_type = 'refund_credit_note_waived'
  AND a.timestamp >= TIMESTAMPTZ '2026-07-01 00:00:00+07'
  AND a.timestamp <  TIMESTAMPTZ '2026-08-01 00:00:00+07'
ORDER BY a.timestamp;
```

Rows where `r.status <> 'succeeded'` are decisions that never became money.
**Exclude them from anything you hand the accountant.**

---

## Step 2 — What the audit trail gives you

`refund_credit_note_waived` (retention **10 years** — §87/3 sets a 5-year floor;
10y is the repo convention for tax evidence, matching the F4 tax-document
backfill in migration 0039) carries:
`refund_id`, `payment_id`, `invoice_id`, `amount_satang`, `waiver_reason`,
`invoice_status` (as at pre-flight), and `runbook_url`.

It does **not** carry the buyer's identity, the document numbers, or the VAT
split — those come from Query A. The audit answers *what was decided and why*;
the invoice row answers *which document is affected*.

---

## Step 3 — `section_105_receipt`: hand the output-VAT tail to the accountant

**Settled facts** (safe to state):

- The §105 sale carried 7% output VAT and was declared for the `payment_date`
  month.
- No §86/10 was issued, and none can be — there is no ใบกำกับภาษี to cite.
- The money HAS been returned to the buyer.
- This system has made no adjustment of any kind.

**Deliver to the accountant**, per refund: the Query A row (document numbers,
buyer, VAT split, both dates) plus the Query B month pairing.

**Then log the outcome in the correction register**, following the
retain-with-cancellation-note → out-of-system instrument → register-pairing
procedure in `docs/runbooks/event-invoice-legacy-no-tin-remediation.md` § Step 4.

> **Cite that procedure, not its premise.** The first line of that section states
> that `paid → void` is illegal. It is not — `canTransition` in
> `src/modules/invoicing/domain/invoice.ts` allows it, which is exactly why the
> `invoice_voided` waiver exists.

---

## Step 4 — `invoice_voided`: what the void already did, and the residual

`void-invoice` re-renders and VOID-stamps both blobs and emits `invoice_voided`,
so the **document** side is complete. The **VAT** side depends on whether the
invoice was ever paid:

| Condition | Action |
|---|---|
| `i.paid_at IS NULL` | No output VAT was ever declared for this sale. Document retention only — nothing for the accountant. |
| `i.paid_at IS NOT NULL` | Output VAT WAS declared. Same handover as Step 3. |

Never hard-delete a §87-numbered document. Retain the original and its copies
with a written cancellation note. §87/3 requires a 5-year minimum; retain for
the repo's 10-year tax-evidence convention.

---

## Monitoring

`refunds.credit_note_waived.count{tenant, reason}` — a **counter**, because
nothing in this system can ever mark a waiver "handled". Alarm, **never page**:
the correct response is a month-close review.

The real control is a **month-close checklist item**, not the alert:

> On the first working day after month end, run Query A and Query B for the
> closed month. If either returns rows, hand them to the accountant and log the
> outcome in the correction register.

---

## Open questions — for the chamber's accountant

These are **unanswered**, which is why neither the admin UI nor this runbook
instructs anyone to file anything. Bundle them with the already-held 088 item
(*ภ.พ.30 voided-VAT + §86/10 netting*).

1. May output VAT already remitted on a refunded §105 sale be reduced at all,
   absent a §86/10 instrument — and by what instrument (an entry in
   รายงานภาษีขาย, an additional ภ.พ.30, an amended ภ.พ.30, or none)?
2. In which ภ.พ.30 month does any reduction belong — the refund month, or the
   original `payment_date` month?
3. Is a partial refund on a §105 sale a partial price reduction for VAT
   purposes, and how is the fractional VAT rounded?
4. Does a paid-then-voided invoice get the same treatment as §105, or does the
   VOID stamp suffice?

**No Revenue Code section is cited for the adjustment instrument.** The repo has
no verified answer, and naming one on a guess is the failure mode this document
exists to prevent.

---

## References

- Thai Revenue Code as used elsewhere in this repo: §78/1 (tax point), §86/4
  (tax invoice), §86/10 (credit note), §87 + §87/3 (registers, 5-year retention
  floor), §105 (receipt).
- `docs/runbooks/event-invoice-legacy-no-tin-remediation.md` — correction-register
  precedent (see the premise caveat in Step 3).
- `docs/observability.md` § 21.1 / § 21.3 / § 21.5.
