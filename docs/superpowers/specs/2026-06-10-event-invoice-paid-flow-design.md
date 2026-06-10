# Event Invoice Paid-Flow Redesign — Design Spec (v2)

**Date:** 2026-06-10 · **Revised:** 2026-06-10 (v2 — 5-specialist panel findings incorporated)
**Status:** Draft — panel-reviewed (thai-tax PASS-with-conditions · architect APPROVE-WITH-CHANGES ·
reliability CHANGES-REQUESTED · drizzle §3.6-partially-holds · senior-tester coverage-gaps).
All HIGH/BLOCKER findings incorporated below. Ready for user review → writing-plans.
**Area:** F4 Invoicing (`src/modules/invoicing/**`) — document-flow correction for event-fee invoices
**Supersedes (partially):** `2026-06-04-event-fee-invoice-design.md` §3a/§4 lifecycle decisions for the
already-paid path. All other parts of the 054 spec (VAT Model B, buyer snapshot, audit routing,
PII redaction, credit-note gates) remain in force.

> **v2 changelog:** numbering decision restructured around the schema collision
> (`invoices_tenant_fiscal_seq_unique` has no stream discriminator — B-1/H-1/H-2 of the panel);
> §3.2 step order fixed (buyer→kind→allocate, lock order, §87 gap discipline); FY + blobKey derive
> from `paymentDate`; `paymentMethod` required; column-mapping table added; outbox email step added;
> J2 credit-note annotation-kind fix pulled into scope; F6 payment-status mapping corrected to the
> real enum (no `'unpaid'` value exists); §3.8a acceptance table + existing-test migration cost added;
> §6 gains ภ.พ.30 correction + error-correction procedure; follow-up #2 escalated to design-blocker.

---

## 1. Problem — §105 violation in the shipped 054 flow

