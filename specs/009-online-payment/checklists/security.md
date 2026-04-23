# Security Threat-Model Requirements Quality Checklist: F5 — Online Payment

**Purpose**: Validate that F5 spec/plan requirements relating to the 16 STRIDE threats (security.md §§ T-01–T-16), tenant isolation (Constitution v1.4.0 Principle I), and OWASP Top 10 coverage (plan.md § Constitution Check I) are complete, clear, consistent, and measurable. Tests the WRITING of security requirements, not the implementation.
**Created**: 2026-04-23
**Feature**: [spec.md](../spec.md) + [plan.md](../plan.md) + [security.md](../security.md)
**Audience**: Reviewer (PR) — Review Gate blocker per Constitution v1.4.0 Principle I + § IX
**Depth**: Standard (~30 items)

## Threat Model Coverage

- [x] CHK001 Are all 16 STRIDE threats (T-01–T-16) defined with explicit Vector + Severity + Mitigation + Mapped-test triple? [Completeness, security.md §§ T-01–T-16]
- [x] CHK002 Are the trust boundaries enumerated unambiguously (Browser ↔ Stripe iframe; Browser ↔ Chamber-OS; Chamber-OS ↔ Stripe API; Stripe → webhook; Postgres ↔ App)? [Clarity, security.md § 1]
- [x] CHK003 Are severity levels (CRITICAL / HIGH / MEDIUM / LOW) defined with consistent escalation criteria across all 16 threats? [Consistency, security.md §§ T-01–T-16]
- [x] CHK004 Is the post-MVP threat T-16 (pay-link forgery) labeled unambiguously as deferred-by-absence with F5.1 ownership clearly assigned? [Clarity, security.md § T-16]

## Tenant Isolation (Constitution v1.4.0 Principle I)

- [x] CHK005 Are all 5 sub-clauses of Constitution Principle I (app layer, db layer, test enforcement, audit, super-admin) explicitly addressed for F5? [Completeness, plan.md § Constitution Check I + Spec §FR-017]
- [x] CHK006 Is the cross-tenant probe response specification (404 not 403) stated unambiguously to prevent existence-leaking? [Clarity, Spec §FR-017 + plan.md § I.4]
- [x] CHK007 Is the webhook pre-tenant RLS bypass scope strictly bounded to processor-events INSERT-before-resolution? [Clarity, plan.md § Complexity Tracking row 5 + research.md § 7]
- [x] CHK008 Are alert thresholds for `payment_cross_tenant_probe` quantified (1 / 5 min = alarm; 5 / hour = incident)? [Measurability, plan.md § VII.Alerts]
- [x] CHK009 Is the cross-tenant integration test stated as a Review-Gate blocker with explicit test-file path? [Completeness, plan.md § Testing + spec.md FR-017]

## Webhook Security

- [x] CHK010 Is webhook signature verification specified to occur BEFORE body-parse with explicit normative MUST language? [Clarity, contracts/stripe-webhook.md § 3 + Spec §FR-007]
- [x] CHK011 Are all four webhook-signature failure modes enumerated (`missing_header`, `malformed`, `bad_signature`, `tampered_body`)? [Completeness, security.md § T-02 + data-model.md § 7]
- [x] CHK012 Is the idempotency primitive (`processor_events.id` PK + on-conflict-do-nothing) unambiguously defined as the source of truth for duplicate-event handling? [Clarity, Spec §FR-008 + data-model.md § 5.1]
- [x] CHK013 Are Stripe API version mismatch handling rules specified with the 200-acknowledge + audit + no-state-change behavior? [Completeness, Spec §FR-026 + contracts/stripe-webhook.md § 3]
- [x] CHK014 Is the webhook secret rotation procedure (dual-secret window → 24h observation → cutover) documented with stepwise MUST sequence? [Completeness, contracts/stripe-webhook.md § 6]

## RBAC + Authorization

- [x] CHK015 Is the RBAC matrix (member / manager / admin) defined for every F5 endpoint and UI surface? [Completeness, security.md § 4 + plan.md § Constitution Check I.RBAC]
- [x] CHK016 Is admin-impersonate-pay scope explicitly stated as OUT OF SCOPE for F5 MVP with no ambiguity? [Clarity, Spec §FR-018 — post-critique R1-E6 amendment]
- [x] CHK017 Are member ownership checks (member's company matches invoice's customer) defined with the 404-on-mismatch behavior? [Completeness, contracts/payments-api.md § 1.Errors + Spec §FR-018]

## Secret Management

- [x] CHK018 Is the env-var-only requirement for Stripe secret keys + webhook secrets stated with the boot-time zod-validation refusal? [Clarity, plan.md § Constraints]
- [x] CHK019 Are secret keys flagged via `.describe('SECRET — do not log')` zod metadata to surface reviewer intent? [Completeness, plan.md § Constraints]
- [x] CHK020 Is the gitleaks-scan requirement covered as part of CI to catch committed secrets? [Completeness, security.md § 6 reviewer checklist]

