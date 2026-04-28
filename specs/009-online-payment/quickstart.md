# F5 — Quickstart (Local Dev Setup)

**Branch**: `009-online-payment`
**Date**: 2026-04-23
**Audience**: developer setting up F5 locally for the first time, or returning after env-var rotation.
**Prereq**: F1+F2+F3+F4 quickstart already followed (`pnpm dev` runs on `:3100`, Neon Singapore connected, Vercel CLI linked).

---

## 1. Create / connect Stripe accounts

You need **two** Stripe accounts (or one account in the right mode):

- **Test mode**: shared with the team for dev + staging + CI integration tests. Account name: `Chamber-OS Dev`. URL: `https://dashboard.stripe.com/test`.
- **Live mode**: SweCham's production account. URL: `https://dashboard.stripe.com`. **Only the production maintainer has access.**

Both accounts must have **PromptPay** enabled in **Settings → Payment methods → PromptPay → Activate**. PromptPay activation requires a Thai business entity verification — already complete for SweCham; for the dev account, test mode supports PromptPay without business verification.

---

## 2. Install Stripe CLI

```bash
# macOS
brew install stripe/stripe-cli/stripe

# Windows (via scoop) or Linux — see https://docs.stripe.com/stripe-cli
```

Authenticate to the test account:

```bash
stripe login
# Opens browser → authorise CLI → CLI captures restricted API key for dev
```

---

## 3. Pull env vars from Vercel

```bash
vercel env pull .env.local
```

This populates the F5 env vars added to the `chamber-os` Vercel project:

| Var | Source | Notes |
|-----|--------|-------|
| `STRIPE_SECRET_KEY` | Vercel | `sk_test_…` for dev/staging; `sk_live_…` for prod |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Vercel | `pk_test_…` / `pk_live_…` (client-safe; `NEXT_PUBLIC_` prefix required for browser bundle) |
| `STRIPE_WEBHOOK_SECRET` | Vercel | The webhook endpoint secret — **per environment** |
| `STRIPE_API_VERSION` | Vercel | `2025-09-30.clover` (pinned — see `research.md` § 2) |
| `STRIPE_ACCOUNT_ID_SWECHAM` | Vercel | SweCham's Stripe account id (`acct_…`) — public, used for tenant resolution |
| `STRIPE_LIVE_MODE` | Vercel | `false` for dev/staging; `true` for prod — used to enforce environment segregation per FR-010 |
| `FEATURE_F5_ONLINE_PAYMENT` | Vercel | `true` to enable; `false` global kill switch |

`src/lib/env.ts` zod-validates these at boot — `pnpm dev` refuses to start if any are missing or malformed.

---

## 4. Forward webhooks to your local dev server

In a separate terminal (keep it running while developing):

```bash
stripe listen --forward-to localhost:3100/api/webhooks/stripe
```

Output looks like:

```
> Ready! You are using Stripe API Version [2025-09-30.clover]. Your webhook signing secret is whsec_abc123… (^C to quit)
```

**Copy the `whsec_…` value into `.env.local`** as `STRIPE_WEBHOOK_SECRET` (overrides the Vercel-pulled one for this local session). Restart `pnpm dev` so the new secret is loaded.

The CLI now forwards every test-mode event to your local handler. You'll see real-time logs of each event delivery + your handler's response status.

---

## 5. Test the happy paths

### 5.1 Card payment

In a third terminal, simulate a successful card payment:

```bash
stripe trigger payment_intent.succeeded
```

This fires a synthetic `payment_intent.succeeded` event. Your local webhook handler should:

- Return 200 OK
- Insert / update a `payments` row
- Call F4 `markPaidFromProcessor`
- Insert audit `payment_succeeded` + `invoice_paid`

Verify in the local DB:

```bash
pnpm tsx scripts/dev/inspect-recent-payments.ts
```

(see § 9 for the script — to be added in `/speckit.implement` Phase 1).

### 5.2 PromptPay payment

```bash
stripe trigger payment_intent.requires_action --add payment_intent:payment_method_types[]=promptpay
# Then:
stripe trigger payment_intent.succeeded
```

### 5.3 Card decline

```bash
stripe trigger payment_intent.payment_failed --override payment_intent:last_payment_error[code]=card_declined
```

### 5.4 Refund (in-app)

UI flow: sign in to `/admin` → open invoice → click "Issue refund" → enter amount + reason → submit. The handler creates the refund via Stripe API + waits for the `charge.refunded` webhook to confirm. End-to-end takes ~3–5 seconds in test mode.

### 5.5 Refund (out-of-band — for FR-011a testing)

