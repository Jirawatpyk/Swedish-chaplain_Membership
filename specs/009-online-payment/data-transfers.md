# F5 Cross-Border Data Transfers — PDPA / GDPR Lawful Basis

**Status**: Active addendum to `plan.md` § Compliance
**Authored**: 2026-04-28 (review-20260428-102639.md H4 closure)
**Reviewer-of-record**: Solo-maintainer (DPO role)

This document records the cross-border PII transfers introduced by F5 (Online Payment) and the lawful basis under Thailand PDPA + EU GDPR. It complements `saq-a-attestation.md § 2` which covers PCI scope. Spec-artefact files (`spec.md`, `plan.md`, `tasks.md`, `constitution.md`) are NOT modified by this addendum per Spec Kit / fix-it-run conventions.

## 1. Transfer inventory

| # | Source | Destination | Data | Frequency | Lawful basis (PDPA) | Lawful basis (GDPR) |
|---|---|---|---|---|---|---|
| 1 | Chamber-OS app (Vercel `sin1`) | Neon `ap-southeast-1` (Singapore) | All tenant data (PII inclusive) | Continuous (every DB op) | §28 — adequacy via SCC; documented in F1 plan | Art. 44 — SCC via Neon DPA |
| 2 | Chamber-OS app (Vercel `sin1`) | Vercel CDN edge (multi-region) | Static assets only (no PII) | Continuous | N/A | N/A |
| 3 | Chamber-OS app | Resend (EU/US) | Member email + transactional email body | Per email send | §28 + §24 contract performance | Art. 44 — Resend DPA + SCC |
| 4 | Chamber-OS app | **Stripe (Ireland HQ + US infrastructure)** | **Member email (`actorEmail`) on PromptPay PaymentIntents only** | **Per PromptPay payment** | **§28 + §24 contract performance** | **Art. 44 + Art. 6(1)(b) contract** |
| 5 | Stripe webhook | Chamber-OS app | Stripe event metadata (no PII bodies stored — sha256 only) | Per Stripe event | N/A (inbound) | N/A (inbound) |

## 2. Stripe transfer (#4) — detail

### Data scope

- **Personal data sent to Stripe**: member's registered email address (`actorEmail`).
- **What is NOT sent**: name, address, phone, member ID, invoice number, line items, tax IDs.
- **Why email is necessary**: Stripe's PromptPay PaymentIntent API requires `payment_method_data.billing_details.email` to initiate the QR-code rail (see `src/modules/payments/infrastructure/gateways/stripe-gateway.ts` and `tests/unit/payments/infrastructure/stripe-gateway-mapping.test.ts`).

### Lawful basis under Thailand PDPA

- **Section 24 (lawful basis)**: contract performance — the member entered into a contract with the chamber (membership), the chamber issued an invoice, and the member elected to pay via PromptPay. Email transmission to Stripe is a necessary processing step for that contract.
- **Section 28 (cross-border transfer)**: Stripe Singapore Pte Ltd is a Stripe Group company that operates as a sub-processor; Stripe's standard DPA includes Module 1 SCCs and a binding intra-group transfer agreement for the Ireland/US back-end.

### Lawful basis under EU GDPR

- **Article 6(1)(b)**: processing necessary for performance of a contract.
- **Article 44–46 (international transfers)**: Stripe's DPA (https://stripe.com/legal/dpa) includes the EU Commission SCCs (2021/914/EU) automatically upon merchant agreement acceptance. No separate signature required.

### Storage limitation

- `payments.processor_payment_method_email` is NOT stored in the F5 schema. The email is sent to Stripe only at PaymentIntent-create time and is not persisted in our DB.
- Stripe's retention is governed by Stripe DPA Annex II — typically 7 years for financial-record purposes.

### Member-facing disclosure

- **Privacy disclosure** rendered at the point of payment in `pay-sheet/security-footer.tsx` (i18n keys `portal.payment.security.privacyDisclosure` in EN/TH/SV per W1 closure).
- **Policy reference**: link to https://stripe.com/privacy is surfaced inline.

## 3. Resend transfer (#3) — summary

Covered in F1 plan and email-broadcast docs. F5 adds no new categories of email data.

## 4. Webhook inbound (#5) — summary

`processor_events` stores `payload_sha256` only — no raw Stripe event body persists in the DB. This is a deliberate data-minimisation design (GDPR Art. 25 / privacy-by-design); see `data-model.md § 5.4` for the full rationale.

## 5. Future transfers

Any new third-party processor added to F5/F6/F7 (e.g. an analytics SaaS, a CRM connector, a Slack bot) MUST be appended to § 1 with lawful-basis analysis BEFORE the implementation merges. This document is the authoritative ledger.
