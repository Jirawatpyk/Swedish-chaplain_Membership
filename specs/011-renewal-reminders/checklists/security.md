# Security Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that security + privacy + multi-tenant-isolation + audit-trail requirements are complete, clear, consistent, and aligned with Constitution v1.4.0 Principle I (NON-NEGOTIABLE) — covering RBAC, tenant isolation, token security, lapsed-portal scope, audit completeness, PII handling, defence-in-depth boundaries.

**Created**: 2026-05-03
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## Requirement Completeness

- [ ] CHK001 - Are RBAC matrix requirements defined for ALL F8 mutating endpoints (admin / manager / member)? [Completeness, Spec §FR-052a]
- [ ] CHK002 - Are tenant-isolation requirements specified at BOTH application AND database layers (defence-in-depth per Constitution Principle I)? [Completeness, Spec §C-1, §FR-047]
- [ ] CHK003 - Is the F8 audit event taxonomy fully enumerated (56 events) without gaps? [Completeness, Spec §FR-048, §audit-port.md]
- [ ] CHK004 - Are lapsed-portal allowed-routes (4 routes) AND blocked-routes (≥6 routes) explicitly enumerated? [Completeness, Spec §FR-005]
- [ ] CHK005 - Is the cross-cutting `enforce-lapsed-portal-scope` middleware requirement defined to cover F3/F6/F7 portal APIs (not only F8)? [Completeness, Spec §FR-005a]
- [ ] CHK006 - Are `RENEWAL_LINK_TOKEN_SECRET` dual-key rotation requirements (PRIMARY + FALLBACK + 30d window) specified? [Completeness, Spec §research.md R16]
- [ ] CHK007 - Is the renewal-link token verification flow (9 steps including subdomain cross-check + member-in-tenant check) fully enumerated? [Completeness, Spec §research.md R1, §FR-027]
- [ ] CHK008 - Are forbidden-fields rules in pino logs fully enumerated for F8 secrets (token + email + payment + secrets)? [Completeness, Spec §FR-049]
- [ ] CHK009 - Are kill-switch behaviours defined for both granular (`FEATURE_F8_AT_RISK_DISABLED`) and full (`FEATURE_F8_RENEWALS`)? [Completeness, Spec §FR-052, §FR-052b]
- [ ] CHK010 - Are `blocked_from_auto_reactivation` toggle authority requirements explicit (admin-only)? [Completeness, Spec §FR-005b, §FR-052a]

## Requirement Clarity

- [ ] CHK011 - Is the renewal-link token format (v1.<base64url(payload)>.<base64url(mac)>) unambiguous about field encoding? [Clarity, Spec §FR-026, §research.md R1]
- [ ] CHK012 - Are token-failure response rules unambiguous (all failure modes return identical generic page; only audit reasons differ)? [Clarity, Spec §FR-027]
- [ ] CHK013 - Is the cross-tenant defence-in-depth rule (`payload.tid === resolveTenantFromRequest()`) clearly documented for both MVP single-tenant and post-F10 multi-tenant eras? [Clarity, Spec §FR-026, §research.md R1]
- [ ] CHK014 - Are forbidden-in-payloads rules for audit events enumerated with no ambiguity (token raw vs hash, email plaintext vs hash)? [Clarity, Spec §FR-049, §audit-port.md § 4]
- [ ] CHK015 - Are token TTL (30 days) + replay-detection (consumed_link_tokens table) requirements distinguishable? [Clarity, Spec §FR-026]
- [ ] CHK016 - Is the `f8_role_violation_blocked` audit event payload schema unambiguous (route + action + role)? [Clarity, Spec §audit-port.md § 2]

## Requirement Consistency

- [ ] CHK017 - Are PII redact list requirements consistent across logger + audit emitter + email templates + portal UI? [Consistency, Spec §FR-049, §audit-port.md § 4]
- [ ] CHK018 - Are auth requirements for cron endpoints (Bearer `CRON_SECRET`) consistent across all 6 cron jobs? [Consistency, Spec §contracts/cron-renewals-api.md]
- [ ] CHK019 - Are RLS+FORCE policy requirements consistent across all 8 F8 tables? [Consistency, Spec §C-1, §data-model.md § 5]
- [ ] CHK020 - Is the manager-role outreach exception (FR-033 + FR-052a) consistent (allowed at use-case + UI + audit)? [Consistency, Spec §FR-033, §FR-052a]
- [ ] CHK021 - Are token secret naming conventions consistent across env vars + research.md + spec.md (`RENEWAL_LINK_TOKEN_SECRET_PRIMARY` vs `_FALLBACK`)? [Consistency, Spec §FR-026, §research.md R16, §quickstart.md § 1]
- [ ] CHK022 - Are 'admin-only' mutation labels consistent between FR-052a + admin-renewals-api.md endpoint contracts? [Consistency, Spec §FR-052a, §contracts/admin-renewals-api.md]

