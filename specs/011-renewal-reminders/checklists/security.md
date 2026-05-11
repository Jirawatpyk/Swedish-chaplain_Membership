# Security Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that security + privacy + multi-tenant-isolation + audit-trail requirements are complete, clear, consistent, and aligned with Constitution v1.4.0 Principle I (NON-NEGOTIABLE) — covering RBAC, tenant isolation, token security, lapsed-portal scope, audit completeness, PII handling, defence-in-depth boundaries.

**Created**: 2026-05-03
**Phase 10 polish sweep**: 2026-05-10 (T277c — closed 38/40 items based on shipped spec + code; 2 items genuinely deferred to F11 with rationale)
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## Requirement Completeness

- [X] CHK001 - RBAC matrix for ALL F8 mutating endpoints — **DONE** evidence: spec FR-052a + Phase 9 T228 (`enforce-rbac-on-f8-mutation.ts` route helper) + `rbac-defence-in-depth.test.ts` integration test (DB-layer audit persistence verified).
- [X] CHK002 - Tenant-isolation at BOTH application AND database layers — **DONE** evidence: spec C-1 + FR-047 + Phase 2 T052 (50-probe `tenant-isolation.test.ts` covering 9 F8 tables × 6 probe patterns) + Constitution Principle I clause 2 verified GREEN.
- [X] CHK003 - F8 audit event taxonomy fully enumerated (56+ events) — **DONE** evidence: spec FR-048 + `audit-port.md` + Phase 9 T258 contract test (64-event catalogue invariants + isF8AuditEventType predicate + canonical typed-shape acceptance).
- [X] CHK004 - Lapsed-portal allowed/blocked routes enumerated — **DONE** evidence: spec FR-005 (4 allowed + ≥6 blocked) + `src/lib/lapsed-portal-scope.ts` + `lapsed-portal-scope.test.ts`.
- [X] CHK005 - Cross-cutting `enforce-lapsed-portal-scope` middleware — **DONE** evidence: spec FR-005a + `lapsed-portal-scope.ts` covers all portal API surfaces.
- [X] CHK006 - `RENEWAL_LINK_TOKEN_SECRET` dual-key rotation (PRIMARY + FALLBACK + 30d) — **DONE** evidence: research.md R16 + `verify-renewal-link-token.ts` dual-key try-PRIMARY-then-FALLBACK + `docs/runbooks/secret-rotation.md` § B 4-step rolling-window procedure.
- [X] CHK007 - Renewal-link token verification flow (9 steps) enumerated — **DONE** evidence: research.md R1 + spec FR-027 + `verify-renewal-link-token.ts` + `renewal-link-token.test.ts` (6 failure modes covered).
- [X] CHK008 - Forbidden pino-log fields enumerated for F8 secrets — **DONE pre-Phase-9** (T234 — `src/lib/logger.ts:REDACT_PATHS` for `renewal_token`, `renewal_link`, `RENEWAL_LINK_TOKEN_SECRET*`, `payment_method`, `card.*`, `primary_contact_email`).
- [X] CHK009 - Kill-switch behaviours for granular + full — **DONE** evidence: spec FR-052 + FR-052b + `FEATURE_F8_RENEWALS` + granular flags + `kill-switch-granular.test.ts` integration test.
- [X] CHK010 - `blocked_from_auto_reactivation` admin-only authority — **DONE** evidence: spec FR-005b + FR-052a + `block-auto-reactivation.ts` use-case + RBAC route guard.

## Requirement Clarity

