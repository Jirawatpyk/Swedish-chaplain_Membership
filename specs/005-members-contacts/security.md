# F3 Security & Threat Model

**Branch**: `005-members-contacts` | **Date**: 2026-04-15
**Scope**: PII surfaces introduced by F3 + admin-impersonation vectors + email-change integrity + bulk-action blast radius.
**Reviewer sign-off (solo-maintainer substitute)**: maintainer co-signature on § 5 checklist + 6× `/speckit.review` + 2× `/speckit.staff-review` passes.

> **Status**: draft authored during `/speckit.plan` per critique E14. Flesh out each § during implementation; must pass `/speckit.review` before the gate.

---

## 1. Threat model — new threats introduced by F3

| # | Threat | Vector | Mitigation | Tests |
|---|---|---|---|---|
| T-F3-01 | Cross-tenant member read | Crafted `member_id` in URL | RLS + 404 response + `member_cross_tenant_probe` audit | `tests/integration/members/tenant-isolation.test.ts` |
| T-F3-02 | Cross-tenant member write | Crafted PATCH/DELETE payload | RLS `WITH CHECK` + Application `TenantContext` guard | same |
| T-F3-03 | Admin-impersonation ATO via email change (critique X2/E6) | Compromised admin redirects member email to attacker | FR-012a dual-channel notification to OLD email (48h revert token) + 5-min verification delay + high-severity audit on every admin-initiated change | `email-change-dual-channel.test.ts` |
| T-F3-04 | Self-service field-whitelist bypass | Forged PATCH body to `/api/portal/profile` | FR-014 + FR-014a compile-time tuple + zod schema generated from tuple + 403 + `member_self_update_forbidden` audit | unit + contract + integration |
| T-F3-05 | Bulk-action blast radius (compromised admin) | Admin archives/plan-changes 100 members × N times | FR-019a 100-row cap + FR-019b Upstash token bucket (10 ops / 10 min / actor) + `bulk_action_rate_limit_exceeded` audit | `bulk-action-rate-limit.test.ts` |
| T-F3-06 | Member lockout via outbox permanent failure | FR-012a committed + email never delivers | FR-012c retry budget + `email_dispatch_failed` audit + admin "Re-send verification" action | `outbox-permanent-failure.test.ts` |
| T-F3-07 | Verification token expiry during Resend outage | 24h TTL exhausted before first successful send | Token auto-refresh on every retry attempt > 1 (outbox dispatcher) | covered by `outbox-permanent-failure.test.ts` |
| T-F3-08 | Primary-contact race condition | Two admins promote different contacts simultaneously | Partial unique index `contacts_one_primary_per_member` + user-friendly 409 `primary_contact_race` | `primary-contact-race.test.ts` |
| T-F3-09 | DOB exposure via default API response | Admin or integration client reads DOB without necessity | Excluded from default response; opt-in `?include=date_of_birth` admin-only query param; redacted from logs | unit (`PrivacyScope` policy) + integration |
| T-F3-10 | `notes` field PII leak via directory search | Admin pastes PII in notes; searchable by other admins | FR-023a: `notes` NOT in `pg_trgm` index + NOT in F9 GDPR export | unit |
| T-F3-11 | Invitation email bounce silent failure | Primary contact never receives invite; admin assumes success | Invitation marked `failed`; warning badge on row; `invitation_bounced` audit; "Re-send invite" action | `invitation-bounce.test.ts` |
| T-F3-12 | Forged bulk action with cross-tenant IDs | Admin submits member IDs from another tenant | RLS filters silently + all-or-nothing semantics return 404 if any ID missing (FR-019) | `bulk-action-rate-limit.test.ts` |

## 2. PII handling

| Field | Storage | API exposure | Logs | Export |
|---|---|---|---|---|
| `contacts.email` | AES-256 at rest (Neon) | Default response | Redacted by name | F9 GDPR export (yes) |
| `contacts.phone` | AES-256 at rest | Default response | Redacted by name | F9 GDPR export (yes) |
| `contacts.date_of_birth` | AES-256 at rest | Opt-in `?include=date_of_birth` admin-only | Redacted by name | F9 GDPR export (yes, owner-only) |
| `members.tax_id` | AES-256 at rest | Default response | Redacted by name | F9 GDPR export (yes) |
| `members.notes` | AES-256 at rest | Default response (admin only — redacted for member-self reads) | NOT redacted (opaque free text) | **Explicitly excluded from F9 export** per FR-023a |

## 3. Transactional integrity boundaries

| Operation | Scope | Rollback |
|---|---|---|
| Create member + primary contact | Single txn | Full rollback on any sub-step failure |
| Plan change | Single txn (+ audit) | Full rollback |
| Bulk action (≤100 rows) | Single txn (+ N audits) | Full rollback; all-or-nothing |
| **Contact email change (FR-012a)** | Single txn: contact update + user email update + session revocation + old-email disable + new-email verification outbox enqueue + dual-channel notification outbox enqueue (+ audit) | **Full rollback before commit; email dispatch failures AFTER commit handled by FR-012c outbox retry + permanent-failure recovery** |
| Revert email change (FR-012b) | Single txn: restore contact + user email + invalidate new-email token + flag `requires_password_reset` (+ audit) | Full rollback |
| Archive + invitation revocation cascade | Single txn | Full rollback |
| Undelete | Single txn | Full rollback |

## 4. Operational runbook

### 4.1 On `member_cross_tenant_probe` alert (1 / 5 min)

