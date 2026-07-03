# Implementation Plan: Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)

**Branch**: `088-invoice-tax-flow-redesign` | **Date**: 2026-07-01 | **Spec**: `specs/088-invoice-tax-flow-redesign/spec.md`
**Input**: Feature specification + design doc `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md` + RD tax research (`docs/superpowers/specs/2026-06-30-f4-accountant-questions.md`).

## Summary

Correct the F4 membership/event document tax flow so a member never receives two §86/4 tax invoices for one sale. The pre-payment document becomes a **non-tax ใบแจ้งหนี้ / Invoice**; the **§86/4 + §105ทวิ ใบกำกับภาษี/ใบเสร็จรับเงิน** is issued only at payment (§78/1 service tax point), dated at the payment date, rendered as **Original + Copy** (two pages, one PDF).

Technical approach (from the 8-surface design map): **relabel the existing `invoice` PdfDocKind in place** (no new kind, no `pdf_doc_kind` enum migration); add a **non-§87 `bill` numbering stream + `bill_document_number_raw` column**; **move the §87 tax-number allocation from issue-time to payment-time** (`record-payment`, `issue-event-invoice-as-paid`, and the async `render-receipt-pdf` worker); **re-target §86/10 credit notes** to the tax receipt (blocked on unpaid bills); add **§86/4 Head-Office/Branch** to the member + tenant identity snapshots; add a **tenant-configurable footer / withholding-tax note** (membership-only, editable); and apply presentation polish (thousands-comma, capitalized English amount-in-words, buyer-block reorder, membership line name + period). Scope ≈ 30 files, ≥ 4 migrations (incl. `0234` US8 zero-rate + MFA-cert columns), ≈ 25 test files. **prod is test-data only** (wiped 2026-06-24) → clean numbering cutover, no byte-stable re-render constraint.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); Node 22 LTS
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · `@react-pdf/renderer` (deterministic PDF) · `@js-joda/core`+`timezone` (Asia/Bangkok fiscal year) · `thai-baht-text` · `stripe` (payment path — passthrough only) · next-intl. **Zero new npm dependencies** (Constitution X).
**Storage**: Neon Postgres `ap-southeast-1` (Drizzle) + Vercel Blob (PDF artifacts + **MFA §80/1(5) certificate scans — reuse the F4 invoice-PDF blob adapter**). New DDL: `document_type` enum `+= 'bill' + 'receipt_105'` (the separate `RE` §105 event-without-TIN register — DECIDED, pinned § D register purity; both values added in migration `0230`); `invoices.bill_document_number_raw` + partial unique index; **`invoices.vat_treatment` enum (default `'standard'` 7% / `'zero_rated_80_1_5'` 0%, pinned in the immutable issue-time snapshot) + `zero_rate_cert_no` + `zero_rate_cert_date` + `zero_rate_cert_blob_key` (migration `0234`, additive; zero-rated w/o `zero_rate_cert_no` = BLOCKED, fail-closed — FR-024)**; `members.is_head_office` + `branch_code`; `tenant_invoice_settings.wht_note_th/_en` + `seller_is_head_office` + `seller_branch_code` + **bank-block fields (FR-022: payee, account no.+type, bank, branch, address, SWIFT, payment-instructions — all NULLable, tenant-configurable)**; amended CHECK constraints on `invoices`.
**Testing**: Vitest (unit + contract), Vitest integration on live Neon `dev` branch, Playwright + `@axe-core/playwright` (e2e / a11y). PDF "goldens" are text-extraction assertions (no stored binaries).
**Target Platform**: Vercel `sin1` (Singapore); web (admin + member portal + API + cron).
**Project Type**: Web — Next.js app + API routes + `src/modules/*` bounded contexts.
**Performance Goals**: inherit F4 SLOs (issue p95 < 1.5s; receipt render). New per-`(tenant, fiscal_year)` advisory lock on the `receipt` stream is taken at every membership payment (payments are low-frequency → acceptable).
**Constraints**: §87 no-gaps on the tax-receipt stream (overflow-must-throw discipline moves to the payment path); deterministic PDF render; two-layer tenant isolation (Postgres RLS + `runInTenant` app layer); immutable issue-time snapshots (FR-038/FR-011). NO byte-stable-history constraint (prod test-data-only).
**Scale/Scope**: 1 live tenant (TSCC, ≈131 members) today; MTA+STD multi-tenant-aware. Single full payment per bill for MVP (F5 has no partial-payment model — verified: `initiatePayment` has no amount param; no `partially_paid` status).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design. Source: `.specify/memory/constitution.md` v1.4.2.*

