# Critique Report (Final — pre-`/speckit.tasks`): 088 Invoice / Receipt Tax-Flow Redesign

**Date**: 2026-07-01 (Final round, post US8 fold)
**Scope**: whole bundle FR-001…025 · US1…8 · SC-001…008 · migrations 0230–0234
**Prior**: [critique-20260701-124839](./critique-20260701-124839.md) (r1, 12 closed) · [critique-20260701-133317](./critique-20260701-133317.md) (r2, 10 closed)
**Verdict**: ⚠️ **PROCEED WITH UPDATES** — 1 🎯 (async-worker input propagation for US8), 4 💡, 1 🤔; all small doc edits, no re-plan.

---

## Executive Summary

The bundle is mature: two prior critique rounds closed 22 findings, the core §86/4-at-payment redesign is validated against TSCC's **live invoice program + RD e-service** (VAT-registered `0994000187203`, 2-doc flow, Original/Copy, WHT note, bank block all match), and US8 (embassy §80/1(5) zero-rate) was folded in cleanly with canonical IDs across all six files. Constitution Check holds (US8 is additive, tenant-scoped, testable; no principle regressed). One **genuine correctness gap** survives the fold: the async receipt-render worker's documented input list (§ F.2) was written for the core flow and never extended for US8, so an async-rendered zero-rate receipt could print VAT 7%. Everything else is polish. Fix G1 (one-line propagation, plus a test) and proceed.

## Product Lens Findings

- **3a/3b (Problem & value)** — US8 is customer-driven with primary-source evidence (RD certs VAT 326/327/351-24) and delivers correct embassy invoicing; AS are outcome-based. No concern.
- **3d (Edge/UX)** — G4 (phase separability), G6 (cert reference vs appended scan) below.
- **3e (Success)** — SC-008 is measurable and binary. Good.

## Engineering Lens Findings

- **4a Architecture** — `vat_treatment` as a per-invoice column pinned into the immutable snapshot is consistent with the existing §86/4-particulars pattern; cert scan reuses the F4 Blob adapter. Sound. See **G3** (reconcile with the existing F4 VAT-rate computation — drive it, don't duplicate).
- **4b Failure modes** — fail-closed CHECK (`invoices_zero_rate_cert_required`) at DB + app layer is correct; `vat_treatment` default `'standard'` back-fills existing rows safely. See **G1** (async render path).
- **4c Security/privacy** — **G2**: `zero_rate_cert_blob_key` stores a tax-supporting document (embassy + chamber particulars, filed with ภพ.30) — retention class + access control + PDPA basis are unspecified.
- **4e Testing** — US8 needs: 0%-compute unit test, fail-closed cert-gate integration test, membership-cannot-be-zero-rated test, async-render-at-0% test (ties to G1). Ensure `/speckit.tasks` emits these.
- **4f Operational** — migration 0234 additive + reversible; **G5**: confirm the 088 rollout flag also gates the `vat_treatment` UI so US8 can dark-launch independently of the core.
- **4g Dependencies** — no new deps (reuses Blob). Good.

## Findings Summary

| ID | Lens | Sev | Category | Finding | Suggestion |
|----|------|-----|----------|---------|------------|
| **G1** | Eng | 🎯 | Failure/coherence | § F.2 says the async `render-receipt-pdf` worker "only reads `receipt_document_number_raw` + `paymentDate`" — never extended for US8. A zero-rate receipt rendered on the async path would lack `vat_treatment` + `zero_rate_cert_no`, so it could print **VAT 7% instead of 0%** and omit the §80/1(5) note. (Same class as the r1 async-worker finding.) | Extend § F.2's worker-input list to source `vat_treatment` + `zero_rate_cert_no`/`_blob_key` from the row/snapshot; add an AS + integration test "async render of a zero-rated bill → VAT 0% + §80/1(5) note". |
| **G2** | Eng | 💡 | Security/privacy | `zero_rate_cert_blob_key` retention/access/PDPA basis unspecified (it's §80/1(5) evidence filed with ภพ.30). | Pin retention to the tax-document class (10y, like `tax_receipt_issued`), admin-only access, note lawful basis (RD §80/1(5) compliance). |
| **G3** | Eng | 💡 | Architecture | Interaction with the existing F4 VAT-rate computation is implicit — risk of double source-of-truth for the rate. | State that `vat_treatment` **drives** the VAT rate (0% vs 7%) and that any existing `vat_rate`/line-rate field is derived from it, not set independently. |
| **G4** | Prod | 💡 | Scope/phasing | US8 (P3) folded into an already-large feature; risk it delays the P1 membership core. | In `/speckit.tasks`, give US8 its own trailing phase with a clean cut-line so the P1 core can ship even if US8 slips. |
| **G5** | Eng | 💡 | Operational | US8 dark-launch gating not stated. | Confirm the 088 feature flag also gates the `vat_treatment` UI + zero-rate render. |
| **G6** | Prod | 🤔 | UX/compliance | "cert reference/attachment" is ambiguous — is the MFA scan **appended** to the tax-invoice PDF or **stored separately + referenced** by cert no.? | Clarify: reference the cert no./date on the document + retain the scan in Blob (not necessarily appended to the PDF); confirm what ภพ.30 filing needs. |

**Counts**: 🎯 1 · 💡 4 · 🤔 1. Prior rounds: r1 12/12 closed, r2 10/10 addressed.

## Constitution Check

10/10 hold. US8 touches PII-adjacent evidence (cert blob) → Principle I (Data Privacy) is satisfied once **G2** pins retention/access. No NON-NEGOTIABLE regressions (Test-First, Clean Architecture, PCI DSS untouched — no payment-data change; zero-rate is a VAT-rate flag).

## Verdict

⚠️ **PROCEED WITH UPDATES** — resolve **G1** (correctness) before `/speckit.tasks`; fold **G2–G5** as small doc edits; answer **G6** (or defer to the issue-invoice UX in tasks). None require re-`/speckit.plan`.

---

*Final critique — read-only for spec/plan; remediation applied only on approval.*
