# Payment E2E test + membership no-TIN findings (2026-06-12)

Session: manual F5 online-payment testing (Stripe TEST mode, live `stripe listen` webhook) + membership no-TIN tax research. Local dev, swecham tenant.

---

## 1. F5 online payment — E2E test result: BOTH METHODS PASS ✅

Tested end-to-end against Stripe test mode with `stripe listen --forward-to localhost:3100/api/webhooks/stripe` (whsec matched `.env.local`).

| Step | 💳 Card | 📱 PromptPay |
|---|---|---|
| Pay sheet + Stripe Elements load | ✅ | ✅ |
| PaymentIntent created | ✅ | ✅ |
| Method action | test card 4242 4242 4242 4242 / 12-34 / 123 | QR generated (12,840 THB, 15-min expiry) → Stripe hosted "Simulate scan" → "Authorize Test Payment" |
| webhook `payment_intent.succeeded` → **[200]** | ✅ | ✅ |
| Invoice → **Paid** | ✅ SC-2026-900003 | ✅ SC-2026-000043 |
| Receipt issued | ✅ | ✅ RC-2026-000010 |

**Config verified complete:** env (test keys, `STRIPE_LIVE_MODE=false` matches sk_test, `FEATURE_F5_ONLINE_PAYMENT=true`), DB `tenant_payment_settings` (online enabled, `enabled_methods=['card','promptpay']`, account `acct_1SDjN4…`, pk_test…), webhook forwarding live + secret matched.

**Test-data mutations** (all E2E fixtures, not real PII): member "E2E Alpha Co" got a test TIN `0105556000009`; 2 of its draft membership invoices issued + paid (SC-2026-900003 card, SC-2026-000043 PromptPay).

### Additional flows tested — ALSO PASS ✅
| Flow | Result |
|---|---|
| **Refund (partial, card-paid SC-2026-900003)** | Stripe refund succeeded (1,070 THB, processor_refund_id set) · webhook `charge.refund.*` → [200] · **auto credit note CN-2026-000018** issued · invoice → `partially_credited` (credited 1,070) |
| **Standalone credit note (PromptPay-paid SC-2026-000043)** | **CN-2026-000019** (§86/10 ใบลดหนี้), 2,140 THB, VAT split proportionally (140 VAT) · sequential CN number · invoice → `partially_credited` (credited 2,140) |
| **PromptPay QR expiry** (SC-2026-000044) | ✅ Stripe "Expire Test Payment" → webhook `payment_intent.payment_failed` → [200] · payment row → `failed` · invoice **stays `issued`** (not paid) · member re-opens Pay → PromptPay → **fresh QR regenerated** (new 15-min countdown + Refresh QR) → can retry |

Note observed during refund: the card-paid invoice's "Method" shows **"Other"** (not "Card") — consistent with the §2 retrieve-failed card-metadata-enrichment gap.

---

## 2. `payment_processor_retrieve_failed` audit — INVESTIGATED (low impact, needs follow-up)

Fired on EVERY successful payment (card 07:29 + PromptPay 07:42), `processor_error_kind: "permanent"`, but **payment still completes (both invoices Paid)** — so it is NON-BLOCKING.

**What it is:** `confirm-payment.ts:572` calls `processorGateway.retrievePaymentIntent()` AFTER the webhook, purely to ENRICH card metadata (brand/last4) + the PromptPay QR-resume URL. On failure it audits `payment_processor_retrieve_failed` and continues — the payment outcome comes from the webhook payload, not this retrieve.

**Likely cause (to confirm):** `stripe-gateway.ts:364` retrieves with `connectOptions(stripeAccount)` (Stripe Connect connected-account context). If the test setup creates the PI on the platform account but retrieves with the connected-account header (or the test account `acct_1SDjN4…` is not a proper Connect account), Stripe returns `resource_missing` → classified `permanent`. This would also mean **card brand/last4 is never enriched** on card payments (minor display gap; PromptPay has no card metadata so N/A).

**Impact:** payments work; the only loss is card-metadata enrichment for display.

### ROOT CAUSE — CONFIRMED 2026-06-12 (ran dev + reproduced)
Ruled OUT: Connect-context (env `STRIPE_ACCOUNT_ID_SWECHAM` == DB `processor_account_id` == `acct_1SDjN42HOqs9a0JA` → `connectOptions` returns `{}`, no header; retrieve works with/without header), expand path (CLI+curl with the exact `latest_charge.payment_method_details.card` expand = OK), API version (pinned `2025-09-30.clover` = OK), the retrieve helpers (no throw). The app gateway's `retrievePaymentIntent` run standalone = OK 6/6.