**NON-NEGOTIABLE gates:**

- [x] **I. Data Privacy & Security** — New PII = `members.branch_code` (a §86/4 party particular). Lawful basis = Thai RD tax-invoice legal obligation (PDPA §24 legal-obligation basis; GDPR Art. 6(1)(c)); admin-only edit (RBAC), not member-self-editable. No new external exposure; stored in Neon (TLS + at-rest encryption). **Two-layer tenant isolation preserved** on `members` / `invoices` / `tenant_invoice_settings` (RLS + FORCE + `runInTenant` tx); a cross-tenant integration test is required (Principle I clause 3). PASS.
- [x] **II. Test-First Development** — Contract + acceptance tests authored before implementation; **100% branch on security-critical use-cases**: §87 allocation at payment (`record-payment`, `issue-event-invoice-as-paid`), the credit-note creditability gate, and the payment→receipt path. PDF goldens regenerated on live Neon (apply migration → `test:integration` before commit). PASS.
- [x] **III. Clean Architecture** — Changes map cleanly: Domain (receipt-kind discriminator in `document-kind.ts`, `DocumentNumber` VO, identity snapshots), Application (issue / record-payment / issue-event-invoice-as-paid / render-receipt-pdf / issue-credit-note / update-tenant-invoice-settings use-cases), Infrastructure (schemas, `invoice-template.tsx`, repos), Presentation (admin / portal / settings form). Module barrels + `no-restricted-imports` respected; payments↔invoicing stays behind the existing bridge port. PASS.
- [x] **IV. Payment Security (PCI DSS)** — The F5 payment path is **passthrough** (`confirm-payment → invoicing-bridge → markPaidFromProcessor → recordPayment`); no PAN/CVV stored or logged, Stripe tokenization unchanged, **SAQ-A scope unchanged**. The only change is that `recordPayment` now mints the §87 tax number — no cardholder data touched. New audit events on receipt issuance at payment are listed in `research.md`. PASS.

**Core principle gates:**

- [x] **V. Internationalization (EN/TH/SV)** — All new strings (ใบแจ้งหนี้/Invoice, สำนักงานใหญ่/สาขา, WHT note, footer) added to EN + TH + SV; the `invoice`→ใบแจ้งหนี้ relabel edits existing i18n **values in place** (keep key names → no `MISSING_MESSAGE`). Thai tax documents mandatory-TH satisfied. PASS.
- [x] **VI. Inclusive UX (Mobile-first + WCAG 2.1 AA)** — Admin/portal changes (both-document download affordances, settings-form WHT/branch fields) start at 320px + WCAG 2.1 AA; shared component library reused. The PDF is a print artifact (no DOM a11y tree). PASS.
- [x] **VII. Performance & Observability** — Inherit F4 SLO budgets; the new `receipt`-stream advisory lock is per-`(tenant, fy)` on low-frequency payments. Metrics + audit on numbering and receipt issuance; the numbering cutover is logged. PASS.
- [x] **VIII. Reliability** — The §87 no-gaps / overflow-must-throw discipline **moves with the allocation** into the payment path (in-tx throw → rollback, no gap). Idempotency preserved on payment→receipt; allocate+render+persist in one tx; audit events for bill-issued / receipt-issued / credit-note; crediting blocked while the receipt PDF is pending/failed. A documented **rollback + cutover runbook** + feature flag + `verify-088-cutover.ts` + the FR-017 in-flight guard (see § Rollout, Cutover & Rollback) satisfy Gate X's rollback requirement for this irreversible tax-numbering change. PASS.
- [x] **IX. Code Quality Standards** — TS strict, ESLint clean, Conventional Commits, `[Spec Kit]` gate prefixes. This is an **auth-adjacent / payment / PII / tax** surface → **≥2 reviewers**, one signing the security checklist; a Thai-tax reviewer at the Review gate. PASS.
- [x] **X. Simplicity (YAGNI)** — `invoice` is **relabelled in place** (no new PdfDocKind) to avoid forcing every switch/gate/column/redaction-arm to disambiguate tax-vs-non-tax. The single added complexity (new `bill` documentType + `bill_document_number_raw`) is justified below. PASS.

**Result: PASS** (no NON-NEGOTIABLE failures; justified complexity recorded).

## Project Structure

### Documentation (this feature)