```bash
# 1. First create a paid invoice via the UI (US1 happy path)
# 2. Then in Stripe dashboard, manually click "Refund" on the test charge
# 3. Watch the `stripe listen` log for the `charge.refunded` event
# 4. Your handler should:
#    - return 200 OK
#    - audit `out_of_band_refund_detected`
#    - alert (in dev: pino structured log at WARN level + console)
#    - NOT create an F4 credit note
```

---

## 6. Test cards reference

| Number | Behaviour |
|--------|-----------|
| `4242 4242 4242 4242` | Always succeeds |
| `4000 0000 0000 9995` | Always declined: `insufficient_funds` |
| `4000 0025 0000 3155` | Requires 3D Secure / SCA challenge |
| `4100 0000 0000 0019` | Always declined: `card_declined` |
| `4000 0000 0000 0259` | Always charges as `disputed` (post-MVP testing) |

Any future expiry date + any 3-digit CVC + any postal code work.

Full list: https://docs.stripe.com/testing#cards

---

## 7. PromptPay test fixture

Stripe test mode auto-confirms PromptPay payments after 30s when `payment_intent.confirm` is called. To accelerate in tests:

```bash
# After creating a PromptPay PaymentIntent in the UI:
stripe trigger payment_intent.succeeded \
  --override payment_intent:id=<pi_id_from_db>
```

This forces an immediate `succeeded` event, bypassing the 30s wait.

---

## 8. Run integration tests (against real Stripe + Neon)

```bash
# Tests need both Neon and Stripe test mode reachable
pnpm test:integration --filter=payments

# E2E with the Sheet drawer (uses the Stripe test mode, expects `stripe listen` running in another terminal)
pnpm test:e2e --grep "@payments" --workers=1
```

The `--workers=1` is mandatory (per the user-memory feedback re: E2E workers — appending `--workers=1` to every Playwright invocation).

CI runs against a dedicated CI Stripe test account with separate keys (set in GitHub Actions secrets — NEVER commit).

---

## 9. Useful dev scripts (to be added in `/speckit.implement`)

| Script | Purpose |
|--------|---------|
| `scripts/dev/inspect-recent-payments.ts` | Print last 20 payment rows with their refund history |
| `scripts/dev/replay-stripe-event.ts <event_id>` | Re-fetch + re-fire a Stripe event for debugging idempotency |
| `scripts/dev/clear-test-payments.ts` | Delete all `processor_environment='test'` rows (NEVER works on `live`) |
| `scripts/dev/seed-test-invoice.ts` | Create a test member + tier + issued invoice for happy-path testing |

---

## 10. Common pitfalls

- **Webhook secret mismatch** — if you see 401 on every `stripe trigger`, you've mixed up the `whsec_…` from `stripe listen` with the Vercel-stored one. The `listen`-issued secret is per-CLI-session; always copy the latest one when you restart `stripe listen`.
- **API version mismatch** — if `webhook_api_version_mismatch` audit fires repeatedly, the Stripe account default has bumped past your pinned `STRIPE_API_VERSION`. Update the env var + regenerate fixtures + re-run contract tests + bump `plan.md` version.
- **PromptPay activation** — if you see "PromptPay is not enabled for this account", go to test-account dashboard → Settings → Payment methods → activate. Live mode requires Thai business KYC.
- **PII redaction in logs** — if you see `card[number]` or full PAN in any log, **STOP** and grep for the leak source. Add the field to `src/lib/logger.ts` redact list. Filing a HIGH-severity bug is appropriate.
- **Cross-tenant probe noise** — during dev with multiple test tenants, if you accidentally mix sessions, you'll see `payment_cross_tenant_probe` events. These are EXPECTED in test; in production, they're a high-severity alert.

---

## 11. SAQ-A pre-implementation checklist

Before merging F5 to `main`, the maintainer signs `specs/009-online-payment/saq-a-attestation.md` confirming:

- [ ] No card number / CVV input field exists in `src/app/**` (grep `<input.*name=.*card.*>` returns 0 matches outside Stripe Elements)
- [ ] No `card_number` / `card[*]` field in any zod schema in `src/modules/payments/application/schemas/**`
- [ ] No PAN-shaped string in any `pino` log line during a representative dev run (grep against rolling 10k log lines)
- [ ] Stripe Elements iframe is the ONLY card capture surface (verified by `tests/e2e/payment-card-happy-path.spec.ts` checking the iframe origin = `js.stripe.com`)
- [ ] CSP headers include the Stripe allowlist on every payment-relevant route, and EXCLUDE it elsewhere
- [ ] `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` never appear in any committed file (gitleaks scan green)

Re-attested before `/speckit.ship`.
