# F5 — Security Threat Model + Checklist

**Branch**: `009-online-payment`
**Date**: 2026-04-23
**Source**: adapted from F1's `specs/001-auth-rbac/security.md` 16-threat template, retargeted at F5's online-payment surface.
**Constitution**: v1.4.0 — Principle IV (PCI DSS, NON-NEGOTIABLE) is the dominant constraint here.
**Status**: DRAFT — security reviewer signs § 6 checklist at the Review Gate.

---

## 1. Trust boundaries

| Boundary | Inside | Outside |
|----------|--------|---------|
| **Browser ↔ Stripe Elements iframe** | Stripe's origin (`js.stripe.com`) | Our React tree |
| **Browser ↔ Chamber-OS API** | Authenticated session + CSRF + same-origin | Public internet |
| **Chamber-OS API ↔ Stripe API** | TLS 1.2+ + Stripe SDK + secret key | Public internet |
| **Stripe → Chamber-OS webhook** | Signed payload (HMAC-SHA256) | Public internet |
| **Postgres ↔ Application** | RLS + `runInTenant` + `SET LOCAL app.current_tenant` | All other DB sessions |

The **CDE (cardholder data environment)** is exclusively inside Stripe. Our network is OUT of the CDE → SAQ-A scope.

---

## 2. Threats (STRIDE-mapped)

### T-01 — Cardholder data leakage to our server
**Vector**: A developer adds a custom `<input name="card_number">` field to `pay-sheet/card-form.tsx` to "improve UX", bypassing Stripe Elements.
**Severity**: CRITICAL (immediate SAQ-A scope loss + PCI breach risk)
**Mitigations**:
- ESLint custom rule forbidding `<input>` with `name` attributes matching `^card[_\-]?(number|cvc|cvv|exp)`
- Code review: `card-form.tsx` MUST mount `<PaymentElement>` and nothing else
- Contract test: `tests/contract/payments/no-card-fields-on-api.contract.test.ts` POSTs `{cardNumber:'4242…'}` to every API route and asserts 400 (zod rejects)
- SAQ-A attestation re-run before `/speckit.ship` (§ 12 saq-a-attestation.md)
- Pino redaction list includes `card[*]`, `card_number`, `card_cvc`
**Mapped tests**: `payment-card-happy-path.spec.ts` (asserts iframe origin = `js.stripe.com`); `no-card-fields-on-api.contract.test.ts`

### T-02 — Webhook signature forgery
**Vector**: Attacker discovers our webhook URL + sends a forged `payment_intent.succeeded` event to mark an unpaid invoice as paid.
**Severity**: HIGH (financial impact; bypasses payment processing entirely)
**Mitigations**:
- `webhooks.constructEvent` verifies HMAC-SHA256 + 5-min timestamp window before any state change (FR-007)
- Verification runs BEFORE body parse (`tests/integration/payments/webhook-signature.test.ts` asserts this)
- 401 + `webhook_signature_rejected` audit on failure
- Stripe webhook secret in env vars only; rotated via § 6 of `contracts/stripe-webhook.md`
- Optional: Stripe IP allowlist as defense-in-depth (post-MVP)
**Mapped tests**: `webhook-signature.test.ts` (4 scenarios)

### T-03 — Webhook replay attack
**Vector**: Attacker captures a legitimate webhook event (somehow) and replays it 100× to confuse our state machine.
**Severity**: MEDIUM (limited blast radius — state is idempotent — but inflates metrics)
**Mitigations**:
- `processor_events.id PRIMARY KEY` (Stripe event id) → INSERT … ON CONFLICT DO NOTHING (FR-008)
- Stripe signature header includes a 5-min-window timestamp; replays > 5 min old fail signature verification
- `webhook.duplicate_ignored.count{tenant, event_type}` metric tracks replay frequency
**Mapped tests**: `webhook-idempotency.test.ts`

### T-04 — Cross-tenant probe via API
**Vector**: Member of tenant A guesses an invoice ULID belonging to tenant B and POSTs to `/api/payments/initiate {invoiceId: <B's invoice>}`.
**Severity**: HIGH (tenant isolation breach is existential per `docs/saas-architecture.md`)
**Mitigations**:
- Application-layer authz: `getInvoiceForPayment(tenantCtx, id)` returns 404 if not in current tenant
- Database-layer RLS: `SELECT … FROM invoices WHERE id=$1` returns 0 rows under wrong tenant
- 404 returned (NEVER 403 — would leak existence)
- `payment_cross_tenant_probe` audit emitted at HIGH severity
- Alert: 1 event / 5 min (alarm); 5 events / hour (incident)
**Mapped tests**: `tenant-isolation.test.ts` (Review-Gate blocker)

