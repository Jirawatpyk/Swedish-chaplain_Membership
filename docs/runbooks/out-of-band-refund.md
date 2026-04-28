# Runbook: Out-of-Band Refund Detected

**Triggered by**: audit event `out_of_band_refund_detected` (FR-011a) + alert
**Severity**: HIGH (financial reconciliation drift)
**Owner**: Chamber-OS maintainer + tenant admin (joint resolution)
**Source spec**: F5 (`specs/009-online-payment/spec.md` Q2 / FR-011 / FR-011a)
**Last updated**: 2026-04-23 (initial draft as part of F5 `/speckit.plan`)

---

## 1. What happened

A `charge.refunded` webhook event arrived from Stripe whose `processor_refund_id` does NOT match any in-app `refunds` row. This means a refund was issued **directly in the Stripe dashboard** (or via Stripe API outside our app), bypassing the in-app refund flow.

Per Q2 / FR-011a, Chamber-OS **explicitly does not auto-reconcile** out-of-band refunds — no F4 credit note is created, no invoice-status transition occurs. The result is **ledger drift**: Chamber-OS thinks the invoice is still `paid`, while Stripe has actually refunded it.

This is a **safety net**, not a normal operating mode. It exists because (a) admin training takes time, (b) emergencies happen (Stripe support sometimes processes refunds on the merchant's behalf), and (c) our refund flow may be temporarily unavailable.

---

## 2. Immediate actions (within 1 hour)

### 2.1 Identify the affected invoice

The audit event payload contains:

```json
{
  "type": "out_of_band_refund_detected",
  "payload": {
    "processor_refund_id": "re_3R...",
    "processor_charge_id": "ch_3R...",
    "amount_satang": 350000,
    "runbook_url": "docs/runbooks/out-of-band-refund.md"
  }
}
```

Look up the in-app Payment + Invoice:

```sql
SELECT
  p.id as payment_id,
  p.invoice_id,
  p.amount_satang as paid_amount,
  i.status as invoice_status,
  i.tenant_id
FROM payments p
JOIN invoices i ON i.id = p.invoice_id
WHERE p.processor_charge_id = '<charge_id_from_audit>';
```

If no row is returned, the refund was for a payment we don't know about — escalate to maintainer (likely a bug or stale environment state).

### 2.2 Identify who initiated the dashboard refund

In Stripe Dashboard:
1. Navigate to Payments → search for `processor_charge_id` from audit
2. Open the payment → "Refund history" → click the refund row
3. Note the **Initiator** field (Stripe staff vs. dashboard user) + reason note

Common scenarios:
- **Tenant admin used the dashboard by accident** — most common; resolve by training + reconciliation
- **Stripe Support processed a refund on the merchant's request** — verify via Stripe support ticket reference
- **Card issuer initiated chargeback** — `charge.dispute.created` event should also be present; this is a different flow (post-MVP)

### 2.3 Decide reconciliation strategy

Two options:

**Option A — Manual in-app credit note** (preferred when possible):
- Sign in to Chamber-OS as admin
- Open the affected invoice → click "Issue credit note" (existing F4 admin action — no F5-specific UI needed for the manual recovery)
- Enter the refund amount + reason ("Reconciliation of out-of-band refund processed in Stripe on YYYY-MM-DD by [initiator]")
- This creates an F4 credit note + transitions invoice to `partially_credited` or `credited` — restoring ledger consistency
- **Caveat**: F4's manual credit-note flow does NOT call Stripe (no second refund) — exactly what we want here, since Stripe has already refunded

**Option B — Mark refund externally + skip credit note** (rare, only when F4 manual CN is not appropriate):
- The future post-MVP "Mark as refunded externally" escape hatch (out of scope for F5 MVP) would automate this; until then, document the divergence in the audit log + tenant accountant's books

In 99% of cases, **Option A** is the correct response.

---

## 3. Follow-up actions (within 1 week)

### 3.1 Notify the tenant admin

Send an email (template TBD; for now, manually):

```
Subject: Out-of-band refund detected on invoice <number>

Hi <admin name>,

Our system detected a refund that was processed directly in your Stripe
dashboard (not through Chamber-OS). The Chamber-OS ledger does not auto-update
in this case to keep our audit trail clean.

To reconcile, please issue a manual credit note in Chamber-OS:
1. Sign in to <admin URL>
2. Open invoice <number>
3. Click "Issue credit note" → enter THB <amount> with reason
   "Reconciliation of Stripe refund <re_xxx> processed on <date>"

Going forward, please always use the in-app "Issue refund" action — it
processes the Stripe refund AND creates the credit note in one step,
keeping your books accurate automatically.

Reference: docs/runbooks/out-of-band-refund.md
```

### 3.2 Update the metric

Verify `out_of_band_refund_rejected_total{tenant, processor_env}` incremented. If it's > 0 for two consecutive months, escalate per spec FR-021 — re-evaluate the Q2 design choice (currently "in-app only + reject"; alternative is "auto-reconcile both paths").

### 3.3 Document the incident

Append a row to `docs/incidents.md` (TBD — to be created on first incident):

| Date | Tenant | Initiator | Amount | Resolved by | Resolution time |
|------|--------|-----------|--------|-------------|-----------------|

---

## 4. Prevention

### 4.1 Admin training

In the Chamber-OS admin onboarding (delivered when a new tenant signs up post-F11):

> **Always issue refunds through Chamber-OS, never through the Stripe dashboard.**
> The in-app refund creates the legal credit note, emails the member, and keeps your books accurate. A dashboard refund creates ledger drift that we have to manually reconcile (this runbook).

### 4.2 Stripe dashboard restrictions (post-MVP)

Stripe permits **role-based access** to the dashboard. Recommend tenant admins:
- Use Stripe's "Read-only" role for users who don't need to refund
- Reserve "Administrator" role for the same person who has Chamber-OS admin access
- Enable Stripe Dashboard 2FA for all users

### 4.3 Future "Mark refunded externally" escape hatch (post-MVP)

If out-of-band refunds become common (> 1/month), implement the post-MVP escape hatch:
- Admin UI: "I see a refund in Stripe that I didn't create here — reconcile it"
- One-click action that creates the F4 credit note + audits with `out_of_band_refund_reconciled` event
- Tracked as a follow-up ticket to Q2 (re-evaluation criterion: out_of_band_refund_rejected_total > 0 for 2 consecutive months)

---

## 5. Rollback / escape hatch

If the manual reconciliation went wrong (e.g. created a CN for the wrong amount):

- F4 credit notes are immutable (per F4 FR-016 / Thai RD §87) — you CANNOT edit a CN
- Issue a second corrective CN with negative-amount-equivalent reasoning ("Correction of CN <prev>") — F4 supports this via the existing partial-credit-note flow
- Document both CNs in the incident log

If the Stripe refund itself was a mistake:
- A refund cannot be "undone" via API — the funds have left the Stripe balance
- Tenant must invoice the customer separately + collect again (manual workflow)

---

## 6. Related

- `specs/009-online-payment/spec.md` — Q2 + FR-011a + FR-020 (`out_of_band_refund_detected` audit event)
- `specs/009-online-payment/security.md` § T-06
- F4 manual credit note: `src/modules/invoicing/application/issue-credit-note.ts`
- Future post-MVP escape hatch: tracked in Q2 follow-up backlog
