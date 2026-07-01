# Tasks: Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)

**Feature**: `088-invoice-tax-flow-redesign` | **Input**: spec.md (US1–US8, FR-001…025, SC-001…008), plan.md, data-model.md (§ A–F, migrations 0230–0234), research.md (D1–D19), contracts/ (issue-invoice, pay-and-record-payment, issue-credit-note, tenant-invoice-settings, member-branch), quickstart.md
**Tests**: REQUIRED — Constitution Principle II (Test-First, NON-NEGOTIABLE). Every user story authors ≥1 failing acceptance test before implementation; security-critical use cases need 100% branch coverage; integration tests hit live Neon `dev`.
**Organization**: by user story (US1–US8) for independent implementation + testing.
**Module**: `src/modules/invoicing/**` (Domain/Application/Infrastructure) + `src/modules/members/**` (branch) + presentation `src/app/(staff)/admin/**` · `src/app/(member)/portal/**` · `src/components/invoices/**` · i18n `src/i18n/messages/{en,th,sv}.json`.

**Format**: `[ID] [P?] [Story?] Description with file path` — `[P]` = parallelizable (different files, no incomplete-task dependency).

⚠️ **Repo gotchas baked into ordering**: apply each Drizzle migration to the `dev` Neon branch and run `pnpm test:integration` **before committing** schema-referencing code (F4 R8); tenant-scoped repo methods MUST thread `tx` from `runInTenant`, never the global `db`; audit-event enum adds are a **4-place** change (domain const + pgEnum + count test + completeness test); run `pnpm typecheck` + full `pnpm lint` as the final gate.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: flag, fixtures, and cutover scaffolding shared by all stories.

- [X] T001 Add `FEATURE_088_TAX_AT_PAYMENT` kill-switch to the zod env schema in `src/lib/env.ts` (default off) + document it in `specs/088-invoice-tax-flow-redesign/quickstart.md`; the flag gates the new bill→payment flow AND (per G5) the US8 `vat_treatment` UI + zero-rate render.
- [X] T002 [P] Add tax-flow test builders (bill / tax-receipt / zero-rate-invoice factories) in `tests/helpers/invoicing-factories.ts`.
- [X] T003 [P] Scaffold `scripts/verify-088-cutover.ts` (asserts zero issued-unpaid legacy invoices + `legal_entity_type` populated + settings seeded) per plan § Rollout.
- [X] T004 [P] Scaffold new i18n keys (bill/tax-receipt titles, §80/1(5) note, bank block, two-doc badges) in `src/i18n/messages/en.json` as canonical, with TH + SV placeholders (guarded by `pnpm check:i18n`).

**Checkpoint**: flag + fixtures ready.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema baseline + numbering streams + snapshot scaffolding + audit event that ALL stories build on. **⚠️ No user story work begins until this phase is green.**

- [ ] T005 Migration `0230_document_type_add_bill.sql` — `ALTER TYPE document_type ADD VALUE 'bill'` **AND** `ALTER TYPE document_type ADD VALUE 'receipt_105'` (the separate `RE` §105 register — added definitely, NOT conditional on any D2-split) (own migration, enum-add ordering) in `drizzle/migrations/` + `bill` and `receipt_105` in the `document_type` pgEnum in `src/modules/invoicing/infrastructure/db/schema-tenant-document-sequences.ts`.
- [ ] T006 Migration `0231_invoices_bill_number_and_checks.sql` — add `bill_document_number_raw` + `invoices_tenant_bill_raw_uniq` partial unique index + rewrite `invoices_draft_has_no_number` & `invoices_non_draft_has_snapshots` + extend `invoices_enforce_immutability`; mirror into `src/modules/invoicing/infrastructure/db/schema-invoices.ts` (data-model § B.3).
- [ ] T007 [P] Add the non-§87 `bill` stream (prefix `SC`, gaps allowed) to `src/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator.ts` + `application/ports/sequence-allocator-port.ts` — reuse the advisory-lock/FY machinery, do NOT assert §87 no-gaps on this stream (research D2/§2).
- [ ] T008 [P] Retire combined-numbering (data-model § F.5): tighten `receipt_numbering_mode` CHECK to `'separate'`-only, drop `'combined'` from the settings zod enum in `src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts`, and delete the `combinedMode` number-reuse branch in `src/modules/invoicing/application/use-cases/record-payment.ts`.
- [ ] T009 Add `tax_receipt_issued` audit event as a **4-place** change (10y retention): domain const/tuple in `src/modules/invoicing/domain/**` audit taxonomy, `audit_event_type` pgEnum, audit-event **count** test, audit-event **completeness** test (data-model § F.6).
- [ ] T010 Extend the issue-time computed snapshot VOs with the base fields (nullable/defaulted, wired per-story later): `buyer_is_vat_registrant` + branch in `src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts`, seller branch + `wht_note` in `tenant-identity-snapshot.ts`, `vat_treatment` default `'standard'` — all `.optional().default(...)` (data-model § C / § F.1 / § F.8.3).
- [ ] T011 Apply migrations 0230+0231 to the `dev` Neon branch (`pnpm db:migrate`) and run `pnpm test:integration` to prove the schema before any dependent code is committed (repo gotcha).

