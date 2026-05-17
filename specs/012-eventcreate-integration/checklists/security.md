# Security Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **security requirements** in spec.md, plan.md, research.md, data-model.md, and contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review` (security checklist co-sign per Constitution v1.4.0 Principle IX solo-maintainer substitute).
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: Webhook authentication, RBAC, tenant isolation, secret management, audit, PDPA/GDPR threat model.

## Webhook Authentication & Replay Protection

- [ ] CHK001 - Are HMAC-SHA256 signature requirements specified for every webhook delivery (algorithm + key length + canonical signing-input)? [Completeness, Spec §FR-002, research.md R2]
- [ ] CHK002 - Is the timing-safe-comparison requirement explicit (preventing string-equality timing oracle)? [Clarity, research.md R2]
- [ ] CHK003 - Are the requirements for `crypto.timingSafeEqual` length-pre-check + try/catch wrapper documented to prevent the unhandled-throw-on-length-mismatch class of bug? [Completeness, research.md R2 round-2 E8]
- [ ] CHK004 - Are timestamp-skew limits quantified (±5 minutes) and the rationale documented? [Clarity, Spec §FR-003, research.md R2]
- [ ] CHK005 - Are replay-protection requirements specified at two independent layers (X-Request-ID idempotency + X-Chamber-Timestamp window)? [Coverage, Spec §FR-003 + §FR-004]
- [ ] CHK006 - Is the requirement to return a **generic 401 body** on all signature/timestamp failure modes explicit (oracle prevention)? [Clarity, research.md R2]
- [ ] CHK007 - Are requirements for behaviour when `tenant_webhook_configs` row is missing OR `enabled = FALSE` differentiated (401 vs. 503 distinction)? [Edge Case, plan.md round-2 E4]

## RBAC Matrix Specification

- [ ] CHK008 - Is the RBAC matrix specified for **every F6 admin surface** with explicit admin/manager/member outcomes? [Completeness, Spec §FR-035]
- [ ] CHK009 - Is the **403 vs 404 distinction** between action-level (manager mutation attempts on `/admin/events/**`) and surface-level (`/admin/integrations/eventcreate/**`) explicitly justified by the surface-disclosure-prevention rationale? [Clarity, Spec §FR-035 + contracts/admin-integration-eventcreate-api.md round-2 E17]
- [ ] CHK010 - Are `role_violation_blocked` audit emission requirements specified for **every** blocked attempt (regardless of status code returned)? [Coverage, Spec §FR-035]
- [ ] CHK011 - Are the integration-config-page nav-visibility requirements (R1 — hidden for CSV-only tenants) documented with a clear trigger condition? [Clarity, contracts/admin-integration-eventcreate-api.md round-2 R1]
- [ ] CHK012 - Is the `member`-role-on-admin-routes outcome (404 not 403) consistently specified across spec FR-035 + all admin contracts? [Consistency, Spec §FR-035]

## Tenant Isolation (Constitution v1.4.0 Principle I — NON-NEGOTIABLE)

- [ ] CHK013 - Are tenant-isolation requirements specified at **both** application layer AND database layer (RLS+FORCE) for every F6 table? [Completeness, plan.md Storage § + data-model.md § 1.1–1.4]
- [ ] CHK014 - Are the cross-tenant integration test requirements explicitly enumerated (Review-Gate blocker per Constitution Principle I clause 3) covering **all 4 F6 tables**? [Coverage, plan.md Testing § round-3 Z4]
- [ ] CHK015 - Are URL-path-tenant vs. signature-resolved-tenant cross-check requirements specified for the webhook receiver (FR-006)? [Completeness, Spec §FR-006]
- [ ] CHK016 - Is the `cross_tenant_probe` audit event escalation severity (`critical`) specified consistently across data-model.md § 4 + contracts/audit-port.md? [Consistency]
- [ ] CHK017 - Are the requirements for `runInTenant(ctx, fn)` binding **before** advisory-lock acquisition documented as a load-bearing ordering invariant? [Clarity, research.md R5 round-2 R2 SQL execution order]

## Secret Management

