# Requirements-Quality Checklist: Thai Tax Compliance — 088 Invoice/Receipt Tax-Flow Redesign

**Purpose**: "Unit tests for the requirements" — validate that the 088 spec/plan/data-model express the Thai tax rules **completely, clearly, consistently, and measurably** BEFORE `/speckit.tasks`. These items test the *requirements writing*, not the implementation.
**Created**: 2026-07-01 · **Focus**: Thai tax compliance (§78/1, §86/4, §87, §105ทวิ, §86/10, §80/1(5), VAT, WHT) + data integrity + rollout · **Depth**: formal (tax gate) · **Audience**: reviewer, pre-tasks
**Sources**: spec.md (FR-001…025, US1…8, SC-001…008), plan.md, data-model.md (§ A–F), research.md

## Requirement Completeness

- [ ] CHK001 - Are all §86/4 required particulars (seller/buyer name·address·TIN·branch, doc title, date, line description, VAT amount) specified as requirements for the payment-time tax invoice? [Completeness, US3/FR-006..010]
- [ ] CHK002 - Is the §87 no-gaps sequential-numbering requirement fully specified for the RC receipt stream (per tenant, per fiscal year, no-gaps discipline)? [Completeness, §D]
- [ ] CHK003 - Are the bill (SC, non-§87) and receipt (RC, §87) numbering streams specified as **provably disjoint** so a bill number can never satisfy the §87 register? [Completeness, SC-002/SC-003]
- [ ] CHK004 - Are VAT-computation requirements specified for BOTH `standard` (7%) and `zero_rated_80_1_5` (0%) treatments? [Completeness, FR-023/US8]
- [ ] CHK005 - Are the §80/1(5) MFA-certificate capture requirements complete (cert no., date, optional Blob scan, fail-closed when zero-rated)? [Completeness, FR-024]
- [ ] CHK006 - Are Original + Copy (§105ทวิ คู่ฉบับ) rendering requirements specified for the tax receipt? [Completeness, US2]
- [ ] CHK007 - Are the credit-note (§86/10) requirements specified to re-target the **tax receipt** (not the non-tax bill), and to block crediting an unpaid ใบแจ้งหนี้? [Completeness, §A.4]
- [ ] CHK008 - Are the WHT-note requirements complete (membership-only scope, tenant-configurable, exact TH/EN wording, render on both membership docs)? [Completeness, FR-012]
- [ ] CHK009 - Are the offline-payment bank-block requirements (payee, account, bank, SWIFT, instructions; render on ใบแจ้งหนี้ only) complete? [Completeness, FR-022]
- [ ] CHK010 - Is a cutover requirement to populate `members.legal_entity_type` before first issuance specified (else the §86/4 branch line is silently omitted for genuine registrants)? [Completeness, §F.1/§E]

## Requirement Clarity

- [ ] CHK011 - Is the VAT tax point unambiguously specified as **payment-time** (§78/1) for the §86/4 receipt, and no §87 number consumed at billing? [Clarity, US1]
- [ ] CHK012 - Is "zero-rated ≠ exempt" clearly stated (§80/1(5) 0% VATable, input-VAT-claimable, ภพ.30 zero-rate sales — NOT §81)? [Clarity, US8/§F.8]
- [ ] CHK013 - Is the RC fiscal-year boundary clearly specified as derived from the **payment date in Asia/Bangkok**, not the issue date? [Clarity, §A.2/trap-G]
- [ ] CHK014 - Is the ≥5,000 baht zero-rate condition clearly specified as a **warn (non-blocking)** with its source? [Clarity, FR-024]
- [ ] CHK015 - Is the WHT-note "membership-only" scope defined via a concrete discriminator (`invoice_subject='membership'`) rather than a vague description? [Clarity, FR-012]
- [ ] CHK016 - Is the buyer branch-line render gate clearly defined as **VAT-registrant juristic** (`legal_entity_type ≠ individual`), not `buyerHasTin`? [Clarity, §F.1]

## Requirement Consistency