- [X] CHK011 - Token format unambiguous — **DONE** evidence: research.md R1 (`v1.<base64url(payload)>.<base64url(mac)>` with explicit field encoding spec).
- [X] CHK012 - Token-failure responses identical-page; only audit reasons differ — **DONE** evidence: spec FR-027 + `verify-renewal-link-token.ts` (single `renewal_token_invalid` 404 page + 6 distinct audit reasons).
- [X] CHK013 - Cross-tenant defence-in-depth (`payload.tid === resolveTenantFromRequest()`) for both eras — **DONE** evidence: spec FR-026 + research.md R1 (MVP single-tenant + post-F10 multi-tenant transitions documented).
- [X] CHK014 - Forbidden-in-payloads for audit events enumerated — **DONE** evidence: spec FR-049 + audit-port.md § 4 (token-hash NOT raw; email-hash NOT plaintext via FNV-1a per F7 precedent).
- [X] CHK015 - Token TTL (30d) + replay-detection (consumed_link_tokens) distinguishable — **DONE** evidence: spec FR-026 + `consumed_link_tokens` table + `renewal_token_invalid` audit reason `replay`.
- [X] CHK016 - `f8_role_violation_blocked` audit payload schema — **DONE** evidence: audit-port.md § 2 + Phase 9 audit-port contract test.

## Requirement Consistency

- [X] CHK017 - PII redact list consistent across logger + audit emitter + email templates + portal UI — **DONE** evidence: cross-checked `src/lib/logger.ts:REDACT_PATHS` vs `audit-port.md` § 4 vs email template TSX vs portal pages — token raw + email plaintext nowhere persisted.
- [X] CHK018 - Cron Bearer auth consistent across all 6 cron jobs — **DONE** evidence: spec contracts/cron-renewals-api.md + `src/lib/cron-auth.ts` + 6 coordinator routes call `enforceCronBearer` + `cron-bearer-auth-rejected.test.ts` 3 cases.
- [X] CHK019 - RLS+FORCE consistent across all 8 F8 tables — **DONE** evidence: spec C-1 + data-model.md § 5 + `pnpm check:multi-tenant` 24/24 SCOPED PASS (covers 9 F8 tables: 8 F8-owned + 1 F2 cross-module `scheduled_plan_changes`).
- [X] CHK020 - Manager-role outreach exception consistent — **DONE** evidence: spec FR-033 + FR-052a + `record-at-risk-outreach.ts` allowed-roles list + UI affordance + audit emit.
- [X] CHK021 - Token secret naming consistent across env + research + spec + quickstart — **DONE** evidence: cross-checked: `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` + `_FALLBACK` consistently named in `src/lib/env.ts`, research.md R16, spec FR-026, quickstart.md § 1, secret-rotation.md.
- [X] CHK022 - 'admin-only' mutation labels consistent FR-052a vs admin-renewals-api.md — **DONE** evidence: cross-checked: every mutating endpoint in `contracts/admin-renewals-api.md` has matching FR-052a admin-only annotation; manager-readonly E2E spec T271 pins HTTP-contract.

## Acceptance Criteria Quality

- [X] CHK023 - Cross-tenant integration test (Review-Gate blocker) verifiable — **DONE** evidence: `tenant-isolation.test.ts` 50/50 probes GREEN; spec SC-006 + C-1 measurable.
- [X] CHK024 - Token-verification security tests for all 6 failure reasons — **DONE** evidence: `renewal-link-token.test.ts` covers malformed/mac_mismatch/expired/replay/cross_tenant/member_not_found_in_tenant.
- [X] CHK025 - RBAC defence-in-depth (UI-hide + use-case 403 + audit emit) verifiable — **DONE Phase 10 T271** evidence: manager-readonly.spec.ts E2E (UI absent) + Phase 9 `rbac-defence-in-depth.test.ts` (use-case 403 + DB audit) + `f8_role_violation_blocked` audit type.

## Coverage — Threat Surfaces

- [X] CHK026 - Renewal-link token compromise scenarios — **DONE** evidence: spec FR-026 + research.md R1 (HMAC-secret leak → dual-key rotation; replay → consumed_link_tokens; cross-tenant → tid check).
- [X] CHK027 - Admin-action abuse scenarios — **DONE** evidence: spec FR-052a + Phase 9 RBAC enforcer + audit `f8_role_violation_blocked` + manager-readonly E2E.
- [X] CHK028 - Lapsed-member abuse scenarios — **DONE** evidence: spec FR-005 + FR-005a + `lapsed-portal-scope.ts` middleware + `lapsed_member_action_blocked` audit + `lapsed-portal-scope.test.ts`.
- [X] CHK029 - Cron-secret leak — **DONE pre-Phase-10** (gap-resolved per research.md R17 + audit `cron_bearer_auth_rejected`).
- [X] CHK030 - Out-of-band attack vectors — **DONE pre-Phase-10** (declared OOS-16; explicit out-of-scope in spec).
- [X] CHK031 - Insider-threat scenarios (admin queries member data) — **DONE** evidence: spec FR-048 + C-1 (every admin read emits `*_view` audit; RLS still applies — admin only sees own-tenant rows).

