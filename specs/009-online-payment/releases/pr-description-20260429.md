## Summary

F5 — Online Payment (Stripe + PromptPay) — the **Phase 2 opener** that lets signed-in members pay their F4-issued invoices online, removing manual bank-transfer reconciliation from the SweCham admin's daily workflow. Card capture via **Stripe Elements** (PCI DSS SAQ-A scope preserved — Constitution Principle IV NON-NEGOTIABLE) + **PromptPay QR** via Stripe PaymentIntents `next_action.promptpay_display_qr_code`. On settlement, F5 invokes the existing F4 `markPaidFromProcessor` use-case so the invoice state machine, sequential receipt numbering, tax-compliant PDF, and auto-email all reuse F4's atomic transaction — **F5 does not re-implement** any F4 flow.

**Shipping branch**: `009-online-payment` (111 commits ahead of `main`; +69 158 / −1 076; 524 files).

## Specification

- [`specs/009-online-payment/spec.md`](../specs/009-online-payment/spec.md) — 6 USs (US1+US2 = P1 ship-together per Q1; US3+US4 = P2; US5+US6 = P3) + 30 FRs + 13 SCs + 16 STRIDE threats + 6 resolved clarifications.
- **Constitution alignment** (10 principles incl. 4 NON-NEGOTIABLE): all gates pass per [`plan.md § Constitution Check`](../specs/009-online-payment/plan.md). PCI Principle IV via Stripe Elements + redact list + PAN regex + zero card data on app server. Tenant-isolation Principle I (v1.4.0) two-layer (app + RLS+FORCE) with the documented narrowest-bypass-window for pre-tenant-resolution `processor_events` insertion.

## Implementation

- **New bounded context**: `src/modules/payments/` (Domain → Application → Infrastructure → Presentation; ESLint barrel guard active).
- **4 new DB tables**: `payments`, `refunds`, `tenant_payment_settings`, `processor_events` — all RLS+FORCE; tenant-scoped policies; advisory-lock per `(tenant, invoice)` with `payments:` namespace prefix disjoint from F4 `invoicing:` numbering locks.
- **18 new audit event types** (16 base + 2 rate-limit; data-model § 7 lists up to 20 incl. webhook ops); `audit_log.retention_years` column (5 default, 10 for tax-document events; R2-E4 backfill of 476 F4 tax-doc rows to 10y per Thai RD §87/3 + GDPR Art. 6(1)(c)).
- **30 migrations** (`0033 → 0062`) incl. T166 async receipt-PDF (migration 0056 + `FEATURE_F5_ASYNC_RECEIPT_PDF` flag).
- **18 OTel metrics + 10 alert rules**; full distributed trace `portal_click → api_payments_initiate → stripe_create_intent → webhook_receive → webhook_verify → f4_markpaid → receipt_email_enqueued`.
- **Stripe API version pinned** (`STRIPE_API_VERSION` env-var; `webhook_api_version_mismatch` audit + 200 ack on drift); webhook handler on Node runtime for raw-body HMAC access.
- **3-layer concurrent-initiate guard**: partial unique index + tenant-filtered SELECT FOR UPDATE + per-(tenant, invoice) advisory-lock + Stripe idempotency-key `inv-{invoiceId}-attempt-{n}` (TOCTOU window closed at staff-review R2).
- **Out-of-band refund detection** (FR-011a) via `charge.refunded` no-matching-row branch — audit + per-tenant + per-env metric + alert + runbook.
- **EN+TH+SV** at release across all 1296 i18n keys + top-20 Stripe decline-reason catalogue × 3 locales.
- See [`tasks.md`](../specs/009-online-payment/tasks.md) for the full 183-task breakdown across 9 phases.

## Performance

| SLO | Target | Actual | Headroom |
|---|---|---|---|
| SLO-F5-001 (initiate p95) | < 1.2 s | 1162 ms | 38 ms |
| SLO-F5-002a (webhook canceled/failed p95 prod) | < 500 ms | 210–260 ms est | ~50 % |
| SLO-F5-002b (webhook succeeded p95 dev) | < 1000 ms | **939 ms** (n=100 + 5-warmup) | 61 ms |