1. Query `audit_log` for events in the last 5 min.
2. Identify `actor_user_id` + `attempted_member_id`.
3. Cross-reference `attempted_member_id` in platform-wide inventory.
4. Decide: typo (low-signal) vs. repeated probe (lock account + incident review).
5. Time-to-triage target: < 5 min.

### 4.2 On `email_dispatch_failed` alert

1. Confirm the outbox row is `permanently_failed` (attempts = 5, last_error visible).
2. Inspect Resend dashboard for the time range — is there a broader outage?
3. If broader outage: wait for Resend recovery + retry manually via "Re-send verification" admin action.
4. If isolated failure: inspect target email deliverability (bounce, blocklist); fall back to contacting member via phone per contact record.
5. Time-to-triage target: < 10 min.

### 4.3 On `bulk_action_rate_limit_exceeded` alert

1. Identify `(tenant_id, actor_user_id)` pair.
2. Review recent bulk-action audit events for the actor.
3. Decide: legitimate busy admin (raise limit after clarify) vs. compromised account (disable actor + rotate password).
4. Time-to-triage target: < 15 min.

### 4.4 On `member_email_change_reverted` alert

1. Identify `actor_user_id` of the original change (compromised admin?) + member.
2. Confirm member reached out to the chamber (out-of-band verification — phone).
3. Investigate actor's other recent actions for further compromise.
4. Decide on actor account disable + incident review.
5. Time-to-triage target: < 30 min.

### 4.5 Confirmed admin-account compromise — incident response

1. **Immediate containment** (< 5 min): disable the compromised admin account via F1 `POST /api/auth/users/[userId]/disable`; revoke all sessions of that user.
2. **Blast-radius triage**: query `audit_log` for all events with `actor_user_id = <compromised>` in the last 7 days; flag any `member_contact_email_changed`, `member_plan_changed`, `member_archived`, `bulk_action_*` events.
3. **Rollback**: for each email change in the window, attempt dual-channel revert token use; if expired, manually re-issue via the F3 admin "Re-send verification email" action after forcing a password-reset on the linked user.
4. **Member notification**: contact every affected member out-of-band (phone) to confirm whether the actions were legitimate.
5. **Password rotation**: force password reset for all other admin accounts in the same tenant as a precaution.
6. **Incident review**: author an incident report within 5 business days per PDPA Section 37 + GDPR Article 33 (72-hour notification to supervisory authority if personal data breach confirmed).
7. Time-to-triage target: < 15 min for containment; < 72 hours for notification.

### 4.6 Tenant-key rotation (deferred to F13 — placeholder)

The `app.current_tenant` postgres-setting key is the authorization boundary for RLS. In F3 single-tenant deployment, this is a static env-driven value. A platform-level rotation procedure (change the setting name, re-deploy, update RLS policies atomically) is scoped to **F13 Super-Admin Console** when multi-tenant operations require it. Until then: if a tenant key is suspected compromised, the mitigation is to re-deploy the application with a new setting name and corresponding policy update.

## 5. Security checklist (merge-gate)

*Sign each item only when the implementation + tests are green.*

### Tenant isolation (Principle I)

- [ ] `members` has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + policy
- [ ] `contacts` has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + policy
- [ ] Every F3 Application use case takes `TenantContext` as an explicit parameter
- [ ] `tests/integration/members/tenant-isolation.test.ts` green 10/10 runs
- [ ] `tests/integration/rls-coverage.test.ts` extended to cover `members` + `contacts` and green
- [ ] Cross-tenant probe returns 404 + audits `member_cross_tenant_probe` at high severity

### PII (PDPA + GDPR)

- [ ] `email`, `phone`, `date_of_birth`, `tax_id` added to `pino` redaction list
- [ ] `date_of_birth` opt-in via `?include=date_of_birth` on detail endpoint only; admin-only
- [ ] Member self-service PATCH body validated via generated zod schema (FR-014a tuple)
- [ ] `notes` NOT in `pg_trgm` index (FR-023a); flag recorded for F9 export exclusion

### Email-change integrity

- [ ] FR-012a transaction covers all 6 steps atomically
- [ ] Dual-channel notification to OLD email deployed + tested
- [ ] 5-minute verification delay enforced on new email
- [ ] Revert token (48h) + flow tested
- [ ] Outbox permanent-failure recovery (admin re-send action) deployed + tested
- [ ] Token TTL auto-refresh on outbox retry tested

### Bulk-action blast radius

- [ ] FR-019a 100-row cap enforced server-side
- [ ] FR-019b Upstash token bucket deployed (10 ops / 10 min / actor)
- [ ] `bulk_action_rate_limit_exceeded` audited at high severity

### Audit log

- [ ] 0009 migration runs cleanly on staging
- [ ] All 20+ new event types emitted by the correct code paths
- [ ] Retention ≥ 5 years inherited from F1+F2

### Invitation bounces

- [ ] Resend `email.bounced` webhook consumed by outbox dispatcher
- [ ] Invitation marked `failed` + `invitation_bounced` audit
- [ ] "Re-send invite" action available in admin UI

### Feature flag

- [ ] `FEATURE_F3_MEMBERS` default-on; kill-switch verified

### Observability

- [ ] F3 runbook added to `docs/observability.md` § F3 Members
- [ ] PagerDuty-equivalent alerts wired for high-severity events

### Reviewer sign-off (solo substitute)

- [ ] ≥ 6× `/speckit.review` automated passes green
- [ ] ≥ 2× `/speckit.staff-review` rounds cleared
- [ ] Maintainer co-signature on this checklist