## Edge Case Coverage

- [X] CHK032 - Zero-tenant cron pass — **DONE pre-Phase-10** (gap-resolved).
- [X] CHK033 - Token re-issuance semantics — **DONE pre-Phase-10** (gap-resolved per research.md R1).
- [X] CHK034 - Member-deletion (GDPR erasure) interaction with active F8 cycles + audit — **DONE Phase 9** evidence: spec FR-053 + `cancel-in-flight-cycles-for-member.ts` use-case + `f3-archival-cascade.test.ts` integration test (cancel + idempotent replay + cross-tenant); audit log retention (5y default; F8 events stay 5y per `audit_log.retention_years` default).
- [X] CHK035 - MVP-era cross-tenant probe meaningful — **DONE** evidence: spec FR-026 round-2 M4 + research.md R1 (defence-in-depth tid check catches "attacker signs token for tenant X but our deployment serves tenant Y" even in single-tenant era — abstraction-future-proofs to F10).

## Compliance & Privacy

- [X] CHK036 - PDPA Section 24 lawful-basis for renewal communications — **DONE** evidence: spec A5 + research.md R12 (transactional NOT marketing — does not require Section 24 marketing consent; covered by Section 28 cross-border + Section 30 data subject rights).
- [X] CHK037 - GDPR Art. 6(1)(b) + Art. 13 alignment — **DONE** evidence: spec A5 + DPIA template § F8 (Phase 9 T256) — lawful basis legitimate-interest documented; member opt-out terminates score-feed; not-an-automated-decision per Art. 22.
- [X] CHK038 - Audit retention (5y) consistent with PDPA + GDPR — **DONE** evidence: spec FR-048 + F5 introduced `audit_log.retention_years SMALLINT NOT NULL DEFAULT 5` (migration 0039); F8 events use 5y default per processing-records.md.

## Ambiguities

- [ ] CHK039 - F5 admin-triggered refund pre-condition verifiable — **DEFERRED to F8 + F5 integration soak window** rationale: F5 `issueRefund` admin use-case is shipped (PR #16); F8 references it in `admin-reject-reactivation.ts` via `f5RefundBridge`. Cross-feature wiring verified at use-case level but no end-to-end integration test pins the F8→F5 refund bridge contract. P11 follow-up: add `tests/integration/renewals/f8-f5-refund-bridge.test.ts` once F5 integration test infra is reusable.
- [ ] CHK040 - `payment_method` enum on `F4InvoicePaidEvent` consistent with F4 taxonomy — **DEFERRED** rationale: F4 + F8 both use `'stripe_card' | 'promptpay' | 'manual_offline'` enum literal in current code; no drift detected by typecheck. Future F5+F8 enum extension (e.g. `'stripe_link'`) needs cross-module update; not a current bug. P11 follow-up: add a Drizzle pgEnum value parity test.

## Notes

- Items marked `[Gap]` indicate missing requirement coverage — should be added before /speckit.tasks
- Cross-tenant integration test is a NON-NEGOTIABLE Review-Gate blocker per Constitution Principle I — verified GREEN at T052 (50/50 probes)
- F8 is ⚠ PII-sensitive ≥2-reviewers (or solo-maintainer 5-stack substitute per Complexity #1)
- Pair with /speckit.review + /speckit.staff-review (security agent) for triangulation

**Phase 10 Sweep close-status (T277c)**: 38/40 items closed (CHK029/030/032/033 were pre-Phase-10; remaining 34 closed in this sweep). 2 items deferred to F11 with explicit rationale (CHK039 F5 refund bridge integration test; CHK040 payment_method enum parity test). Neither blocks `/speckit.ship` — F8 ships dark + F8/F5 wiring already works at use-case level.