T166 async receipt-PDF: 46.7 % p95 reduction vs sync legacy (1762 ms → 939 ms). Full benchmark in [`perf-results-t166-2026-04-28.md`](../specs/009-online-payment/perf-results-t166-2026-04-28.md).

## Testing

| Suite | Result |
|---|---|
| TypeScript strict | ✅ pass |
| ESLint (Clean Architecture barrel guard) | ✅ pass (0 errors, 0 warnings) |
| `pnpm check:i18n` | ✅ 1296 keys × EN/TH/SV |
| `pnpm check:layout` | ✅ 58 page/loading pairs |
| Unit + contract (`pnpm test`) | ✅ 2363/2363 (after palette-search F2 flake fix) |
| Integration (live Neon Singapore) | ✅ 623/623 + 10 skipped + 1 todo per [`qa-2026-04-28.md`](../specs/009-online-payment/qa/qa-2026-04-28.md) |
| Coverage thresholds (Domain 100 % line; Application ≥80 % line+branch; security-critical 100 % branch) | ✅ |

**Review-Gate blocker integration tests** all green:

- `tests/integration/payments/tenant-isolation.test.ts` (Constitution v1.4.0 Principle I clause 3)
- `tests/integration/payments/webhook-signature.test.ts` (FR-007 / SC-009 — 4 scenarios)
- `tests/integration/payments/webhook-idempotency.test.ts` (FR-008 / SC-005)
- `tests/integration/payments/refund-multi-partial.test.ts` (FR-011b incl. concurrent-race)
- `tests/integration/payments/out-of-band-refund.test.ts` (FR-011a)
- `tests/integration/payments/api-version-pinning.test.ts` (FR-026)
- `tests/integration/payments/stale-invoice-auto-refund.test.ts` (US1 AS5)
- `tests/integration/payments/f4-markpaid-integration.test.ts` (FR-004; T166 async outbox shape)
- `tests/integration/payments/environment-mismatch.test.ts` (FR-010)
- `tests/integration/payments/kill-switch.test.ts` (FR-016 / SC-013)
- `tests/integration/payments/audit-retention-backfill.test.ts` (R2-E4 Review-Gate blocker)
- `tests/integration/invoicing/receipt-pdf-reconcile-cron.test.ts` (B3 stuck-pending recovery)

## Review Notes

**14 review rounds completed** (8 `/speckit.review` + 4 `/speckit.staff-review` + 2 ad-hoc focused passes; T118 ≥6+≥2 gate over-satisfied):

- Latest staff-review: [`reviews/full-re-audit-20260428-190738.md`](../specs/009-online-payment/reviews/full-re-audit-20260428-190738.md) — full code-side walk × 120 checklist items (PCI 30 + Security 30 + UX 30 + Finance 30) → **117/120 PASS, 0 FAIL, 3 STALE-wording fixed inline**.
- [`review-20260428-154035.md`](../specs/009-online-payment/reviews/review-20260428-154035.md) — 5-pass staff review (Correctness / Security / Performance / Spec Compliance / Test Quality) → APPROVED.
- [`review-20260428-152437.md`](../specs/009-online-payment/reviews/review-20260428-152437.md) — round #3 closure verification → APPROVED.

**Solo-maintainer 5-stack substitute** (Constitution Principle IX) evidence on file at [`saq-a-attestation.md § 5`](../specs/009-online-payment/saq-a-attestation.md):

1. ✅ `/speckit.review` (8 rounds)
2. ✅ `/speckit.staff-review` (4 rounds)
3. ✅ `pci-saqa-guardian` agent (T032 logger redact list — 2 critical + 1 R3 closed)
4. ✅ `security-threat-modeler` agent (16 STRIDE threats covered)
5. ✅ post-remediation `/speckit.verify` ([`qa-2026-04-28.md`](../specs/009-online-payment/qa/qa-2026-04-28.md))