### T-05 — Cross-tenant probe via webhook (compromised Stripe account id)
**Vector**: Attacker registers a Stripe webhook pointing at our endpoint using a maliciously-crafted account id metadata.
**Severity**: MEDIUM (Stripe signature verification covers most of this)
**Mitigations**:
- Tenant resolution via `tenant_payment_settings.processor_account_id` lookup → unknown account_id → 200 + `acknowledged_only` (no state change)
- `webhook_signature_rejected` audit if signature is forged
- Stripe IP allowlist (post-MVP) as defense-in-depth
**Mapped tests**: `tenant-isolation.test.ts` includes a "stranger Stripe account event" scenario

### T-06 — Out-of-band refund creating ledger drift
**Vector**: Admin opens Stripe dashboard and clicks "Refund" instead of using the in-app UI; our F4 credit note is not created → Chamber-OS ledger thinks invoice is paid while Stripe shows refunded.
**Severity**: MEDIUM (financial reconciliation drift; not a security breach but a compliance + audit risk)
**Mitigations**:
- FR-011a: detect via webhook + audit `out_of_band_refund_detected` + alert + runbook link
- Admin retraining: documented in onboarding (`docs/runbooks/out-of-band-refund.md`)
- `out_of_band_refund_rejected_total` metric — re-evaluate Q2 answer if > 0 for 2 consecutive months
**Mapped tests**: `out-of-band-refund.test.ts`

### T-07 — Stripe API version drift breaking webhook handler
**Vector**: Stripe auto-bumps account default API version → webhook payload schema changes → handler silently mis-parses → wrong invoice marked paid (or no action).
**Severity**: HIGH (silent financial errors)
**Mitigations**:
- FR-026: `STRIPE_API_VERSION` env var pinned + verified on every webhook event
- Mismatch → 200 + `webhook_api_version_mismatch` audit + NO state change (the event is acknowledged but not processed)
- Quarterly engineering review to consider version bump
**Mapped tests**: `api-version-pinning.test.ts`

### T-08 — Stripe environment mismatch (test event hitting live endpoint)
**Vector**: Misconfigured webhook subscription delivers a test-mode event to the live-mode endpoint (or vice versa) → unintended state change in the wrong environment.
**Severity**: MEDIUM (limited to staged environments; production has separate keys)
**Mitigations**:
- FR-010: handler checks `event.livemode` against env-expected `STRIPE_LIVE_MODE`
- Mismatch → 200 + `payment_environment_mismatch` audit + NO state change
**Mapped tests**: `environment-mismatch.test.ts`

### T-09 — Race condition: concurrent refunds exceeding cap
**Vector**: Two admin tabs simultaneously refund 60% each of a payment; both pass pre-flight check before either commits → cumulative > 100%.
**Severity**: HIGH (over-refund = financial loss)
**Mitigations**:
- FR-011b: `SELECT … FOR UPDATE` on `payments(id)` row inside the refund transaction → second refund waits, then re-reads sum, then rejects
- Pre-flight server-side validation refuses over-cap before Stripe call
**Mapped tests**: `refund-multi-partial.test.ts` includes Promise.all() concurrent scenario

### T-10 — Race condition: admin marks paid manually while online payment is in-flight
**Vector**: F4 admin clicks "Mark as paid" (manual reconciliation) at the same moment a member's online payment is settling; both transition the invoice to paid.
**Severity**: MEDIUM (results in over-collection)
**Mitigations**:
- F4's `markPaid` is idempotent (FR-007 of F4) — second call returns conflict
- F5's `confirm-payment` checks invoice state before invoking F4 markPaid; if already paid (manually), auto-refunds the online payment via Stripe + audits `payment_auto_refunded_concurrent_manual_mark`
**Mapped tests**: `stale-invoice-auto-refund.test.ts` covers the related stale-invoice edge case; concurrent-mark race added in implementation phase