```text
specs/088-invoice-tax-flow-redesign/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions distilled from the design map + tax research
├── data-model.md        # Phase 1 — entities, new columns, CHECK/index changes, numbering streams
├── quickstart.md        # Phase 1 — dev setup, migration + cutover, how to test
├── contracts/           # Phase 1 — changed use-case + route contracts
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/modules/invoicing/
├── domain/                 # document-kind.ts (NEW inferReceiptKind resolver — membership→receipt_combined, NOT reuse inferEventDocumentKind), document-number.ts, {member,tenant}-identity-snapshot.ts (branch fields + buyer_is_vat_registrant juristic discriminator, fail-closed)
├── application/use-cases/  # issue-invoice.ts (→ 'bill' stream + bill-stream-only runtime assertion), record-payment.ts + issue-event-invoice-as-paid.ts + render-receipt-pdf.ts (§87 RC at payment, payment-date + payment-FY, NULL-document_number-safe, Original+Copy), issue-credit-note.ts (target receipt), void-invoice.ts (bill-number fallback + ใบแจ้งหนี้ void title), update-tenant-invoice-settings.ts
└── infrastructure/         # db/schema-invoices.ts (bill column + CHECK), db/schema-tenant-document-sequences.ts ('bill' enum), db/schema-tenant-invoice-settings.ts (WHT/branch), pdf/templates/invoice-template.tsx (relabel, Original+Copy, footer, presentation), pdf/amount-to-english.ts (capitalize), repos/*
src/modules/members/infrastructure/db/schema-members.ts   # is_head_office + branch_code (+ admin edit form/route)
src/modules/payments/**                                    # passthrough — verify no change; confirm F8/F6 finalisers run POST-commit (outside the receipt-lock tx)
src/modules/renewals/**                                    # F8 renewal parity — renewal invoices = non-tax bills → RC receipt at renewal payment; renewal email/success copy
scripts/verify-088-cutover.ts                              # NEW cutover assertion (enum has 'bill'; settings separate/RC; WHT seeded; issue allocates only 'bill')
src/app/(staff)/admin/invoices/**                          # download affordances (both docs), labels, issue-dialog copy, settings form; issue-invoice form gains a VAT-treatment toggle (standard 7% / zero-rated §80/1(5) 0%) + MFA-cert fields (cert no/date/upload) shown fail-closed when zero-rated (US8, FR-023/FR-024)
src/app/(member)/portal/invoices/**                        # download both docs, labels
src/components/invoices/invoice-settings-form.tsx          # WHT-note (TH/EN) + seller branch + bank-block (FR-022) fields; fieldset grouping + sticky Save @320px (FR-036)
src/i18n/messages/{en,th,sv}.json                          # relabel-in-place + new keys (incl. interactive strings, timeline, palette — SC-009 keep-Thai-plus-gloss)
# --- UX round-2 surfaces (FR-027..036 / SC-011,012) ---
# admin/invoices/**: pre-issue review dialog (FR-027) · §87-mint money-modal no-optimistic/undo (FR-028) · per-row Record-payment + undo-on-issue toast (FR-035) · list filters + RC-register/§80/1(5) period view (FR-031) · uniform toasts/inline-alerts (FR-032)
src/components/command-palette/invoices-group.tsx          # "Record payment"/"Re-render receipt" entries (FR-035)
src/modules/members/application/timeline/resolve-invoice-event-copy.ts  # render tax_receipt_issued + relabel invoiceIssued→ใบแจ้งหนี้ (FR-029)
src/modules/insights/** (F9) + src/modules/renewals/** (F8) # read-path fix: count issued ใบแจ้งหนี้ via status+bill_document_number_raw, NEVER document_number (FR-030 — existing consumers)
drizzle/migrations/                                        # ≥4 migrations (enum + bill column/index + CHECKs; members branch; settings WHT/branch; invoices vat_treatment + MFA-cert columns → 0234)
tests/{unit,contract,integration,e2e}/invoicing/**         # ≈25 files (numbering, goldens, credit-note, settings, payment→receipt)
```

**Structure Decision**: extends the existing **F4 `src/modules/invoicing/`** bounded context (Clean Architecture layers preserved) plus a two-column addition to **F3 `members`** and the presentation surfaces; the **F5 `payments`** module is passthrough (no behavioural change). The **UX round-2** requirements additionally touch **read-paths** in **F9 `insights`** (AR/outstanding), **F8 `renewals`** (at-risk `invoicesOverdueCount`), the **F3 `members` timeline** resolver, and the **command-palette** — all as existing consumers (FR-029 / FR-030 / FR-031 / FR-035), plus mobile-first responsive + i18n/a11y across the new surfaces (FR-036 / SC-009..012). No new module, bounded-context boundary, or npm dependency.