The shipped event-fee invoice feature (PR #69) reuses the membership 2-step lifecycle
(`draft → issued (unpaid, due+30) → paid`) for event tickets. The thai-tax-compliance auditor
ruled (2026-06-09) that this is **illegal for no-TIN buyers**:

| Case | Current flow | Ruling |
|---|---|---|
| A — event buyer **with TIN** | Issue → ใบกำกับภาษี (unpaid) → pay → ใบเสร็จรับเงิน | **PASS** (§78/1 allows tax-invoice-before-payment) |
| B — event buyer **without TIN** | Issue → **ใบเสร็จรับเงิน #1** (status=issued, UNPAID) → pay → **ใบเสร็จรับเงิน #2** | **FAIL — SHIP BLOCKER** |

Why Case B fails (§105 วรรคหนึ่ง): a ใบเสร็จรับเงิน may only be issued **ในทันทีที่รับชำระเงิน**.
The current flow renders a receipt at *issue* time while the invoice is unpaid (due+30), then
renders a *second* receipt at record-payment — two differently-numbered receipts for one payment.

Secondary findings from the ruling:
- §86/6 abbreviated tax invoice is **not available** (chamber is not a retail/mass-service business
  under the Director-General's criteria) → no-TIN → §105 receipt is the correct document type;
  only the *timing* is wrong.
- VAT tax point (§78/1(1), service) for an already-collected fee = the date payment was received →
  the document date must be the **real payment date**, not the admin keying date, or VAT lands in
  the wrong ภ.พ.30 month (§80).
- `dueDate = issue + 30` on an already-paid event invoice is misleading — removed on the as-paid path.
- §86/10 credit notes cannot reference a §105 receipt — already handled
  (`receipt_not_creditable`), unchanged.

## 2. Business reality (clarified 2026-06-10)

1. **Both payment timings exist.** Most event fees are already paid (attendee paid via
   EventCreate or another channel before documentation), but some buyers must be **billed
   first** (corporate sponsors, registered-then-pay).
2. **Bill-first is TIN-only.** Only buyers with a 13-digit TIN may be billed before payment
   (a pre-payment tax invoice requires the buyer's TIN per §86/4 for a registered-business buyer;
   we apply it conservatively to all bill-first buyers). A no-TIN buyer is always already-paid;
   there is no legal document for "no-TIN, unpaid".
3. **Path detection — auto from F6 + admin override.** The real F6 enum is
   `paid | pending | refunded | free | waitlisted | no_show`
   (`src/modules/events/domain/value-objects/payment-status.ts:27-34` — there is **no `'unpaid'`
   value**; the v1 spec's mapping was wrong). Mapping:

   | F6 `payment_status` | Default mode | Override allowed? |
   |---|---|---|
   | `paid` | **already-paid** | → bill-first only if buyer has TIN |
   | `pending`, `waitlisted` | **bill-first** if TIN; **blocked** if no-TIN (copy: "รอรับเงินก่อน แล้วบันทึกแบบจ่ายแล้ว") | → already-paid allowed (F6 data may lag reality; admin attests money was received) |
   | `free` | no fee — invoice only creatable with `amountOverride` (existing `no_fee_free_event` guard); admin then picks the mode explicitly | both (TIN rules still apply) |
   | `refunded` | **hard-blocked** — documenting a refunded fee is wrong; explanatory copy | no override |
   | `no_show` | no default — admin must pick the mode explicitly (attendance flag says nothing about payment) | both (TIN rules still apply) |

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

- `canTransition` (`src/modules/invoicing/domain/invoice.ts:370`) becomes subject-aware:
  `canTransition(from, to, subject)`. `draft → paid` is legal **only when
  `subject === 'event'`**; for `'membership'` the legal map is unchanged.
  Panel note (architect M-1): `canTransition` currently has **zero production call-sites**
  (barrel + 2 test files only) — the new use-case MUST actually call it (making the domain
  table load-bearing for the first time); the runtime protections remain the §3.4 guards +
  repo WHERE-status clauses + DB CHECKs. Existing test
  `tests/unit/invoicing/domain/invoice.test.ts:382` pins `draft→paid` illegal — flip it
  (event) and keep the membership-illegal twin. `domain/invoice.ts` carries file-level 100%
  branch threshold — both directions of every new branch need tests.
- A `paid` row created via this path carries everything a non-draft row needs in one step.
- `issueDate = dueDate = paymentDate` (real money-received date); `netDaysSnapshot = 0`
  (verified: no positivity CHECK on the column).
- **Fiscal year derives from `paymentDate` (Bangkok local), NOT `now()`** (panel HIGH —
  tax #1 / reliability H-2): `fy = fiscalYearFromUtcIso(paymentDate→Bangkok)`. The existing
  `issueInvoice` uses `now` (`issue-invoice.ts:297`) — copying that would put a 28-Dec-2026
  payment keyed on 5-Jan-2027 into the FY2027 number stream on a document dated 2026
  (§87 stream/date mismatch + wrong ภ.พ.30 period). The PDF `blobKey` embeds the same fy.
  Backdated documents make stream numbers non-monotonic vs dates — normal for
  retrospective documentation; documented rationale for the accountant (§6 item 1).

### 3.2 Use-case (Application)

`src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts`

Input: `{ tenantId, actorUserId, requestId?, invoiceId, paymentDate, paymentMethod }` —
**`paymentMethod` is REQUIRED** (CHECK `invoices_paid_has_payment` forces
`payment_method NOT NULL` on every paid row — drizzle C3; same enum as `recordPayment`,
route may default to `'other'` following `mark-paid-from-processor.ts:169`).

`paymentDate` validation: not in the future **compared against Bangkok local date**
(`bangkokLocalDate(now)`, not UTC — an admin at 01:00 Bangkok must be able to enter "today");
**VAT-period-aware warning** (not block): warn when `paymentDate` falls in a prior tax month
whose ภ.พ.30 filing deadline has passed (≈ the 15th / e-filing 23rd of the following month),
with copy noting an additional filing may be needed — replaces the v1 fixed-60-day rule
(tax MEDIUM #4).

Step order **(v2 — reordered; the v1 order was unimplementable: the allocator needs to know
which stream, which depends on the buyer's TIN, which needs the snapshot — reliability H-1):**

```
withTx (runInTenant):
  1. lockForUpdate(invoice) → load draft — must be invoiceSubject='event' AND status='draft'
     (not-found → emit invoice_cross_tenant_probe + typed err, mirroring issueInvoice
      L195-207 — Principle I clause 4; this is a NEW mutation surface and needs its own
      probe + cross-tenant integration test, panel M-5)
  2. resolve buyer snapshot — non-member: pre-pinned at draft; matched member: pin now via
     getForIssue(forUpdate) with the same archive guard as issueInvoice
  3. document kind (single document):
       buyerHasTin  → 'receipt_combined'   (ใบกำกับภาษี/ใบเสร็จรับเงิน — §86/4 + §105ทวิ)
       no TIN       → 'receipt_separate'   (ใบเสร็จรับเงิน — §105)
  4. allocate number(s) per §3.3, fy from paymentDate   ← POST-SEQUENCE ZONE starts here:
     every later failure THROWS a TxAbort-carrier (IssueInvoiceInternalError pattern,
     issue-invoice.ts:174-178) so the allocator increment rolls back — returning err after
     allocate would commit a §87 gap. Pre-allocate failures return typed err as usual.
  5. compute VAT (splitVatInclusive — Model B, reuse) from the line sum
  6. render ONE PDF + upload to Blob (renderAndUploadPdf + loadTenantLogo — existing helpers)
  7. persist via NEW repo port method `applyIssueAsPaid(tx, …)` (WHERE status='draft';
     conflict → InvoiceApplyConflictError → 409): status='paid',
     issueDate=dueDate=paymentDate, paidAt=now, paymentDate, paymentMethod,
     netDaysSnapshot=0, column mapping per §3.6 table
  8. audit: emit invoice_issued + invoice_paid atomically, both via the in-tx emitter
     (`audit.emit(tx, …)` — never the null-tx variant), payload parity with recordPayment
     (payment_method, payment_date, receipt_document_number, receipt_pdf_async:false, …);
     member/non-member timeline-vs-emitNonMemberInvoiceEvent branching unchanged
  9. enqueue ONE auto-email outbox row (the invoice_paid receipt template; event_non_member
     PDPA footer when memberId null; empty-recipient → skip + warn + autoEmailSkipped metric
     — parity with recordPayment L619-677; v1 omitted email entirely, panel M-6)
```

Lock order follows the R7-S1 canonical order (invoice FOR UPDATE → member FOR UPDATE →
advisory lock → sequence FOR UPDATE — `issue-invoice.ts:6-30`); the v1 step order inverted
member-vs-advisory and was deadlock-prone against concurrent `issueInvoice`.

**Idempotency / concurrency (3 layers, explicit — panel M-1):** (1) `lockForUpdate` before
reading the draft; (2) `status !== 'draft'` after lock → typed 409; (3) `applyIssueAsPaid`
WHERE-status guard → `InvoiceApplyConflictError` → 409. This also serialises the cross-route
race (`/issue` vs `/issue-as-paid` on the same TIN draft — one wins, one gets 409).
Create-draft dedup (`invoices_event_registration_uniq`) is unchanged and covers as-paid rows
(`status='paid'` ≠ 'void' → indexed).

**F8 parity decision (panel L-1):** matched-member as-paid DOES fire the F4InvoicePaidEvent
onPaidCallbacks exactly like recordPayment (memberId non-null) — silent divergence rejected;
benign for event subject but explicit.

**Orphaned-blob note (reliability L-1):** render+upload happen in-tx; on rollback the row
stays draft and references no blob, but the uploaded blob itself survives as an orphan
(contains buyer PII). Existing issueInvoice has the same residual (its "transactional sweeper"
comment is aspirational — no sweeper exists). Mitigation: best-effort `blob.delete` in the
catch path; full sweeper remains out of scope (same as 054).

### 3.3 Document numbering (§87) — restructured (panel BLOCKER)

**Schema fact (B-1):** `invoices_tenant_fiscal_seq_unique` is
`UNIQUE(tenant_id, fiscal_year, sequence_number)` with **no stream discriminator**
(`drizzle/migrations/0019:217-219`), and the 0203 CHECK forces `sequence_number` +
`document_number` NOT NULL on every non-draft row. Receipt-stream numbers today NEVER occupy
`invoices.sequence_number` — they live in `receipt_document_number_raw` only
(`record-payment.ts:476-491`). Therefore the v1 instruction "no-TIN main number from the
receipt stream" cannot be persisted without colliding with the invoice stream (23505) or
failing the CHECK (23514). The v1 "§3.6 no new migrations" claim is withdrawn.

- **TIN as-paid → `receipt_combined` on the invoice stream** (it IS a §86/4 tax invoice;
  one payment, one document, one invoice number; `receipt_document_number_raw` stays NULL per
  the combined-mode precedent). Issued **regardless of tenant `receiptNumberingMode`** — that
  setting governs the 2-step flow's payment-time receipt. (Complexity Tracking entry.)
- **no-TIN as-paid → DECISION GATED ON §6 item 2 (now a DESIGN blocker, not a ship gate):**
  - **Path β (default — the auditor's "safe reading"):** the §105 receipt number comes from the
    existing **receipt stream** and is stored in `receipt_document_number_raw`;
    `sequence_number`/`document_number` stay NULL for these rows → requires ONE migration
    relaxing `invoices_non_draft_has_snapshots` + `invoices_draft_has_no_number` with predicate
    `invoice_subject='event' AND receipt_document_number_raw IS NOT NULL` (new migration; never
    edit applied ones; Drizzle `check()` builders synced).
  - **Path α (if the RD accountant approves stream-sharing):** keep the 054 status quo — the
    no-TIN receipt is numbered from the shared invoice stream (`sequence_number`/
    `document_number` as today, no migration). Mid-FY the no-TIN receipts simply continue in
    the same stream they already occupy (no renumbering split).
  - Implementation does NOT start on the no-TIN path until the accountant answers; the TIN
    path and all guards are independent and can proceed.
- FY for BOTH streams derives from `paymentDate` (§3.1). The receipt stream lazy-bootstraps
  per (tenant, type, fy) via the allocator's `ON CONFLICT DO NOTHING` — no seeding migration.
- Mid-year stream change (β) must be explained to the auditors/accountant in writing —
  folded into §6 items 1+2.

### 3.4 Guards (root fix for §105) + downstream latch

- `issueInvoice` (bill-first path) **rejects** `subject==='event' && !buyerHasTin(...)` with
  typed error `event_no_tin_requires_paid_issue` (whitespace-only TIN fires the guard too —
  `buyerHasTin` trims). Needs: HTTP mapping in the `/issue` route error map (422) + EN/TH/SV
  i18n keys + the 4 existing test files that assert the old behaviour flipped (§3.8).
- `issueEventInvoiceAsPaid` accepts only `subject==='event'` + `status==='draft'` and CALLS
  `canTransition('draft','paid','event')`.
- Bill-first event (TIN) keeps the §86/4 TIN gate at issue.
- **Interim legacy guard (tax MEDIUM #2):** until §6 item 1 remediation completes, legacy
  no-TIN event rows sitting at `status='issued'` can still reach `recordPayment` and mint a
  second receipt. Add a rejection in `recordPayment` for
  `subject='event' && !buyerHasTin && status='issued'` (typed error directing the operator to
  the remediation runbook), removable after remediation. `resend-pdf` keeps re-signing the
  pinned (illegal) blob for legacy rows — remediation, not code, fixes those documents.
- **J2 annotation-kind fix — IN SCOPE (tax HIGH #3):** `issue-credit-note.ts:629-635`
  hardcodes the re-render annotation kind `'invoice'` on the assumption that only
  kind='invoice' parents are creditable — FALSE once an as-paid TIN document
  (main PDF = `receipt_combined`) is credited: the J2 re-render would overwrite the only
  §105ทวิ receipt evidence blob with a wrongly-titled document (10-y retention violation).
  Derive the annotation kind from the stored document kind (subject + TIN + as-paid),
  with an integration test asserting the annotated original keeps the
  "ใบกำกับภาษี / ใบเสร็จรับเงิน" title.
- **Rate limit:** the new route gets the same 20/5min per (tenant, actor) limiter as `/issue`
  (same §87-burn rationale — `issue/route.ts:31-46`).
- **Error correction:** an as-paid no-TIN receipt keyed wrongly (amount/buyer) has NO
  in-system correction path (paid→void is illegal; §105 receipts are not creditable).
  v2 ships a documented manual procedure (§6 item 6); a void-from-paid transition is
  explicitly out of scope (v-next).

### 3.5 UX (`/admin/invoices/new`, event type)

- Mode detection per the §2.3 mapping table (auto-default + override columns there), shown as
  a mode selector with the detected default; payment-date field (pre-filled from F6 where
  available) and doc-type preview (TIN → "ใบกำกับภาษี/ใบเสร็จรับเงิน", no-TIN →
  "ใบเสร็จรับเงิน"); single button **"บันทึกรับเงิน + ออกใบเสร็จ" / "Record payment & issue
  receipt"** → client calls the existing event-draft route, then
  `POST /api/invoices/{invoiceId}/issue-as-paid` (admin-gated, zod-validated
  `paymentDate` + `paymentMethod`, rate-limited, error→HTTP map mirroring `/issue`).
  If the second call fails the invoice remains a plain draft (visible, re-actionable) —
  no partial document.
- **bill-first** (selectable only when buyer has TIN): existing flow unchanged.
- Selecting no-TIN + bill-first is blocked server-side (the §3.4 guard), with UI copy
  (EN/TH/SV): "ผู้ซื้อไม่มีเลขประจำตัวผู้เสียภาษี ต้องบันทึกรับเงินทันที —
  ออกใบเรียกเก็บล่วงหน้าไม่ได้ตามกฎหมาย".
- Invoices list: as-paid rows appear directly as **Paid**; no dangling due date.

### 3.6 Data model / persistence (v2 — corrected)

- **Migrations:** Path α — none. Path β — exactly one (CHECK relaxations per §3.3).
  The v1 blanket "no new migrations" claim is withdrawn (panel B-1).
- **Column mapping for the single as-paid document (panel M-2/C2/C3):**

  | Column | TIN (combined) | no-TIN (β) |
  |---|---|---|
  | `sequence_number` / `document_number` | invoice stream | NULL (relaxed CHECK) |
  | `receipt_document_number_raw` | NULL (combined precedent) | receipt-stream number (format-checked, 0060) |
  | `pdf_blob_key` / `pdf_sha256` / `pdf_template_version` | the single document (0203 requires) | same |
  | `receipt_pdf_status` | `'rendered'` — REQUIRED in the same UPDATE (0056 CHECK fires the moment status='paid'; `'pending'` would summon the T166 async worker + 0061 CHECK) | `'rendered'` |
  | `receipt_pdf_blob_key` | NULL (the receipt IS the document) | NULL |
  | `payment_method` / `paid_at` / `payment_date` | required (0019 CHECK) | required |
- Verified by the drizzle panel: immutability trigger early-returns on `OLD.status='draft'`
  (single UPDATE draft→paid passes); `invoices_subject_fields_ck`, credited-total CHECKs,
  `invoices_event_registration_uniq`, `invoices_draft_has_no_number` (α) all pass; receipt
  stream lazy-bootstraps. New repo port method `applyIssueAsPaid` (+ Drizzle impl threading
  `tx`) is an explicit port change (Principle III).

### 3.7 Audit

Reuse `invoice_issued` + `invoice_paid` (one tx, both in-tx emits — an emit failure rolls
back everything). No new audit event types. Payload parity with recordPayment (§3.2 step 8).
Two rows share `created_at` — verify the timeline consumer tiebreaks by insertion order, not
timestamp (reliability L-3).

### 3.8 Testing (TDD, per Constitution II)

**Coverage:** `issue-event-invoice-as-paid.ts` gets the same file-level 100%
lines/branches/functions entry in `vitest.config.ts` as `issue-invoice.ts` /
`record-payment.ts` (same tax-document mutation class).

**P0 (adversarial — from the senior-tester panel):**
- Concurrent double-POST of issue-as-paid (live Neon, parallel) → one success, one 409, one
  number consumed, one PDF, one audit pair; cross-route race `/issue` vs `/issue-as-paid`.
- FY boundary: paymentDate 28-Dec keyed 5-Jan → number in the paymentDate FY; blobKey fy matches.
- paymentDate Bangkok semantics (01:00 Bangkok "today" accepted); VAT-period warn boundary.
- Mode mapping for ALL SIX F6 payment_status values (incl. `refunded` hard-block, `free`
  amountOverride path, `no_show` no-default).
- Server-side block of no-TIN bill-first via direct `POST /api/invoices/{id}/issue`
  (contract test — the `/issue` route currently has NO contract tests at all).
- §87 interleave: membership → bill-first event → as-paid TIN in one FY (stream continuity
  N, N+1, N+2) + as-paid no-TIN interleaved (no invoice-stream burn under β) + receipt-stream
  FIRST allocation (lazy bootstrap in-tx).
- Rollback/§87-gap: blob-upload failure and second-audit-emit failure both roll back fully
  (row stays draft, no number burned, no audit rows, re-actionable).
- receiptNumberingMode='separate' tenant + as-paid TIN → still `receipt_combined`.
- CHECK-negative probes: missing receipt_pdf_status / missing payment_method → 23514 (proves
  the constraints fire); post-paid UPDATE blocked by immutability trigger.
- J2: as-paid TIN → issue credit note → annotated original keeps the combined title.
- Cross-tenant: as-paid on another tenant's draft → err + `invoice_cross_tenant_probe`
  (Principle I clause 3 Review-Gate blocker for the new surface).
**P1:** archived matched member; F6 status drift load→submit (pin the decision: server
re-checks F6 at draft-create only; admin override is attested); voided-then-recreate dedup;
audit payload-level integration; i18n key-resolution against real en/th/sv.json (key renames
are a known runtime-crash class); PDF golden as-paid variants (date=paymentDate incl. BE
display-only rendering).
**P2:** derive-overdue ignores as-paid rows; redaction-cron predicate covers paid-never-issued
(pin `status <> 'draft'`); CSV export includes as-paid; F5 portal shows no Pay button.

**Existing-test migration cost (explicit tasks, not incidental — senior-tester):**
flip `tests/unit/invoicing/issue-invoice.test.ts` L734/L744/L785 (no-TIN now rejected, incl.
whitespace-TIN branch); rewrite the no-TIN legs of
`tests/integration/invoicing/issue-event-invoice.test.ts` (L441) and
`record-payment-event-invoice.test.ts` (L201/L433) onto the as-paid path; rebuild the setup of
`credit-note-receipt-separate-blocked.test.ts` on as-paid; flip
`tests/unit/invoicing/domain/invoice.test.ts:382` + extend `invoice-state-machine.test.ts`
(100%-branch file); keep `record-payment.test.ts` L559-567 / `issue-credit-note.test.ts` L544
as commented legacy-row defensive tests until §6 item 1 completes; extend
`seq-interleaved-membership-event.test.ts` + `issue-vs-archive-race.test.ts` with as-paid legs;
new contract file `tests/contract/invoices/issue-as-paid.contract.test.ts` (template:
`event-draft.contract.test.ts`). Project-memory caveat: the pre-push contract gate is
non-blocking — run `pnpm vitest run tests/contract/invoices/` manually before push.

**thai-tax-compliance auditor re-review before ship** — scope explicitly includes document
FLOW (§105 timing, numbering streams, FY-from-paymentDate, J2 annotation), not just VAT math.

### 3.8a Acceptance scenarios (Given/When/Then per story)

| US | Scenario | Expected |
|---|---|---|
| US1 no-TIN as-paid | Given an event draft for a no-TIN buyer (F6 paid), When admin records payment+issues with paymentDate D, Then ONE ใบเสร็จรับเงิน (receipt_separate) exists, dated D, numbered per §3.3 decision, status=paid, audit issued+paid, one receipt email enqueued |
| US2 TIN as-paid | Given a TIN buyer draft (F6 paid), When issue-as-paid, Then ONE ใบกำกับภาษี/ใบเสร็จรับเงิน (receipt_combined, invoice stream) regardless of receiptNumberingMode |
| US3 TIN bill-first | Given a TIN buyer (F6 pending), When issue, Then ใบกำกับภาษี issued/unpaid as today; When later recordPayment, Then receipt per tenant mode (unchanged) |
| US4 override | Given F6 pending + no-TIN, When admin overrides to already-paid attesting receipt of funds, Then as-paid proceeds; Given F6 refunded, Then creation is hard-blocked |
| US5 no-TIN bill-first blocked | Given a no-TIN event draft, When `POST /api/invoices/{id}/issue` (direct API), Then 422 `event_no_tin_requires_paid_issue`, no §87 number consumed |

## 4. What does NOT change

- Membership lifecycle, VAT Model B math, buyer-snapshot rules, §86/10
  `receipt_not_creditable` gate (keyed off the same `inferEventDocumentKind` — as-paid no-TIN
  rows are correctly non-creditable; as-paid TIN rows correctly creditable), PII redaction
  cron (predicate `status <> 'draft'` already covers paid-never-issued), F5 portal self-pay
  scope (all F5 paths require status='issued', unreachable for as-paid).
- Two *intentional* behaviour changes called out (not silent): `issueInvoice` no longer
  accepts no-TIN events (the root fix), and matched-member as-paid fires F8 onPaidCallbacks
  (parity decision, §3.2).

## 5. Governance

F4 = security/PII/tax surface → Review gate ≥2 reviewers (or solo-maintainer substitute) +
security checklist + thai-tax auditor sign-off. Complexity Tracking entries:
(a) subject-conditional `draft→paid` transition; (b) numbering decision α/β + mid-year stream
implications; (c) receiptNumberingMode override on the as-paid TIN path; (d) FY-from-
paymentDate + backdating/non-monotonic numbering rationale; (e) `issueDate=dueDate` semantic
overload on as-paid rows; (f) VAT-rate-at-tax-point note (7% is decree-extended; a rate change
inside the backdate window would need the rate as of paymentDate — current code uses the
tenant's configured rate; acceptable for v1, noted).

---

## 6. Out-of-code follow-ups (operator actions — tracked here so they are not lost)

| # | Item | Owner | When | Status |
|---|---|---|---|---|
| 1 | **Remediate already-issued no-TIN event documents** (e.g. `SC-2026-000022`): with the accountant, void the issue-time pseudo-receipt and keep exactly one valid §105 receipt per payment; retain originals+copies with cancellation notes for the full §87/3 period; regenerate affected E2E/demo seeds. **Must complete BEFORE flag-flip** (until then the §3.4 interim guard blocks legacy double-receipts) | Operator + accountant | Before flag-flip / ship | OPEN |
| 2 | **Confirm §105 numbering stream with an RD accountant** — **DESIGN BLOCKER for the no-TIN path** (β = separate receipt stream + 1 migration, α = shared invoice stream + none; §3.3). TIN path + guards proceed independently | Operator + accountant | Before implementing the no-TIN path | OPEN |
| 3 | **Tax-point question for EventCreate-collected fees**: attendee-payment date (assumed; drives the paymentDate pre-fill) vs remittance date | Operator + tax advisor | Before heavy production use | OPEN |
| 4 | **Advance-billing question**: may a TIN sponsor be billed before the event takes place? Current design allows it (§78/1 pre-payment tax invoice) | Operator + tax advisor | Before first pre-event sponsor bill | OPEN |
| 5 | **ภ.พ.30 period correction for mis-issued documents** (tax HIGH #4): for each legacy no-TIN event document, if the issue-date month (when output VAT was declared) ≠ the real payment month, file additional ภ.พ.30 returns (surcharge 1.5%/month on underpaid months) | Operator + accountant | With item 1 | OPEN |
| 6 | **Manual error-correction procedure for as-paid receipts** (no in-system path: paid→void illegal, §105 not creditable): document the accountant-approved cancel-and-reissue procedure (retain the erroneous receipt with a cancellation note; issue a corrected receipt) in the operations runbook | Operator + accountant | Before flag-flip | OPEN |

---

## 7. References

- Auditor ruling 2026-06-09 + 5-specialist panel review 2026-06-10 (thai-tax-compliance-auditor,
  chamber-os-architect, reliability-guardian, drizzle-migration-reviewer, senior-tester —
  conversation record): §105 วรรคหนึ่ง, §78/1 tax point, §86/4, §86/6 unavailability, §86/10,
  §80 ภ.พ.30 period.
- `docs/superpowers/specs/2026-06-04-event-fee-invoice-design.md` (054 spec, superseded in part).
- Code: `src/modules/invoicing/domain/invoice.ts` (state machine) · `domain/document-kind.ts` ·
  `application/use-cases/issue-invoice.ts` · `record-payment.ts` · `issue-credit-note.ts`
  (J2, L629) · `resend-pdf.ts` · `src/modules/events/domain/value-objects/payment-status.ts`
  (real F6 enum) · `drizzle/migrations/0019` (unique index :217, paid-has-payment :203) ·
  `0056` · `0060` · `0061` · `0201` · `0203` · `0206/0207` (immutability trigger) ·
  `infrastructure/persistence/postgres-sequence-allocator.ts` (lazy bootstrap).