**Checkpoint**: schema + streams + audit + snapshot scaffolding green on live Neon — user stories can begin.

---

## Phase 3: User Story 1 — Non-tax bill → tax receipt at payment (Priority: P1) 🎯 MVP

**Goal**: pre-payment doc is a non-tax ใบแจ้งหนี้ (non-§87 bill number); the single §86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน is issued only at payment, dated at payment date, §87 RC number born then. No member ever holds two §86/4 tax invoices.

**Independent Test**: issue a membership bill → PDF is ใบแจ้งหนี้ with `SC-…`, no §86/4 title; pay (online + offline) → one ใบกำกับภาษี/ใบเสร็จ dated at payment, `RC-…` §87 number; SC-001 audit query shows exactly one `tax_receipt_issued`.

### Tests for US1 (author first, MUST fail) ⚠️

- [ ] T012 [P] [US1] Contract test for issue-invoice (bill kind, `SC` number, no §87 at issue) in `tests/contract/invoicing/issue-invoice.contract.test.ts` per `contracts/issue-invoice.md`.
- [ ] T013 [P] [US1] Contract test for pay-and-record-payment (RC §87 minted in-tx at payment, `tax_receipt_issued` emitted, dated at payment date) in `tests/contract/invoicing/pay-and-record-payment.contract.test.ts` per `contracts/pay-and-record-payment.md`.
- [ ] T014 [P] [US1] Integration test (live Neon): issue → offline pay → exactly one RC §86/4 receipt, bill `document_number` NULL, `bill_document_number_raw` set, one `tax_receipt_issued` (SC-001) in `tests/integration/invoicing/bill-to-receipt.integration.test.ts`.
- [ ] T015 [P] [US1] Integration test: online (Stripe passthrough) + offline produce identical receipt kind/number/dating (FR-005) in `tests/integration/invoicing/payment-parity.integration.test.ts`.
- [ ] T015a [P] [US1] Integration test (live Neon): interleaved membership + event-with-TIN payments within a fiscal year → the §87 `RC` tax-receipt register is contiguous / gap-free (SC-002) in tests/integration/invoicing/rc-no-gaps.integration.test.ts

### Implementation for US1