## Complexity Tracking

| Complexity | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New `bill` `document_type` + `bill_document_number_raw` column, **plus** a separate `receipt_105` `document_type` (`RE` prefix) for the §105 event-without-TIN register — both added in migration `0230` (DECIDED, pinned § D — register purity) | The non-tax ใบแจ้งหนี้ needs its own sequential number, isolated from the §87 tax register; and the §105 event-without-TIN receipt gets its own `RE` register (sequential but NOT under strict §87 no-gaps) so the §86/4/§87 `RC` register stays **pure** for a clean RD audit | Reusing `invoices.sequence_number`/`document_number` is unsafe — `sequence_number` feeds the §87 uniqueness index (no stream discriminator), so a non-§87 bill number there could false-collide or falsely satisfy §87 invariants. Folding §105 `RE` into a shared `RC` receipt stream is rejected — it would mix §105 non-tax receipts into the §86/4/§87 register and muddy the RD audit trail (register purity, § D) |
| §87 allocation moved issue-time → payment-time (touches `record-payment` + `issue-event-invoice-as-paid` + `render-receipt-pdf`) | The §86/4 tax number must be minted at the tax point (§78/1 = payment) | Keeping §87 at issue is the root cause of the duplicate-§86/4 this feature removes; a cosmetic-only rename would leave the flow illegal |
| **US8 embassy §80/1(5) zero-rate folded into core 088** (per-invoice `vat_treatment` + MFA-cert capture (no/date/optional blob) + zero-rate §86/4 render at VAT 0% + §80/1(5) note; migration `0234`) | Customer request (2026-07-01): TSCC sells to embassies / int'l-orgs (e.g. Embassy of Sweden expo-booth) which are **zero-rated (0%) under §80/1(5)** per RD certs VAT 326-24/327-24/351-24 — case-by-case, MFA-cert-evidenced. Still a **full §86/4 tax invoice at VAT 0%** (creditable/reportable, NOT §81 exemption) | Shipping US8 as a separate later feature was rejected — the zero-rate treatment must be pinned into the same immutable issue-time snapshot as membership 7% and rendered by the same §86/4 tax-receipt path; splitting it would fork the snapshot + PDF template twice and delay a launch-blocking real sale |

## Rollout, Cutover & Rollback

*Added per critique 2026-07-01 (P8, P9, E7, E13, E14, X1, X2).*

**Land order (one atomic PR):** migration `0230` (`document_type += 'bill'`) → `0231-0233` (bill column + CHECKs; members branch; settings WHT/branch) → `0234` (invoices `vat_treatment` + MFA-cert columns — US8, additive) → code (issue→`bill`, pay→`RC`, async worker, `void-invoice`, zero-rate treatment + cert capture) → settings flip (`receiptNumberingMode='separate'`, `receiptNumberPrefix='RC'`, WHT note, seller branch). The issue-side and pay-side numbering edits **MUST ship together** — a partial rollout mints two §87 numbers per sale (E7).

**Feature flag:** gate the §87-at-payment switch behind `FEATURE_088_TAX_AT_PAYMENT` so it can be reverted **before the first real payment**; the settings flip is the operator trigger. The **same flag also gates the US8 surface** — the issue-invoice `vat_treatment` toggle UI (standard 7% / zero-rated §80/1(5) 0%) + MFA-cert fields and the zero-rate §80/1(5) render arm — so US8 can **dark-launch independently of the core** (flag off → the toggle is hidden and every invoice is `'standard'` 7%; G5).

**US8 phasing (trailing + severable):** although US8 (embassy §80/1(5) zero-rate) folds into the same immutable snapshot + §86/4 render path as the P1 membership core, it is a **P3 add-on with no P1 dependency**. `/speckit.tasks` **MUST give US8 its own final phase with a clean cut-line** — all `vat_treatment` / MFA-cert / zero-rate-render / 0%-compute tasks sequenced last — so the **P1 membership core can ship on schedule even if US8 slips** (G4). This severability is reinforced at runtime by the shared `FEATURE_088_TAX_AT_PAYMENT` dark-launch gate (see Feature flag above): the core can go live with US8 flag-dark.

**Cutover verification (`scripts/verify-088-cutover.ts`, pre- and post-flip):** asserts the enum has `bill`; SweCham settings = `separate`/`RC`; the WHT note is seeded; and `issue-invoice` allocates **only** the `bill` stream (a runtime assertion throws if asked for a tax stream post-cutover, E7). Plus a **verified operator gate**: zero issued-unpaid invoices at cutover (a count query in the runbook), else FR-017 blocks paying a legacy §87-numbered bill (P8).

