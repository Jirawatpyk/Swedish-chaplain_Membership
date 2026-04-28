# Runbook — `webhook_api_version_mismatch`

**Owner**: Solo-maintainer (escalate to Stripe support if Stripe-side version drift)
**Severity**: alarm (Q5 monitoring — Stripe API version drift detector)
**Source signal**: `webhook.api_version_mismatch_total` counter (> 0 triggers alert)
**Audit event**: `webhook_api_version_mismatch` (retention 5y)
**Last reviewed**: 2026-04-28 (staff-review R2 R004)

---

## Symptom

Stripe webhook events arrive with an `api_version` field that does NOT match the pinned `STRIPE_API_VERSION` env var. The webhook handler emits `webhook_api_version_mismatch` audit events and records the metric. Per FR-026 / Q5, mismatched events are processed defensively but the divergence is a leading indicator that Stripe's account-level API version is drifting from our pin.

## Why this matters

Stripe's webhook payload schema can change between API versions (field renames, enum additions, removed fields). If our parsing code assumes the pinned version's schema while Stripe is sending a newer version's payload, we may:

- Mis-deserialise nested fields (e.g. `payment_intent.next_action`).
- Silently ignore new fields (potentially missing settlement state).
- Throw on unknown enum values.

We pin `STRIPE_API_VERSION` to keep the schema stable. A mismatch alert means the pin and Stripe's account default have diverged — usually because Stripe rolled out a new default API version and our account inherited it.

---

## Triage steps (in order)

1. **Confirm the divergence**.
   - Vercel Logs → filter on `payments.webhook` traces → grab a recent mismatched-event log line. The audit row stores `received_api_version` and `expected_api_version` in the payload.
   - Stripe Dashboard → Developers → Workbench → "Default API version" — does it match our `STRIPE_API_VERSION` env var?

2. **Check Stripe's release notes**.
   - https://stripe.com/docs/upgrades — find the diff between the received version and our pinned version. Pay attention to:
     - PaymentIntent, Charge, Refund, PaymentMethod object changes.
     - Webhook event-type renames or new event types.
     - `next_action` shape changes.

3. **Decide: pin-up or roll-back**.
   - **Pin-up (preferred)**: review the schema diff, update parsing code if needed, then bump `STRIPE_API_VERSION` env var to the new version. Test against Stripe webhook simulator before production deploy.
   - **Roll-back (emergency)**: Stripe Dashboard → Workbench → revert the account-level default API version to our pinned version. This is fast but only works for a short window after Stripe upgrades the default.

4. **Verify no events were dropped**.
   - The mismatch path still processes events defensively (per FR-026) — but check for new event types we don't handle:
   - `SELECT DISTINCT event_type FROM processor_events WHERE received_at > now() - interval '24 hours';` — any unfamiliar entries?

---

## Escalation

- **Schema diff is non-trivial** → pause F5 deploys, run `/speckit.review` on the parsing code, write a migration plan, and treat the version bump as a Spec Kit feature gate.
- **Stripe support unavailable** + **drift continues** → set `FEATURE_F5_ONLINE_PAYMENT=false` to kill-switch payments while we stabilise. Communicate to members via maintenance banner.

---

## Recovery

After the pin is updated and deployed:

1. `webhook.api_version_mismatch_total` should flatten to 0.
2. Re-process any audit-flagged events that may have been mis-parsed:
   - Stripe Dashboard → Webhooks → "Resend events" for the affected event IDs.
3. Spot-check a few `processor_events` rows for the most recent payments to confirm field shape is sane.

---

## Prevention

- The SAQ-A attestation pre-deploy checklist (`specs/009-online-payment/saq-a-attestation.md` § 4) requires "quarterly review of Stripe API version pin".
- Stripe sends advance email notice of default-version changes — subscribe a monitored mailbox to Stripe developer announcements.
- The `webhook.api_version_mismatch_total` counter is an early-warning canary — alert at > 0 (not a higher threshold) to catch drift the same day Stripe rolls a new default.
