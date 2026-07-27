# Runbook — `renewals_awaiting_payment_no_invoice` (wedged renewal cycles)

**Owner:** Renewals / Billing
**Alert:** AI-A1 (see `docs/observability.md` § 26.3)
**Severity:** report-only while the feature ships dark. See § 6 before promoting it to a paging alert.
**Related:** `docs/runbooks/stale-pending-count.md` (same shape — a gauge whose steady state is 0)

---

## 1. What this gauge means

`renewals_awaiting_payment_no_invoice{tenant}` counts renewal cycles that are
sitting in `awaiting_payment` for a **billable** member (not archived, not
erased) who has **no live membership invoice** (`draft` or `issued`).

In plain terms: *the system is waiting for this member to pay a bill that does
not exist.* They will never be billed and never chased, because every reminder
path keys off an invoice. Nothing else on any dashboard shows this —
`membership_suspended_count` counts them as ordinary unpaid members, which
looks completely normal during renewal season.

Steady-state expectation is **0**.

## 2. First triage step — was an invoice recently voided?

**Do this before anything else.** A voided-for-correction invoice is the single
most common benign cause, and void-on-reissue is a routine treasurer action.
Nothing clears `renewal_cycles.linked_invoice_id` on void, so the cycle stays
in `awaiting_payment` while its invoice leaves the live set.

```sql
-- Recently voided membership invoices for the affected tenant.
SELECT i.invoice_id, i.member_id, i.document_number, i.voided_at, i.void_reason
FROM invoices i
WHERE i.tenant_id = '<tenant-slug>'
  AND i.invoice_subject = 'membership'
  AND i.status = 'void'
  AND i.voided_at > now() - interval '7 days'
ORDER BY i.voided_at DESC;
```

If the wedged members appear in that list, this is **expected and transient** —
a corrected invoice is about to be issued. Confirm with the treasurer, then
close. If the same member is still wedged 48 hours later, treat it as real and
continue to § 3.

## 3. List the wedged cycles

Runnable as-is — substitute the tenant slug. This is the same predicate the
gauge uses (`src/modules/renewals/infrastructure/auto-invoice-gauge-query.ts`).

```sql
SELECT
  rc.cycle_id,
  rc.member_id,
  m.member_number,
  m.company_name,
  rc.status,
  rc.period_from,
  rc.period_to,
  rc.expires_at,
  rc.linked_invoice_id,
  rc.auto_draft_invoice_id,
  rc.created_at
FROM renewal_cycles rc
JOIN members m
  ON m.tenant_id = rc.tenant_id
 AND m.member_id = rc.member_id
WHERE rc.tenant_id = '<tenant-slug>'
  AND rc.status = 'awaiting_payment'
  AND m.archived_at IS NULL
  AND m.status <> 'archived'
  AND m.erased_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM invoices live
    WHERE live.tenant_id = rc.tenant_id
      AND live.member_id = rc.member_id
      AND live.invoice_subject = 'membership'
      AND live.status IN ('draft', 'issued')
  )
ORDER BY rc.expires_at ASC;
```

## 4. How a cycle gets wedged

| # | Cause | Signature | Action |
|---|---|---|---|
| 1 | **Invoice voided for correction** | a `void` membership invoice for the member in the last few days | § 2 — usually benign and transient |
| 2 | **Mutual abort near T-0** (Task 9's documented non-recovery window) | cycle flipped to `awaiting_payment`, `linked_invoice_id IS NULL`, no invoice row at all | § 5 — issue the bill |
| 3 | **Invoice hard-deleted / pruned** | `auto_draft_invoice_id` points at a row that no longer exists | § 5 |
| 4 | **Member reactivated after erasure/archive** | member is billable now but was not when the cycle moved | § 5 |

Note what is **not** here: an `issued` invoice whose cycle link is missing is
a *different* defect (Task 11's orphan), it is repaired automatically by the
`reconcile-issued-orphans` cron, and it is excluded from this gauge by the
`NOT EXISTS` clause. If you are looking at an orphan, you are in the wrong
runbook.

## 5. Remediation

For each genuinely wedged cycle, pick one:

**(a) The member should be billed** — the normal case.
Go to **Admin → Members → *member* → Renewals**, and issue a membership
invoice for the cycle's period. If the tenant is enrolled in auto-invoice, the
next daily auto-draft pass (05:00 ICT) will *not* pick this cycle up on its
own: `listCyclesEligibleForAutoDraft` only considers `upcoming`/`reminded`
cycles, and this one is already `awaiting_payment`. It must be issued by hand.

**(b) The cycle should not be open** — e.g. the member left, or the cycle was
superseded.
Cancel it through the admin UI so the cascade + audit trail fire. Do **not**
`UPDATE renewal_cycles SET status = ...` directly: the state machine writes an
audit row and the direct write does not, leaving an unexplained gap.

**(c) Data repair** — only with a maintainer present, and only after (a) and
(b) are ruled out.

After remediation, the gauge clears on the next daily coordinator pass
(05:00 ICT). It will **not** clear immediately.

## 6. Before promoting AI-A1 to a paging alert

AI-A1 ships **report-only** on purpose. Two things must happen first:

1. **Establish a real 0 baseline.** Collect at least one full week of daily
   samples with the feature enabled and confirm the value is genuinely 0 in
   steady state. Until then, "steady state is 0" is a design intent, not an
   observed fact.
2. **Alert on SUSTAINED wedge, not on `> 0`.** A transient void (§ 2) can put
   the gauge above zero for a day or two, and paging on that would burn the
   alert's credibility on the first fire. Fire on *the same cycles still
   wedged after N days* — e.g. value > 0 on 3 consecutive daily samples —
   rather than on any non-zero reading.

Also note the gauge goes **absent**, not stale, if its query fails
(`forgetAutoInvoiceGauges`). Whatever monitor you build should treat *no data*
as a distinct, investigable condition — not as 0.

## 7. Emergency stop — how to halt issuing/drafting

The treasurer's **Issue / Discard** routes
(`POST /api/invoices/[id]/issue-auto-drafted` + `.../discard-auto-draft`) do
NOT re-check `FEATURE_AUTO_INVOICE` themselves (2026-07 audit, security LOW —
by design). They are already covered by two blanket kill-switches that 503
every state-changing `/api/invoices/**` write:

- **`READ_ONLY_MODE=true`** (Vercel env + redeploy, ~30 s, reversible) — the
  fastest global write-freeze; halts Issue/Discard along with every other money
  mutation while keeping reads + sign-in alive.
- **`FEATURE_F4_INVOICING=false`** — disables the whole F4 invoicing surface
  (path-based) including these routes.

To stop only the *proactive drafting* without freezing manual invoicing, turn
off **`FEATURE_AUTO_INVOICE`** (the daily cron then short-circuits to
`200 {skipped}`) and/or the tenant flag `auto_invoice_enabled`; drafts already
in the queue remain issuable/discardable unless a blanket switch above is also
set.