**In-flight guard (FR-017):** the pay path rejects a legacy issued invoice lacking `bill_document_number_raw` (mirrors the existing `legacy_no_tin_event_needs_remediation` pattern) → force void + re-issue.

**Rollback (Constitution Gate X):** `ALTER TYPE … ADD VALUE 'bill'` and consumed §87 numbers are irreversible → rollback = **revert the flag + redeploy prior code + revert the settings flip** (NOT a DB down-migration, E14); `bill`-numbered rows become read-broken on old code (acceptable — prod is test-data-only). A defective *issued* tax receipt post-launch is remediated via §86/10 credit-note or void+re-issue, never by mutating the §87 register. Wire `READ_ONLY_MODE` into the cutover to freeze writes in ~30s.

**Production success signals (P10):** alert on `count(paid membership rows with >1 §87 number) == 0` (proves SC-001); a bill-vs-receipt issuance dashboard; and an alert on `pdf_render_permanently_failed` for paid receipts (FR-019).

**F8/F6 ordering (E15):** confirm F8 `applyPendingTierUpgrade` + F6 as-paid finalisers run **post-commit**, outside the receipt advisory-lock tx, so the enlarged payment tx does not widen lock/rollback scope.

**Combined-numbering retired (Decision A, 2026-07-01):** `receipt_numbering_mode` is always `'separate'` in the new flow — the bill has no §87 number to reuse. **Delete the `combinedMode` reuse branch** in `record-payment.ts` (it would reuse a non-§87 bill number as the tax number — a §87 violation). Keep the column (no migration churn); optionally tighten the CHECK to `'separate'`-only later. The **combined DOCUMENT** format (ใบกำกับภาษี/ใบเสร็จรับเงิน merged) is unrelated and unchanged. See data-model § F.5.

**Operator cutover checklist (T072 — execute in order at go-live):**
1. **Pre-flight (flag OFF):** run `pnpm tsx scripts/verify-088-cutover.ts` against prod (`DATABASE_URL_UNPOOLED`) — every HARD check must pass: `bill`/`receipt_105` enums, `tax_receipt_issued` audit type, `bill_document_number_raw` column, settings `separate`/`RC`, **seller Tax ID is a real 13-digit RD TIN** (T070, rejects placeholders), WHT note seeded, **zero issued-unpaid legacy §87 invoices** (FR-017 gate). Fix any ✗ before proceeding.
2. **Data-audit (operator, prod):** populate `members.legal_entity_type` for the imported members (juristic → their entity type; natural persons → `individual`/NULL — the §86/4 branch line **fails closed** on NULL). Seed `tenant_invoice_settings`: real seller Tax ID (`0994000187203`), HQ address, `seller_is_head_office=true`/`seller_branch_code=NULL`, `wht_note_th`/`_en` (แบบ A — **accountant-validated text, standing OPEN**), and the FR-022 bank block (KBank, Emquartier). Re-run the verify script — all green.
3. **Freeze + flip:** `READ_ONLY_MODE=true` (writes return 503 in ~30s) → flip settings (`receipt_numbering_mode='separate'`, `receipt_number_prefix='RC'`) via the US5 settings form or a one-off UPDATE → `FEATURE_088_TAX_AT_PAYMENT=true` in Vercel env → redeploy → clear `READ_ONLY_MODE`.
4. **Post-flip verify:** re-run the verify script (post-flip) + smoke-test one membership bill→pay→RC on prod; confirm the production success signals above read clean.

**Rollback checklist (before the first real payment — irreversible once a §87 number is consumed):** `READ_ONLY_MODE=true` → revert `FEATURE_088_TAX_AT_PAYMENT=false` in Vercel env → redeploy the prior code → revert the settings flip → clear `READ_ONLY_MODE`. A defective *issued* §86/4 post-launch is NOT rolled back — remediate via §86/10 credit-note or void+re-issue (never mutate the §87 register).

**US8 dark-launch confirmation (G5, verified):** with `FEATURE_088_TAX_AT_PAYMENT=false` the issue-invoice `vat_treatment` toggle + MFA-cert fields are hidden (`showVatTreatmentControl = taxAtPayment && !isMembership`) and every invoice is `'standard'` 7% (server coerces + the DB CHECK `invoices_membership_is_standard` enforces); the §80/1(5) note render arm (`templateVersion >= 8`) is only reached for a `zero_rated_80_1_5` row, which cannot be created flag-off → US8 gates off cleanly.