### T-11 — Sensitive data leakage in logs
**Vector**: A developer adds `logger.info({ event: rawWebhookBody })` for debugging → full webhook payload (potentially containing card metadata) lands in pino logs → log aggregator indexed.
**Severity**: HIGH (potential PCI scope drift — depends on field)
**Mitigations**:
- `src/lib/logger.ts` redact list extended (per plan.md § Constraints): `card[*]`, `card_number`, `card_cvc`, `stripe_secret_key`, `stripe_webhook_secret`, `Stripe-Signature`, `Authorization`, `Set-Cookie`, full webhook body (whitelist event-id + event-type + api_version + livemode only)
- PAN regex in redact list as defense-in-depth
- ESLint rule (custom): `logger.*` calls receiving objects with key matching `^(card|raw_body|payload|stripe_secret|webhook_secret)` are warnings
- CI grep over recent logs (10k lines sample) for PAN-pattern strings before merge
**Mapped tests**: not directly testable — covered by code review + linter + post-implementation log audit

### T-12 — Stripe account compromise (secret key leak)
**Vector**: An attacker obtains `STRIPE_SECRET_KEY` (e.g., from a compromised laptop) and creates fraudulent charges/refunds on SweCham's Stripe account.
**Severity**: CRITICAL
**Mitigations**:
- Secret in Vercel env vars only (NEVER `.env` in git; gitleaks scan in CI)
- Restricted secret keys (Stripe restricted keys) for non-payment operations where possible — F5 needs full secret for `paymentIntents.create` + `refunds.create`, but webhook verification + read-only operations COULD use restricted keys (post-MVP improvement)
- Quarterly key rotation drill (operational runbook)
- Stripe Dashboard 2FA enforced
**Mapped tests**: not directly testable; relies on env-management discipline

### T-13 — Webhook secret leak
**Vector**: An attacker obtains `STRIPE_WEBHOOK_SECRET` → can forge events.
**Severity**: HIGH
**Mitigations**:
- Stored in env vars only; gitleaks scan
- Rotation procedure documented (`contracts/stripe-webhook.md` § 6) — Stripe permits multiple active endpoints during rotation window
- `webhook_signature_rejected` count alert catches malicious post-rotation forgery attempts using the old secret
**Mapped tests**: webhook secret rotation E2E (post-MVP runbook drill)

### T-14 — DoS via webhook spam
**Vector**: Attacker discovers webhook URL + floods with fake events to exhaust DB writes / log capacity.
**Severity**: LOW–MEDIUM
**Mitigations**:
- Rate limit: 600 events/min/IP at the Vercel WAF + Upstash token bucket
- Stripe signature verification refuses fakes early (cheap CPU)
- `webhook.signature_rejected_total` metric + alert at 1/5min
**Mapped tests**: `webhook-signature.test.ts` (basic); load test at scale not in MVP