**Actual cause = INTERMITTENT webhook-time retrieve failure.** `confirm-payment.ts:572` step 6 re-fetches the PI right when `payment_intent.succeeded` is delivered; the object is occasionally not-yet-retrievable at that instant (Stripe webhook read-consistency). `mapStripeError` (stripe-gateway.ts:184) maps it via the **default → `kind:'permanent'`** case (it's a 4xx, not a network/rate-limit error), so it is NOT retried → card metadata is permanently lost for that payment.
- **Proof of contrast (same code, two outcomes):** a fresh card payment 2026-06-12 15:41 logged `stripe-gateway: retrievePaymentIntent ok` → payment row `method='card', card_brand='visa', card_last4='4242'` → UI "Card". The two earlier payments (07:29/07:42) failed the retrieve → `method='other'`, no brand/last4 → UI "Other". Intermittent, not deterministic.
- **Impact:** cosmetic (card brand/last4 + Method label). Payment outcome, mark-paid, receipt all correct either way. No security/PCI impact.

### FIX (chosen) — bounded retry on the webhook-time enrichment retrieve
Add a small bounded retry-with-backoff to the confirm-payment step-6 enrichment retrieve (Stripe's documented pattern for objects referenced by a just-delivered webhook). Keeps the PCI single-trust-boundary retrieve (still never reads card from the event payload); recovers the metadata within the same handler instead of relying on Stripe redelivery. Tracked for implementation (payments surface — needs tests + security review).

---

## 3. Membership no-TIN — tax research ruling (thai-tax-compliance-auditor, 2026-06-12)

**Context:** real member list (v11) = 131 members, **46 (35%) have no tax_id** — 13 Individual + ~32 corporate (Regular/Start-up/Premium/Large/Gold) + 1 Student, ALL active/billable. System hard-blocks membership invoice issue without a tax_id (`tax_id_required` 422).

**Ruling:**
1. **§86/4 buyer-TIN requirement is NOT absolute** — it is mandatory only when the BUYER is a VAT-registered ผู้ประกอบการจดทะเบียน (so they can claim input VAT). Added by ประกาศอธิบดีฯ ฉบับที่ 199, effective 1 Jan 2015. Non-registrant buyers need only name + address for a valid §86/4. *(Operator must have the chamber's accountant confirm the exact notification number/wording before citing officially — the auditor confirmed substance + year, not the precise citation form.)*
2. **Standard practice for no-Thai-TIN buyers:** issue a **§105 ใบเสร็จรับเงิน** (receipt — no buyer TIN required), NOT a placeholder TIN on a full tax invoice. Every Thai person/company always has a 13-digit TIN (company reg no. / national ID).
3. **Cheapest correct handling, ranked:**
   - **(A) Capture the missing Thai TINs** — the primary answer, ~0 cost, no code change; covers the vast majority (Thai corporates + Thai individuals all HAVE a TIN, it just wasn't in the old list).
   - **(B) For genuinely-foreign / no-Thai-TIN buyers → §105 receipt** (same as the 064 event flow); legally sufficient, output VAT still filed on ภ.พ.30 normally.
   - **(C) placeholder TIN on a full tax invoice → DO NOT.**
4. **Is the hard-block right or too strict?** Structurally correct (blocks before §87 allocation, no number burned — `issue-invoice.ts:315-317`) and correct for Thai buyers (forces TIN capture). **Too strict ONLY for genuinely-foreign no-Thai-TIN buyers** — for that subset, the right change is to **relax → route to §105 receipt** (extend the existing gate), NOT build a big new feature.

**Membership-no-TIN feature size estimate: MEDIUM (not large) — ~1/3–1/2 of 064**, because the heavy infra is reusable (pdf_doc_kind, β receipt-stream numbering, receipt_separate §105 template, the as-paid use-case, `canTransition(subject)`). The one design decision: bill-first vs as-paid for no-TIN membership (as-paid likely sufficient — the "bill" is the F8 renewal reminder). **Build it ONLY if the post-TIN-capture foreign-no-TIN count is meaningful (10-20+); if it's 2-3, manual accountant receipts are cheaper.**

---

## Next steps (operator-chosen 2026-06-12)
1. Continue payment testing: refund · credit note · PromptPay QR expiry.
2. THEN revisit the membership-no-TIN feature decision (after capturing real TINs + counting genuine foreign-no-TIN members).
3. Follow up on `payment_processor_retrieve_failed` (item 2) — confirm Connect-context cause + card-metadata-enrichment impact.
4. `stripe listen` was left running for continued testing.