- [ ] CHK018 - Is the per-tenant webhook secret generation entropy specified (32-byte cryptographic random)? [Completeness, research.md R7]
- [ ] CHK019 - Is the one-time-reveal flow requirement explicit, with no second-show fallback? [Clarity, Spec §FR-024]
- [ ] CHK020 - Are the 24-hour grace-window requirements for secret rotation specified (active + grace dual-verify, automatic grace expiry)? [Completeness, Spec §FR-008, research.md R7]
- [ ] CHK021 - Is the `webhook_secret_grace_used` audit event emission requirement specified for every webhook accepted on the grace key? [Coverage, research.md R7]
- [ ] CHK022 - Is the secret-at-rest threat model documented with explicit acceptance of the plaintext-DB-storage trade-off (mitigated by encryption + rotation)? [Completeness, research.md R2 round-2 E9]

## Audit Log Coverage

- [ ] CHK023 - Are the **43 F6 audit event types** (original spec scoped 35; extended to 43) completely enumerated with payload shapes, severity, and retention years? [Completeness, data-model.md § 4 + contracts/audit-port.md + canonical closed union at `src/modules/events/application/ports/audit-port.ts:76-171`]
- [ ] CHK024 - Are requirements for the **dual-write fallback** of `webhook_rolled_back` (DB tx + stderr `pino.fatal`) specified to prevent silent observability loss? [Coverage, research.md R6 round-1 E3]
- [ ] CHK025 - Is the `audit_log.payload jsonb` column (F2 migration 0007) explicitly named as the canonical structured-payload carrier (NOT the legacy `summary` text)? [Clarity, contracts/audit-port.md round-2 M1]
- [ ] CHK026 - Are audit-event retention requirements consistently 5 years across all 35 F6 events (no F4-style 10-year tax-doc overlap)? [Consistency, data-model.md § 4]
- [ ] CHK027 - Is the requirement that `audit_event_type` Postgres enum be extended via migration 0132 (35 × `DO BEGIN ALTER TYPE … EXCEPTION duplicate_object`) explicit, with rationale for the per-DO-block pattern? [Clarity, data-model.md § 7 round-1 E6]

## PDPA / GDPR Compliance

- [ ] CHK028 - Are lawful-basis requirements documented for processing non-member attendee PII (legitimate interest under PDPA §24(5) / GDPR Art. 6(1)(f))? [Completeness, spec.md Assumptions § Privacy + compliance posture]
- [ ] CHK029 - Are the differentiated retention requirements quantified (member-linked 5y; non-member 2y then pseudonymise)? [Clarity, Spec §FR-032]
- [ ] CHK030 - Is the pseudonymisation transform requirement specified deterministically (per-tenant SHA-256 salt; quota + aggregate stats preserved)? [Completeness, Spec §FR-032, research.md R9]
- [ ] CHK031 - Is the per-tenant salt rotation policy specified (rotate on security-incident or every 3 years)? [Coverage, research.md R9 round-1 E10]
- [ ] CHK032 - Are the erasure-tool requirements specified to satisfy PDPA §30 / GDPR Art. 17 within the 30-day statutory deadline (SC-012)? [Measurability, Spec §FR-032a + §SC-012]
- [ ] CHK033 - Is the relink-disallowed-on-pseudonymised-rows requirement specified to prevent contaminated records? [Edge Case, Spec §FR-014 round-2 R4]

## Threat Model Coverage

- [ ] CHK034 - Are requirements for ALL OWASP Top 10 classes touched by F6 explicitly addressed (A01 access control, A02 cryptographic failures, A03 injection, A05 misconfiguration, A07 auth failures)? [Coverage, plan.md Constitution Check § I]
- [ ] CHK035 - Are rate-limiting requirements quantified (10 req/min/tenant per FR-005 round-2 E13 adjustment) with measurable justification? [Clarity, Spec §FR-005]
- [ ] CHK036 - Is the Zapier supply-chain-deprecation contingency documented with a graceful-degradation strategy (n8n/Make.com swap → CSV ultimate fallback)? [Coverage, research.md R1 round-3 Q5]
- [ ] CHK037 - Is the cross-border-transfer GDPR posture documented (covered by F1 SCC instruments; no F6-specific work)? [Completeness, spec.md Assumptions § Privacy]
- [ ] CHK038 - Are security failure / breach response audit-emission requirements specified for `cross_tenant_probe`, `webhook_signature_rejected`, and `role_violation_blocked`? [Completeness, data-model.md § 4]

## Notes

- This checklist is the canonical security review gate for F6 per Constitution Principle IX solo-maintainer substitute clause (security checklist co-sign).
- All "[Gap]" items require resolution before `/speckit.implement`. "[Ambiguity]" items can fold into `/speckit.tasks` decomposition.
- Maintainer + staff-review agent both co-sign this checklist at `/speckit.review` gate.