## SAQ-A Attestation

Per Constitution Principle IV (NON-NEGOTIABLE):

- Card data **never** touches the Chamber-OS server — Stripe Elements iframe + Stripe-hosted PromptPay QR are the sole CDE.
- `payments` schema has **no card-number column**; only processor-issued tokens + `last4` + `brand` + `expiry_month` + `expiry_year` persisted.
- Logger redact list covers 24 paths + PAN regex defense-in-depth across Visa/MC/Amex/Discover/UnionPay/JCB/Diners.
- `git ls-files | xargs grep -lE "sk_(live|test)_…|whsec_…|rk_…"` → **0 matches** (T156 gitleaks substitute, 2026-04-28).
- See [`saq-a-attestation.md`](../specs/009-online-payment/saq-a-attestation.md) for the full SAQ-A v4.0 questionnaire + § 4 pre-ship verification (6/7 items signed).

## Checklist

- [x] All code-verifiable tasks completed (177/183 — 6 open are human-gated or deferred polish)
- [x] Code review passed (14 rounds total)
- [x] QA testing passed (`qa-2026-04-28.md`: TC-001…TC-006 PASS; TC-007 e2e deferred to T146)
- [x] CI gates green (typecheck + lint + i18n + layout + unit + contract + integration)
- [x] Changelog: see commit history `git log main..HEAD --oneline` (111 commits)
- [x] Documentation: 4 checklists (PCI/Security/UX/Finance) re-audited 2026-04-29 (30/30 each); `saq-a-attestation.md` § 4 6/7 signed
- [ ] **T146 Manual SR pass** (NVDA + VoiceOver) — template at [`sr-qa-2026-04-28.md`](../specs/009-online-payment/sr-qa-2026-04-28.md); cannot be substituted by automated agent (axe-core can't traverse Stripe Elements iframe)
- [ ] **T155 SAQ-A § 5 maintainer counter-signature** — `Stripe AOC reviewed (date)` field needs maintainer fill from https://stripe.com/docs/security
- [ ] **T161 Vercel Rolling Releases** plan: 10 % → 50 % → 100 % with 30-min observation windows (deploy-time only)

## Known limitations

- F5.1 forward-compat seam: `tenant_payment_settings.allow_anonymous_paylink` column exists (default `false`) for post-MVP signed pay-link infrastructure. Toggling has no effect in F5 MVP.
- F5 single-tenant SweCham; F11 SaaS Connect onboarding deferred (data model is MTA-ready — schema swap-only).
- Multi-currency invoices (SEK/EUR/USD) out of scope for F5 (THB-only per F4 assumption).
- Dispute / chargeback in-app UI deferred post-MVP (`charge.dispute.created` audit + alert only).
- 3 deferred polish tasks (T130a F5.1 stale-pending-refund recovery; T165 AST-based test refactor; T167 optimistic-overlay deletion gated on 7-day prod metric).

## Files

| Group | Files |
|---|---|
| F5 module | `src/modules/payments/**` (Domain + Application + Infrastructure) |
| Webhook | `src/app/api/webhooks/stripe/route.ts` (650 LOC, Node runtime) |
| Pay UX | `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/**` (10 components) |
| Refund UX | `src/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog/**` |
| Migrations | `drizzle/migrations/0033 → 0062` (30 files) |
| Tests | `tests/{unit,contract,integration,e2e,perf}/payments/**` |
| i18n | `src/i18n/messages/{en,th,sv}.json` + `payment-decline-reasons.json` × 3 |
| F4 barrel ext | `src/modules/invoicing/index.ts` (markPaidFromProcessor + issueCreditNoteFromRefund + getInvoiceForPayment) |

---

🤖 Generated with [Claude Code](https://claude.com/claude-code) following `/speckit.ship` from spec-driven development artefacts.
