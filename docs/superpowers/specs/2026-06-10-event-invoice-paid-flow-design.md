# Event Invoice Paid-Flow Redesign — Design Spec (v1)

**Date:** 2026-06-10
**Status:** Draft — brainstorm-approved (4 sections), ready for writing-plans
**Area:** F4 Invoicing (`src/modules/invoicing/**`) — document-flow correction for event-fee invoices
**Supersedes (partially):** `2026-06-04-event-fee-invoice-design.md` §3a/§4 lifecycle decisions for the
already-paid path. All other parts of the 054 spec (VAT Model B, buyer snapshot, audit routing,
PII redaction, credit-note gates) remain in force.

---

## 1. Problem — §105 violation in the shipped 054 flow

The shipped event-fee invoice feature (PR #69) reuses the membership 2-step lifecycle
(`draft → issued (unpaid, due+30) → paid`) for event tickets. The thai-tax-compliance auditor
ruled (2026-06-09, full ruling in conversation; summary below) that this is **illegal for
no-TIN buyers**:

| Case | Current flow | Ruling |
|---|---|---|
| A — event buyer **with TIN** | Issue → ใบกำกับภาษี (unpaid) → pay → ใบเสร็จรับเงิน | **PASS** (§78 allows tax-invoice-before-payment) |
| B — event buyer **without TIN** | Issue → **ใบเสร็จรับเงิน #1** (status=issued, UNPAID) → pay → **ใบเสร็จรับเงิน #2** | **FAIL — SHIP BLOCKER** |

Why Case B fails (§105 วรรคหนึ่ง): a ใบเสร็จรับเงิน (Official Receipt) may only be issued
**ในทันทีที่รับชำระเงิน** — at the moment payment is received. The current flow renders a
receipt at *issue* time while the invoice is still unpaid (due+30), then renders a *second*
receipt at record-payment — two differently-numbered receipts for one payment.

Secondary findings from the ruling:
- §86/6 abbreviated tax invoice is **not available** (chamber is not a retailer; requires
  Director-General approval) → no-TIN → §105 receipt is the correct document type; only the
  *timing* is wrong.
- VAT tax point (§78) for an already-collected fee = the date payment was received → the
  document date must be the **real payment date**, not the admin keying date, or VAT lands in
  the wrong ภ.พ.30 month (§80).
- `dueDate = issue + 30` on an already-paid event invoice is misleading (implies an open
  receivable) — remove it from the already-paid path.
- §86/10 credit notes cannot reference a §105 receipt — already handled
  (`receipt_not_creditable`), unchanged.

## 2. Business reality (clarified 2026-06-10)

1. **Both payment timings exist.** Most event fees are already paid (attendee paid via
   EventCreate or另 channel before documentation), but some buyers must be **billed first**
   (corporate sponsors, registered-then-pay).
2. **Bill-first is TIN-only.** Only buyers with a 13-digit TIN may be billed before payment
   (a pre-payment tax invoice legally requires the buyer's TIN per §86/4). A no-TIN buyer is
   always already-paid; there is no legal document for "no-TIN, unpaid".
3. **Path detection:** auto from F6 `event_registrations.payment_status`
   (`paid` → already-paid; `unpaid` → bill-first) **with admin override** at creation.

## 3. Design — Approach A: new use-case `issueEventInvoiceAsPaid`

### 3.1 State machine (Domain)

```
Event already-paid (ALL no-TIN + TIN where already paid):
   draft ──issueAsPaid──> paid            ← NEW transition, atomic, ONE document
Event bill-first (TIN only) — unchanged:
   draft ──issue──> issued ──pay──> paid
Membership — unchanged:
   draft ──issue──> issued ──pay──> paid
```

- `canTransition` (`src/modules/invoicing/domain/invoice.ts:370`) gains `draft → paid`,
  **legal only when `invoiceSubject === 'event'`** (the subject must become an input to the
  transition check, or the Application layer enforces the subject guard before calling it —
  decide at plan time; membership must NOT be able to skip `issued`).
- A `paid` row created via this path carries everything a non-draft row needs in one step:
  §87 number, VAT split, snapshots, receipt PDF, `paidAt`, `paymentDate`.
- `issueDate = dueDate = paymentDate` (real money-received date). No open receivable is
  implied; satisfies the `due_date IS NOT NULL` leg of `invoices_non_draft_has_snapshots`.
- `netDaysSnapshot = 0` on this path.

### 3.2 Use-case (Application)

`src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts`

```
issueEventInvoiceAsPaid({ tenantId, actorUserId, requestId?, invoiceId, paymentDate, paymentMethod? }):
  withTx (runInTenant):
    1. load draft  — must be invoiceSubject='event' AND status='draft'
    2. allocate §87 number + compute VAT (splitVatInclusive — reuse, Model B unchanged)
    3. resolve buyer snapshot (non-member: pre-pinned at draft; matched member: pin now
       via getForIssue, same FOR-UPDATE archive guard as issueInvoice)
    4. document kind (single document):
         buyerHasTin  → 'receipt_combined'   (ใบกำกับภาษี/ใบเสร็จรับเงิน — §86/4 + §105ทวิ)
         no TIN       → 'receipt_separate'   (ใบเสร็จรับเงิน — §105)
    5. render ONE PDF + upload to Blob
    6. persist: status='paid', issueDate=dueDate=paymentDate, paidAt=now,
       paymentDate=input.paymentDate, receiptPdf fields, netDaysSnapshot=0
    7. audit: emit invoice_issued + invoice_paid atomically (reuse existing types; the
       existing member/non-member timeline-vs-non-timeline branch applies to both emits)
```

Reuses the existing numbering/VAT/snapshot logic from `issueInvoice` and the receipt-render
logic from `recordPayment` — composed, not duplicated (extract shared helpers where natural;
do NOT copy-paste the §87 allocator or renderAndUploadPdf blocks).

**`paymentDate` (VAT tax point — §78/§80):** input field, pre-filled from the F6 registration
where available, admin-editable, default today. The PDF's issue date IS this date. Validation:
not in the future; warn (not block) if > 60 days in the past (late documentation is the
operator's compliance call).

### 3.3 Document numbering (§87)

- TIN combined (`receipt_combined`) → **invoice** sequence stream (it IS a §86/4 tax
  invoice). Same stream membership uses — continuity preserved.
- no-TIN §105 (`receipt_separate`) → **receipt** sequence stream (the existing separate
  receipt stream), NOT the invoice stream. A §105 receipt is not a §86/4 document; mixing it
  into the tax-invoice stream is the part of the 054 design the auditor flagged as
  "confirm with an RD accountant". Using the receipt stream is the safe reading.
  ⚠️ Operator follow-up #2 (§6) tracks the accountant confirmation.

### 3.4 Guards (root fix for §105)

- `issueInvoice` (bill-first path) **rejects** `subject==='event' && !buyerHasTin(...)` with a
  new typed error `event_no_tin_requires_paid_issue` — a no-TIN event invoice can never again
  render a receipt at issue time. This deletes the violation at its root.
- `issueEventInvoiceAsPaid` accepts only `subject==='event'` + `status==='draft'`.
- Bill-first event (TIN) keeps the §86/4 TIN gate at issue.
- `recordPayment` is unreachable for the as-paid path (row is already `paid`; existing
  status-based idempotency handles a double-submit).

### 3.5 UX (`/admin/invoices/new`, event type)

- Mode detection: F6 `payment_status` → default mode, admin can override:
  - **already-paid** (default when F6=paid): show **payment-date** field (pre-filled) +
    doc-type preview (TIN → "ใบกำกับภาษี/ใบเสร็จรับเงิน", no-TIN → "ใบเสร็จรับเงิน") + single
    button **"บันทึกรับเงิน + ออกใบเสร็จ" / "Record payment & issue receipt"** → calls
    create-draft then `issueEventInvoiceAsPaid` (or a combined route) → lands on a `paid`
    invoice with ONE document.
  - **bill-first** (selectable only when buyer has TIN): existing flow unchanged
    (Create draft → Issue → later Record payment).
- Selecting no-TIN + bill-first is blocked with explanatory copy (EN/TH/SV):
  "ผู้ซื้อไม่มีเลขประจำตัวผู้เสียภาษี ต้องบันทึกรับเงินทันที — ออกใบเรียกเก็บล่วงหน้าไม่ได้ตามกฎหมาย".
- Invoices list: as-paid event rows appear directly as **Paid**; no dangling due date.

### 3.6 Data model / migrations

- Expected: **no new tables/columns**. `draft → paid` is Domain logic; paid rows populate the
  same snapshot/numbering/pdf fields.
- Verify at implement time that a `paid` row that never passed `issued` satisfies every CHECK
  (`invoices_non_draft_has_snapshots` 0203, `invoices_paid_has_receipt_status`, immutability
  trigger timing). If any CHECK assumes the issued intermediate state, amend it in a new
  migration (do not edit applied ones).

### 3.7 Audit

Reuse `invoice_issued` + `invoice_paid` (emitted atomically in the one tx). No new audit
event types → no 4-place enum churn. Member/non-member payload branching unchanged
(timeline vs `emitNonMemberInvoiceEvent`).

### 3.8 Testing (TDD, per Constitution II)

- **Unit:** `canTransition` event `draft→paid` ok / membership `draft→paid` rejected ·
  `issueEventInvoiceAsPaid` (no-TIN → one `receipt_separate`; TIN → one `receipt_combined`;
  `issueDate===paymentDate`; status `paid`; future paymentDate rejected) ·
  `issueInvoice` rejects no-TIN event (`event_no_tin_requires_paid_issue`).
- **Integration (live Neon):** as-paid no-TIN + TIN end-to-end (no 23514 from any CHECK);
  §87 continuity across interleaved membership + bill-first + as-paid; receipt-stream
  allocation for no-TIN; cross-tenant probe unchanged; idempotent double-submit.
- **PDF golden:** no-TIN §105 single receipt · TIN combined document (title
  "ใบกำกับภาษี / ใบเสร็จรับเงิน") · date = paymentDate.
- **E2E (`--workers=1`):** mode auto-detect + override · payment-date field · no-TIN
  bill-first blocked · single-document result. `@a11y` + `@i18n` on the new form states.
- **thai-tax-compliance auditor re-review before ship** (scope: document flow + §105 timing +
  numbering streams — explicitly NOT just VAT math this time).

## 4. What does NOT change

- Membership lifecycle, VAT Model B math, buyer-snapshot rules, §86/10
  `receipt_not_creditable`, PII redaction cron, F5 portal self-pay scope, audit taxonomy.
- Bill-first event flow for TIN buyers (it is legal; only gains the no-TIN rejection guard).

## 5. Governance

F4 = security/PII/tax surface → Review gate ≥2 reviewers (or solo-maintainer substitute) +
security checklist + thai-tax auditor sign-off. `draft→paid` subject-conditional transition
and the dual numbering streams go in `plan.md` § Complexity Tracking.

---

## 6. Out-of-code follow-ups (operator actions — tracked here so they are not lost)

| # | Item | Owner | When | Status |
|---|---|---|---|---|
| 1 | **Remediate already-issued no-TIN event documents** (e.g. `SC-2026-000022` and any other no-TIN event invoice issued under the old flow): with the accountant, void the issue-time pseudo-receipt and keep exactly one valid §105 receipt per payment; regenerate affected E2E/demo seeds afterwards | Operator + accountant | Before or at ship of this redesign | OPEN |
| 2 | **Confirm §105 numbering stream with an RD accountant**: no-TIN event receipts on the separate receipt stream (this spec §3.3) vs sharing the invoice stream — confirm the chosen reading; if the accountant rules the shared stream is required, §3.3 flips and the spec must be amended | Operator + accountant | During implementation (blocks ship sign-off) | OPEN |
| 3 | **Tax-point question for EventCreate-collected fees**: when EventCreate collects on TSCC's behalf and remits later, is the tax point the attendee-payment date or the remittance date? Design assumes attendee-payment date (`paymentDate` pre-fill). Confirm with tax advisor; if remittance date, only the pre-fill source changes | Operator + tax advisor | Before heavy production use of event invoicing | OPEN |
| 4 | **Advance-billing question (from auditor)**: may a sponsor with TIN be billed (tax invoice issued) before the event takes place, or must billing wait until the service is rendered? Current design allows it (bill-first = plain §78 pre-payment tax invoice). Confirm acceptable | Operator + tax advisor | Before first pre-event sponsor bill | OPEN |

---

## 7. References

- Auditor ruling 2026-06-09 (thai-tax-compliance-auditor, conversation record): §105 วรรคหนึ่ง,
  §78 tax point, §86/4, §86/6 unavailability, §86/10, §80 ภ.พ.30 period.
- `docs/superpowers/specs/2026-06-04-event-fee-invoice-design.md` (054 spec, superseded in part).
- Code: `src/modules/invoicing/domain/invoice.ts` (state machine), `domain/document-kind.ts`,
  `application/use-cases/issue-invoice.ts`, `application/use-cases/record-payment.ts`,
  `drizzle/migrations/0203_event_invoice_non_draft_snapshots_relax.sql`.
