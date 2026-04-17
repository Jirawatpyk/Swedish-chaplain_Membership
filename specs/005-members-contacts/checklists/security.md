# Security Requirements Quality Checklist: F3 — Member & Contact Management + Smart Features

**Purpose**: "Unit tests" for the **quality of security requirements** in F3's spec, plan, data-model, contracts, and security.md artefacts. Evaluates whether PII handling, tenant isolation, email-change integrity, rate limits, audit-trail coverage, and operational runbook requirements are **complete, clear, consistent, measurable, and traceable** — NOT whether the implementation works.
**Created**: 2026-04-15
**Feature**: [spec.md](../spec.md)
**Depth**: Comprehensive — compliance audit (PDPA + GDPR + Constitution v1.4.0 Principle I)
**Audience**: Maintainer + `/speckit.review` + `/speckit.staff-review` agents at Merge Gate

---

## Tenant Isolation (Constitution Principle I, v1.4.0 clauses 1-5)

- [X] CHK001 Are application-layer tenant-isolation requirements (clause 1) explicit about `TenantContext` being an **explicit parameter** on every use case, not implicit middleware? [Completeness, Plan § Constitution Check I]
- [X] CHK002 Are database-layer RLS requirements (clause 2) explicit that `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` apply to **both** `members` and `contacts` tables? [Completeness, Data-model § 3]
- [X] CHK003 Is the test enforcement requirement (clause 3) explicit that the cross-tenant integration test is a **Review-Gate blocker** (merge-blocking if missing or red)? [Clarity, Plan § Constitution Check I]
- [X] CHK004 Are requirements consistent between spec (FR-021, FR-022) and plan (clauses 1-5) on returning **404** (never 403/401) for cross-tenant probes? [Consistency, Spec FR-022, Plan § Constitution Check I]
- [X] CHK005 Is `member_cross_tenant_probe` explicitly specified as **high severity** (not info) with the stated alert threshold (1 event / 5 min)? [Clarity, Plan § VII + Security.md § 1]
- [X] CHK006 Are super-admin impersonation requirements (clause 5) explicitly marked **N/A in F3** with deferral to F13? [Completeness, Plan § Constitution Check I]
- [X] CHK007 Is the `DEBUG_RLS_STATE` developer-flag requirement explicit about **dev-only scope** (production silently relies on RLS default)? [Clarity, Plan § Constitution Check I]
- [X] CHK008 Is the RLS policy `USING` clause explicitly specified (not merely referenced) for both tables? [Completeness, Data-model § 3]
- [X] CHK009 Is there a requirement that cross-cutting `tests/integration/rls-coverage.test.ts` (F2-originated) be **extended to include F3 tables**? [Traceability, Plan § Testing]
- [X] CHK010 Are cross-tenant probe logging requirements explicit about **what payload fields** are captured (attempted_member_id, actor_user_id, actor_tenant_id)? [Completeness, Data-model § 4]

## PII Handling (PDPA + GDPR)

- [X] CHK011 Are PDPA + GDPR lawful-basis requirements documented for **each new PII field** introduced in F3? [Traceability, Plan § Constitution Check I]
- [X] CHK012 Is the distinction between contractual-necessity (primary contact) and consent (secondary, DOB) fields explicit? [Clarity, Plan § Constitution Check I]
- [X] CHK013 Are `date_of_birth` requirements explicit that collection happens **only for Thai Alumni** and is **Application-layer enforced** (not a DB CHECK)? [Clarity, Research § 6]
- [X] CHK014 Is the "opt-in via `?include=date_of_birth` admin-only query param" requirement specified consistently across spec, plan, and contracts? [Consistency, Contracts § Endpoint 3]
- [X] CHK015 Is the PII logs-redaction list (`email`, `phone`, `date_of_birth`, `tax_id`) specified as **required additions** to the F1 `pino` redaction? [Completeness, Plan § Constraints]
- [X] CHK016 Are requirements explicit that `Authorization` headers and raw verification tokens are also redacted? [Coverage, Plan § Constraints]
- [X] CHK017 Is the `notes` field treatment requirement explicit about (a) NO inclusion in pg_trgm search index, (b) NO inclusion in F9 GDPR export? [Completeness, Spec FR-023a + § Security]
- [X] CHK018 Are requirements for email-hash-only audit payloads (not raw emails) specified for `member_contact_email_changed`? [Clarity, Data-model § 4]
- [X] CHK019 Is PII minimum-necessity justified for `tax_id` (Corporate + Partnership only; optional for Individual + Thai Alumni)? [Measurability, Spec FR-009a]
- [X] CHK020 Are data retention requirements explicit for member + contact records after archival (soft-delete vs anonymization)? [Gap]
- [X] CHK021 Are GDPR right-to-erasure requirements explicit or deferred (referenced to F9)? [Completeness, Spec Assumptions]
- [X] CHK022 Is at-rest AES-256 encryption requirement inherited from F1 explicitly reaffirmed for the new tables? [Traceability, Plan § Constitution Check I]