### T-15 — Stripe Elements XSS via tampered hosted iframe
**Vector**: A network attacker MITMs `js.stripe.com` script load and injects malicious JS that steals card data.
**Severity**: MEDIUM (Stripe's responsibility primarily; we minimise our exposure)
**Mitigations**:
- HSTS + TLS 1.2+ (inherited)
- CSP `script-src 'self' https://js.stripe.com` — no inline scripts; SRI checksums where Stripe publishes them (currently they don't, so SRI is N/A)
- Subresource integrity tracked as a "watch" item — adopt if Stripe ships SRI
**Mapped tests**: not testable in CI; covered by browser security model

### T-16 — Pay-link forgery (POST-MVP risk; currently mitigated by absence)
**Vector**: F5.1 will introduce signed pay-links for unauthenticated clerks. If poorly designed, attackers could forge a link to pay any invoice OR replay a captured link to pay multiple times.
**Severity**: HIGH (when F5.1 ships)
**Mitigations**:
- Currently MITIGATED BY ABSENCE — `allow_anonymous_paylink=false` in F5 MVP (Q3); the threat surface does not exist yet
- F5.1 MUST do its own threat modeling: signed JWT with single-use jti + invoice id + tenant id + 7-day expiry + revoke-on-void/credit + rate-limit per IP, etc.
- Documented as "not in F5 scope; F5.1 owes its own security.md"

---

## 3. Privacy / data protection (PDPA + GDPR)

| Concern | Lawful basis | Retention | Notes |
|---------|--------------|-----------|-------|
| Payment records | Legal obligation (Thai RD §87/3 + GDPR Art. 6(1)(c)) | 5 years (10 if attached to F4 tax doc) | Erasure refused per legal-obligation basis |
| Refund records | Legal obligation | 5 years (10 if attached to F4 credit note) | Same |
| Tenant payment settings | Legitimate interest (operational config) | Tenant lifecycle | Updated freely; audit trail |
| Processor events (webhook log) | Legitimate interest (audit + idempotency) | 1 year (purgeable; not financial record by itself) | Payload SHA-256 stored, not body |

PDPA Section 28 cross-border transfer: Stripe processes data in EU/US/SG. Stripe is a sub-processor; covered by SCC + Stripe's DPA already on file with SweCham.

---

## 4. RBAC matrix (delta vs F1+F4)

| Resource | `member` | `manager` | `admin` |
|----------|----------|-----------|---------|
| `POST /api/payments/initiate` (own company invoice) | ✅ | ❌ 403 | ❌ 403 (admin uses different impersonation flow if ever needed) |
| `POST /api/payments/[id]/cancel` (own payment) | ✅ | ❌ | ❌ |
| `POST /api/refunds/initiate` | ❌ | ❌ 403 | ✅ |
| `GET /admin/invoices/[id]` (payment timeline panel) | n/a | ✅ read-only | ✅ |
| `GET /admin/invoices` (filter "paid online") | n/a | ✅ | ✅ |
| Update `tenant_payment_settings` | n/a | ❌ 403 | ✅ |
| View own payment history (`/portal/invoices`) | ✅ (own company only) | n/a | n/a |
| Webhook endpoint | (not auth-mediated; signature only) | (n/a) | (n/a) |

---

## 5. Compliance — PCI DSS SAQ-A scope

See `saq-a-attestation.md` for the full SAQ-A questionnaire.

Key claim: **the Chamber-OS server is OUTSIDE the CDE**. Cardholder data exists only in Stripe-controlled domains (`js.stripe.com` iframe + `api.stripe.com` server). Our server holds processor-issued tokens + non-sensitive metadata (last-4, brand, expiry).

Scope verification: re-attest before every production deploy that touches F5 surfaces; quarterly self-audit.

---

## 6. Reviewer's security checklist (must be signed at Review Gate)

By signing below, the security reviewer confirms ALL of the following are true:

- [ ] No raw PAN, CVV, or card track data exists in any database row, log line, error report, telemetry payload, or screenshot generated by F5 — verified by code review + grep over a representative log sample.
- [ ] Every webhook request is signature-verified BEFORE body-parse — verified by reading `process-webhook-event.ts` + `tests/integration/payments/webhook-signature.test.ts`.
- [ ] Every payment-touching API route is RBAC-checked + tenant-scoped + RLS-enforced + cross-tenant-probe-audited.
- [ ] Cross-tenant integration test (`tests/integration/payments/tenant-isolation.test.ts`) passes green.
- [ ] All 20 audit event types in spec FR-020 (16 via migration 0040 + 2 rate-limit events via migration 0043 per Threat F-09 + 2 webhook ops-visibility events via migration 0046 per audit 2026-04-25 findings #10/#13) are emitted with the correct severity + payload schema (verified by `tests/integration/payments/audit-coverage.test.ts` to be added in `/speckit.implement` Phase 4).
- [ ] Stripe API version is pinned via `STRIPE_API_VERSION` env var; webhook handler emits `webhook_api_version_mismatch` on drift (FR-026).
- [ ] In-app refund flow is the ONLY path that creates F4 credit notes; out-of-band refunds detected + audited (FR-011a).
- [ ] FR-011b refund-amount cap enforced server-side pre-flight + concurrent-refund row-lock test passes.
- [ ] CSP allowlist for `js.stripe.com` + `api.stripe.com` is scoped to F5-relevant routes only (verified by middleware test).
- [ ] All env vars (STRIPE_*, FEATURE_F5_ONLINE_PAYMENT) are zod-validated at boot; missing/malformed = boot failure.
- [ ] No Stripe secret key, webhook secret, or `Stripe-Signature` header value appears in any committed file (gitleaks green).
- [ ] SAQ-A attestation (`saq-a-attestation.md`) signed by maintainer + dated within last 30 days.
- [ ] Solo-maintainer substitute stack (5 agents) ran green if applicable: `/speckit.review` + `/speckit.staff-review` + `pci-saqa-guardian` + `security-threat-modeler` + post-remediation `/speckit.verify`.
- [ ] **Manual SR pass on pay-sheet completed** (post-critique E12+X5, 2026-04-23): NVDA (Windows) + VoiceOver (macOS / iOS) screen-reader walkthroughs of (a) Pay-now CTA → drawer open, (b) Card form interactions inside Stripe Elements iframe, (c) PromptPay tab + QR + countdown, (d) Confirmation panel + close. Results documented in `specs/009-online-payment/sr-qa-{date}.md`. Required because axe-core has known iframe-traversal limitations and CANNOT validate accessibility inside the Stripe Elements iframe — manual SR is the only authoritative check.

**Signed**: ____________________ (security reviewer) **Date**: ____________________