## Acceptance Criteria Quality

- [ ] CHK023 - Is the cross-tenant integration test (Review-Gate blocker per Principle I) requirement objectively verifiable? [Acceptance Criteria, Spec §SC-006, §C-1]
- [ ] CHK024 - Are token-verification security tests measurable for all 6 failure reasons (malformed/mac_mismatch/expired/replay/cross_tenant/member_not_found_in_tenant)? [Acceptance Criteria, Spec §FR-027]
- [ ] CHK025 - Are RBAC defence-in-depth test requirements (UI-hide + use-case 403 + audit emit) verifiable? [Acceptance Criteria, Spec §FR-052a]

## Coverage — Threat Surfaces

- [ ] CHK026 - Are renewal-link token compromise scenarios (HMAC-secret leak, replay, cross-tenant) covered with explicit defence requirements? [Coverage, Spec §FR-026, §research.md R1]
- [ ] CHK027 - Are admin-action abuse scenarios (manager attempts admin-only mutation, member attempts admin endpoint) covered with audit + 403 requirements? [Coverage, Spec §FR-052a]
- [ ] CHK028 - Are lapsed-member abuse scenarios (lapsed member attempts privileged action) covered with FR-005a middleware + audit requirements? [Coverage, Spec §FR-005, §FR-005a]
- [X] CHK029 - Are cron-secret leak scenarios covered with rotation + Bearer-auth-rejection-audit requirements? [Coverage, Spec §research.md R17 + audit `cron_bearer_auth_rejected` — gap-resolved]
- [X] CHK030 - Are out-of-band attack vectors (email forwarding, screenshot leak) covered or explicitly out of scope? [Coverage, Spec §OOS-16 — gap-resolved (declared out-of-scope)]
- [ ] CHK031 - Are insider-threat scenarios (admin queries member data they shouldn't) covered by audit + RLS requirements? [Coverage, Spec §FR-048, §C-1]

## Edge Case Coverage

- [X] CHK032 - Are zero-tenant edge case requirements (cron iterates 0 active tenants) defined? [Edge Case, Spec §Edge Cases / Zero-tenant cron pass — gap-resolved]
- [X] CHK033 - Are token-reissuance edge case requirements (T-90 link expires before T-30 fires; T-30 link supersedes? Rotates?) clarified? [Edge Case, Spec §Edge Cases / Token re-issuance + research.md R1 §Token re-issuance semantics — gap-resolved]
- [ ] CHK034 - Are member-deletion (GDPR erasure) interaction requirements with active F8 cycles + audit log specified? [Edge Case, Spec §FR-053]
- [ ] CHK035 - Are MVP-era cross-tenant probe requirements (only one tenant exists; cross-check still meaningful?) documented? [Edge Case, Spec §FR-026 round-2 M4]

## Compliance & Privacy

- [ ] CHK036 - Are PDPA Section 24 lawful-basis requirements documented for renewal communications (transactional, not marketing)? [Compliance, Spec §A5]
- [ ] CHK037 - Are GDPR Art. 6(1)(b) + Art. 13 information-to-data-subject requirements aligned with F8 reminder content? [Compliance, Spec §A5]
- [ ] CHK038 - Are audit retention requirements (5 years) consistent with PDPA + GDPR retention obligations for F8 data? [Compliance, Spec §FR-048]

## Ambiguities

- [ ] CHK039 - Is the F5 admin-triggered refund pre-condition (does F5 actually expose `issueRefund` admin use-case?) verifiable before /speckit.tasks? [Ambiguity, Spec §FR-005d, §P5-r2]
- [ ] CHK040 - Is the `payment_method` enum on `F4InvoicePaidEvent` consistent with F4's actual payment-method taxonomy? [Ambiguity, Spec §research.md R12]

## Notes

- Items marked `[Gap]` indicate missing requirement coverage — should be added before /speckit.tasks
- Cross-tenant integration test is a NON-NEGOTIABLE Review-Gate blocker per Constitution Principle I
- F8 is ⚠ PII-sensitive ≥2-reviewers (or solo-maintainer 5-stack substitute per Complexity #1)
- Pair with /speckit.review + /speckit.staff-review (security agent) for triangulation