## Access Control (RBAC + Self-Service)

- [X] CHK023 Are RBAC requirements specified for **every new endpoint** in `contracts/members-api.md` (14+ endpoints)? [Coverage, Contracts]
- [X] CHK024 Is the `admin`/`manager`/`member` role matrix for `members:*` and `contacts:*` families explicit and unambiguous? [Clarity, Research § 3]
- [X] CHK025 Is the member self-service **field whitelist** requirement specified as a **compile-time tuple** (not prose)? [Clarity, Spec FR-014a]
- [X] CHK026 Is there a requirement that the zod schema for `/api/portal/profile` PATCH be **generated from** the tuple (not hand-written)? [Clarity, Spec FR-014a]
- [X] CHK027 Is there a unit-test requirement that the zod schema's key set **equals** the tuple? [Measurability, Spec FR-014a]
- [X] CHK028 Are `member_self_update_forbidden` audit requirements specific about what is captured on rejection (attempted fields, redacted payload)? [Clarity, Data-model § 4]
- [X] CHK029 Are requirements consistent between spec US5 and plan on which fields are member-self-editable? [Consistency, Spec US5 + FR-014]
- [X] CHK030 Is the "primary contact can invite colleagues" permission requirement explicit about **how primary-ness is verified** (is_primary flag check)? [Clarity, Research § 3]
- [X] CHK031 Is the manager role's **read-only** constraint explicit across directory, detail, timeline, and edit routes? [Consistency, Spec FR-001 + FR-004]
- [X] CHK032 Are forged-payload rejection requirements explicit (403 + audit + what's NOT done)? [Completeness, Spec US5 AS3]

## Email-Change Integrity (FR-012a/b/c)

- [X] CHK033 Is the **6-step atomic transaction** requirement (FR-012a items i-vi) specified with explicit rollback-on-any-sub-step-failure semantics? [Completeness, Spec FR-012a]
- [X] CHK034 Is the **5-minute verification delay** requirement specified consistently across spec (Clarifications Q2 refinement), FR-012a, and US3 AS6? [Consistency]
- [X] CHK035 Is the **dual-channel notification to OLD address** requirement specified with 48-hour token TTL, revert action, and high-severity audit? [Completeness, Spec FR-012a + § Security]
- [X] CHK036 Is the revert-token flow requirement (FR-012b) explicit about **atomic rollback** (contact + user email + new-token invalidation + `requires_password_reset` flag)? [Clarity, Spec FR-012b]
- [X] CHK037 Is the **"password reset required after revert"** requirement explicit about why (prevents attacker reuse of harvested password)? [Clarity, Spec § Security item 4]
- [X] CHK038 Is the admin-initiated email change explicitly marked **high severity** on every occurrence (FR-023 audit list)? [Consistency, Spec FR-023 + § Security item 3]
- [X] CHK039 Is the outbox retry budget requirement (≥5 attempts; 60s/5m/30m/3h/12h backoff) specified precisely? [Clarity, Spec FR-012c + § Security]
- [X] CHK040 Is the admin "Re-send verification email" recovery endpoint #15 requirement specified for **permanent-failure scenarios only**, not casual retries? [Clarity, Contracts Endpoint 15]
- [X] CHK041 Is the verification token TTL **auto-refresh** on outbox retry requirement specified (anti-expiry during Resend outage)? [Clarity, Research § 4 + Spec § Security]
- [X] CHK042 Is the revert-token endpoint #16 explicitly marked **public (unauthenticated)** with the token alone as authorization + rate-limit (5 attempts/10 min)? [Completeness, Contracts Endpoint 16]
- [X] CHK043 Are audit requirements explicit for **all three email-change sub-events** (`member_contact_email_changed`, `user_sessions_revoked`, `email_verification_sent`)? [Coverage, Data-model § 4]
- [X] CHK044 Are the OLD-email notification and revert-action audit events specified (`email_change_notification_sent_to_old_address`, `member_email_change_reverted`)? [Coverage, Data-model § 4]

## Bulk-Action Blast Radius (FR-019a/b)

- [X] CHK045 Is the **100-row per-batch cap** (FR-019a) specified with **server-side enforcement** (not UI-only)? [Clarity, Spec FR-019a]
- [X] CHK046 Is the 400-class response code specified when a forged request exceeds the cap? [Completeness, Contracts Endpoint 10]
- [X] CHK047 Is the per-actor **Upstash token-bucket rate limit** (10 ops / 10 min / `(tenant_id, actor_user_id)`) explicit in requirements? [Clarity, Spec FR-019b]
- [X] CHK048 Are `bulk_action_rate_limit_exceeded` audit requirements marked high severity with explicit payload fields? [Completeness, Data-model § 4]
- [X] CHK049 Is the **all-or-nothing transaction** requirement for bulk actions specified with no partial-state outcomes? [Clarity, Spec FR-019]
- [X] CHK050 Are bulk-action integration-test requirements specified for both cap violation and rate-limit violation? [Coverage, Plan § Testing]
- [X] CHK051 Is there a requirement that the 101-row rejection test covers both client UI block and server-side defence? [Coverage, Data-model validation rules]

## Audit Log (Principle VIII)

- [X] CHK052 Is the audit-log migration `0009` requirement explicit that `ALTER TYPE ADD VALUE` runs **outside any transaction block** (Postgres rule) AND is wrapped in idempotency-safe DO blocks? [Clarity, Plan § Migration Rollback Plan]
- [X] CHK053 Is the "rollback IMPOSSIBLE for enum additions" requirement explicit, with the forward-fix policy named? [Clarity, Plan § Migration Rollback Plan]
- [X] CHK054 Are **all 20+ new audit event types** listed in FR-023 + data-model § 4 with no drift between the two? [Consistency, Spec FR-023 + Data-model § 4]
- [X] CHK055 Are payload shapes specified for each new audit event (not prose-only)? [Completeness, Data-model § 4]
- [X] CHK056 Is the ≥5-year retention requirement explicitly inherited from F1+F2? [Traceability, Plan § Constitution Check VIII]
- [X] CHK057 Is the `audit_log` RLS policy (inherited from F2) explicitly referenced as covering F3 events? [Traceability, Data-model § 3]
- [X] CHK058 Are high-severity events distinguished from info-severity events in the audit list? [Clarity, Data-model § 4]
- [X] CHK059 Is there a requirement that the **`payload.member_id` GIN index** accelerates the timeline projection (US6)? [Completeness, Data-model § 2]
- [X] CHK060 Are requirements for the `audit_log AFTER INSERT` trigger (updates `members.last_activity_at`) specified? [Clarity, Data-model § 1.1]

## OWASP Top 10 Coverage

- [X] CHK061 Are A01 (Broken Access Control) mitigations explicitly mapped: RBAC + RLS + self-service whitelist + compile-time tuple? [Coverage, Plan § Constitution Check I]
- [X] CHK062 Is A07 (Identification & Authentication Failures) mitigation for the admin-impersonation ATO explicitly referenced in plan? [Traceability, Plan § Constitution Check I]
- [X] CHK063 Are A04 (Insecure Design) requirements explicit for the FR-012a transaction preventing "stale session takes over via email rotation"? [Clarity, Plan § Constitution Check I]
- [X] CHK064 Is A03 (Injection) coverage explicit via Drizzle parameterised queries + zod boundaries? [Traceability]
- [X] CHK065 Is A05 (Security Misconfiguration) coverage explicit for `pg_trgm` being migration-installed not enabled-by-default? [Clarity, Plan § Constitution Check I]
- [X] CHK066 Is A09 (Logging Failures) explicitly covered by naming each high-severity event (cross-tenant probe, self-update-forbidden, etc.)? [Completeness, Plan § Constitution Check I]
- [X] CHK067 Is A10 (SSRF) explicitly marked N/A with rationale? [Traceability, Plan § Constitution Check I]

## Operational Runbook & Alerting

- [X] CHK068 Are runbook requirements explicit for each high-severity audit event (cross-tenant probe, email dispatch failed, rate limit exceeded, email change reverted)? [Coverage, Security.md § 4]
- [X] CHK069 Is time-to-triage quantified per alert type (5 min / 10 min / 15 min / 30 min)? [Measurability, Security.md § 4]
- [X] CHK070 Are alert threshold requirements specific (1 probe / 5 min → alarm; 5 / hour → incident)? [Clarity, Plan § Constitution Check VII]
- [X] CHK071 Is the kill-switch requirement (`FEATURE_F3_MEMBERS=0` → 503) explicit about what it disables vs preserves? [Clarity, Plan § Migration Rollback Plan]
- [X] CHK072 Is the kill-switch test requirement (`feature-flag-kill-switch.test.ts`) listed in plan § Testing? [Completeness, Plan § Testing]

## Solo-Maintainer Review Substitute (Principle IX)

- [X] CHK073 Are solo-substitute requirements explicit: ≥6× `/speckit.review` + ≥2× `/speckit.staff-review` + maintainer co-signature on security.md checklist? [Completeness, Plan § Constitution Check IX]
- [X] CHK074 Is the merge-gate checklist in security.md § 5 the **authoritative security sign-off artifact**? [Consistency, Security.md § 5]

## Gaps & Ambiguities

- [X] CHK075 Are CAPTCHA / bot-detection requirements on the public revert-token endpoint #16 specified, or is rate-limit alone sufficient? [Gap, Contracts Endpoint 16]
- [X] CHK076 Is there a requirement for rotating the `app.current_tenant` postgres setting key on tenant compromise? [Gap]
- [X] CHK077 Are incident-response requirements explicit for a confirmed admin-compromise scenario (lock account, rotate sessions, notify affected members)? [Gap, Security.md § 4]
- [X] CHK078 Is there a requirement specifying how long `auth_tokens` (verification + revert) are retained after redemption or expiry? [Gap]

---

## Gap Resolution Log (2026-04-15 post-critique round 2)

All `[Gap]` items above are resolved via spec + security.md updates:

| Checklist Item | Resolution |
|---|---|
| CHK020 (data retention after archival) | **FR-027** — archived members retained for ≥ 5-year audit window; hard-delete deferred to F9 erasure pipeline |
| CHK021 (GDPR right-to-erasure) | **FR-028** — erasure requests routed to F9 + F13 tooling; no F3 erasure surface |
| CHK075 (CAPTCHA on revert endpoint) | **DEFER-04** — single-use token + 5-attempt rate limit / 10 min sufficient for F3; CAPTCHA revisited if real-world evidence emerges |
| CHK076 (tenant-key rotation) | **DEFER-05** + security.md § 4.6 — rotation procedure scoped to F13 Super-Admin Console |
| CHK077 (admin-compromise IR) | **security.md § 4.5** — full incident-response runbook authored |
| CHK078 (auth_tokens retention) | **FR-029** — inherit F1's 30-day purge after expiry/redemption for new token types |

## Verification Evidence (T153 — Polish Phase 2026-04-17)

All 78 items verified by cross-referencing F3 implementation artefacts. Key evidence:

| Evidence source | Items covered |
|---|---|
| `specs/005-members-contacts/plan.md` § Constitution Check I clauses 1-5 | CHK001-CHK010 (tenant isolation) |
| `specs/005-members-contacts/data-model.md` § 3 (RLS policies) | CHK002, CHK008, CHK057 |
| `specs/005-members-contacts/data-model.md` § 4 (audit event table) | CHK010, CHK018, CHK028, CHK043-CHK044, CHK048, CHK054-CHK060 |
| `specs/005-members-contacts/plan.md` § Constitution Check I (PII) | CHK011-CHK022 |
| `specs/005-members-contacts/contracts/members-api.md` | CHK023, CHK040-CHK042, CHK046 |
| `specs/005-members-contacts/spec.md` FR-014a (compile-time tuple) | CHK025-CHK027 |
| `specs/005-members-contacts/spec.md` FR-012a/b/c + § Security | CHK033-CHK044 |
| `specs/005-members-contacts/plan.md` § Migration Rollback Plan | CHK052-CHK053 |
| `specs/005-members-contacts/plan.md` § Constitution Check I (OWASP) | CHK061-CHK067 |
| `docs/observability.md` § 14.3 (alerts + runbooks) — T147 | CHK068-CHK070 |
| `tests/integration/members/tenant-isolation.test.ts` (14/14 green) | CHK003-CHK004 |
| `tests/integration/members/bulk-action-cap.test.ts` (4/4 green) | CHK045-CHK046, CHK050 |
| `tests/integration/members/bulk-action-rate-limit.test.ts` (3/3 green) | CHK047-CHK048 |
| `tests/integration/members/contact-email-change-atomic.test.ts` (4/4 green) | CHK033, CHK036 |
| `tests/integration/rls-coverage.test.ts` (8/8 green) | CHK009 |
| `tests/unit/members/application/whitelist-schema-equals-tuple.test.ts` (4/4 green) | CHK025-CHK027 |
| Gap Resolution Log above | CHK020-CHK021, CHK075-CHK078 |

**T155a (manual screen-reader pass)**: ⏳ PENDING — requires NVDA/VoiceOver human attestation.
**T156 (maintainer co-sign)**: ⏳ PENDING — requires human co-signature.

## Notes

- Check items off as the requirement is validated: `[x]`
- All 6 flagged gaps resolved via spec FRs or explicit `DEFER-*` roadmap entries
- Traceability target: ≥80% (achieved — 78/78 items now reference spec/plan/data-model/contracts/security.md)
- This checklist is a **merge gate** per Plan § Constitution Check IX — every unchecked item is a blocker
