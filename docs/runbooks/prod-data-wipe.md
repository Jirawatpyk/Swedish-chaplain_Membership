# Runbook — Prod data wipe (pre-launch clean)

When wiping prod transactional/test data to reach a clean launch state (e.g. before importing the real ~131 members), follow this to avoid silently breaking online payments.

## ⚠️ MUST preserve (or re-seed) the SYSTEM-ACTOR users

The reserved system-actor rows in the `00000000-0000-0000-0000-0000000f50xx`
UUID namespace are **non-human `actor_user_id` values** that webhook + cron
writes point at:

| id | account |
|----|---------|
| `…0000000f5001` | `system-stripe-webhook@chamber-os.internal` |
| `…0000000f5002` | `system-resend-webhook@chamber-os.internal` |

`payments.actor_user_id`, `refunds.initiator_user_id`, `audit_log.actor_user_id`
are `uuid REFERENCES users(id)`. If a wipe deletes users (keeping only human
admins) it removes these rows, and then **every Stripe/Resend webhook throws an
FK violation → 500 → online payments silently fail** (customer charged, invoice
never marked paid, no receipt). Migrations 0041/0181 seed them but run **once**,
so a post-wipe redeploy does NOT restore them.

> This happened after the **2026-06-24** wipe — surfaced **2026-07-06** as
> `stripe-webhook.dispatch_threw` (`err:"eZ"` = minified `PostgresError`);
> `pi_3Tq5…` was charged on Stripe but stuck `pending`. Recovery: resend the
> Stripe event once the actors exist (the app re-processes an unprocessed
> event; it does not idempotency-skip a not-yet-succeeded one).

## Wipe procedure

1. When deleting from `users`, **exclude system actors**:
   ```sql
   DELETE FROM users WHERE id NOT LIKE '00000000-%' AND <your test-data predicate>;
   ```
2. **Always** re-seed afterwards regardless (idempotent, ON CONFLICT DO NOTHING):
   ```bash
   pnpm seed:system-actors:prod
   ```
   Exit 0 + "all 2 system actors present" ⇒ webhooks can write `actor_user_id`.
3. Also restore the other kept-state (plans, tenant config, invoice settings,
   bootstrap admin) per the prod-restore checklist.

## Verify online payment works after a wipe

Issue a test bill → pay online (Stripe test card) → confirm the invoice flips to
`paid` + a `RC-…` receipt renders (i.e. the webhook processed without an FK throw).
