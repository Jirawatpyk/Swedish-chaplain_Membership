# F5 — PCI DSS SAQ-A Self-Assessment Attestation

**Branch**: `009-online-payment`
**Date**: 2026-04-23 (initial draft) — re-attest before each production deploy that touches F5 surfaces
**Standard**: PCI DSS SAQ A v4.0 (the most current version as of 2026-04-23 — confirm against `https://www.pcisecuritystandards.org/document_library/` at attestation time)
**Scope**: SweCham (and any future Chamber-OS tenant) using F5 Online Payment via Stripe Elements + Stripe-hosted PromptPay

---

## 1. SAQ-A applicability checklist

This attestation claims **SAQ-A eligibility**. SAQ-A applies to merchants who:

| Eligibility criterion | Yes / No | Evidence |
|------------------------|----------|----------|
| Outsource ALL cardholder data functions to PCI DSS validated third-party service providers | YES | All card capture via Stripe Elements (hosted iframe loaded from `js.stripe.com`); all card data processing in Stripe's infrastructure |
| Maintain only paper reports or receipts with cardholder data — NOT electronic | YES | We persist only processor-issued tokens (`pi_…`, `ch_…`) + non-sensitive metadata (last-4, brand, expiry month/year) — these are NOT cardholder data per PCI DSS definition |
| Do NOT electronically store, process, or transmit any cardholder data on merchant systems or premises | YES | The Chamber-OS server NEVER receives raw PAN, CVV, or full track data. Verified by FR-005 + code review + ESLint rules. |
| Have confirmed PCI DSS validated status of all third-party service providers | YES | Stripe is PCI DSS Level 1 certified (validated annually; see https://stripe.com/docs/security and Stripe's AOC) |

If any of the above is "No", **SAQ-A does NOT apply** and we MUST escalate to SAQ-A-EP or SAQ-D — both require Constitution amendment per Principle IV.

---

## 2. Implementation evidence (per F5 design)

### Card capture
- **File**: `src/app/(member)/portal/invoices/[id]/_components/pay-sheet/card-form.tsx`
- **Mechanism**: imports `<PaymentElement />` from `@stripe/react-stripe-js`; renders an `Elements` provider with `clientSecret` from our server
- **Server interaction**: client-side Stripe Elements iframe handles all card input; on confirm, the SDK posts directly to Stripe's API (NOT to our server) and returns a `paymentIntent` reference
- **Forbidden by lint**: any `<input>` with `name` attribute matching `^card[_\-]?(number|cvc|cvv|exp)`

### Webhook handling
- **File**: `src/app/api/webhooks/stripe/route.ts`
- **Mechanism**: receives Stripe-signed webhooks; verifies via `stripe.webhooks.constructEvent`; persists only token-level metadata
- **Card metadata persisted on `payments` row**: `card_brand`, `card_last4`, `card_exp_month`, `card_exp_year` — these are explicitly NOT cardholder data per PCI DSS glossary

### Logging
- **File**: `src/lib/logger.ts`
- **Redaction list** (extended in F5): `card_number`, `card_cvc`, `card[*]`, `stripe_secret_key`, `stripe_webhook_secret`, `Stripe-Signature`, `Authorization`, full webhook body
- **Defense-in-depth**: PAN regex pattern matched + redacted before log emission

### CSP
- **File**: `src/app/middleware.ts`
- **Allowlist**: `script-src 'self' https://js.stripe.com`; `frame-src https://js.stripe.com https://hooks.stripe.com`; `connect-src 'self' https://api.stripe.com`
- **Scope**: applied only on `/portal/invoices/*` + `/admin/invoices/*` routes; webhook + other routes do NOT include the Stripe allowlist

---

## 3. SAQ-A questionnaire (v4.0 distilled)

### Build and Maintain a Secure Network

**1.1** No firewalls or routers managed by us are in scope (we use Vercel + Neon — both manage their own).
- **Status**: ✅ N/A — we don't operate the network infrastructure

**2.1** No system passwords, SNMP community strings, or other security parameters set to vendor defaults on systems within CDE.
- **Status**: ✅ N/A — no systems in CDE on our side

### Protect Cardholder Data

**3.1** Cardholder data NOT stored on our merchant systems.
- **Status**: ✅ COMPLIANT — verified by absence of card-number column in `data-model.md` § 2; verified by FR-005

**4.1** Strong cryptography on all cardholder data transmissions over open networks.
- **Status**: ✅ COMPLIANT — TLS 1.2+ + HSTS on every payment-touching endpoint (FR-019); Stripe Elements iframe uses TLS to `js.stripe.com`; our API uses TLS to client browsers

### Maintain a Vulnerability Management Program

**6.2** Software components have current vendor-supplied security patches.
- **Status**: ✅ COMPLIANT — Vercel platform managed; Stripe SDK pinned + Renovate/Dependabot keeps it current; quarterly review of Stripe API version pin

**6.6** Web-facing applications have automated technical solution that detects + prevents web-based attacks.
- **Status**: ✅ COMPLIANT — Vercel WAF inherited; CSP + HSTS + signed webhooks; OWASP Top 10 coverage in `security.md` § 2

### Implement Strong Access Control Measures

**8.1** All users assigned a unique ID before accessing system components.
- **Status**: ✅ COMPLIANT — F1 Auth provides unique user IDs + sessions; admin/manager/member RBAC

**9.1** Physical access to systems with cardholder data restricted.
- **Status**: ✅ N/A — no on-premise systems

### Regularly Monitor and Test Networks

**10.1** Audit trails track all access to system components.
- **Status**: ✅ COMPLIANT — append-only `audit_log` table extended with 20 F5 event types (FR-020; 16 via migration 0040 + 2 rate-limit events via migration 0043 per Threat F-09 + 2 webhook ops-visibility events via migration 0046 per audit 2026-04-25 findings #10/#13); 5-year retention minimum

**11.1** Quarterly external vulnerability scans.
- **Status**: 🟡 INHERITED — Vercel + Stripe handle infrastructure scans; we add a quarterly app-level dependency scan (npm audit + Snyk) as part of the engineering chore cadence

### Maintain an Information Security Policy

**12.1** Information security policy established + published + maintained.
- **Status**: ✅ COMPLIANT — Constitution v1.4.0 § Compliance + this saq-a-attestation.md + `security.md`; reviewed quarterly

### A.1 (Service Provider Attestation)

**A.1.1** Stripe (our PCI service provider) maintains current PCI DSS attestation.
- **Status**: ✅ VERIFIED — Stripe is PCI DSS Level 1 (latest AOC available at https://stripe.com/docs/security/stripe; SweCham retains a copy in vendor-files)

---

## 4. Pre-ship verification

Before each production deploy that touches F5 surfaces, the maintainer:

- [ ] Re-runs the SAQ-A applicability checklist (§ 1) — answer all "Yes"
- [ ] Confirms no new code path receives card data on our server (grep + code review)
- [ ] Confirms `STRIPE_*` env vars are not committed (gitleaks scan green)
- [ ] Confirms CSP allowlist scope unchanged (no expansion to non-payment routes)
- [ ] Confirms log redaction list unchanged or expanded (never reduced)
- [ ] Confirms Stripe SDK + API version still pinned (no silent SDK upgrade)
- [ ] **Manual SR (screen reader) pass completed within last 30 days** (post-critique E12+X5, 2026-04-23): NVDA (Windows) + VoiceOver (macOS/iOS) walkthrough of pay-sheet drawer (Pay-now CTA → method tabs → card form iframe → PromptPay QR + countdown → confirmation). Results in `specs/009-online-payment/sr-qa-{date}.md`. Required because axe-core cannot validate accessibility inside Stripe Elements iframe.
- [ ] Re-signs § 5 attestation block

---

## 5. Maintainer attestation

**I attest that, as of the date below, F5 Online Payment as deployed satisfies all SAQ-A eligibility criteria and the PCI DSS SAQ-A control requirements summarised above. The Chamber-OS server is outside the cardholder data environment. Card data is processed exclusively by Stripe via Stripe Elements + Stripe-hosted PromptPay. No raw PAN, CVV, or full track data is stored, logged, transmitted, or persisted by Chamber-OS infrastructure.**

**Signed**: ____________________
**Role**: Maintainer
**Date**: ____________________
**Stripe AOC reviewed (date)**: ____________________
