# Member billing address (2026-08-03)

**Trigger**: customer request — VAT-registrant buyers need the ใบกำกับภาษี to carry
their ภ.พ.20-registered address while the contact/company address differs.
Complements 088's buyer head-office/branch-code fields.

**Decision**: optional per-member billing address; invoice buyer snapshot prefers
it at issue time, else company address (current behavior). Operator approved
2026-08-03 after weighing the zero-code workaround (edit→issue→revert) — rejected
as ongoing practice (forgetting to revert + audit noise).

## Scope (1 PR, branch `member-billing-address`)

1. **F3 schema**: nullable billing_* columns mirroring the existing member
   address set. No enable flag — enabled = billing line1 IS NOT NULL; clearing
   NULLs the group. Hand-written migration + journal registration.
2. **F3 domain/application**: all-or-nothing group validation mirroring the
   company-address rules; billing fields flow into `member_updated` audit.
3. **Admin member form**: checkbox "Billing address differs from company
   address" (EN/TH/SV) revealing the second group; member detail shows it
   read-only. RHF + zod-i18n; render test against real en.json.
4. **F4 snapshot**: one switch point in the member-identity-snapshot composer —
   billing fields when present, else company. Credit notes inherit via the
   invoice snapshot. PDF untouched (renders the snapshot string). Issued
   invoices untouched (immutable, FR-038).
5. **PII lifecycle (blocker-grade)**: billing fields scrubbed in every erasure/
   redaction path the company address is; included in GDPR Art 20 export +
   member self-view. Integration-tested on live dev Neon.
6. **Portal**: read-only display. Self-edit = follow-up, deliberately out.

## Out of scope

Per-invoice buyer override; PDF template changes; retro-editing issued
documents; portal self-edit.

## Gates

TDD; unit + contract + integration (migration roundtrip, erasure scrub,
snapshot-at-issue) + form render test; check:i18n / lint / typecheck; then
enterprise-ux + thai-tax + pdpa reviews before PR.

## Formal-process note

Full Spec Kit (10-gate) deliberately not used: additive optional field, no
state-machine/money-path change; this doc + the three reviews are the
proportionate trail (same pattern as erasure-log-ux-enhancement).
