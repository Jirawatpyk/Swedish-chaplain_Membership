# Implementation Plan: Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)

**Branch**: `088-invoice-tax-flow-redesign` | **Date**: 2026-07-01 | **Spec**: `specs/088-invoice-tax-flow-redesign/spec.md`
**Input**: Feature specification + design doc `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md` + RD tax research (`docs/superpowers/specs/2026-06-30-f4-accountant-questions.md`).

## Summary

Correct the F4 membership/event document tax flow so a member never receives two §86/4 tax invoices for one sale. The pre-payment document becomes a **non-tax ใบแจ้งหนี้ / Invoice**; the **§86/4 + §105ทวิ ใบกำกับภาษี/ใบเสร็จรับเงิน** is issued only at payment (§78/1 service tax point), dated at the payment date, rendered as **Original + Copy** (two pages, one PDF).

Technical approach (from the 8-surface design map): **relabel the existing `invoice` PdfDocKind in place** (no new kind, no `pdf_doc_kind` enum migration); add a **non-§87 `bill` numbering stream + `bill_document_number_raw` column**; **move the §87 tax-number allocation from issue-time to payment-time** (`record-payment`, `issue-event-invoice-as-paid`, and the async `render-receipt-pdf` worker); **re-target §86/10 credit notes** to the tax receipt (blocked on unpaid bills); add **§86/4 Head-Office/Branch** to the member + tenant identity snapshots; add a **tenant-configurable footer / withholding-tax note** (membership-only, editable); and apply presentation polish (thousands-comma, capitalized English amount-in-words, buyer-block reorder, membership line name + period). Scope ≈ 30 files, ≥ 3 migrations, ≈ 25 test files. **prod is test-data only** (wiped 2026-06-24) → clean numbering cutover, no byte-stable re-render constraint.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); Node 22 LTS
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · `@react-pdf/renderer` (deterministic PDF) · `@js-joda/core`+`timezone` (Asia/Bangkok fiscal year) · `thai-baht-text` · `stripe` (payment path — passthrough only) · next-intl. **Zero new npm dependencies** (Constitution X).
**Storage**: Neon Postgres `ap-southeast-1` (Drizzle) + Vercel Blob (PDF artifacts). New DDL: `document_type` enum `+= 'bill'`; `invoices.bill_document_number_raw` + partial unique index; `members.is_head_office` + `branch_code`; `tenant_invoice_settings.wht_note_th/_en` + `seller_is_head_office` + `seller_branch_code`; amended CHECK constraints on `invoices`.
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
- [x] **VIII. Reliability** — The §87 no-gaps / overflow-must-throw discipline **moves with the allocation** into the payment path (in-tx throw → rollback, no gap). Idempotency preserved on payment→receipt; allocate+render+persist in one tx; audit events for bill-issued / receipt-issued / credit-note; crediting blocked while the receipt PDF is pending/failed. PASS.
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
├── domain/                 # document-kind.ts (payment-time receipt-kind helper), document-number.ts, {member,tenant}-identity-snapshot.ts (branch fields)
├── application/use-cases/  # issue-invoice.ts (→ 'bill' stream), record-payment.ts + issue-event-invoice-as-paid.ts + render-receipt-pdf.ts (§87 RC at payment, payment-date, Original+Copy), issue-credit-note.ts (target receipt), update-tenant-invoice-settings.ts
└── infrastructure/         # db/schema-invoices.ts (bill column + CHECK), db/schema-tenant-document-sequences.ts ('bill' enum), db/schema-tenant-invoice-settings.ts (WHT/branch), pdf/templates/invoice-template.tsx (relabel, Original+Copy, footer, presentation), pdf/amount-to-english.ts (capitalize), repos/*
src/modules/members/infrastructure/db/schema-members.ts   # is_head_office + branch_code (+ admin edit form/route)
src/modules/payments/**                                    # passthrough — verify no behavioural change
src/app/(staff)/admin/invoices/**                          # download affordances (both docs), labels, issue-dialog copy, settings form
src/app/(member)/portal/invoices/**                        # download both docs, labels
src/components/invoices/invoice-settings-form.tsx          # WHT-note (TH/EN) + seller branch fields
src/i18n/messages/{en,th,sv}.json                          # relabel-in-place + new keys
drizzle/migrations/                                        # ≥3 migrations (enum + bill column/index + CHECKs; members branch; settings WHT/branch)
tests/{unit,contract,integration,e2e}/invoicing/**         # ≈25 files (numbering, goldens, credit-note, settings, payment→receipt)
```

**Structure Decision**: extends the existing **F4 `src/modules/invoicing/`** bounded context (Clean Architecture layers preserved) plus a two-column addition to **F3 `members`** and the presentation surfaces; the **F5 `payments`** module is passthrough (no behavioural change). No new module or npm dependency.

## Complexity Tracking

| Complexity | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| New `bill` `document_type` + `bill_document_number_raw` column | The non-tax ใบแจ้งหนี้ needs its own sequential number, isolated from the §87 tax register | Reusing `invoices.sequence_number`/`document_number` is unsafe — `sequence_number` feeds the §87 uniqueness index (no stream discriminator), so a non-§87 bill number there could false-collide or falsely satisfy §87 invariants |
| §87 allocation moved issue-time → payment-time (touches `record-payment` + `issue-event-invoice-as-paid` + `render-receipt-pdf`) | The §86/4 tax number must be minted at the tax point (§78/1 = payment) | Keeping §87 at issue is the root cause of the duplicate-§86/4 this feature removes; a cosmetic-only rename would leave the flow illegal |