- [ ] CHK017 - Do all references state **membership is always VAT 7% (`standard`)** consistently across US8, FR-023, and data-model §F.8? [Consistency]
- [ ] CHK018 - Are the async-worker render requirements consistent with snapshot-pinning — i.e. the worker sources `vat_treatment` + cert from the pinned snapshot (§F.2 ↔ §F.8.3)? [Consistency, G1]
- [ ] CHK019 - Is the combined-numbering-retired decision consistent everywhere (always `'separate'`; `'combined'` dropped from settings) with no stale "combined stays" text? [Consistency, §F.5]
- [ ] CHK020 - Are the audit-event requirements consistent about `invoice_issued` (bill) vs `tax_receipt_issued` (RC at payment) — which fires, when, at what retention? [Consistency, FR-021/§F.6]
- [ ] CHK021 - Is `vat_treatment` consistently stated as the **single source of truth that drives the VAT rate** (F4 rate derived, not independently set)? [Consistency, G3/§F.8.3]

## Acceptance Criteria & Measurability

- [ ] CHK022 - Is SC-001 (exactly one §86/4 tax number per paid sale, born at payment) objectively measurable via the `tax_receipt_issued` audit event? [Measurability, SC-001]
- [ ] CHK023 - Is SC-008 (a zero-rated embassy sale issues a §86/4 tax invoice at VAT 0% with a captured MFA cert, no 7% charged; missing-cert blocked) objectively verifiable? [Measurability, SC-008]
- [ ] CHK024 - Are the §87 no-gaps requirements measurable (a query proving no gaps per stream/fiscal year)? [Measurability, SC-002]
- [ ] CHK025 - Can "one member holds exactly one §86/4 tax document, never two" be objectively verified from the requirements? [Measurability, US1 AS4]

## Scenario & Edge-Case Coverage

- [ ] CHK026 - Are requirements defined for the in-flight legacy bill (old flow: §87 at issue, no bill number) → void + re-issue (fail-closed, never two §87 numbers)? [Coverage, FR-017]
- [ ] CHK027 - Are requirements defined for VOID of a paid vs unpaid bill (which of the two blobs are VOID-stamped)? [Coverage, Clarifications]
- [ ] CHK028 - Are requirements defined for async receipt-render permanent failure (admin alert + re-render reusing the SAME allocated RC, no §87 gap)? [Coverage, FR-019]
- [ ] CHK029 - Are requirements defined for renewal-generated invoices following the identical ใบแจ้งหนี้ → RC flow? [Coverage, FR-018/US1 AS5]
- [ ] CHK030 - Are the US8 zero-rate edge cases covered as requirements (membership-cannot-be-zero-rated; zero-rate-without-cert blocked; async render at 0%)? [Edge, US8 AS#2/#4/#5]
- [ ] CHK031 - Is the buyer branch-line edge case defined for NULL `legal_entity_type` (fail-closed → no line, never fall back to TIN)? [Edge, §F.1]

## Non-Functional (Compliance / Security / Retention)

- [ ] CHK032 - Are retention requirements specified for the tax-document class (10y) AND the `zero_rate_cert_blob` (§80/1(5) evidence filed with ภพ.30, 10y, admin-only)? [NFR, FR/§F.8.3 G2]
- [ ] CHK033 - Are tenant-isolation (RLS) requirements specified for the new invoice columns (`bill_document_number_raw`, `vat_treatment`, cert fields), per Constitution Principle I? [NFR, Constitution I]
- [ ] CHK034 - Is Buddhist-Era-display-only (no BE in storage) reaffirmed for all new date requirements (cert date, payment/receipt date)? [NFR, Conventions]

## Dependencies, Assumptions & Rollout

- [ ] CHK035 - Are the 3 accountant fact-confirms documented with resolution status (P1 VAT-registered = confirmed; flat-tier; WHT membership-only)? [Assumption, build gate]
- [ ] CHK036 - Is the "prod is test-data-only → no byte-stable re-render constraint" assumption documented and validated? [Assumption]
- [ ] CHK037 - Are migration reversibility + additive requirements specified (0230–0234), and is the "next free index" note current? [Operational, §B.6]
- [ ] CHK038 - Are rollout/rollback + feature-flag requirements specified, including `FEATURE_088_TAX_AT_PAYMENT` gating the US8 UI + zero-rate render for independent dark-launch? [Operational, G4/G5]

## Ambiguities & Conflicts (resolution check)

- [ ] CHK039 - Is the MFA-cert "referenced vs appended" question resolved in the requirements (referenced by no./date on the doc; scan retained in Blob, not appended)? [Ambiguity, G6]
- [ ] CHK040 - Is any conflict between FR-015 (bill stays downloadable after payment) and the FR-016 "payable record / tax-receipt-issued" wording resolved without contradiction? [Conflict, r2-F5]