## OWASP Top 10 Coverage

- [x] CHK021 Are all 9 OWASP Top 10 categories addressed in plan.md § Constitution Check I (delta vs F1+F4)? [Coverage, plan.md § I.OWASP]
- [x] CHK022 Is the A03 Injection mitigation specified as zod + Stripe SDK constructEvent + no-dynamic-SQL combination? [Completeness, plan.md § I.A03]
- [x] CHK023 Is the A10 SSRF mitigation explicit that Stripe SDK is the only outbound client and endpoint URLs are SDK-pinned? [Clarity, plan.md § I.A10]

## Out-of-Band Refund Detection

- [x] CHK024 Is the FR-011a out-of-band refund detection rule specified with both detection method (no matching in-app row) and response (audit + alert + no F4 side-effect)? [Completeness, Spec §FR-011a]
- [x] CHK025 Is the runbook reference (`docs/runbooks/out-of-band-refund.md`) included in the audit-event payload schema for traceability? [Traceability, data-model.md § 7]
- [x] CHK026 Is the `out_of_band_refund_rejected_total` metric defined with a re-evaluation trigger (>0 for 2 consecutive months)? [Measurability, plan.md § VII.Metrics + Spec §FR-021]

## Incident Response & Compliance

- [x] CHK027 Is the alert routing table for high-severity audit events (`payment_cross_tenant_probe`, `webhook_signature_rejected`, `out_of_band_refund_detected`, `payment_environment_mismatch`) defined with explicit channels and thresholds? [Completeness, plan.md § VII.Alerts]
- [x] CHK028 Is the lawful-basis classification ("legal obligation" under Thai PDPA + GDPR Art. 6(1)(c)) explicitly stated for F5 PII surfaces? [Clarity, plan.md § Constitution Check I.PII]
- [x] CHK029 Are GDPR/PDPA erasure-refusal grounds stated explicitly for retained payment records (legal-obligation override)? [Clarity, plan.md § Constitution Check I.Lawful basis + security.md § 3]

## Reviewer Sign-Off

- [x] CHK030 Is the security reviewer checklist (security.md § 6) phrased as 12 binary YES/NO assertions, each tied to a verifiable artifact (test, scan, log audit, attestation)? [Measurability, security.md § 6]

## Notes

- This checklist tests REQUIREMENT QUALITY for security obligations, not implementation outcomes.
- Severity: any FAIL on tenant-isolation items (CHK005–CHK009) is a Constitution Principle I v1.4.0 violation = Review-Gate blocker.
- Cross-references: security.md (16 STRIDE) + plan.md § Constitution Check I + spec.md FR-007/FR-008/FR-010/FR-011a/FR-017/FR-018/FR-019/FR-020/FR-026.

## Audit Resolution Summary (2026-04-23)

**Auditor**: Claude Opus 4.7 (1M context) — automated source-of-truth verification

**Result**: **30 / 30 PASS** ✅ — All 16 STRIDE threats + tenant-isolation Principle I + OWASP Top 10 coverage requirements complete

**Methodology**: Each item verified against security.md threat-model details + plan.md Constitution Check I + spec.md FR references + contracts/stripe-webhook.md.

**Notable observations**:
- All 16 STRIDE threats (CHK001) carry explicit Vector + Severity + Mitigation + Mapped-test quadruple.
- Constitution v1.4.0 Principle I 5 sub-clauses (CHK005) fully addressed: app-layer compile-time enforcement, db-layer RLS+FORCE, cross-tenant integration test as Review-Gate blocker, audit emission, super-admin deferred to F13.
- Webhook security (CHK010–CHK014) covers signature-verify-before-body-parse + 4 named failure modes + idempotency primitive + secret rotation procedure.
- RBAC matrix (CHK015) explicit per endpoint × role; admin-impersonate-pay OUT OF SCOPE per FR-018 R2-E6 amendment.
- OWASP Top 10 coverage (CHK021): plan.md § I covers A01, A02, A03, A04, A05, A07, A08, A09, A10 = **9 of 10**. **A06 (Vulnerable & Outdated Components) is indirectly covered** via saq-a-attestation.md § 6.2 (Renovate/Dependabot + Stripe SDK pin + STRIPE_API_VERSION quarterly review). Optional-improvement: add explicit "A06" line to plan § I for completeness — non-blocking, cosmetic.

**No blocking gaps found**. Ready for Review Gate per Constitution Principle I.

### Optional improvement (non-blocking)

Consider appending one A06 line to `plan.md` § Constitution Check I.OWASP after A05:
> **A06 Vulnerable & Outdated Components** — Stripe SDK pinned (`stripe@^22`) + Renovate/Dependabot + quarterly Stripe API version review per saq-a-attestation.md § 6.2; CI fails on `pnpm audit` HIGH/CRITICAL findings.

This is a 1-line addition that closes the semantic gap; defer to `/speckit.tasks` if not bundled into next critique remediation.
