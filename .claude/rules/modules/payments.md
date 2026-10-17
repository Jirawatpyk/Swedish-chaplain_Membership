---
paths:
  - "src/modules/payments/**"
  - "src/app/api/webhooks/stripe/**"
  - "src/components/payments/**"
  - "tests/**/payments/**"
---

# Payments (F5 `009-online-payment`)

Live in production with real money. Review with `financial-integrity-reviewer` + `pci-saqa-guardian` (SAQ-A: card data never touches our servers).

- **Stack added**: `stripe@^22` server + `@stripe/stripe-js@^9` + `@stripe/react-stripe-js@^6` (Elements). Env `STRIPE_API_VERSION` (pinned, FR-026) + `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` + `STRIPE_WEBHOOK_SECRET` + `FEATURE_F5_ONLINE_PAYMENT`.
- **Tables**: `payments`, `refunds`, `tenant_payment_settings`, `processor_events`; migrations 0033–0050.
- **The concurrent-initiate guard is three layers**: a partial unique index on `processor_payment_intent_id`, a tenant-filtered `SELECT … FOR UPDATE`, and `pg_advisory_xact_lock` per (tenant, invoice) that closes the TOCTOU window *before* the row probe — plus the Stripe idempotency key `inv-{invoiceId}-attempt-{n}`. The `payments:` lock namespace is a TOCTOU guard, not numbering.
- `/api/internal/metrics/stale-pending-count` emits the `payments.stale_pending_count` gauge every 5 min.
- Billing emails resolve the recipient through `BillingRecipientPort` (the live primary contact).
- Bulk "mark paid" goes through `record-payment`, not `mark-paid-offline`.
