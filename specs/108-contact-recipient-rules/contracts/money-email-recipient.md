# Contract — Money-email recipient resolution (Tier A)

Applies to every transactional email tied to an invoice, receipt, credit note or payment:
`invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`,
`invoice_pdf_resent`, `receipt_pdf_resent`, `credit_note_pdf_resent` (F4 outbox event
types), plus the address handed to the payment processor (F5).

## 1. Resolution rule

```
resolveMoneyRecipient(port, tx, tenantId, memberId, snapshot) →
  memberId === null      → { kind: 'non_member', email: snapshot.primary_contact_email }   // event buyer, admin-typed
  live primary found     → { kind: 'member', email, locale }                              // is_primary AND removed_at IS NULL, read NOW
  no live primary        → { kind: 'no_recipient' }
```

- MUST run at enqueue time, inside the caller's tenant transaction when one is open, else
  through the port's own `runInTenant` (resend path, `tx === null`).
- MUST NOT read `member_identity_snapshot.primary_contact_email` for a member invoice.
- MUST NOT fall back to the snapshot, to CC/BCC, or to any other contact when
  `no_recipient`.
- On `no_recipient`: no outbox row; emit audit `auto_email_skipped_no_recipient`
  `{ invoice_id | credit_note_id, email_event_type, skipped_for_member_id }` in the
  caller's tx (mutation paths) or standalone (resend, `tx === null`); bump
  `invoicing.auto_email_skipped{reason:'no_recipient'}` when the caller knows the
  subject label; return `EmailDispatchOutcome = 'skipped_no_email'` (record-payment /
  issue paths) or `err({ code: 'no_recipient' })` (resend paths, mapped to 409).
- **`skipped_for_member_id`, not `member_id`** — migration 0009's trigger bumps
  `members.last_activity_at` from any audit payload carrying `member_id`, and the
  member timeline selects on it. A skipped email is not member activity; staff
  visibility is FR-003's banner. **`email_event_type`, not `event_type`** — so the
  payload never reads as a second copy of `audit_log.event_type`.
- `resolveMoneyRecipient` is a PURE resolver; the audit + metric side effect is a
  separate export `auditAutoEmailSkippedNoRecipient(audit, tx, args)`. The
  idempotent-replay arm of record-payment resolves without re-auditing a decision
  the original attempt already owned.

## 2. Port

```ts
// invoicing/application/ports/recipient-locale-port.ts (widened; name kept to limit churn)
interface RecipientLocalePort {
  getMemberEmailLocale(tx, tenantId, memberId): Promise<F4OutboxLocale | null>;           // existing
  getMemberEmailRecipient(tx, tenantId, memberId):
    Promise<{ email: string; locale: F4OutboxLocale | null } | null>;                   // NEW, required
}
```

Adapter: one SQL read of the live primary contact. Test double: `tests/helpers/
recipient-locale-fake.ts` (single shared fake; no per-file object literals).

## 3. Per-path obligations

| Path | Use case | Obligation |
|---|---|---|
| Receipt on payment | `record-payment` | live resolve at `:1115`; keep the three-arm outcome (`sent` / `disabled` / `skipped_no_email`); replay arm `:455-461` uses live too |
| Void notice | `void-invoice` | live resolve; **add** the empty-recipient guard (none today) |
| Credit note | `issue-credit-note` | live resolve keyed on the original invoice's `memberId` |
| Resend invoice / receipt / credit note | `resend-pdf` | live resolve; **delete** `recipientEmailOverride` from both input arms; credit-note arm gains the guard |
| Render / reconcile jobs | `receiptPdfRenderEnqueue`, `receipt-pdf-reconcile`, `void-pdf-reconcile` | not emails: keep sentinel / copy-forward unchanged, allow-listed by the gate |
| Renewal reminders, dunning, tier upgrade | F8 | already live (`is_primary AND removed_at IS NULL`); regression tests only |

## 4. Payment processor (F5)

```ts
// payments/application/ports/billing-recipient-port.ts (NEW)
interface BillingRecipientPort { getPrimaryContactEmail(tenantId: string, memberId: string): Promise<string | null>; }
```

- `InitiatePaymentInput.actorEmail` is removed. `initiatePayment` resolves the billing
  email through the port; PromptPay with `null` → `err({ kind: 'permanent', code:
  'primary_contact_missing' })` → HTTP 409 `primary_contact_missing`. Card: no email shared
  (unchanged).
- `payment_method_data.billing_details.email` MUST equal the live primary contact's email.

## 5. HTTP surfaces

| Route | Change |
|---|---|
| `POST /api/portal/invoices/[invoiceId]/resend` | 202 body becomes `{ ok: true }` (no `recipientEmail`); client toast already ignores it |
| `POST /api/invoices/[invoiceId]/resend`, `POST /api/credit-notes/[creditNoteId]/resend` (staff) | unchanged body `{ ok, documentNumber, recipientEmail }`; 409 `no_recipient` added |
| `POST /api/payments/initiate` | drops the `actorEmail` plumbing; 409 `primary_contact_missing` added |

## 6. Gate + tests

- `pnpm check:money-recipient` (`scripts/check-money-email-recipient.ts`, pre-push): every
  `.primary_contact_email` read under `src/modules/invoicing/**`, `src/modules/payments/**`,
  `src/app/api/**` must match an `ALLOWED` entry `{ file, contains, why }`; every entry must
  be found (positive control).
- Contract test `tests/contract/invoicing/money-email-recipient-inventory.test.ts`: promote
  B after issuing under A; pay, void, credit-note, resend ×3, initiate PromptPay; assert
  every outbox `to_email` and the processor `billingEmail` equal B; zero rows equal A.
- Integration (live Neon): `record-payment`, `void-invoice`, `issue-credit-note`,
  `resend-pdf` each gain a "primary changed after issue" case and a "no primary" case
  asserting the audit row + `skipped_no_email` and **no** outbox row.
