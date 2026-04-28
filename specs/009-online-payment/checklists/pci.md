# PCI DSS SAQ-A Requirements Quality Checklist: F5 — Online Payment

**Purpose**: Validate that F5 spec/plan requirements relating to PCI DSS SAQ-A scope preservation (Constitution Principle IV — NON-NEGOTIABLE) are complete, clear, consistent, and measurable. This checklist tests the WRITING of the requirements, not the implementation.
**Created**: 2026-04-23
**Feature**: [spec.md](../spec.md) + [plan.md](../plan.md) + [security.md](../security.md) + [saq-a-attestation.md](../saq-a-attestation.md)
**Audience**: Reviewer (PR) — Review Gate blocker per Constitution Principle IV + § IX (security checklist sign-off)
**Depth**: Standard (~30 items)

## SAQ-A Scope Preservation

- [x] CHK001 Are the SAQ-A eligibility criteria explicitly enumerated in requirements (no electronic CHD storage / processing / transmission on merchant systems)? [Completeness, Spec §IV NON-NEGOTIABLE + saq-a-attestation.md § 1]
- [x] CHK002 Is "cardholder data environment (CDE)" defined with an explicit boundary stating Stripe is the CDE and Chamber-OS is OUT of scope? [Clarity, saq-a-attestation.md § 1]
- [x] CHK003 Are the exact processor-issued metadata fields permitted on `payments` rows enumerated (token id + last-4 + brand + expiry only)? [Completeness, Spec §FR-005 + data-model.md § 2.1]
- [x] CHK004 Is the prohibition on raw PAN, CVV, and full track data unambiguous across requirements (databases / logs / error reports / telemetry / screenshots / memory beyond form submission)? [Consistency, Spec §FR-005]

## Card Capture & Stripe Elements

- [x] CHK005 Is the requirement to delegate card capture to Stripe Elements stated in normative MUST language? [Clarity, Spec §FR-006]
- [x] CHK006 Are forbidden anti-patterns for card capture explicitly listed (self-hosted card forms, custom `<input>` for card number/CVV)? [Completeness, Spec §FR-006 + plan.md § Stripe SDK loading pattern]
- [x] CHK007 Is the ESLint rule scope for forbidding `<input name="card[_-]?(number|cvc|cvv|exp)">` defined with an explicit pattern? [Clarity, security.md § T-01]
- [x] CHK008 Are the API request body shapes for `/api/payments/initiate` and `/api/refunds/initiate` specified to exclude any card-field parameter? [Completeness, contracts/payments-api.md § 1.Request schema]

## Logging & Redaction

- [x] CHK009 Is the pino redact list for F5 fully enumerated (`card_number`, `card_cvc`, `card[*]`, `stripe_secret_key`, `stripe_webhook_secret`, `Stripe-Signature`, `Authorization`)? [Completeness, plan.md § Constraints + security.md § T-11]
- [x] CHK010 Is the PAN-regex defense-in-depth pattern specified verbatim so reviewers can verify it matches all major card networks? [Clarity, plan.md § Constraints]
- [x] CHK011 Is the requirement to log only `event_id + event_type + api_version + livemode` from webhook bodies (not the full body) stated as a normative MUST? [Clarity, plan.md § Constraints]
- [x] CHK012 Is the cross-request correlation requirement (hashed user IDs in logs) consistent between F5 spec and the inherited F1+F4 logging pattern? [Consistency, plan.md § Constraints]

## TLS, HSTS, CSP

- [x] CHK013 Is the TLS 1.2+ requirement specified for every payment-touching endpoint with no exceptions? [Completeness, Spec §FR-019]
- [x] CHK014 Is HSTS coverage stated as inherited from platform middleware with explicit verification expectation? [Clarity, plan.md § Constraints]
- [x] CHK015 Are the CSP allowlist directives for Stripe enumerated explicitly (`script-src`, `frame-src`, `connect-src`)? [Completeness, plan.md § IV.CSP additions]
- [x] CHK016 Is the global CSP allowlist tight enough to preserve SAQ-A scope (Stripe origins limited to `js.stripe.com` + `hooks.stripe.com` + `api.stripe.com` exact hosts; no route-conditional drift, no broader directives)? [Clarity, saq-a-attestation.md § 3 — Phase-9 consolidation from initial route-scoped design to global scope; SAQ-A safe because origin allowlist is tight + webhook route is server-to-server (CSP irrelevant) + no broader script-src/frame-src/connect-src directives]

## Audit Trail Coverage (PCI events)

- [x] CHK017 Are all 15 named F5 audit event types covered with explicit payload schemas (no sensitive card data, no signing secrets)? [Completeness, Spec §FR-020 + data-model.md § 7]
- [x] CHK018 Is the audit retention requirement (≥5 years for payment events; 10 years for tax-document-touching events) measurable and traceable to a regulatory citation? [Measurability, Spec §FR-022 + data-model.md § 7.1]
- [x] CHK019 Is the immutability requirement on audit entries stated unambiguously with a "MUST NOT be mutable or deletable" clause? [Clarity, Spec §FR-020]