- [ ] T016 [US1] Relabel `PdfDocKind 'invoice'` in place → ใบแจ้งหนี้/Invoice (title + kind-aware Original marker = null) in `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` (research D1); update `src/modules/invoicing/domain/document-kind.ts` title map.
- [ ] T017 [US1] `issue-invoice.ts` allocates only the non-§87 `SC` bill number (not the §87 stream) + pins the snapshot in `src/modules/invoicing/application/use-cases/issue-invoice.ts`.
- [ ] T017a [US1] FR-027 pre-issue review/confirm dialog before issue in `src/app/(staff)/admin/**` + `src/components/invoices/**`: surface buyer + the Head-Office/Branch line that will print, VAT treatment (visually prominent when zero-rated 0%), cert no/date, totals, the SC bill number stream (no §87), WHT-note presence, with an explicit acknowledgement that issue PINS an immutable tax snapshot (editable only by void); WARN when (a) the bill renders with no payment path (online-pay off AND bank block empty) and (b) no §86/4 branch line prints because the buyer's `legal_entity_type` is unset (folds FR-008's branch preview + the NULL-legal-entity-type warn — cross-ref T032); EN/TH/SV keys.
- [ ] T018 [US1] Move §87 RC allocation into the payment tx: `record-payment.ts` allocates `receipt_document_number_raw` (RC) in-tx, dates at payment date (Asia/Bangkok), emits `tax_receipt_issued`, enqueues render (research §3, FR-002).
- [ ] T018a [US1] FR-028 route record-payment / any §87-minting action through the money-mutation modal (ux §6.4 — spinner, dialog stays open until success/failure, NO optimistic close, NO undo toast) in `src/app/(staff)/admin/**` + `src/components/invoices/**`; optimistic-UI + undo-toast are FORBIDDEN on any §87-minting mutation (never reuse the shipped bulk-mark-paid optimistic/undo pattern here).
- [ ] T019 [US1] Mirror the identical RC allocation + `tax_receipt_issued` in `src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts` (must behave identically to record-payment; FR-005/FR-006).
- [ ] T019a [US1] FR-029 render the new `tax_receipt_issued` event on the member timeline (link the RC document + interpolate the `RC-…` number; keys `admin.members.timeline.taxReceiptIssued` EN/TH/SV), reword the existing `invoiceIssued` copy to "ใบแจ้งหนี้ issued", and render paid + tax-receipt so the payment moment is not confusingly doubled, in `src/app/(staff)/admin/members/**` timeline + `src/i18n/messages/*` (FR-014's relabel scope includes `admin.members.timeline.*`).
- [ ] T020 [US1] Async worker: `render-receipt-pdf.ts` reads `receipt_document_number_raw` + payment-date-derived `fiscalYear` (NOT frozen issue FY), recompute kind via `inferReceiptKind`, null-safe every `documentNumber` deref (data-model § F.2).
- [ ] T021 [US1] Wire online payment (Stripe confirm / PromptPay) through `recordPayment` so the online path mints the RC + `tax_receipt_issued` identically (FR-005); no card data change (PCI SAQ-A untouched).
- [ ] T021a [US1] FR-032 uniform action feedback: issue/pay/re-render/credit/void emit doc-specific success toasts EN/TH/SV (issue→"ใบแจ้งหนี้ SC-… issued", pay→"Tax receipt RC-… issued", etc.); irreversible/tax-mutation FAILURES route to an inline `role="alert"` (focused), NOT a transient toast; a concurrent stale-write (409) shows an inline "already paid/voided — refresh", not a raw error, in `src/app/(staff)/admin/**` + `src/components/invoices/**` + `src/i18n/messages/*`.
- [ ] T021b [US1] FR-035 command-palette admin actions "Record payment for …" (deep-link `?pay=1`) + "Re-render tax receipt"; keys `admin.commandPalette.invoices.*` EN/TH/SV in the command-palette registration under `src/app/(staff)/admin/**` / `src/components/**`.
- [ ] T021c [US1] FR-035 per-row "Record payment" quick action on issued bills (defaults today / bank-transfer) in the `src/app/(staff)/admin/**` invoice list; optional bulk record-payment = one RC per invoice sequentially in-tx, gap-free, NOT undoable (never reuse the optimistic/undo bulk-mark-paid pattern).
- [ ] T021d [US1] FR-035 toast-with-undo (10s) after ISSUE only (revert to draft — no §87 consumed) in `src/app/(staff)/admin/**` + `src/i18n/messages/*`; undo/optimistic NEVER on record-payment (FR-028).
- [ ] T022 [US1] Gate the whole new flow behind `FEATURE_088_TAX_AT_PAYMENT` (T001); flag off = legacy behaviour.
- [ ] T023 [US1] Apply any US1 schema deltas to `dev` Neon + re-run `pnpm test:integration` (T012–T015 now green); `pnpm typecheck`.

**Checkpoint**: MVP — bill→payment→single §86/4 works online + offline; SC-001/SC-002/SC-003 provable.

---

## Phase 4: User Story 2 — Tax receipt renders Original + Copy (Priority: P1)

**Goal**: the ใบกำกับภาษี/ใบเสร็จ is a single PDF with ต้นฉบับ + สำเนา, one document number, one artifact (§105ทวิ คู่ฉบับ).

**Independent Test**: generate a payment-time receipt → PDF has 2 pages (Original + Copy) sharing one RC number and one sha.

- [ ] T024 [P] [US2] Integration/PDF test asserting the `receipt_combined` PDF has an Original page + a Copy page sharing one RC number + one stored artifact (SC-004) in `tests/integration/invoicing/original-copy.integration.test.ts`.
- [ ] T025 [US2] Render ต้นฉบับ + สำเนา as two pages/one PDF for `receipt_combined` in `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` (spec § A.2, US2 AS1).
- [ ] T026 [US2] Confirm the blob/sha adapter stores the single two-page artifact once in `src/modules/invoicing/infrastructure/adapters/*blob*` (no double-render).

**Checkpoint**: US1 + US2 — every tax receipt carries Original + Copy.

---

## Phase 5: User Story 3 — §86/4 Head Office / Branch on both parties (Priority: P2)

**Goal**: seller + buyer §86/4 blocks show สำนักงานใหญ่/สาขา; buyer branch on the member record (admin-managed), default head office, rendered only for VAT-registrant juristic buyers (fail-closed on NULL `legal_entity_type`).

**Independent Test**: set a member branch → receipt shows สาขาที่ NNNNN; unknown branch → สำนักงานใหญ่; individual/NULL type → no branch line; seller always TSCC head office.

### Tests for US3 (author first, MUST fail) ⚠️

- [ ] T027 [P] [US3] Contract test for member-branch admin edit (head-office/branch pairing, admin-only) in `tests/contract/members/member-branch.contract.test.ts` per `contracts/member-branch.md`.
- [ ] T028 [P] [US3] Integration test: VAT-registrant + branch → สาขา line; registrant + no branch → สำนักงานใหญ่; individual/NULL → NO line (fail-closed); seller = head office (US3 AS1–4, §F.1) in `tests/integration/invoicing/branch-render.integration.test.ts`.

### Implementation for US3

- [ ] T029 [US3] Migration `0232_members_branch_fields.sql` — `is_head_office` + `branch_code` + `members_branch_pairing_ck`; mirror into `src/modules/members/infrastructure/db/schema-members.ts`.
- [ ] T030 [US3] Populate `buyer_is_vat_registrant` on the identity snapshot at issue from `members.legal_entity_type` (`≠ individual` AND non-NULL → true; else false, fail-closed) in `src/modules/invoicing/application/use-cases/issue-invoice.ts` + the VO from T010.
- [ ] T031 [P] [US3] Admin member-branch edit (admin-only, tax-critical posture) in the members application + `src/app/(staff)/admin/members/**` edit surface.
- [ ] T032 [US3] Render seller + buyer Head Office/Branch on BOTH ใบแจ้งหนี้ and tax receipt, gated on `buyer_is_vat_registrant` (never `buyerHasTin`), in `invoice-template.tsx` (FR-008).
- [ ] T033 [US3] Apply 0232 to `dev` Neon + `pnpm test:integration` (T027/T028 green).

**Checkpoint**: §86/4 branch particular present + fail-closed.

---

## Phase 6: User Story 4 — Document presentation polish (Priority: P2)

**Goal**: thousands separators, capitalized English amount-in-words, buyer block order Name→Address→Tax ID→Head Office/Branch, membership line = plan name + coverage period.

**Independent Test**: render each kind → `12,000.00`, uppercase words, correct buyer order, plan+period line.

- [ ] T034 [P] [US4] Unit test: `formatThbSatang` adds thousands separators + amount-in-words capitalized first letter (deterministic, locale-independent) in `tests/unit/invoicing/format-thb.test.ts` (FR-009).
- [ ] T035 [US4] Add thousands-separator + capitalized English words + buyer-block reorder (FR-010) + membership line = plan + period (FR-011) in `invoice-template.tsx`.
- [ ] T035a [US4] FR-034 §86/4 particulars (buyer name, line items, plan+period, notes) MUST wrap/paginate and are NEVER silently truncated (a truncated buyer name / dropped line is non-compliant); Original + Copy paginate consistently on overflow, with a PDF overflow-pagination assertion, in `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx`.
- [ ] T036 [P] [US4] Wire the plan-name + coverage-period into the membership line description at issue in `issue-invoice.ts`.

**Checkpoint**: presentation matches the customer's document.

---

## Phase 7: User Story 5 — Tenant-configurable footer + WHT note + bank block (Priority: P2)

**Goal**: replace the hardcoded footer with tenant-configurable notes; WHT note renders on membership documents ONLY; FR-022 offline-payment bank block on the ใบแจ้งหนี้.

**Independent Test**: configure WHT note → renders on membership doc, NOT on event doc; second tenant with no note → clean footer; bank block renders on the ใบแจ้งหนี้ only.

### Tests for US5 (author first, MUST fail) ⚠️

- [ ] T037 [P] [US5] Contract test for tenant-invoice-settings PATCH (wht_note_th/en, seller branch, bank fields; `'combined'` rejected) in `tests/contract/invoicing/tenant-invoice-settings.contract.test.ts` per `contracts/tenant-invoice-settings.md`.
- [ ] T038 [P] [US5] Integration test: WHT note on membership doc, absent on event doc, absent for a no-note tenant (SC-007) in `tests/integration/invoicing/wht-note-scope.integration.test.ts`.

### Implementation for US5

- [ ] T039 [US5] Migration `0233_tenant_invoice_settings_wht_and_seller_branch.sql` — `wht_note_th/_en` + `seller_is_head_office` + `seller_branch_code` + `tenant_invoice_settings_seller_branch_ck` **+ the FR-022 bank-block fields** (payee/account/bank/branch/address/swift/instructions, all NULL) per data-model § F.7; mirror into `schema-tenant-invoice-settings.ts`.
- [ ] T040 [US5] Thread the note + seller-branch + bank fields settings → snapshot → template in `update-tenant-invoice-settings.ts` + the settings repo (thread `tx` from `runInTenant`).
- [ ] T041 [US5] Render the tenant WHT note gated on `invoice_subject='membership'` (both membership docs, never event) + drop the hardcoded Chamber-OS/§-citation footer in `invoice-template.tsx` (FR-012).
- [ ] T042 [US5] Render the FR-022 bank block + "Issued by"/"Received by"/"Date" fields on the ใบแจ้งหนี้ ONLY (not the tax receipt) in `invoice-template.tsx`.
- [ ] T043 [P] [US5] Add WHT-note + seller-branch + bank fields to the settings form in `src/components/invoices/invoice-settings-form.tsx` (remove the `'combined'` option).
- [ ] T043a [US5] Confirmation dialog on changing the document prefix / numbering mode (warn of the §87 numbering-stream impact) + success/error save toasts (MED); EN/TH/SV dialog + toast keys in `src/components/invoices/invoice-settings-form.tsx`.
- [ ] T043b [US5] Structured bank-block fields (payee, account_no, account_type, bank, branch, address, swift + a free-text instructions line TH/EN — NOT one blob) with SWIFT + account-no format validation, help text, char counters, EN/TH/SV labels (MED; data-model § F.7, SHARED UX #3) in `src/components/invoices/invoice-settings-form.tsx`.
- [ ] T044 [US5] Apply 0233 to `dev` Neon + `pnpm test:integration` (T037/T038 green).

**Checkpoint**: footer/WHT/bank are tenant-configurable + membership-scoped.

---

## Phase 8: User Story 6 — Credit notes target the tax receipt (Priority: P2)

**Goal**: §86/10 ใบลดหนี้ references + annotates the §86/4 tax receipt (not the bill), issuable only after the receipt exists; crediting an unpaid bill rejected.

**Independent Test**: credit an unpaid bill → rejected; pay then credit → references RC number, CREDITED annotation on the receipt blob.

### Tests for US6 (author first, MUST fail) ⚠️

- [ ] T045 [P] [US6] Contract test for issue-credit-note (targets `receiptDocumentNumberRaw`, blocked pre-receipt) in `tests/contract/invoicing/issue-credit-note.contract.test.ts` per `contracts/issue-credit-note.md`.
- [ ] T046 [P] [US6] Integration test: credit unpaid bill rejected; paid → CN references RC + annotation lands on the receipt blob (SC-006, § A.4) in `tests/integration/invoicing/credit-note-target.integration.test.ts`.

### Implementation for US6

- [ ] T047 [US6] Re-target credit note to the tax receipt: `original_document_number → receiptDocumentNumberRaw ?? documentNumber.raw`, `original_issue_date → receipt (payment) date`; add precondition `receipt_pdf_status='rendered'` in `src/modules/invoicing/application/use-cases/issue-credit-note.ts` (§ A.4).
- [ ] T048 [US6] Re-target the CREDITED annotation to the `receipt_pdf_blob_key` (kind `receipt_combined`), not the non-tax bill blob.

**Checkpoint**: credit notes legally target the tax document.

---

## Phase 9: User Story 7 — Event-fee parity, §105 unchanged (Priority: P3)

**Goal**: event-with-TIN reuses ใบแจ้งหนี้ → RC receipt; event-without-TIN stays §105 ใบเสร็จ at payment (unchanged legal identity); all inherit the polish.

**Independent Test**: event-with-TIN billed then paid → same ใบแจ้งหนี้→RC flow; event-no-TIN → §105 receipt at payment as today.

- [ ] T049 [P] [US7] Integration test: event-with-TIN → bill→RC flow; event-no-TIN → `receipt_separate` §105 at payment, legal identity unchanged, new presentation (US7 AS1/AS2) in `tests/integration/invoicing/event-parity.integration.test.ts`.
- [ ] T050 [US7] Confirm `inferEventDocumentKind` routes event-with-TIN to the bill→RC path and event-no-TIN to `receipt_separate` at payment, with the event-no-TIN §105 number allocated from the SEPARATE `RE` (`receipt_105`) register — prefix `RE`, sequential (good bookkeeping) but NOT under the strict §87 tax no-gaps (it is a §105 non-tax receipt, not §86/4), reusing the existing allocator machinery — in `src/modules/invoicing/domain/document-kind.ts` + `src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts` + `src/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator.ts`.
- [ ] T051 [US7] Ensure event documents inherit US4 presentation without altering the §105 legal identity in `invoice-template.tsx`.

**Checkpoint**: event flows consistent, §105 untouched.

---

## Phase 10: User Story 8 — Embassy / int'l-org §80/1(5) VAT zero-rate (Priority: P3) — trailing, severable

**Goal**: per-invoice `vat_treatment` (standard 7% / zero_rated_80_1_5 0%), MFA-cert capture (fail-closed), full §86/4 at VAT 0% + §80/1(5) note; membership always 7%. Gated by `FEATURE_088_TAX_AT_PAYMENT` for independent dark-launch (G5). **P1 core (US1–US6) ships even if US8 slips (G4).**

**Independent Test**: issue non-membership zero-rate w/ cert → bill + RC at VAT 0% + §80/1(5) note; no cert → blocked; membership → cannot be zero-rated.

### Tests for US8 (author first, MUST fail) ⚠️

- [ ] T052 [P] [US8] Contract test: issue-invoice `vatTreatment='zero_rated_80_1_5'` requires `zeroRateCertNo` (422 `zero_rate_cert_required`), membership coerced to standard, `<5,000` warns in `tests/contract/invoicing/issue-invoice-zero-rate.contract.test.ts` (FR-023/024).
- [ ] T053 [P] [US8] Integration test: zero-rate sale → bill + payment-time §86/4 at vat_amount 0 + §80/1(5) note + captured cert; no-cert blocked; membership stays 7% (SC-008, US8 AS1–4) in `tests/integration/invoicing/zero-rate.integration.test.ts`.
- [ ] T054 [P] [US8] Integration test: async render of a `zero_rated_80_1_5` bill → receipt PDF computes VAT 0% + §80/1(5) note (sources pinned `vat_treatment`, never defaults to 7%) — US8 AS5 / G1 in `tests/integration/invoicing/zero-rate-async.integration.test.ts`.

### Implementation for US8

- [ ] T055 [US8] Migration `0234_invoices_vat_treatment_zero_rate.sql` — `vat_treatment` (NOT NULL DEFAULT `'standard'`) + `zero_rate_cert_no`/`_date`/`_blob_key` + `invoices_vat_treatment_valid` + `invoices_zero_rate_cert_required` CHECKs; mirror into `schema-invoices.ts` (data-model § F.8).
- [ ] T056 [US8] Pin `vat_treatment` (+ cert fields) into the issue-time snapshot + block membership from zero-rate; fail-closed cert gate (zod + use-case + DB CHECK); `<5,000` warn in `issue-invoice.ts` (FR-023/024).
- [ ] T057 [US8] `vat_treatment` drives the VAT rate (single source of truth: 0% vs 7%; F4 `vat_rate` derived, never independent) in the VAT computation (`src/modules/invoicing/domain/**` totals policy) — FR-025/G3.
- [ ] T058 [US8] Render VAT 0% on the ใบแจ้งหนี้ + full §86/4 at VAT 0% + §80/1(5) note + cert no./date reference (scan NOT appended — G6) on the tax receipt in `invoice-template.tsx`; §80/1(5) note not on membership, WHT note not on zero-rate.
- [ ] T059 [US8] Async worker sources pinned `vat_treatment` + `zero_rate_cert_*` for the §80/1(5) render in `render-receipt-pdf.ts` (G1, closes T054).
- [ ] T060 [US8] Capture `vat_treatment` (+ `zero_rate_cert_no`) in the `invoice_issued` + `tax_receipt_issued` audit payloads (no new event); cert blob = tax-doc class 10y, admin-only (G2) in the audit emitter + blob adapter.
- [ ] T061 [P] [US8] Add the `vat_treatment` toggle + MFA-cert fields (no/date/upload) to the admin issue-invoice form in `src/app/(staff)/admin/**`, shown/gated by the flag.
- [ ] T061a [US8] Hide/disable the `vat_treatment` toggle when `invoice_subject='membership'` (error-prevention, H3) + a short explanatory caption ("membership is always VAT 7%; §80/1(5) applies to non-membership sales only"), EN/TH/SV keys; server REJECT `membership_cannot_be_zero_rated` (422) stays as defense-in-depth (SHARED UX #1 — reject, NOT silent-coerce) in `src/app/(staff)/admin/**` issue-invoice form.
- [ ] T061b [US8] Inline client-side missing-cert validation BEFORE submit when `vat_treatment='zero_rated_80_1_5'` and cert no. empty — `aria-invalid` + `aria-describedby` + `role="alert"`, localised EN/TH/SV; 422 `zero_rate_cert_required` + DB CHECK stay as defense-in-depth (SHARED UX #2) in `src/app/(staff)/admin/**` issue-invoice form.
- [ ] T061c [US8] Progressive disclosure of the cert fields (no./date/upload) revealed only when zero-rate is selected, with an `aria-live="polite"` announce of the reveal (MED) in `src/app/(staff)/admin/**` issue-invoice form.
- [ ] T061d [US8] Inline ≥5,000 THB pre-submit advisory warning (non-blocking, `role="status"`/`aria-live`, localised EN/TH/SV) in `src/app/(staff)/admin/**` issue-invoice form (FR-024).
- [ ] T061e [US8] MFA cert upload UX (drag/drop + upload progress + error/retry states) + ClamAV scan reusing the F7.1a inline-image-upload pattern (`src/modules/broadcasts/**` scan adapter) → private Vercel Blob (tax-doc class 10y, admin-only) (MED) in `src/app/(staff)/admin/**` issue-invoice form.
- [ ] T061f [US8] FR-033 issue-failure recovery + dirty-state in the `src/app/(staff)/admin/**` issue form: a failed issue PRESERVES entered `vat_treatment` + cert no/date + the already-ClamAV-scanned `zero_rate_cert_blob_key` and offers retry WITHOUT re-uploading; switching zero_rated→standard→zero_rated RESETS the cert fields; an abandoned/superseded scanned cert blob gets a TTL sweep (F4 error-rows-CSV precedent) via a cron/worker in `src/modules/invoicing/**`; a dirty issue form has a beforeunload/route-change guard.
- [ ] T061g [US8] FR-024 cert upload PRIMARY input = native "Choose file" button (keyboard-focusable, ≥44px; drag/drop = enhancement, per FR-036); on inline-validation block focus moves to the first invalid field; revealed cert fields enter tab order immediately after the toggle with a visible focus ring; inputs carry mobile keyboard hints (cert-no on the issue form; `branch_code` numeric max5 / swift chars / account_no digits on the settings bank block) across `src/app/(staff)/admin/**` issue form + `src/components/invoices/invoice-settings-form.tsx`.
- [ ] T062 [US8] Apply 0234 to `dev` Neon + `pnpm test:integration` (T052–T054 green).

**Checkpoint**: embassy zero-rate correct end-to-end; independently deferrable.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: relabel every surface, resilience, cutover, rollout, and the full gate.

- [ ] T063 [P] Relabel ALL user-facing strings (PDF titles, admin, portal) EN/TH/SV so the pre-payment bill is never ใบกำกับภาษี/Tax Invoice; `pnpm check:i18n` parity (FR-014, SC-005) across `src/i18n/messages/*` + consumers.
- [ ] T063a Interactive-string i18n-parity inventory (SC-009): enumerate ALL new INTERACTIVE strings (vat_treatment toggle + caption, cert labels/help/errors, ≥5,000 warn, "Tax receipt" badge, "payable record — tax receipt issued (see RC)" label, "receipt being generated", admin re-render/permanent-fail alert, settings help + confirmation dialog, bank-block labels) and assert EN/TH/SV presence via `pnpm check:i18n` across `src/i18n/messages/*`; badges are text-badges (not colour-only, WCAG 1.4.1).
- [ ] T063b FR-009 document dates format per locale (BE display-only for th-TH; storage stays Gregorian ISO) + long Thai notes/names wrap and are NEVER clipped on the PDF or the 320px list, via the shared date helper + `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx` + the portal document list.
- [ ] T063c SC-009 pin the SV strategy = keep-Thai-plus-gloss (Thai tax term + parenthetical Swedish gloss) applied consistently across all new interactive strings (pinned, not deferred); seed the glossary in `src/i18n/messages/sv.json` and assert EN/TH/SV parity via `pnpm check:i18n` (co-closes SC-009 with T063a).
- [ ] T064 [P] Relabel transactional **email** templates (subjects + bodies) — bill email never says Tax Invoice; the tax document travels on the receipt email (FR-020, SC-005) in the email templates dir.
- [ ] T065 Two-document disambiguation (FR-016): RC "Tax receipt" badge + listed first; SC marked "payable record — tax receipt issued (see RC)" in the admin + `src/app/(member)/portal/**` document lists; keep both downloadable after payment (FR-015).
- [ ] T065a FR-016 conditional bill label: an UNPAID bill shows ใบแจ้งหนี้/Invoice, a PAID bill shows a localised text-badge "payable record — tax receipt issued (see RC)" (not colour-only, WCAG 1.4.1) + a clickable "see RC" link navigating to the RC tax receipt (H1/H2/LOW); EN/TH/SV keys in the admin + `src/app/(member)/portal/**` document lists.
- [ ] T065b [P] FR-031 admin invoice-list filters (document type SC/RC/RE/CN · payment-tax-point state · `vat_treatment`) + a period view surfacing the §86/4 RC §87 register and the §80/1(5) zero-rate sales list (ภพ.30 support) in `src/app/(staff)/admin/**` invoice list + the application query; saved-segments/bulk-export = follow-on.
- [ ] T065c FR-016 render the StatusBadge on the invoice detail-page header (not only list rows), reusing the shipped StatusBadge/Badge variant (no new badge component); every document control carries an accessible name (kind+number) and the "see RC" cross-reference names its target ("see tax receipt RC-…") in the admin detail + `src/app/(member)/portal/**` + `src/components/invoices/**`.
- [ ] T066 Async resilience (FR-019): portal "receipt being generated" state + permanent-render-failure admin alert + re-render reusing the SAME allocated RC (never re-allocates) via the existing F4 resend surface + reconcile cron.
- [ ] T066a FR-019 member-facing async state: portal `aria-live` announce of "your tax receipt is being generated", auto-refresh/poll to reveal the PDF on render-ready, reassurance copy, and a graceful permanent-render-failure member state (support path) — H4 — with EN/TH/SV keys in `src/app/(member)/portal/**`.
- [ ] T066b FR-019 name the admin permanent-fail surface concretely — an inline alert-state row on the admin invoices/documents list + the existing admin notification surface; admin rows show a shimmer "receipt generating" state while pending; indicators respect `prefers-reduced-motion` (pulse fallback) in `src/app/(staff)/admin/**` invoice list + notification surface.
- [ ] T067 In-flight legacy-bill guard (FR-017): pay path rejects a legacy §87-numbered invoice with no bill number → `legacy_invoice_needs_reissue` (409) → void + re-issue in `record-payment.ts` (data-model § F.4).
- [ ] T068 Void handling: `void-invoice.ts` falls back to `bill_document_number_raw` + ใบแจ้งหนี้ title for an unpaid bill; a voided PAID membership stamps VOID on BOTH blobs (bill + receipt) — edge cases § (data-model § F.3).
- [ ] T069 Renewal parity (FR-018): renewal (F8) membership invoice issues as ใบแจ้งหนี้ (no §87), RC at renewal payment (online+offline), renewal email/success screens reference correct docs; integration test in `tests/integration/invoicing/renewal-parity.integration.test.ts`.
- [ ] T070 Cutover data-audit (§ E / § F.1): populate `members.legal_entity_type` for the 131 members + seed TSCC seller identity (Tax ID `0994000187203`, HQ address) + WHT note (แบบ A) + bank block into `tenant_invoice_settings`; wire into `scripts/verify-088-cutover.ts` (T003).
- [ ] T070a FR-022 auto-fill "Issued by" from the acting admin's display name and PIN it into the issue-time snapshot (`src/modules/invoicing/application/use-cases/issue-invoice.ts` + the identity snapshot VO), keeping "Received by"/"Date" blank for the wet signature in `invoice-template.tsx`.
- [ ] T071 [P] Reaffirm tenant isolation: extend the cross-tenant integration test to read/write the new invoice columns (`bill_document_number_raw`, `vat_treatment`, cert fields) — Constitution I (CHK033).
- [ ] T071a [P] FR-030 count + label an issued ใบแจ้งหนี้ via `status` + `bill_document_number_raw` (NEVER `document_number`, NULL until payment) across the F9 AR/outstanding dashboard (`src/modules/insights/**`), the F8 at-risk `invoicesOverdueCount` (`src/modules/renewals/**`), and the member-detail invoice surface (`src/app/(staff)/admin/members/**`); post-cutover verified (folds the NULL-`document_number` sweep into T071).
- [ ] T071b [P] SC-012 regression test: after payment the member timeline shows a `tax_receipt_issued` entry carrying the RC number AND the F9 AR / F8 at-risk / member-detail surfaces count issued-unpaid ใบแจ้งหนี้ correctly (via `status` + bill number) in `tests/integration/invoicing/timeline-ar-regression.integration.test.ts`.
- [ ] T072 Rollout/rollback runbook + flag flip: finalize `FEATURE_088_TAX_AT_PAYMENT` land-order + rollback in plan § Rollout; confirm US8 UI + zero-rate render gate off cleanly (dark-launch).
- [ ] T072a [P] `@a11y`/responsive axe-core WCAG 2.1 AA e2e coverage (SC-010 + SC-011) for the new surfaces (issue-invoice form incl. progressive cert reveal + ≥5,000 warn, portal two-document disambiguation, async pending + permanent-fail state, settings form incl. confirmation dialog): assert keyboard/focus + aria-live regions + zero axe violations, AND additionally assert WCAG 1.4.10 Reflow / 1.4.4 Resize 200% / 2.5.5 Target Size (axe alone does not cover these), AND SC-011 at 320/375px `document.scrollWidth ≤ innerWidth` (no horizontal scroll) with every new control ≥44px, via `pnpm test:e2e --grep "@a11y"` in `tests/e2e/invoicing/**`.
- [ ] T072b [P] FR-036 mobile-first responsive: the 4 new surfaces (admin issue form, settings form, portal 2-doc list, portal pending state) render at 320px with no horizontal scroll and every new control is ≥44×44px (≥24 min); the portal per-row PDF view/download control is ≥44px + `aria-label` (kind+number) + a `download` filename encoding the kind, and Original+Copy is one file that opens on iOS Safari + Android Chrome; the cert upload PRIMARY input is a native "Choose file" button (keyboard-focusable, ≥44px; drag/drop = enhancement); the settings form groups fields with `<fieldset><legend>` + a reachable/sticky Save at 320px, across `src/app/(staff)/admin/**` + `src/app/(member)/portal/**` + `src/components/invoices/**`.
- [ ] T073 Run `scripts/verify-088-cutover.ts` on `dev`, then the full local gate: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration` + `pnpm test:e2e` for the affected surfaces; walk `checklists/tax-compliance.md` (CHK001–040).
- [ ] T074 [P] Run `quickstart.md` validation end-to-end (issue → pay → receipt → credit → zero-rate) on `dev`.

---

## Dependencies & Execution Order

- **Setup (P1)** → **Foundational (P2, blocking)** → **US phases** → **Polish**.
- **Foundational (T005–T011)** blocks every user story (schema, streams, audit, snapshot).
- **US1 (P1)** is the MVP backbone; **US2** ships with it. **US3/US4/US5/US6 (P2)** each depend only on Foundational + US1's template/snapshot, and are otherwise independent (different template arms / migrations 0232/0233).
- **US7 (P3)** depends on US1 (bill→RC flow) + US4 (presentation). **US8 (P3)** depends on Foundational + US1 (issue/pay/async) — trailing + severable (G4): P1 core ships without it.
- Within a story: **tests (fail) → migration/schema → domain → application → template/presentation → apply-to-Neon + integration**.

### Parallel Opportunities

- Setup T002/T003/T004 in parallel.
- Foundational T007/T008 in parallel (after T005/T006).
- Per story, all `[P]` test tasks author in parallel before implementation.
- After Foundational, US3/US4/US5/US6 can be staffed in parallel (distinct migrations + template arms); US8 last.

---

## Implementation Strategy

- **MVP** = Phase 1 + 2 + **US1** (+US2) → STOP, validate SC-001/002/003/004 on `dev`, demo the bill→§86/4-at-payment core.
- **Incremental**: add US3 → US4 → US5 → US6 (each independently testable + shippable), then US7, then **US8 as the trailing severable phase**, then Polish.
- **Flag discipline**: everything ships behind `FEATURE_088_TAX_AT_PAYMENT` (off in prod) until cutover (T070–T072); US8 UI gates off independently for dark-launch.

## Notes

- Tests REQUIRED (Constitution II): 100% branch on security-critical use cases (record-payment, issue-invoice, credit-note, void); Domain 100% line; integration on live Neon `dev`.
- **T015a** is the explicit SC-002 §87-no-gaps regression for the `RC` §86/4 tax-receipt register (interleaved membership + event-with-TIN payments in one fiscal year → contiguous `RC`); the `RE` §105 event-without-TIN series (its own `receipt_105`/`RE` register) is sequential-but-NOT-§87-strict and is deliberately kept out of the `RC` no-gaps guarantee.
- `[P]` = different files, no incomplete-task dependency. `[Story]` traces to spec US.
- Apply each migration + `pnpm test:integration` BEFORE committing schema-referencing code; thread `tx` from `runInTenant`; run `pnpm typecheck` + full `pnpm lint` as the final gate; zero `test.fixme`/bare `test.skip` on release.
- The UX-implementation tasks at letter-suffix ids (T043a/b, T061a–e, T063a, T065a, T066a, T072a) trace to the **2026-07-01 UX review**; SC-009 (interactive-string EN/TH/SV parity) closes on T063a, SC-010 (`@a11y` axe-core WCAG 2.1 AA on the new surfaces) on T072a. Shared UX decisions: membership zero-rate = UI-prevent + server REJECT (not coerce); missing-cert = inline client validation + 422/CHECK defense-in-depth; bank block = STRUCTURED fields; all new interactive strings text-badged (WCAG 1.4.1) with EN/TH/SV keys.
- The UX round-2 letter-suffix tasks (T017a, T018a, T019a, T021a–d, T035a, T061f/g, T063b/c, T065b/c, T066b, T070a, T071a/b, T072b) + the extended T072a trace to the **2026-07-01 UX round-2 review** (FR-027…036, SC-011/012); SC-011 (320/375px no-h-scroll + every new control ≥44px) closes on T072a/T072b and SC-012 (member-timeline `tax_receipt_issued` + F9 AR / F8 at-risk / member-detail correctness via `status` + bill number) on T071a/T071b.