## Environment Segregation

- [x] CHK020 Is the test-vs-live environment segregation requirement specified at every layer (env vars, webhook secret, Stripe account, event `livemode` check)? [Completeness, Spec §FR-010 + plan.md § Storage]
- [x] CHK021 Is `payment_environment_mismatch` audit event payload specified to capture both `expected_livemode` and `actual_livemode`? [Clarity, data-model.md § 7]
- [x] CHK022 Are env var requirements (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`, `STRIPE_PUBLISHABLE_KEY`, `FEATURE_F5_ONLINE_PAYMENT`) enumerated with the zod-validation requirement at boot? [Completeness, plan.md § Constraints]

## Webhook Signature Verification

- [x] CHK023 Is the requirement that signature verification MUST run BEFORE body parse stated in normative MUST language? [Clarity, contracts/stripe-webhook.md § 3 + Spec §FR-007]
- [x] CHK024 Is the webhook secret rotation procedure documented with a clear MUST sequence (dual-secret window → cutover)? [Completeness, contracts/stripe-webhook.md § 6]

## SAQ-A Attestation Process

- [x] CHK025 Is the SAQ-A re-attestation cadence specified (before each production deploy that touches F5)? [Completeness, saq-a-attestation.md § 4]
- [x] CHK026 Are the SAQ-A applicability criteria checks (§ 1) stated as binary YES/NO answers with explicit consequences if any answer is NO? [Clarity, saq-a-attestation.md § 1]
- [x] CHK027 Is the maintainer attestation block (§ 5) defined with all required fields (date, Stripe AOC review date, role)? [Completeness, saq-a-attestation.md § 5]

## Reviewer Sign-Off Requirements

- [x] CHK028 Are the 12 items on the security reviewer checklist (security.md § 6) all phrased as binary YES/NO assertions a reviewer can sign? [Measurability, security.md § 6]
- [x] CHK029 Is the requirement for ≥2 reviewers (or solo-maintainer 5-stack substitute) explicitly tied to the PCI surface and stated in plan.md Constitution Check § IX? [Completeness, plan.md § IX + Constitution § IX]
- [x] CHK030 Are the consequences of any unchecked PCI item documented (Review-Gate blocker; Constitution amendment required for SAQ-A scope changes)? [Clarity, Spec §IV NON-NEGOTIABLE + plan.md § IV]

## Notes

- This checklist tests REQUIREMENT QUALITY, not implementation. Every item asks "Are the requirements written correctly for X?" — not "Does the system do X correctly?"
- Severity: any FAIL on PCI items is a Review-Gate blocker per Constitution Principle IV (NON-NEGOTIABLE).
- Re-run before every production deploy touching F5 surfaces (cadence aligned with SAQ-A re-attestation per saq-a-attestation.md § 4).
- Cross-references: spec.md FR-005, FR-006, FR-007, FR-010, FR-019, FR-020, FR-022 + plan.md Constitution Check IV + security.md (16 STRIDE) + saq-a-attestation.md (SAQ-A v4.0).

## Audit Resolution Summary (2026-04-23)

**Auditor**: Claude Opus 4.7 (1M context) — automated source-of-truth verification against spec.md / plan.md / security.md / saq-a-attestation.md / data-model.md / contracts/

**Result**: **30 / 30 PASS** ✅ — Constitution Principle IV (NON-NEGOTIABLE) requirements fully covered

**Methodology**: Each item was verified by reading the cited spec/plan section and confirming the requirement is (a) present, (b) unambiguous, (c) consistent across documents, and (d) measurable where applicable.

**Notable observations**:
- All SAQ-A scope-preservation requirements (CHK001–CHK008) explicitly enumerated; SAQ-A v4.0 v4.0 questionnaire fully populated in saq-a-attestation.md.
- All logging/redaction requirements (CHK009–CHK012) include the verbatim PAN regex + 7 forbidden field names — no ambiguity for ESLint/CI enforcement.
- All TLS/HSTS/CSP requirements (CHK013–CHK016) traceable; CSP allowlist scope is route-conditional (Stripe iframes only on payment surfaces).
- All audit-trail requirements (CHK017–CHK019) cover 15 named event types with explicit payload schemas + 5/10-year retention with regulatory citations.
- Reviewer sign-off requirements (CHK028–CHK030) include the 12-item security checklist and Constitution § IX ≥2-reviewer (or solo-substitute) rule.

**No gaps found**. Ready for Review Gate per Constitution Principle IV.

## Re-audit 2026-04-29 (full code-side walk)

Re-audit at HEAD (`5708434` + working-tree edits) confirmed **30 / 30 PASS** after 1 stale-wording fix applied inline at CHK016 — checklist now matches the Phase-9 global-CSP consolidation documented in `saq-a-attestation.md § 3`. See `specs/009-online-payment/reviews/full-re-audit-20260428-190738.md` for per-item evidence trail.
