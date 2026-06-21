# Observability — Project-Wide Standards

**Project**: SweCham / TSCC Membership System
**Status**: Active
**Date started**: 2026-04-09
**Triggered by**: critique 2026-04-09 items P5 + X2 (Recommendation)
**Scope**: Metrics, logs, traces, alerts, and dashboards across all features
(F1–F9)

This document is the single source of truth for "how do we know the system
is healthy in production". Every feature owns a section; F1 seeded the
document with the auth section.

---

## 1. Principles

- **Structured logs** (JSON) not text. Parseable by default.
- **Metrics are cheap; alerts are expensive.** Export many metrics;
  alert on a few carefully chosen ones.
- **RED per endpoint**: Rate, Errors, Duration for every API route.
- **USE per resource**: Utilisation, Saturation, Errors for every
  external dependency (DB, Redis, email).
- **Traces for critical flows**: at minimum, every auth flow and every
  payment flow gets distributed tracing.
- **SLO-based alerting, not symptom-based.** Alert when an SLO's error
  budget is burning fast, not when any single error occurs.
- **Every log line has a request ID** for correlation across logs, traces,
  and audit events.

---

## 2. Observability stack

| Signal | Tool | Storage | Access |
|---|---|---|---|
| **Logs** | `pino` (Node) → Vercel Logs → Vercel UI (F1) → Grafana Cloud / Datadog (F2+) | 30 days in Vercel, 1 year in long-term (F2+) | Vercel dashboard, on-call runbook |
| **Traces** | `@vercel/otel` → Vercel OpenTelemetry collector | 14 days | Vercel dashboard |
| **Metrics** | Vercel Analytics (automatic) + custom via OTel → Vercel Metrics (F1) → Grafana Cloud (F2+) | Varies | Vercel dashboard, public status page (F2+) |
| **Audit log** | Postgres `audit_log` table | ≥ 5 years | Admin audit viewer (F9), DB read-only role |
| **Errors** | pino logs + future Sentry integration | 30 days | On-call |
| **Uptime / synthetic** | Vercel Speed Insights + future external checks (Pingdom / UptimeRobot) | Varies | Public status page (F2+) |

**F1 scope**: Vercel-built-in tools only (logs, Analytics, Speed Insights,
OTel traces). Grafana / Datadog / Sentry / external synthetic checks are
deferred to F2+ — the stack is architected to slot them in without
changing application code.

---

## 3. Log schema

Every log line is a JSON object with at least:

```json
{
  "level": "info | warn | error | debug",
  "time": "2026-04-09T10:23:15.123Z",
  "requestId": "0192f0a1-...",
  "event": "sign_in_success | ...",
  "module": "auth | members | invoices | ...",
  "userId": "hashed:a1b2c3... | null",
  "sessionId": "NEVER LOGGED",
  "msg": "Human-readable one-liner"
}
```

**Required fields**: `level`, `time`, `requestId`, `event`, `module`, `msg`.

**Redaction rules** (`pino` config):
- `password*` → `[REDACTED]`
- `token*` → `[REDACTED]`
- `secret*` → `[REDACTED]`
- `authorization` → `[REDACTED]`
- `cookie` → `[REDACTED]`
- `sessionId` → never in logs (enforced by ESLint rule)
- `email` → hashed to `hashed:sha256(email)[0..8]` for correlation without
  PII exposure

---

## 4. F1 Auth — metrics catalogue

Each metric is exported as an OpenTelemetry counter, gauge, or histogram.
Names follow `<module>_<subject>_<action>` convention.

### 4.1 Sign-in

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_signin_attempts_total` | counter | `portal`, `outcome` (success / invalid-credentials / locked / pending / disabled / rate-limited) | Volume + distribution of sign-in attempts |
| `auth_signin_duration_seconds` | histogram | `portal`, `outcome` | Latency of sign-in including argon2 verify |
| `auth_lockouts_total` | counter | — | How often accounts get locked (credential stuffing signal) |
| `auth_failed_signin_count` | counter | `reason` | Count of each failure reason for anomaly detection |

### 4.2 Password reset

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_password_reset_requested_total` | counter | `email_known` (true / false, server-side only — not leaked to clients) | Volume of reset requests |
| `auth_password_reset_completed_total` | counter | — | Successful completions; ratio to requested = conversion |
| `auth_password_reset_duration_seconds` | histogram | — | From request to completion (proxies for email delivery latency if combined with Resend webhook timings) |

### 4.3 Invitation

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_invitation_sent_total` | counter | `role` | How many invitations admins send |
| `auth_invitation_redeemed_total` | counter | `role` | How many invites convert to active accounts |
| `auth_invitation_time_to_redeem_seconds` | histogram | `role` | How long users take to accept invites (UX signal) |
| `auth_invitation_expired_total` | counter | — | How many invites expire unredeemed (email delivery issue or user disengagement) |

### 4.4 Session

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_sessions_active` | gauge | `role` | Current concurrent sessions |
| `auth_session_duration_seconds` | histogram | `role`, `end_reason` (sign-out / idle / absolute / password-change / role-change / disable / admin-end) | Session lifetime distribution |
| `auth_idle_warning_shown_total` | counter | `outcome` (stayed / timed-out) | How often users engage with the idle warning |

### 4.5 Password management

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_password_changed_total` | counter | `trigger` (self / reset) | How often passwords change |
| `auth_password_weak_rejected_total` | counter | `reason` (short / pwned / same) | How often the policy blocks weak passwords |

### 4.6 RBAC enforcement

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_rbac_denied_total` | counter | `role`, `resource`, `action` | Denied operations — high values on one resource = UX issue |
| `auth_manager_denied_write_total` | counter | `endpoint` | Specifically: managers hitting endpoints they can't mutate |

### 4.7 Dependencies (USE)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `auth_db_query_duration_seconds` | histogram | `query` | Neon Postgres query latency |
| `auth_db_connection_errors_total` | counter | — | DB connection issues |
| `auth_redis_request_duration_seconds` | histogram | — | Upstash latency |
| `auth_redis_fallback_total` | counter | — | Count of fail-open-to-memory fallbacks (Upstash outage signal) |
| `auth_email_send_duration_seconds` | histogram | `template` | Resend API call latency |
| `auth_email_send_failures_total` | counter | `reason` (api-error / rate-limited / bounced / complained) | Email delivery issues |

---

## 5. SLOs (Service Level Objectives) — F1

SLOs are the budget against which alerts fire. They translate user
experience into measurable targets.

| SLO | Target | Window | Error budget | Source |
|---|---|---|---|---|
| **Sign-in availability** | ≥ 99.9% of sign-in requests return a non-5xx status | 30-day rolling | 0.1% = ~43 min/month | `auth_signin_attempts_total{outcome!="5xx"} / total` |
| **Sign-in latency (p95)** | < 400 ms (spec SC-001 target is 5 s end-to-end on mobile/4G, but the API budget is tighter per Constitution VII) | 30-day rolling | 5% of requests can exceed 400 ms | `auth_signin_duration_seconds` histogram |
| **Password reset delivery** | ≥ 99% of reset emails are accepted by Resend within 60 s (spec SC-002) | 7-day rolling | 1% of resets can fail delivery | `auth_email_send_duration_seconds{template="reset"}` + Resend webhook |
| **RBAC correctness** | Zero unauthorised accesses (spec SC-003) | Per release | 0% (hard rule) | E2E test + monitored as `auth_rbac_bypass_total` gauge which MUST be 0 |
| **Audit completeness** | 100% of auth events captured (spec SC-004) | Per release | 0% | audit-completeness test + `auth_audit_missing_total` MUST be 0 |

---

## 6. Alerts — F1 initial set

**Alert philosophy**: alert on **SLO burn rate**, not individual errors.
Page the on-call only for things that require **immediate human action**.

| Alert | Condition | Severity | Owner | Runbook |
|---|---|---|---|---|
| **Sign-in error rate exploding** | `rate(5xx) > 5%` over 5 min | 🚨 Page | Auth on-call | Check Neon, Upstash, Vercel status dashboards |
| **Sign-in latency p95 > 800 ms** | 10-min rolling window | 🚨 Page | Auth on-call | Check argon2 time, DB latency, Redis latency |
| **Lockout spike** | `rate(auth_lockouts_total) > 10/hour` | ⚠ Warn | Security | Likely credential-stuffing attempt — review IP addresses |
| **Manager write denials spike** | `rate(auth_manager_denied_write_total) > 20/day` | ⚠ Warn | Product | UX signal — managers trying to do things they can't; improve UI hiding |
| **Email failure rate > 5%** | `rate(auth_email_send_failures_total) / rate(auth_email_send_total) > 5%` over 1 hour | 🚨 Page | Ops | Resend dashboard + fallback plan |
| **Redis fallback activated** | `rate(auth_redis_fallback_total) > 0` over 1 min | ⚠ Warn | Ops | Upstash outage — verify + monitor |
| **Audit completeness failed** | `auth_audit_missing_total > 0` | 🚨 Page | Security | Audit gap — investigate immediately |
| **Invitation redemption rate dropping** | `rate(redeemed) / rate(sent) < 50%` over 30 days | 📉 Report | Product | Email deliverability or onboarding UX issue |
| **Idle warning timeout rate high** | `rate(timed-out) / rate(shown) > 80%` over 30 days | 📉 Report | Product | Consider shorter shown-ahead window or different copy |

Severity levels:
- 🚨 **Page**: wakes the on-call engineer immediately
- ⚠ **Warn**: Slack notification, reviewed within 1 business day
- 📉 **Report**: weekly summary, no immediate action

---

## 7. Dashboards

### 7.1 F1 Auth dashboard (Vercel Analytics)

A single Vercel Analytics dashboard with panels for:

1. **Sign-in funnel** — attempts → success → redirects
2. **Sign-in latency** — p50 / p95 / p99 over time
3. **Failure reason breakdown** — pie chart of `auth_signin_attempts_total` by `outcome`
4. **Active sessions** — live count
5. **Lockouts** — timeline
6. **Invitation conversion** — sent vs redeemed
7. **Email delivery** — success / failure rate
8. **Idle warning engagement** — stayed vs timed-out

This dashboard is the **on-call's first stop** when something looks wrong.

### 7.2 Future: public status page (F2+)

A public `status.swecham.se` page showing the Sign-in availability SLO,
the current error budget burn rate, and planned maintenance windows.
Deferred to F2+.

---

## 8. Incident response

### 8.1 Paging flow

1. Alert fires → on-call paged via Vercel webhook → email + SMS
2. On-call acknowledges in Slack `#incidents` channel
3. Create incident doc (template: `docs/incidents/YYYY-MM-DD-<slug>.md`)
4. Mitigate first, root-cause after
5. Post-mortem within 48 hours for 🚨 Page-level incidents

### 8.2 Escalation

| Minutes since page | Action |
|---|---|
| 0–5 | On-call acknowledges |
| 5–15 | On-call mitigates or escalates to secondary |
| 15–30 | Engineering lead paged |
| 30+ | CEO paged |

(F1 has one engineer + one manager in practice; this is aspirational for when the team grows.)

---

## 9. Owner

**F1 Auth section**: The engineer who ships F1 is the initial owner of
the auth metrics + SLOs + alerts. Reviewed quarterly by the security lead.

**Future sections**: Each feature adds its own section under § 4+ with
the same structure (metrics catalogue, SLOs, alerts, dashboard link,
owner).

---

## 10. F2 Plans — metrics catalogue

Each metric follows the `<module>_<subject>_<action>` convention established in § 4.

### 10.1 Plan CRUD

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `plans_created_total` | counter | `category` (corporate / partnership), `year` | Volume of plan creation — spike detection |
| `plans_updated_total` | counter | `category`, `year`, `locked_field_attempted` (true / false) | Edit volume; `locked_field_attempted=true` = UX signal that the lock banner was ignored client-side |
| `plans_cloned_total` | counter | `source_year`, `target_year` | Clone frequency — expect a once-per-year spike in December |
| `plans_activated_total` | counter | `year` | State transitions to active |
| `plans_deactivated_total` | counter | `year` | State transitions to inactive |
| `plans_soft_deleted_total` | counter | `year` | Soft-delete events |
| `plans_undeleted_total` | counter | `year` | Undelete events — high values suggest UX confusion |
| `plans_list_duration_seconds` | histogram | `year`, `role` | List query latency (p95 < 400 ms target per Constitution VII) |
| `plans_get_duration_seconds` | histogram | — | Single plan fetch latency |

### 10.2 Fee configuration

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `fee_config_updated_total` | counter | — | Fee-config mutations — expect rare, audit-sensitive |
| `fee_config_get_duration_seconds` | histogram | `role` | Read latency for fee-config page |

### 10.3 Command palette

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `palette_search_requests_total` | counter | `role` | Volume of search API calls |
| `palette_search_duration_seconds` | histogram | — | `/api/plans/search` response latency (budget: < 100 ms p95) |
| `palette_open_cold_ms` | histogram | — | Client-side cold-open measurement (budget: < 300 ms) |
| `palette_open_warm_ms` | histogram | — | Client-side warm-open measurement (budget: < 100 ms) |

### 10.4 Tenant isolation

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `plans_not_found_total` | counter | `endpoint` | Info-severity 404s — normal noise, but input to F13 cross-tenant correlator |
| `plans_cross_tenant_probe_total` | counter | — | **HIGH SEVERITY** — escalated by F13 periodic scan when `plan_not_found` entries correlate to a plan existing in another tenant |

### 10.5 Dependencies (USE)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `plans_db_query_duration_seconds` | histogram | `query` (list / get / create / update / clone / delete / search) | Neon query latency for plans module |
| `plans_db_connection_errors_total` | counter | — | Connection failures specific to plans operations |
| `plans_rls_set_local_duration_seconds` | histogram | — | Time to execute `SET LOCAL app.current_tenant` per transaction |

---

## 11. SLOs — F2

| SLO | Target | Window | Error budget | Source |
|---|---|---|---|---|
| **Plans list availability** | ≥ 99.9% of `/api/plans/{year}` return non-5xx | 30-day rolling | 0.1% ≈ 43 min/month | `plans_list_duration_seconds` + 5xx counter |
| **Plans API latency (p95)** | < 400 ms (Constitution VII) | 30-day rolling | 5% can exceed | `plans_list_duration_seconds` histogram |
| **Palette search latency (p95)** | < 100 ms | 30-day rolling | 5% can exceed | `palette_search_duration_seconds` |
| **Tenant isolation correctness** | Zero cross-tenant data leaks | Per release | 0% (hard rule) | `tenant-isolation.test.ts` + `plans_cross_tenant_probe_total` MUST be 0 |

---

## 12. Alerts — F2

| Alert | Condition | Severity | Owner | Runbook |
|---|---|---|---|---|
| **Plans API error rate** | `rate(5xx) > 5%` over 5 min on `/api/plans/**` | 🚨 Page | Plans on-call | Check Neon health, RLS config, recent deploys |
| **Plans API latency p95 > 800 ms** | 10-min rolling window | 🚨 Page | Plans on-call | Check Neon query plan, connection pool saturation |
| **Cross-tenant probe detected** | `rate(plans_cross_tenant_probe_total) > 0` | 🚨 Page | Security | See § 12.1 runbook below |
| **Cross-tenant probe (low-freq)** | `rate(plans_not_found_total) > 1/min` sustained 5 min | ⚠ Warn | Security | Possible probing — review audit_log for actor pattern |
| **Clone year spike** | `rate(plans_cloned_total) > 5/hour` | ⚠ Warn | Product | Unexpected cloning activity — verify admin intent |
| **Fee config mutation** | `fee_config_updated_total` increment | 📉 Report | Finance | Audit review — fee changes affect invoicing |

### 12.1 `plan_cross_tenant_probe` runbook (critique E9)

**Severity**: 🚨 Page — immediate human response required.
**Thresholds**: 1/min = alarm, 5/hr = investigation.
**Target triage time**: < 5 minutes.

**Triage steps**:

1. **Inspect audit_log** — query entries for the alerting window:
   ```sql
   SELECT * FROM audit_log
   WHERE event_type = 'plan_not_found'
     AND created_at >= NOW() - INTERVAL '30 minutes'
   ORDER BY created_at DESC;
   ```
2. **Identify actor** — extract `actor_user_id` from the matching rows. Cross-reference with `users` table to determine role, tenant, and account status.
3. **Check pattern** — determine if the 404s correlate to plan IDs that exist in *another* tenant (this is the F13 periodic scan's job, but can be done manually):
   ```sql
   SELECT DISTINCT payload->>'plan_id' AS probed_plan_id,
          mp.tenant_id AS actual_tenant
   FROM audit_log al
   LEFT JOIN membership_plans mp
     ON mp.plan_id = al.payload->>'plan_id'
   WHERE al.event_type = 'plan_not_found'
     AND al.created_at >= NOW() - INTERVAL '30 minutes'
     AND mp.tenant_id IS NOT NULL
     AND mp.tenant_id != al.tenant_id;
   ```
4. **Decide action**:
   - If confirmed cross-tenant probe: **disable the actor account** immediately, create an incident record, notify the affected tenant.
   - If false positive (e.g. bookmarked URL after plan deletion): close the alert with a note.
5. **Post-incident**: file a post-mortem within 48 hours per § 8.1.

**Escalation**: if triage exceeds 5 minutes or the pattern is unclear, page the engineering lead per § 8.2 escalation table.

**Reference**: `specs/002-membership-plans/plan.md` § I (Tenant Isolation), critique E6 + E9 (2026-04-11).

---

## 13. Links

- Constitution Principle VII: `.specify/memory/constitution.md` § VII
- F1 plan observability: `specs/001-auth-rbac/plan.md` § "VII. Performance & Observability"
- F1 research observability: `specs/001-auth-rbac/research.md` § 11
- F1 security metrics tie-in: `specs/001-auth-rbac/security.md` § 6 (review gate uses metrics from § 4 here)
- F2 plan observability: `specs/002-membership-plans/plan.md` § I (Tenant Isolation) + § VII (Observability)
- F2 cross-tenant probe design: critique E6 + E9 (2026-04-11)

---

## 14. F3 Members & Contacts

**Status**: Fleshed out in Polish phase (T147). All US1–US7 shipped and green.
**Source refs**: `specs/005-members-contacts/plan.md § Constitution Check VII`, `security.md § 4`, `data-model.md § 4`.

### 14.1 Metrics catalogue

| Metric | Type | Labels | Source |
|---|---|---|---|
| `members.api.latency_ms` | histogram | `{method, route}` | every `/api/members/**` + `/api/portal/**` handler via `@vercel/otel` span duration |
| `members.api.requests_total` | counter | `{method, route, status_class}` | every `/api/members/**` response (2xx/4xx/5xx) |
| `members.search.latency_ms` | histogram | `{has_query, status}` | `GET /api/members?q=…` — pg_trgm GIN path |
| `members.bulk.rows_per_action` | histogram | `{action, outcome}` | `POST /api/members/bulk` |
| `members.cross_tenant_probe.count` | counter | `{actor_tenant, route}` | emitted on each `member_cross_tenant_probe` audit event |
| `members.self_update_forbidden.count` | counter | `{attempted_fields}` | emitted on each `member_self_update_forbidden` audit event |
| `members.email_change.count` | counter | `{event}` (`initiated`/`verified`/`reverted`/`failed`) | email-change lifecycle events |
| `members.bundle_warning.latency_ms` | histogram | `{plan_id}` | `/api/plans/[year]/[planId]/affected-members` |
| `outbox.dispatch.latency_ms` | histogram | `{notification_type, attempt}` | member-email outbox cron dispatcher |
| `outbox_permanent_failures_total` | counter | `{notification_type, reason}` where `reason ∈ {max_retries, invalid_recipient, no_template_handler}` | `permanently_failed` flips after 5 retries or unrenderable payload |
| `outbox_stuck_rows_total` | counter (rate-alerted) | — | pending rows > 30 min past `next_retry_at` at cron tick time; rate > 0 = cron is down or lost `CRON_SECRET` |
| `members.invite.count` | counter | `{outcome}` (`sent`/`already_linked`/`no_email`) | portal invite events |
| `members.archive.count` | counter | `{cascade_sessions}` (`0`/`1`/`2+`) | archive cascade cardinality signal |

### 14.2 SLO targets

| SLO | Target | Error budget | Measured by |
|---|---|---|---|
| Members API p95 | < 400 ms | 1 % per month | `members.api.latency_ms` p95 over 5 min windows |
| Members API p99 | < 800 ms | 0.1 % per month | `members.api.latency_ms` p99 |
| Substring search p95 (SC-002) | < 500 ms @ 5 k rows | 1 % per month | `members.search.latency_ms` p95 |
| Bulk 100-row p95 (SC-004) | < 5 s | 0.1 % per month | `members.bulk.rows_per_action` + latency span |
| Bundle-warning fetch p95 (SC-008) | < 200 ms @ 500 members | 1 % per month | `members.bundle_warning.latency_ms` p95 |
| Core Web Vitals (LCP / INP / CLS) | < 2.5 s / < 200 ms / < 0.1 | per-release Lighthouse CI gate | Vercel Speed Insights |

### 14.3 Alerting thresholds

#### High severity (page immediately)

| Event / Metric | Threshold | Action |
|---|---|---|
| `member_cross_tenant_probe` | ≥ 1 event in 5 min | Alarm → incident; isolate tenant, rotate session tokens, audit affected member IDs. Time-to-triage: 5 min. |
| `member_cross_tenant_probe` | ≥ 5 events in 1 h | Escalate to security incident — potential systematic enumeration attack. |
| `email_dispatch_failed` (critical type) | ≥ 1 `permanently_failed` for `email_verification` or `email_change_revert` | Alarm → triage Resend outage vs. bad template vs. invalid address. Time-to-triage: 15 min. |
| `outbox_permanent_failures_total` | `rate > 0` sustained 5 min | Proactive Vercel Alert — admin sees `201 Created` but email never sends. Check Resend status, template integrity, and row `last_error` column. |
| `outbox_stuck_rows_total` | `rate > 0` sustained 5 min | Cron dispatcher is down or lost `CRON_SECRET`. Verify Vercel Cron schedule + env var + recent function logs for `cron.outbox_dispatch.*`. |
| `members.api.latency_ms` p95 | > 1 s for 5 consecutive min | Alarm → check Neon query plan, pg_trgm index health. |

#### Medium severity (notify on-call, investigate next business hour)

| Event / Metric | Threshold | Action |
|---|---|---|
| `member_self_update_forbidden` | ≥ 5 events in 10 min per actor | Investigate forged portal payload; possible script or compromised member session. Time-to-triage: 10 min. |
| `outbox_permanent_failures_total` | ≥ 3 failures in 30 min | Check Resend rate limits and outbox `last_error` distribution. |
| `members.bulk.rows_per_action` p95 | > 8 s for 100-row action | Bulk endpoint degraded — profile DB query + RLS policy latency. |

#### Info (log and monitor, no page)

| Event | Notes |
|---|---|
| `member_email_change_reverted` | Any occurrence → audit review for admin-impersonation ATO pattern. |
| `bulk_action_rate_limit_exceeded` | 1 per actor per 10 min budget — verify not scripted abuse. |
| `members.invite.count` outcome=`already_linked` | Elevated rate may indicate double-click bug on the Invite button. |

### 14.4 Runbooks

#### R-M01: Cross-tenant probe alarm

```
1. Pull audit_log rows: SELECT * FROM audit_log WHERE event_type = 'member_cross_tenant_probe'
   AND timestamp > NOW() - INTERVAL '1 hour' ORDER BY timestamp DESC;
2. Identify actor_user_id + actor_tenant_id in the payload.
3. Check actor session freshness: SELECT * FROM sessions WHERE user_id = '<actor>';
4. If pattern is systematic (sequential member IDs), revoke all sessions for actor + notify legal.
5. If isolated (single probe, then stops), log as false-positive — likely stale frontend link.
6. Close incident after 24 h no recurrence.
```

#### R-M02: Email dispatch failed (critical)

```
1. Check outbox: SELECT * FROM notifications_outbox WHERE permanently_failed = true
   AND updated_at > NOW() - INTERVAL '2 hours';
2. Inspect failed_reason column for pattern (SMTP 5xx vs. network timeout vs. template error).
3. If Resend outage: monitor status.resend.com, retry via admin UI once restored.
4. If bad template: patch template → redeploy → manually re-enqueue via:
   UPDATE notifications_outbox SET permanently_failed = false, retry_count = 0
   WHERE id = '<row_id>';
5. For email_verification failures: contact affected member via alternate channel (admin-to-admin).
6. Emit post-mortem if > 5 members affected.
```

#### R-M03: Admin-compromise scenario

```
1. Lock account: UPDATE users SET disabled = true WHERE id = '<compromised_admin_id>';
2. Revoke all sessions: DELETE FROM sessions WHERE user_id = '<compromised_admin_id>';
3. Audit affected member writes: SELECT * FROM audit_log WHERE actor_user_id = '<id>'
   AND timestamp > '<compromise_window_start>' ORDER BY timestamp;
4. Notify affected members of any PII changes (email/phone/plan changes).
5. Rotate RESEND_API_KEY + UPSTASH_REDIS_REST_TOKEN if admin had infrastructure access.
6. Engage legal/DPO for PDPA/GDPR 72-hour notification assessment.
```

### 14.5 PII redaction (T038)

`src/lib/logger.ts` REDACT_PATHS extended with: `email`, `toEmail`, `phone`, `date_of_birth`,
`dateOfBirth`, `tax_id`, `taxId` — top-level + one-level-deep `*.` variants. Censor value: `[REDACTED]`.

Invariant test: `tests/unit/lib/logger-pii.test.ts` (authored alongside first use-case logging).

### 14.6 Dashboard queries (Vercel Logs / future Grafana)

```sql
-- Cross-tenant probes in last 24 h
SELECT DATE_TRUNC('hour', timestamp) AS hour, COUNT(*) AS probes
FROM audit_log
WHERE event_type = 'member_cross_tenant_probe'
  AND timestamp > NOW() - INTERVAL '24 hours'
GROUP BY 1 ORDER BY 1;

-- Outbox health
SELECT notification_type,
       COUNT(*) FILTER (WHERE permanently_failed) AS failed,
       COUNT(*) FILTER (WHERE sent_at IS NULL AND NOT permanently_failed) AS pending,
       AVG(retry_count) AS avg_retries
FROM notifications_outbox
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY 1;

-- Bulk action usage (last 7 days)
SELECT payload->>'action' AS action, COUNT(*) AS total
FROM audit_log
WHERE event_type = 'member_bulk_action_completed'
  AND timestamp > NOW() - INTERVAL '7 days'
GROUP BY 1;
```

### 14.7 Reference

- `specs/005-members-contacts/plan.md § Constitution Check VII`
- `specs/005-members-contacts/security.md § 4` (runbook requirements CHK068–CHK070, CHK077)
- `specs/005-members-contacts/data-model.md § 4` (23 F3 audit event types + payload shapes)
- Constitution Principle I clause 4 (audit severity for cross-tenant probes)
- Constitution Principle VII (Performance & Observability SLOs)

### 14.8 COMP-1 Member Erasure — reconciliation sweep (US2d)

GDPR Art.17 / PDPA §33 member erasure is two-phase: a durable atomic scrub tx
(sets `members.erased_at`) followed by best-effort POST-COMMIT cascades (F1
linked-login erasure, F7 broadcast cancel/content-scrub, F8 renewal cancel, F6
event-registration erasure). `member_erased` is the completion proof — emitted
ONLY when every cascade reports clean. If a cascade fails after the scrub
committed, the member is **stuck**: `erased_at` is set but `member_erased` never
landed. The reconciliation sweep (`POST /api/cron/members/reconcile-erasures`)
re-drives the idempotent `eraseMember` for each stuck member and emits the
metric below per re-driven member.

#### 14.8.1 Metrics catalogue

| Metric | Type | Labels | Source |
|---|---|---|---|
| `members_erasure_outcome_total` | counter | `{outcome, tenant}` where `outcome ∈ {reconciled, still_pending, error}` | one per re-driven member in `/api/cron/members/reconcile-erasures` (`erasureMetrics.outcome`) |
| `auth_erase_cascade_outcome_total` | counter | `{outcome}` where `outcome ∈ {failed, last_admin, threw}` | emitted INSIDE the F1 linked-login erasure cascade (`authMetrics.eraseCascadeOutcome`) when an `eraseUser` re-drive does not complete. **`last_admin` is the non-auto-recoverable signal** — see § 14.8.3. |

`outcome` semantics for `members_erasure_outcome_total`:

- `reconciled` — `member_erased` was emitted THIS tick; the erasure is now
  complete. The healthy terminal state. (A reconciled member is no longer stuck,
  so it is not enumerated on the next tick — no double `member_erased`.)
- `still_pending` — the scrub is committed (row IS erased) but a cascade is STILL
  failing (`cascadesComplete=false`, or a typed `Result.err` on the re-drive).
  **TRANSIENT** — the next tick retries. NOT an error; the tick returns 200.
- `error` — an UNCAUGHT throw from `eraseMember` (genuine bug / DB blip). The
  tick returns **500** so cron-job.org retries it.

#### 14.8.2 Alert rules

| Alert | Condition | Severity | Owner | Action |
|---|---|---|---|---|
| Stuck-erasure (transient) | `members_erasure_outcome_total{outcome="still_pending"}` rate > 0 sustained over N≥3 consecutive ticks | alarm → page DPO/on-call | Platform on-call + DPO | A cascade keeps failing across ticks → the Art.17/§33 erasure is NOT completing. Inspect the per-cascade pino error (`erase-member: <cascade> not clean / threw`) for the failing module; once the underlying fault clears, the next tick auto-completes (no manual data action). |
| Stuck-erasure (tick error) | `members_erasure_outcome_total{outcome="error"}` rate > 0 sustained over N≥3 ticks (the tick also 500s) | alarm → page on-call | Platform on-call | An uncaught throw from `eraseMember` — a real bug or DB outage. Inspect `cron.members.reconcile_erasures.uncaught` (stack) + `cron.members.reconcile_erasures.query_failed`. |
| **Last-admin (NON-retryable)** | `auth_erase_cascade_outcome_total{outcome="last_admin"}` ≥ 1 in any tick **(distinct from a transient `still_pending`)** | alarm → page DPO/on-call as a **manual operator action**, NOT a transient | Platform on-call + DPO | See § 14.8.3 — the re-drive can NEVER self-complete; an operator MUST promote/transfer another admin first. |

#### 14.8.3 The `last_admin` distinct, non-auto-recoverable alert

When the erased member's contact is the **last active admin** for the tenant,
the F1 linked-login erasure cascade hits the
`users_last_admin_protection` trigger and `eraseUser` returns the distinct
`'erase-user-last-admin'` code. The cascade adapter maps it to the
`authMetrics.eraseCascadeOutcome('last_admin')` metric label (NOT the generic
`failed`). The use-case withholds `member_erased` (allCascadesClean=false), so
the reconciler re-drives it **every tick** — and it will recur as `still_pending`
**forever**, because re-driving the SAME erasure cannot remove the last-admin
constraint. This is the ONE stuck-erasure case the reconciler **cannot**
self-heal.

Alert on the `last_admin` signal **SEPARATELY** from a transient `still_pending`:

- A transient `still_pending` clears on its own once the failing cascade's
  underlying fault (DB blip, Resend outage, etc.) resolves — page, but expect
  auto-recovery.
- A `last_admin` signal requires a **manual, non-retryable operator action**:
  **promote or transfer another user to the `admin` role** (so the erased
  member's login is no longer the last admin), after which the NEXT reconciler
  tick completes the erasure normally. Re-driving the cron without doing this is
  futile (it will recur as `still_pending`/`last_admin` indefinitely).

Align the two signals on ONE dashboard: a co-incident
`members_erasure_outcome_total{outcome="still_pending"}` + a
`auth_erase_cascade_outcome_total{outcome="last_admin"}` on the same member
means **fix the last-admin first**; a `still_pending` with NO `last_admin`
companion is a transient cascade fault to investigate and wait out.

#### 14.8.4 Reference

- `src/app/api/cron/members/reconcile-erasures/route.ts` — the sweep
- `src/modules/members/application/use-cases/erase-member.ts` — `cascadesComplete` gating
- `src/modules/members/infrastructure/adapters/auth-user-erasure-adapter.ts` — `last_admin` metric label
- `docs/runbooks/cron-jobs.md § Members — reconcile-erasures` — operator playbook + cadence
- Constitution Principle I clause 3 (mandatory cross-tenant integration test) + clause 4

---

## 15. Post-F3 observability backlog

Non-blocking items deferred from F3 ship. Track against the F2+ observability roadmap (Grafana Cloud / Datadog migration).

### 15.1 `auth_invitation_enqueue_failed_total` — dashboard + alert wiring

**Context**: Metric counter added in F3 round-3 follow-up (commit `9a47c44`) to surface a silent-success bug — admin invites a user via `POST /api/auth/invite`, the `createUser` use case succeeds on the F1 side, but the `notifications_outbox` enqueue insert fails (DB error, unique race, etc.). The admin sees `201 Created` but the invitation email will **never be sent** because the dispatcher cron only drains rows that made it into the outbox table.

**Current mitigation (log-only)**:
- Code path: `src/modules/auth/application/create-user.ts:174-184` emits `logger.error('create_user.invitation_enqueue_failed', { errCode, errCause })` + calls `authMetrics.invitationEnqueueFailed(role, reason)`.
- Operator workflow: grep Vercel Logs for the log tag:
  ```bash
  vercel logs <deployment-url> | grep "create_user.invitation_enqueue_failed"
  ```
- Reactive only — operator finds issues after the fact, not proactively.

**Backlog item — when Grafana Cloud lands (F2+)**:

1. **Panel**: add to the "Auth metrics" dashboard.
   - Query: `sum(rate(auth_invitation_enqueue_failed_total[5m])) by (role, reason)`
   - Viz: time-series line chart, stacked by `reason` label (`enqueue_failed` | `no_row_returned`).
   - Threshold line at 0 (any non-zero rate is actionable).
2. **Alert rule**:
   - Condition: `sum(rate(auth_invitation_enqueue_failed_total[5m])) > 0` sustained for 5 min.
   - Severity: P2 (admin-facing silent-success bug).
   - Notification: on-call engineer via PagerDuty / Opsgenie / Slack.
   - Runbook link: this section (§ 15.1).
3. **Resolve-incident runbook**:
   ```
   1. Identify affected users: grep audit_log for `account_created` events within the
      5-min spike window where the matching `notifications_outbox` row is missing.
   2. Manually insert the outbox row OR invalidate the invitation + re-invite via
      admin UI (which re-runs the same createUser flow — idempotent on email).
   3. Root-cause the enqueue failure via pino logs — typical causes: Neon
      connection pool exhaustion, unique-constraint race on concurrent invite,
      statement_timeout on the INSERT.
   4. If > 5 users affected: post-mortem + file F10 ticket for "resend invitation"
      admin action (currently absent — mentioned as future work in create-user.ts:18).
   ```

**Estimated effort**: ~30 min once Grafana Cloud is provisioned + dashboard access is granted.

**Not a ship blocker for F3** because:
- Admin-invite flow volume is low (tens of events per day per tenant).
- `logger.error` captures full context — operators can find issues via log search.
- Grafana Cloud is explicitly F2+ roadmap per § 2 observability stack table.

### 15.2 Future backlog items

Add future post-ship observability follow-ups here (format: subsection 15.N with context, current mitigation, target state, effort estimate, and ship-blocker justification).

---

## 16. F4 Invoicing — metrics catalogue (T022)

All metrics emitted by the `invoicing` bounded context. Every use case creates a pino child logger + OTel span; counters + histograms attached as span attributes.

### 16.1 Issue-invoice transactional path (the critical F4 surface)

| Name | Kind | Labels | Purpose |
|---|---|---|---|
| `invoicing.issue.duration_ms` | histogram | tenant_slug, outcome | Wall-clock of full issue tx (seq alloc → PDF → Blob → DB → outbox) |
| `invoicing.issue.count` | counter | tenant_slug, outcome | issued, failed, idempotency_replay |
| `invoicing.pdf_render.duration_ms` | histogram | tenant_slug, template_version, doc_type | PDF render only (SC-003 reproducibility) |
| `invoicing.seq_allocator.contention_retries` | counter | tenant_slug, document_type, fiscal_year | Advisory-lock retry count |
| `invoicing.blob_upload.duration_ms` | histogram | tenant_slug, outcome | Vercel Blob upload time |

### 16.2 Auto-email delivery

| Name | Kind | Labels | Purpose |
|---|---|---|---|
| `invoicing.auto_email.enqueued` | counter | tenant_slug, event_type | Outbox rows added inside issue/pay/void/CN tx |
| `invoicing.auto_email.sent` | counter | tenant_slug, event_type | Dispatcher successfully invoked Resend |
| `invoicing.auto_email.bounces` | counter | tenant_slug, bounce_reason | Resend webhook flagged a permanent failure |
| `invoicing.auto_email.throttled` | counter | tenant_slug, member_id_hash | Token-bucket rejected (>10/h per member) |

### 16.3 Cross-tenant + security

| Name | Kind | Labels | Purpose |
|---|---|---|---|
| `invoicing.cross_tenant_probe.count` | counter | tenant_slug, actor_role | Crafted-URL probes → 404 + audit |
| `invoicing.logo_blob.count` | counter | tenant_slug | Monotonic per-tenant logo upload counter (50 cap) |
| `invoicing.logo_upload_rejected.count` | counter | tenant_slug, reason | MIME / size / dim / EXIF / cap |

### 16.4 Overdue + operational

| Name | Kind | Labels | Purpose |
|---|---|---|---|
| `invoicing.overdue.detected` | counter | tenant_slug | Lazy overdue derivation (once per day per invoice) |
| `invoicing.resend.count` | counter | tenant_slug, doc_type | Manual PDF resend (admin clicks resend button) |

### 16.5 Verified metrics at F4 Phase 10 ship (T113)

The § 16.1–16.4 catalogue is the **full target set**. The subset actually emitting
counters on the wire as of the Phase 10 ship is smaller — the other entries stay
catalogued here as a post-MVP observability roadmap. The emit names use
Prometheus-style underscores to match the F1/F3 `outboxMetrics` convention
already in place; dot-notation names in the tables above map 1:1 via the OTel
SDK exporter.

| Catalogue name | Wire name | Status | Emit site |
|---|---|---|---|
| `invoicing.issue.count` | `invoicing_issue_total` | ✅ Wired | `issueInvoice` post-commit (counts consumed §87 sequences only — rolled-back attempts excluded) |
| `invoicing.issue.duration_ms` | `invoicing_issue_duration_ms` | ✅ Wired | `issueInvoice` wall-clock (performance.now() at entry → .record() at ok-return) |
| `invoicing.pdf_render.duration_ms` | `invoicing_pdf_render_duration_ms` | ✅ Wired | `reactPdfRenderAdapter.render` labelled by `kind` ∈ {invoice, receipt_combined, receipt_separate, credit_note, void_stamped_invoice, invoice_preview} |
| `invoicing.auto_email.bounces` | `invoicing_auto_email_bounces_total` | ✅ Wired | `/api/cron/outbox-dispatch` perm-fail branches — labelled by `reason` ∈ {invalid_recipient, max_retries, no_template_handler} |
| `invoicing.cross_tenant_probe.count` | `invoicing_cross_tenant_probe_total` | ✅ Wired | `f4AuditAdapter.emit` fires on 3 probe event types — labelled by `probe_type` ∈ {invoice, credit_note, tenant_invoice_settings} |
| `invoicing.logo_load_failed` | `invoicing_logo_load_failed_total` | ✅ Wired (Round-2 2026-05-15) | `loadTenantLogo` fires when Blob `downloadBytes` throws (404, ACL revoked, network). PDF render falls through to no-logo — Thai-RD compliance preserved. **Alert**: sustained non-zero rate per tenant ⇒ expired blob key or misconfigured upload. Negative-cached 60 s after a failure (Round-3) so a 5xx storm doesn't multiply this counter on every cron pass. |
| `invoicing.receipt_failure_mark_suppressed` | `invoicing_receipt_failure_mark_suppressed_total` | ✅ Wired (Round-2 2026-05-15) | `renderReceiptPdf` fires when the async worker FAILS *and* the subsequent `applyReceiptPdfFailure` write ALSO fails (Neon outage). Row stuck `pending` without attempt-counter increment ⇒ never reaches `pdf_render_permanently_failed`. **Alert**: any non-zero rate ⇒ on-call investigates Neon health. |
| `invoicing.seq_allocator.contention_retries` | `invoicing_seq_allocator_contention_retries_total` | ⏸ Instrument ready, no emit | `postgresSequenceAllocator.allocateNext` uses `pg_advisory_xact_lock` which BLOCKS rather than retrying; this counter awaits a future claim-release allocator rewrite. |
| `invoicing.blob_upload.duration_ms` | — | ⏸ Deferred | Covered indirectly via `invoicing_issue_duration_ms` tail; add later if blob becomes the dominant issuance latency contributor. |
| `invoicing.auto_email.enqueued` | — | ⏸ Deferred | Enqueue count derivable from `notifications_outbox` COUNT + dashboard join; low-signal separate counter. |
| `invoicing.auto_email.sent` | — | ⏸ Deferred | Same rationale as `enqueued`; plus Resend's own dashboard reports send count. |
| `invoicing.auto_email.throttled` | — | ⏸ Deferred | Resend route 1/5-min rate-limit exists (T107); counter add when the 429 rate becomes interesting. |
| `invoicing.logo_blob.count` | — | ⏸ Deferred | Tenant-level lifetime counter (50 cap per tenant) already asserted in `update-tenant-invoice-settings` use-case; metric is monitoring-only. |
| `invoicing.logo_upload_rejected.count` | — | ⏸ Deferred | Reason classes surface via `pdf_render_failed` + `tenant_invoice_settings_updated` audit chaining; counter add if upload abuse patterns emerge. |
| `invoicing.overdue.detected` | — | ⏸ Deferred | Covered via `invoice_overdue_detected` audit row count (idempotent-per-day); metric would be audit-row-count redundant. |
| `invoicing.resend.count` | — | ⏸ Deferred | Covered via `invoice_pdf_resent` + `receipt_pdf_resent` + `credit_note_pdf_resent` audit rows; resend is ≪ daily volume so counter adds little beyond audit trail. |

**SLO coverage at ship:**

| SLO | Evidence source |
|---|---|
| SLO-F4-001 issuance success rate | `invoicing_issue_total` (post-commit only) vs total issue calls via pino logs |
| SLO-F4-002 issuance p95 latency | `invoicing_issue_duration_ms` histogram |
| SLO-F4-003 PDF render determinism | `pdf-deterministic.test.ts` (SC-003) + staging re-render probe |
| SLO-F4-004 auto-email bounce rate | `invoicing_auto_email_bounces_total` / Resend send count |
| SLO-F4-005 cross-tenant probes | `invoicing_cross_tenant_probe_total` — any non-zero rate alerts |
| SLO-F4-006 invoice list query p95 | T110a perf test (RUN_PERF=1, p95=324ms observed vs 500ms budget) + prod p95 via Vercel Speed Insights once deployed |

Deferred metrics can be added post-ship without migration — all go through the
existing `@opentelemetry/api` → `@vercel/otel` pipeline. Adding a new emit
site is a ~5-line patch (instrument + call site + doc row).

### 16.1 Running perf-gated suites locally / in CI

All three Phase 10 perf tests are marked `it.skipIf(!RUN_PERF)` — they
run only when the `RUN_PERF=1` env var is set, so the default unit+
integration pipeline stays fast. To exercise them (budgets fail-close
the run):

```bash
pnpm test:perf   # runs T110 (PDF render), T110a (list query), T111 (seq allocator)
```

`pnpm test:perf` is a tsx wrapper (`scripts/run-perf-tests.ts`) that
sets `RUN_PERF=1` and spawns vitest against the three perf suites —
cross-platform, no extra devDep. CI wiring: schedule a nightly job
with `DATABASE_URL` pointing at live Neon Singapore and run
`pnpm install && pnpm test:perf`. Exit code propagates so a missed
p95/p99 budget fails the pipeline.

## 17. SLOs — F4

| Objective | Window | Budget | Measurement |
|---|---|---|---|
| SLO-F4-001 issuance success rate | 28d rolling | ≥ 99.5% | `issue.count{outcome='issued'} / (issued+failed)` |
| SLO-F4-002 issuance p95 latency | 28d rolling | ≤ 1500 ms | `issue.duration_ms p95` |
| SLO-F4-003 PDF render determinism | 28d rolling | 100% byte-identical | CI + staging sha256 equality probe |
| SLO-F4-004 auto-email bounce rate | 28d rolling | ≤ 2% | `auto_email.bounces / auto_email.sent` |
| SLO-F4-005 cross-tenant probes | 28d rolling | 0 per tenant | `cross_tenant_probe.count == 0` |
| SLO-F4-006 invoice list query p95 | 28d rolling | ≤ 500 ms @ 5k rows | T110a perf test + prod p95 |

## 18. Alerts — F4 initial set

| Alert | Trigger | Severity | Runbook |
|---|---|---|---|
| `f4-cross-tenant-probe` | `cross_tenant_probe.count >= 1` within 5 min | PAGE | § 19.1 — investigate + rotate session if abuse confirmed |
| `f4-issuance-p99-slow` | p99 `issue.duration_ms` > 3000 ms for 10 min | NOTIFY | § 19.2 — check Blob + Resend latency + DB connections |
| `f4-auto-email-bounce-storm` | `auto_email.bounces / hour > 5%` | NOTIFY | § 19.3 — pause dispatcher, investigate stale addresses |
| `f4-seq-contention-spike` | `seq_allocator.contention_retries p95 > 2/min` | NOTIFY | Advisory lock churn — check for runaway concurrent issues |
| `f4-logo-upload-rejected-flood` | `logo_upload_rejected.count / hour > 20` | NOTIFY | Possible abuse — audit actor |
| `f4-pdf-render-failed-spike` | `pdf_render_failed` audit events > 5 / hour | PAGE | Likely font / template regression — check latest deploy |

## 19. F4 Runbooks

### 19.1 Cross-tenant probe investigation (`f4-cross-tenant-probe`)

1. Query `audit_log` for the last 50 `invoice_cross_tenant_probe` / `credit_note_cross_tenant_probe` rows:
   ```sql
   SELECT tenant_id, actor_user_id, payload, timestamp
   FROM audit_log
   WHERE event_type IN ('invoice_cross_tenant_probe','credit_note_cross_tenant_probe')
   ORDER BY timestamp DESC LIMIT 50;
   ```
2. Confirm actor is a known session (not a brute-force token).
3. If actor legitimate (mistyped id): reach out, close ticket.
4. If actor hostile: revoke session, email admin, escalate to legal if PII exfiltrated.
5. Update incident in `specs/007-invoices-receipts/reviews/incident-NNN.md`.

### 19.2 Doc-number overflow runbook (FR-035)

1. If allocator hits `2_000_000` (6-digit overflow): issue blocks with `document_number_overflow`.
2. Decide: bump prefix (SC → SC2) or reset fiscal-year cadence. Both require maintainer sign-off.
3. Apply new prefix via `tenant_invoice_settings.invoice_number_prefix` update.
4. Verify next issuance lands at new prefix + seq 1.

### 19.3 Auto-email permanent-failure recovery

1. Dashboard → "F4 auto-email failures" badge on `/admin`.
2. Click through to list of `auto_email_delivery_failed` rows.
3. For each: admin fixes recipient email via F3 member edit → triggers manual `resend-pdf` (T107).
4. Stale addresses > 30d age: mark member contact `do_not_auto_email = true` (future F9 column).

### 19.4 Template-version release process

1. PR introducing a template change bumps `CURRENT_TEMPLATE_VERSION` constant.
2. `pdf-template-version-smoke.test.ts` (T045) covers version registry completeness.
3. Old versions MUST remain in the registry indefinitely — deleting an old version breaks reproducibility (FR-016).
4. Release notes document the visual diff + which invoice batches will use the new version.

## 20. F4 staging-baseline

Populated in Phase 10 T114b after a live issuance flow on staging. Placeholders:

- Invoice-issue trace ID: _(tbd)_
- p50 / p95 / p99: _(tbd)_
- Blob upload p95: _(tbd)_
- Resend queue latency: _(tbd)_

Target: ≤1500 ms p95 for full issue tx; ≤800 ms p95 for PDF render alone.


---

## 21. F5 Online Payment — metrics catalogue (T140–T143)

**Status**: REVIEW-READY (2026-04-27). Branch `009-online-payment`.
**Source authority**: `specs/009-online-payment/plan.md` § VII Performance & Observability.

F5 wires distributed traces, 15 OTel metrics, and 9 alert rules across the Stripe
payment lifecycle. The full critical-path span tree:

```
portal_click
  └─ api_payments_initiate
       └─ stripe_create_intent           (external — Stripe API)
            └─ payments_repo_insert      (DB — pending row)
asynchronous webhook delivery (Stripe → app):
  webhook_receive
    └─ webhook_verify                    (HMAC raw-body, pre-parse)
         └─ processor_events_upsert      (DB — idempotency guard)
              └─ runInTenant
                   └─ confirm-payment | fail-payment | cancel-payment | charge-refunded
                        └─ f4_markpaid (succeeded branch only)
                             └─ receipt_email_enqueued
```

Every span carries `tenant.id`, `invoice.id`, `payment.id`, `payment.method`,
`processor.event_id` attributes. **No raw card data, full event body, or
`Stripe-Signature` header value is ever attributed** — those are in pino's
redact list (see § 21.4).

### 21.1 Metrics catalogue (18 metrics — T166 added 3)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `payments.initiate.count` | counter | `tenant`, `method` (card\|promptpay) | RED rate per method |
| `payments.initiate.duration_ms` | histogram | `tenant`, `method` | initiate p95 < 1.2 s SLO |
| `payments.succeeded.count` | counter | `tenant`, `method` | settlement throughput |
| `payments.failed.count` | counter | `tenant`, `method`, `reason_code` | decline-rate alert (excluding bank-decline codes) |
| `payments.auto_refunded_stale.count` | counter | `tenant` | guard-rail anomaly (overpaid invoice flagged for auto-refund) |
| `refunds.initiate.count` | counter | `tenant`, `method`, `partial:bool` | refund volume |
| `refunds.succeeded.count` | counter | `tenant` | refund → CN throughput |
| `refunds.failed.count` | counter | `tenant`, `reason_code` | refund-failure forensics |
| `webhook.receive.count` | counter | `tenant`, `event_type` | per-type ingest rate |
| `webhook.duplicate_ignored.count` | counter | `tenant`, `event_type` | idempotency guard hit-rate (FR-008) |
| `webhook.signature_rejected_total` | counter | _(no tenant — pre-verification)_ | abuse / misconfiguration canary |
| `webhook.api_version_mismatch_total` | counter | _(no tenant)_ | Q5 monitoring — Stripe API version drift detector |
| `out_of_band_refund_rejected_total` | counter | `tenant`, `processor_env` | FR-011a leading indicator (admin refunded via Stripe Dashboard, not in-app) |
| `member_invite_to_payment_funnel_dropoff` | counter | `tenant`, `step` | F5.1 promotion KPI (FR-016a) |
| `payments.stale_pending_count` | gauge | `tenant` | post-critique X1+E3 — pending > 24h zombies |
| `receipt_pdf_render_duration_ms` | histogram | `tenant`, `outcome` (rendered\|failed) | T166 async receipt render — worker p95 budget |
| `receipt_pdf_render_failures_total` | counter | `tenant`, `cause` (render_failed\|blob_upload_failed\|invalid_state\|invoice_not_found\|settings_missing) | T166 — render-pipeline forensics by failure cause |
| `receipt_pdf_pending_count` | gauge | `tenant` | T166 — paid invoices stuck in `receipt_pdf_status='pending'` (sampled by reconciliation cron) |

**Cardinality**: `reason_code` and `event_type` are bounded enums; `tenant` is
small-cardinality (≤ a few hundred over project lifetime). `step` is enum from
`{invite_sent, invite_opened, account_created, invoice_viewed, payment_initiated,
payment_succeeded}`. **Never** label by `payment.id`, `email`, or any high-cardinality
identifier.

### 21.2 SLO targets

| SLO | Target | Source signal |
|---|---|---|
| SLO-F5-001 initiate p95 | < 1.2 s | `payments.initiate.duration_ms` histogram (Stripe RTT included — documented deviation in plan.md) |
| SLO-F5-002a webhook processing p95 (canceled / failed / non-mutating event types) | < 500 ms (prod) / < 750 ms (dev cross-border) | webhook span duration filtered by `event_type` |
| SLO-F5-002b webhook processing p95 (succeeded branch — F4 markPaid + `receipt_pdf_status='pending'` flip + outbox enqueue; **PDF render async post T166**) | **< 1000 ms (dev) / < 750 ms (prod estimate)** | webhook span duration filtered by `event_type=payment_intent.succeeded`. T166 shipped 2026-04-28 — async PDF removed PDF-render + Blob-upload from hot path (48.2 % p95 reduction; measured async p95 = 859 ms dev, legacy sync p95 = 1657 ms dev — see `specs/009-online-payment/perf-results-t166-2026-04-28.md`). T167 (delete optimistic-UI overlay) gated on prod p95 < 1000 ms for 7 consecutive days. |
| SLO-F5-003 PromptPay QR render p95 | < 2 s | client-side observation (Vercel Speed Insights) |
| SLO-F5-004 settlement → portal confirmation p95 | < 10 s | distributed trace `webhook_receive → portal_revalidate` |
| SLO-F5-005 payment-success rate | ≥ 95 % over 1 h excluding bank-decline codes | `payments.succeeded.count` / (`payments.succeeded.count` + `payments.failed.count{reason_code != insufficient_funds, card_declined, generic_decline}`) |
| SLO-F5-006 webhook idempotency | 100 % zero double-paid / double-credited | T150 30-day soak harness (`scripts/perf/webhook-idempotency-soak.ts`) |
| SLO-F5-007 receipt email delivery time-to-first-attempt p95 (post T166 async) | ≤ 60 s post-webhook-ack | distributed trace `payment_intent.succeeded webhook_receive → receipt_email_outbox_dispatched` (added 2026-04-28 per review-20260428-102639.md S3 closure). Outbox cron cadence 5 min in dev / 1 min in prod; 60 s p95 budget assumes prod cadence + worker first-attempt success on the happy path. `pdf_render_permanently_failed` page (§ 21.3 below) is the alert on the failure tail. |

### 21.3 Alert rules (11 alerts — T166 added `pdf_render_permanently_failed`; review-20260428-102639.md added `slo_f5_002b_breach`)

| Alert | Severity | Threshold | Runbook |
|---|---|---|---|
| `webhook_signature_rejected` ≥ 1 / 5 min | **alarm** | possible abuse / misconfig | `docs/runbooks/webhook-signature-rejected.md` (TODO) |
| `webhook_api_version_mismatch_total` > 0 | **alarm** | Stripe API version drift — Q5 monitoring | `docs/runbooks/api-version-mismatch.md` (TODO) |
| `payment_cross_tenant_probe` ≥ 1 / 5 min | **alarm** | Constitution Principle I breach attempt | `docs/runbooks/cross-tenant-probe.md` |
| webhook span p99 > 2 s | **alarm** | Stripe → us latency or DB stall | observe + diagnose; auto-recovers if Stripe transient |
| webhook backlog > 5 min | **page** | event delivery queue unhealthy | check Vercel function execution + Stripe webhook UI |
| payment-success rate < 95 % (1 h, ex bank-decline) | **alarm** | feature regression or processor outage | check Stripe status + `payments.failed.count` per `reason_code` |
| `payments.stale_pending_count` > 5 for any tenant | **alarm** | post-critique X1+E3 — zombie pending | `docs/runbooks/stale-pending-refund-sweep.md` (covers payment+refund both) |
| `out_of_band_refund_rejected_total` > 0 / day | **alarm** | admin used Stripe Dashboard instead of in-app refund | `docs/runbooks/out-of-band-refund.md` (FR-011a) |
| `payments.auto_refunded_stale.count` > 0 | **alarm** | overpaid invoice — guard-rail fired | check invoice state + manual reconciliation |
| `pdf_render_permanently_failed` ≥ 1 (any tenant) | **page** | T166 receipt PDF worker exhausted 3 attempts — invoice `paid` with no receipt PDF available to member | `docs/runbooks/receipt-pdf-permanently-failed.md` |
| `slo_f5_002b_breach` — webhook span p95 (succeeded) > 1000 ms sustained 30 min | **alarm** | post-T166 async-PDF SLO regression — implies the F4 markPaid + outbox-enqueue tail is creeping back into the hot path, OR Neon/Vercel network latency degraded. Block T167 (optimistic-UI overlay deletion) — the gate condition is "prod p95 < 1000 ms for 7 consecutive days"; sustained breach resets the 7-day timer. | Dashboard panel: `webhook_span_duration_ms{event_type="payment_intent.succeeded"}`. Query: `histogram_quantile(0.95, rate(webhook_span_duration_ms_bucket{event_type="payment_intent.succeeded"}[30m]))`. Triage: check Vercel function timing breakdown + Neon connection pool wait + receipt outbox enqueue duration. Rollback: re-enable `FEATURE_F5_ASYNC_RECEIPT_PDF=true` if the breach correlates with the kill-switch flipping to false. |

**T167 gate**: SLO-F5-002b prod p95 < 1000 ms for 7 consecutive days unblocks T167 (delete optimistic-UI overlay) per `tasks.md` line ~444. Maintainer query (manual eyeball at the end of each 7-day window):

```promql
max_over_time(
  histogram_quantile(0.95,
    rate(webhook_span_duration_ms_bucket{event_type="payment_intent.succeeded",env="prod"}[24h])
  )[7d:1h]
) < 1000
```

If the 7-day rolling max is < 1000 ms, the gate clears. If `slo_f5_002b_breach` fires anywhere in the window, the timer resets to day 0.

### 21.4 Logging redact rules (additions)

Added to `src/lib/logger.ts` redact list for F5 (T032):

```
card_number, card_cvc, card[*], stripe_secret_key, stripe_webhook_secret,
Stripe-Signature, Authorization
```

Plus full webhook body → redacted to `event_id` + `event_type` + `api_version` +
`livemode` only. Defense-in-depth PAN-regex scrub for any field that slips through.

### 21.5 Runbooks

- `docs/runbooks/out-of-band-refund.md` — FR-011a admin used Stripe Dashboard instead of in-app refund
- `docs/runbooks/stale-pending-refund-sweep.md` — pending refund > 24h recovery
- `docs/runbooks/stale-pending-count.md` — cron-job.org configuration for `payments.stale_pending_count` gauge (T138)
- `docs/runbooks/receipt-pdf-permanently-failed.md` — T166 receipt PDF worker exhausted 3 attempts (page on-call)
- `docs/runbooks/receipt-pdf-async-rollback.md` — T166 async receipt PDF kill-switch flip (`FEATURE_F5_ASYNC_RECEIPT_PDF=false`)

### 21.6 Dashboard — F5 Online Payment (Vercel Analytics)

- **Top row**: payment-success rate (1 h gauge), webhook backlog (line), `stale_pending_count` per tenant (table)
- **Second row**: initiate p95/p99 by method, webhook p95/p99, settlement → portal p95
- **Third row**: failure breakdown by `reason_code`, refund volume + success-rate, OOB-refund counter
- **Fourth row** (security): `webhook_signature_rejected_total`, `webhook_api_version_mismatch_total`, `payment_cross_tenant_probe`

### 21.7 Alert routing

- **alarm** → `#oncall-payments` Slack + on-call email digest
- **page** → PagerDuty primary on-call rotation
- **info** (cross-tenant probe at low frequency) → audit log only; alarm at ≥1/5min escalation

---

## 22. F7 Email Broadcast — metrics catalogue (T033)

**Status**: SPEC — emit sites land Phase 3+ (T036+). Branch `010-email-broadcast`.
**Source authority**: `specs/010-email-broadcast/plan.md` § Performance & Capacity deep-dive + § Observability.

F7 wires distributed traces, 16 OTel metrics, and 11 alert rules across the
broadcast lifecycle. The full critical-path span tree:

```
member_compose_page_load
  └─ portal_broadcasts_quota
       └─ broadcasts_repo_count_for_member_quota   (DB — derived view)

member_submit_button_click
  └─ api_broadcasts_submit
       └─ html_sanitiser                           (DOMPurify — Application layer)
            └─ resolve_segment_recipients          (joins members + contacts; suppression filter deferred)
                 └─ broadcasts_repo_insert         (DB — submitted row + reservation derived)
                      └─ audit_broadcast_submitted (DB — same tx)
                           └─ admin_notification_enqueue (Resend transactional, async)

admin_approve_send_now_button
  └─ api_admin_broadcasts_approve
       └─ broadcasts_repo_lock_for_update         (DB — SELECT FOR UPDATE)
            └─ resend_create_audience              (external — Resend Broadcasts API)
                 └─ resend_add_contacts            (external — paginated)
                      └─ resend_create_broadcast   (external)
                           └─ resend_send_broadcast (external — fires dispatch)
                                └─ broadcasts_repo_update_to_sending  (DB)
                                     └─ audit_broadcast_send_started + audit_broadcast_approved

asynchronous webhook delivery (Resend → app):
  webhook_receive
    └─ webhook_verify                              (Svix HMAC-SHA256, raw-body, pre-parse)
         └─ broadcast_deliveries_upsert            (DB — idempotency guard via UNIQUE resend_event_id)
              └─ runInTenant                        (re-bind from pre-tenant bypass context)
                   └─ delivered | bounced | complained | soft_bounced
                        └─ marketing_unsubscribes_upsert (FR-027 cascade on bounce/complaint)
                             └─ audit_broadcast_suppression_applied (DB)

scheduled-dispatch cron (cron-job.org → /api/cron/broadcasts/dispatch-scheduled):
  cron_dispatch_scheduled
    └─ broadcasts_repo_lock_due                    (SELECT FOR UPDATE SKIP LOCKED + advisory_xact_lock)
         └─ approve-send (per row, batched 10/run, 4-min runtime budget)

public unsubscribe page (/unsubscribe/[token]):
  unsubscribe_page_load
    └─ verify_unsubscribe_token                    (HMAC-SHA256 verify)
         └─ runInTenant                             (re-bind from pre-tenant bypass context)
              └─ marketing_unsubscribes_upsert      (DB — idempotent)
                   └─ audit_broadcast_unsubscribed
```

Every span carries `tenant.id`, `broadcast.id`, `actor.role`,
`segment.type` attributes. **No raw HTML body, raw rejection reason text,
recipient email addresses (when used as keys), `Svix-Signature` header
value, or unsubscribe-token plaintext is ever attributed** — those are in
pino's redact list (see § 22.4).

### 22.1 Metrics catalogue (18 metrics)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `broadcasts.draft.count` | counter | `tenant`, `actor_role` (member_self_service\|admin_proxy\|system) | Compose-funnel top-of-funnel signal |
| `broadcasts.submit.count` | counter | `tenant`, `actor_role` | Submission throughput |
| `broadcasts.submit.duration_ms` | histogram | `tenant`, `actor_role` | submit p95 < 1.2 s SLO (sanitiser + segment resolve dominant) |
| `broadcasts.submit.precondition_blocked.count` | counter | `tenant`, `precondition` (a–k from FR-002) | Submission-funnel drop-off (quota exhausted, halted, plan no-eblast, etc.) |
| `broadcasts.approve_send_now.duration_ms` | histogram | `tenant` | approve & send-now p95 < 1.5 s (Resend RTT dominant) |
| `broadcasts.failed_to_dispatch.count` | counter | `tenant`, `failure_reason` (resend_5xx\|resend_429\|resend_403\|app_error\|timeout) | Dispatch-failure forensics |
| `broadcasts.dispatch_failure_rate` | gauge | `tenant` | Computed: `failed_to_dispatch / send_started` over 1h rolling window; > 10 % alert |
| `broadcasts.cron.dispatched.count` | counter | `tenant` | Scheduled-send cron throughput |
| `broadcasts.cron.skipped.count` | counter | `tenant`, `reason` (kill_switch\|no_due_rows) | Cron tick observability. Round 3 G3 fix: `advisory_lock_held` removed — `FOR UPDATE SKIP LOCKED` skips at the Postgres engine level without surfacing skipped-row counts to the app; the label was structurally unemittable. Lock-contention is now indirectly observable via `cron_dispatch_scheduled` span p99. |
| `broadcasts.webhook.receive.count` | counter | `tenant`, `event_type` (delivered\|bounced\|complained\|sent\|delivery_delayed) | Per-event ingest rate |
| `broadcasts.webhook.duration_ms` | histogram | `tenant` | webhook handler p95 < 250 ms |
| `broadcasts.webhook_signature_rejected_total` | counter | `reason` (feature_disabled\|body_too_large\|missing_header\|bad_signature) | Abuse / misconfig canary. Round 3 code-reviewer fix: added `reason` label so secret-rotation incidents read distinct from kill-switch blocks on dashboards. NO tenant label (rejected pre-verification). |
| `broadcasts.bounce_rate_per_broadcast` | gauge | `tenant`, `broadcast_id` | Per-broadcast bounce rate; > 2 % warn, > 5 % page. Cardinality ceiling: see § 22.4. |
| `broadcasts.complaint_rate_per_broadcast` | gauge | `tenant`, `broadcast_id` | Per-broadcast complaint rate; ≥ 0.1 % warn, ≥ 0.5 % page, > 5 % Q14 SC-005 (b) auto-halt. Cardinality ceiling: see § 22.4. |
| `broadcasts.queue_pending` | gauge | `tenant` | `submitted` + `approved-with-scheduled` count; > 8000 warn |
| `broadcasts.stuck_sending_count` | gauge | `tenant` | `status='sending'` for > 24 h count; ≥ 1 alarm |
| `broadcasts.audience_drift_detected.count` | counter | `tenant` | F7.1-IMP5 — emitted whenever idempotency-replay observes a recipient-count mismatch between expected and Resend audience reality. **Black swan event** — should be 0 over weeks; > 0 / 24 h pages ops to investigate partial-delivery scope. Backed by audit event `broadcast_resend_audience_drift`. |
| `broadcasts.drift_check_unverifiable.count` | counter | `tenant` | Round-5 R5-S1 — emitted when `getAudienceContactCount` fails on a non-404 (Resend 5xx / network) during idempotency replay. The replay still advances to `sending` but recipients-delivered count cannot be verified. Backed by audit event `broadcast_resend_drift_check_unverifiable`. > 1 / hour alarm. |
| `broadcasts.dispatch_budget_exhausted.count` | counter | `tenant`, `sub_kind` (network\|timeout\|server_5xx\|api) | **Phase 8 / FR-021 / AS2 (E2 verify-fix 2026-05-02)** — incremented when the 1-hour retry budget elapses with Resend still failing → row transitioned to `failed_to_dispatch`. **Steady state = 0**; any non-zero count in a 15-minute window pages on-call (a member's scheduled E-Blast did not go out). Backed by audit event `broadcast_failed_to_dispatch` + Slice E member transactional notification email. |
| `broadcasts_audit_emit_failed_total` | counter | `tenant`, `event_type` | **R8.5 (R7 silent-failure MED-1 close)** — wired in `safeAuditEmit` + `safeAuditEmitTyped` catch arms (`src/modules/broadcasts/application/use-cases/_safe-audit-emit.ts`). Increments when audit-storage hiccups during a security-rejection / read-only forensic-emit path. **Alert F7-A1**: any non-zero rate sustained ≥ 1 min pages on-call (Principle VIII audit invariant; forensic-trail gap on a swallowable catch arm). Companion to F8-A2 / F6 cron-audit alarms — mirrors the same SIEM-actionable signal-loss pattern. Runbook: `docs/runbooks/audit-emit-loss.md`. |

**Cardinality**: `precondition`, `failure_reason`, `reason`, `event_type`
are bounded enums; `tenant` is small-cardinality (≤ a few hundred over
project lifetime). `broadcast_id` on per-broadcast gauges is bounded by
the recipient cap × broadcast count per tenant per quota year (10/year/member
× ~131 members ≈ 1310 ids/year). **Never** label by `recipient_email_lower`,
`member_id`, or any high-cardinality identifier.

### 22.2 SLO targets (per SC-010 / Q6)

| SLO | Target | Source signal |
|---|---|---|
| SLO-F7-001 compose page TTFB p95 | < 600 ms | Vercel Speed Insights `/portal/broadcasts/new` |
| SLO-F7-002 submit endpoint p95 | < 1.2 s | `broadcasts.submit.duration_ms` (sanitiser + segment resolve included; documented Constitution VII deviation in plan.md) |
| SLO-F7-003 admin queue list p95 | < 500 ms @ 1 k pending | Vercel Speed Insights `/admin/broadcasts` |
| SLO-F7-004 admin approve & send-now p95 | < 1.5 s | `broadcasts.approve_send_now.duration_ms` (Resend RTT dominant) |
| SLO-F7-005 webhook handler p95 | < 250 ms | `broadcasts.webhook.duration_ms` |
| SLO-F7-006 public unsubscribe page TTFB p95 | < 400 ms | Vercel Speed Insights `/unsubscribe/[token]` |
| SLO-F7-007 admin time-to-decision median | ≤ 24 h (FR-013 amber); p95 ≤ 48 h (red) | `GET /api/admin/broadcasts/sla-stats` rolling 30-day computation; SC-002 |
| SLO-F7-008 webhook idempotency | 100 % zero double-processed events | UNIQUE `(tenant_id, resend_event_id)` index (migration 0065) |
| SLO-F7-009 dispatch failure rate | < 1 % over 1 h excluding Resend service incidents | `broadcasts.dispatch_failure_rate` gauge |
| SLO-F7-010 sender reputation | Per-broadcast bounce < 2 %, complaint < 0.1 % steady-state | `bounce_rate_per_broadcast` + `complaint_rate_per_broadcast` |

### 22.3 Alert rules (11 alerts)

| Alert | Severity | Threshold | Runbook |
|---|---|---|---|
| `broadcasts.webhook_signature_rejected_total` ≥ 5 / 5 min | **page** | possible abuse / misconfig (PDPA-relevant) | `docs/runbooks/broadcasts-webhook-attack.md` |
| `broadcast_cross_tenant_probe` ≥ 1 / 5 min | **page** | Constitution Principle I clause 3 breach attempt | `docs/runbooks/breach-notification.md` |
| `broadcasts.dispatch_failure_rate` > 10 % / 1 h | **page** | Resend incident or app bug | `docs/runbooks/broadcasts-dispatch-failure.md` |
| `broadcasts.stuck_sending_count` ≥ 1 (≥ 24 h) | **alarm** | webhook event lost or Resend resource missing | `docs/runbooks/broadcasts-stuck-sending.md` |
| `broadcasts.bounce_rate_per_broadcast` > 2 % | **alarm** | List quality issue; pre-cursor to reputation incident | `docs/runbooks/broadcast-deliverability-incident.md` |
| `broadcasts.bounce_rate_per_broadcast` > 5 % | **page** | Sender reputation at immediate risk | `docs/runbooks/broadcast-deliverability-incident.md` |
| `broadcasts.complaint_rate_per_broadcast` ≥ 0.5 % | **page** | Q14 SC-005 (b) trigger imminent | `docs/runbooks/broadcast-deliverability-incident.md` |
| `broadcast_complaint_rate_per_broadcast_breach` event ≥ 1 / 24 h | **page** | Q14 auto-halt fired; admin clear-halt required | `docs/runbooks/broadcasts-halt-clear.md` |
| `broadcasts.queue_pending` > 8000 | **alarm** | FR-013 SLA breach risk | `docs/runbooks/broadcasts-queue-overflow.md` |
| Any F7 surface p95 budget breach (any of the 6 SLOs above) | **alarm** | UX degradation; investigate per-surface | `docs/runbooks/broadcasts-perf-regression.md` |
| `cron_dispatch_scheduled` span p99 > 30 s / 1 h | **alarm** | Round 3 G3 replacement: was `cron.skipped{advisory_lock_held}` but `FOR UPDATE SKIP LOCKED` returns no skip-count to the app. Span-duration proxy: lock-contention OR Resend latency surge OR DB pool exhaustion all manifest as p99 spikes on this span. | `docs/runbooks/broadcasts-dispatch-failure.md` |
| `broadcasts.audience_drift_detected.count` > 0 / 24 h | **page** | F7.1-IMP5 — recipient-count drift on idempotency replay; partial-delivery investigation required | `docs/runbooks/broadcasts-dispatch-failure.md` |
| `broadcasts.drift_check_unverifiable.count` > 1 / 1 h | **alarm** | R5-S1 — multiple unverifiable replays in a window; Resend availability or app classification bug | `docs/runbooks/broadcasts-dispatch-failure.md` |

### 22.4 Logging redact rules (additions)

Added to `src/lib/logger.ts` redact list for F7 (Phase 3+ T031 wiring):

```
resend_broadcasts_api_key, resend_broadcasts_webhook_secret,
unsubscribe_token_secret, Svix-Signature, Svix-Id, Svix-Timestamp,
recipient_email_lower (when keyed log; allowed in error_message field
  only as part of structured payload, with last 2 chars + domain visible),
body_html (raw — sanitised version may be logged in trace context only,
  capped at 1024 chars), rejection_reason (raw — sha256 only logged)
```

Plus full webhook body → redacted to `resend_event_id` + `event_type` +
`broadcast_id` + `recipient_member_id` + `bounce_type` only.
Defence-in-depth: any field containing `@` regex match → masked except
last 2 chars before `@` + domain.

### 22.4a F7 platform-redaction limitation (T176 — privacy CHK048)

**Status (2026-05-02)**: Vercel does NOT currently expose a per-path
log-redaction primitive that would mask the `/unsubscribe/v1\..*` URL
component in platform access logs / log-drain export. Application-layer
pino redaction (§ 22.4) keeps tokens out of structured app logs, but
Vercel's edge / function access logs may capture the full request URL.

**Mitigation stack (defence-in-depth, ordered by strength)**:

1. **HMAC-signed tokens** (`UNSUBSCRIBE_TOKEN_SECRET`) — leak grants
   only idempotent unsubscribe replay (no PII exfiltration); attacker
   needs both signing-secret compromise AND access to log retention.
2. **Quarterly rotation** of `UNSUBSCRIBE_TOKEN_SECRET` (per
   `docs/runbooks/credential-compromise.md`) bounds the breach window
   to 90 days. Cadence escalates to monthly if a CHK048 follow-up
   audit detects token-shaped strings in the Vercel access-log export.
3. **Vercel log retention window** is 30 days on the current plan —
   tokens older than that age out automatically.
4. **No PII in token payload** beyond the recipient's own email — the
   minimum identity needed to action the unsubscribe.

**Re-evaluation trigger**: Vercel publishes a per-path redaction
primitive (or the log-drain export gains pre-export filtering); F7
upgrades to platform-layer redaction and downgrades the secret-rotation
cadence back to annual baseline.

### 22.5 Sample rates

Per perf.md CHK049:
- **Production**: 10 % trace sampling for spans
- **Staging / dev**: 100 % trace sampling
- All metrics: 100 % aggregation (counters / histograms / gauges fully exported regardless of trace sampling)

### 22.6 Runbooks

- `docs/runbooks/broadcast-deliverability-incident.md` — bounce/complaint spike + Q14 SC-005 (b) auto-halt
- `docs/runbooks/broadcast-cancel-too-late.md` — recipient already received but admin needs follow-up
- `docs/runbooks/breach-notification.md` — cross-cutting PDPA §37 24h + GDPR Art. 33 72h workflow
- `docs/runbooks/credential-compromise.md` — cross-cutting F1+F4+F5+F7 secret-rotation procedure
- `docs/runbooks/broadcasts-stuck-sending.md` — 24h stuck-`sending` reconciliation
- `docs/runbooks/broadcasts-dispatch-failure.md` — `dispatch_failure_rate` > 10 %
- `docs/runbooks/broadcasts-webhook-attack.md` — webhook signature rejection spike
- `docs/runbooks/broadcasts-perf-regression.md` — p95 budget breach
- `docs/runbooks/broadcasts-queue-overflow.md` — `queue_pending` > 8000
- `docs/runbooks/broadcasts-halt-clear.md` — Q14 admin clear-halt walkthrough
- `docs/runbooks/cron-jobs.md` — cron-job.org configuration (F5 + F7 shared)

### 22.7 Dashboard — F7 Email Broadcast (Vercel Analytics)

- **Top row**: queue_pending (line), median_time_to_decision rolling 30d (gauge), dispatch_failure_rate (line)
- **Second row**: submit p95/p99, approve_send_now p95/p99, webhook p95
- **Third row**: per-broadcast bounce + complaint rate heatmap, suppression-list growth, halted-members count
- **Fourth row** (security): `webhook_signature_rejected_total`, `broadcast_cross_tenant_probe`, `unsubscribe_token_invalid`

### 22.8 Alert routing

- **alarm** → `#oncall-platform` Slack + on-call email digest
- **page** → PagerDuty primary on-call rotation
- **info** (cross-tenant probe at low frequency) → audit log only; alarm at ≥ 1 / 5 min escalation

### 22.9 F7.1a Email Broadcast Advanced — metrics catalogue (T122)

Extends § 22.1 with **5 new metrics** for pagination (US1) + image embedding (US2). Module path: `src/lib/metrics/broadcasts-f71a.ts`. Cardinality discipline carries from § 22.1; the explicit `broadcast_id` label on `broadcasts.manual_retry_count` is intentional for ad-hoc forensics and is documented in the module header.

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `broadcasts.batch_dispatch_duration_ms` | histogram | `tenant`, `batch_index` (0..4 for 50k ceiling) | US1 per-batch latency; F7.1a SLO target p95 < 90s sustained ≥15 min ⇒ warn |
| `broadcasts.partial_send_count` | counter | `tenant` | US1 — broadcasts that landed in `partially_sent` terminal state |
| `broadcasts.manual_retry_count` | counter | `tenant`, `broadcast_id` | US1 — admin-initiated retries on `partially_sent` broadcasts (3-budget per FR-008d) |
| `broadcasts.image_scan_duration_ms` | histogram | `tenant`, `verdict` ∈ {clean,infected,error,timeout} | US2 — ClamAV scan latency; SC-005 p95 < 500ms |
| `broadcasts.clamav_signature_age_hours` | observable gauge | (none — shared infra) | US2 — age of most-recent signature DB load, probed hourly via `CLAMD VERSION` |

### 22.10 F7.1a Email Broadcast Advanced — alert rules (T123)

Extends § 22.3 with **4 new alerts**:

| Alert | Severity | Threshold | Runbook |
|---|---|---|---|
| `broadcasts.clamav_signature_age_hours` > 48 | **page** | freshclam stopped pulling new signatures — image scans are increasingly stale | `docs/runbooks/clamav-signature-stale.md` |
| `broadcasts.image_scan_duration_ms` p99 > 5000 over 5 min OR no scan completes in 2 min when uploads attempted (proxy for daemon-unreachable) | **page** | ClamAV daemon down or Fly.io VM unreachable; member upload UX banner already shown | `docs/runbooks/clamav-daemon-down.md` |
| `broadcasts.partial_send_count[1h] / broadcasts.submit.count[1h]` > 0.05 | **alarm** | Partial-send rate > 5% sustained — likely Resend rate-limit pressure or batch-boundary tuning required | `docs/runbooks/broadcast-partial-send-recovery.md` |
| `dispatch_concurrency_saturation` > 0.80 sustained 15 min (computed: active batches / cap 4) | **alarm** | Concurrency cap saturating — batch fan-out may queue; review concurrency policy if persistent | `docs/runbooks/broadcasts-perf-regression.md` |

The 4 F7.1a alerts route per § 22.8 (alarm → `#oncall-platform`; page → PagerDuty). Two F7.1a-specific runbooks land under `docs/runbooks/` for the ClamAV alerts; the partial-send alert shares the broadcasts-perf-regression triage tree plus a dedicated `broadcast-partial-send-recovery.md` decision tree.

---

## 23. F8 Renewal Tracking + Smart Reminders — observability

**Lineage**: spec § Performance & Observability (FR-046, SC-003 pipeline p95, SC-005 at-risk recompute p95). Round-4 staff-review-2026-05-09 closed R4-S8 (this section was missing) + R4-W7 (cron field-aliasing semantics).

F8 ships dark behind `FEATURE_F8_RENEWALS=false` until F9 admin shell lands. All metrics + alerts described here MUST be wired before the production flag-flip.

### 23.1 Metrics catalogue

#### 23.1.1 Pipeline dashboard

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `renewals.pipeline.load_duration_ms` | histogram | `tenant_id`, `tier_filter`, `urgency_filter` | OTel span `admin_pipeline_load` | SC-003 |
| `renewals.pipeline.row_count` | gauge | `tenant_id`, `urgency_band` | rows on the CURRENT page (≤ page-size 50) per load — NOT the in-window total (that is bucketed on the span to avoid a per-tenant scale leak) | — |
| `renewals.pipeline.lapsed_tab_visit_total` | counter | `tenant_id` | route handler | — |

#### 23.1.1.b Phase 9 / T231 — business-volume counters

These counters power the ops dashboard view of "what F8 actually did today". Distinct from operational/incident counters above; these feed the SLO panels for FR-046 + FR-029 + FR-037.

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `renewals_reminders_sent_total` | counter | `tier_bucket` (5-enum), `offset_day` (~6-enum), `caught_up` (bool) | `dispatch-one-cycle.ts` success path — `caught_up=true` means the send came from the bounded catch-up recovery path rather than the normal dispatch window; a spike here signals cron-health degradation (see F8-A13) | FR-010 |
| `renewals_reminders_skipped_total` | counter | `reason` (FR-012 SkipReason union, ~10-enum) | `dispatch-one-cycle.ts:emitSkipAudit` | FR-012 |
| `renewals_reminders_failed_total` | counter | `reason` (gateway error kind, ~5-enum) | `dispatch-one-cycle.ts` failure path | FR-010a |
| `renewals_self_service_completed_total` | counter | `tenant` | `confirm-renewal.ts` success | US3 |
| `renewals_self_service_failed_total` | counter | `tenant`, `reason` (~6-enum from `selfServiceFailureReason`) | `/api/portal/renewal/[memberId]/confirm/route.ts` | US3 |
| `at_risk_scores_recomputed_total` | counter | `tenant` | `compute-at-risk-score.ts` | FR-029 |
| `at_risk_threshold_crossings_total` | counter | `tenant`, `from_band`, `to_band` (4 × 4 = 16) | `compute-at-risk-score.ts` band-cross | FR-031 |
| `tier_upgrade_suggestions_created_total` | counter | `tenant`, `target_tier` (5-enum) | `evaluate-tier-upgrade.ts` insert path | FR-037 |
| `tier_upgrade_suggestions_accepted_total` | counter | `tenant` | `accept-tier-upgrade.ts` | FR-039 |
| `renewals_cycles_active` | observable gauge | `tenant` | `renewalsMetrics.observeCycleStateGauge('active', …)` | FR-046 |
| `renewals_cycles_in_grace` | observable gauge | `tenant` | `renewalsMetrics.observeCycleStateGauge('in_grace', …)` | FR-004 |
| `renewals_cycles_lapsed_total` | observable gauge | `tenant` | `renewalsMetrics.observeCycleStateGauge('lapsed_total', …)` | FR-007a |

**Cardinality hygiene**: every label is a bounded enum or small-cardinality string. NEVER use member-id / email / IP as a label — those belong in traces + logs, not metrics.

#### 23.1.2 At-risk widget + recompute

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `renewals.at_risk.recompute_duration_ms` | histogram | `tenant_id`, `members_total` | OTel span `at_risk_recompute_per_tenant` | SC-005 |
| `renewals.at_risk.recompute_members_succeeded_total` | counter | `tenant_id`, `band` | use-case | — |
| `renewals.at_risk.recompute_members_failed_total` | counter | `tenant_id` | use-case | — |
| `renewals.at_risk.snooze_total` | counter | `tenant_id`, `actor_role` | use-case | — |
| `renewals.at_risk.outreach_recorded_total` | counter | `tenant_id`, `channel`, `template_id` | use-case | — |

#### 23.1.3 Cron coordinators (4 paths)

All 4 coordinators emit a single `cron_dispatch_orchestrated` audit on completion. The audit payload's **`cron_kind` discriminator** distinguishes which path produced the event (added in Phase 6 review I3 + verified by 4 unit tests in `tests/unit/api/cron/renewals/{dispatch,at-risk}-coordinator.test.ts`):

| `cron_kind` | Coordinator route | Schedule |
|---|---|---|
| `dispatch` | `/api/cron/renewals/dispatch-coordinator` | daily |
| `at_risk_recompute` | `/api/cron/renewals/at-risk-recompute-coordinator` | weekly |
| `lapse` | `/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator` | daily |
| `reconcile` | `/api/cron/renewals/reconcile-pending-reactivations-coordinator` | daily |

**R4-W7 field-aliasing note (staff-review-2026-05-09)**: at-risk + lapse + reconcile coordinators reuse the `reminders_dispatched` and `tasks_created` payload field names with kind-specific semantics. Treat the (`cron_kind`, `reminders_dispatched`, `tasks_created`) tuple as kind-discriminated:

| `cron_kind` | `reminders_dispatched` means | `tasks_created` means |
|---|---|---|
| `dispatch` | reminder emails sent (literal) | escalation tasks created (literal) |
| `at_risk_recompute` | members recomputed | members failed |
| `lapse` | cycles transitioned to lapsed | per-tenant errors |
| `reconcile` | reminders fired (T-7/T-3/T-1) | timeouts processed |

**Alert query rule**: every alert keyed on `reminders_dispatched` or `tasks_created` MUST include a `cron_kind = '<expected>'` filter to avoid double-counting across coordinators that fire in overlapping windows. Example PromQL guard: `cron_dispatch_orchestrated{cron_kind="dispatch"}` not `cron_dispatch_orchestrated`.

| Metric | Type | Labels | Source |
|---|---|---|---|
| `renewals.coordinator.tenants_enqueued_total` | counter | `cron_kind` | coordinator audit |
| `renewals.coordinator.tenants_succeeded_total` | counter | `cron_kind` | coordinator audit |
| `renewals.coordinator.tenants_failed_total` | counter | `cron_kind` | coordinator audit |
| `renewals.coordinator.duration_ms` | histogram | `cron_kind` | OTel span (lapse + reconcile + at-risk; dispatch span existed since Wave I5) |
| `renewals.coordinator.audit_emit_failed_total` | counter | `cron_kind` | error path |
| `renewals.cron_bearer_auth_rejected_total` | counter | `route` | 401 path |

**Phase 8 — Escalation task queue (US6, R10 W9 close)**

The Phase 8 admin queue + 4 admin actions (`POST done|skip|reassign`) emit the audit events
`escalation_task_completed`, `escalation_task_skipped`, `escalation_task_reassigned` (5-year retention each)
plus the queue-load `escalation_task_created` already emitted by the 6 inline producers. The metrics below
SHOULD be wired before the production flag-flip — they currently rely on the existing `cron_kind`-aware
coordinator metrics + the F1-shared `pino`-derived structured logs. None are part of the SLO breach gate
because the queue is admin-only (no member-facing latency SLO); the SLO row below covers the queue page
load only.

| Metric | Type | Tags | Source | SLO link |
|---|---|---|---|---|
| `renewals.escalation_task.queue_load_duration_ms` | histogram | `tenant_id`, `assignment_filter`, `status_filter` | `tasks/page.tsx` server component (R10 forward — not yet wired) | F8-SLO-Esc-1 |
| `renewals.escalation_task.action_total` | counter | `tenant_id`, `action ∈ {done,skip,reassign}`, `outcome ∈ {success,task_not_found,task_not_open,server_error}` | `tasks/[taskId]/{done,skip,reassign}/route.ts` (R10 forward) | — |
| `renewals.escalation_task.overdue_count` | gauge | `tenant_id` | per page-load summary (existing port `countMatching`) | — |
| `renewals.escalation_task.audit_emit_failed_total` | counter | `event_type ∈ {completed,skipped,reassigned}` | use-case catch arm (existing pino warn breadcrumb) | F8-A2 (rolls up into the existing audit-emit alarm) |

#### 23.1.5 Reconcile-pending-reactivations — timeout outcome counters (branch 063)

Added in branch `063-renewal-audit-fixes` to close the money-observability gap identified in the Round-2 reliability review. Each counter captures a distinct outcome path inside `processTimeout` so SRE can triage money-at-risk situations without reading Stripe refund histories manually.

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `renewals_reconcile_timeout_transition_failed_post_refund_total` | counter | `tenant` | `processTimeout` — refund succeeded, tx2 cycle-transition threw (non-conflict DB blip); cycle stays `pending_admin_reactivation` with refunded money; self-heals next cron run | F8-A13 (paging) |
| `renewals_reconcile_timeout_transition_failed_no_refund_total` | counter | `tenant` | `processTimeout` — tx2 transition threw but no refund had been issued (no invoice / no settled charge); no money at stake; self-heals next cron run | informational |
| `renewals_reconcile_timeout_refund_orphaned_total` | counter | `tenant` | `processTimeout` — refund issued, then admin/conflict won the tx2 window (accepted residual #6); money returned to member against a now-non-pending cycle | informational |
| `renewals_reconcile_timeout_admin_race_skipped_total` | counter | `tenant` | `processTimeout` — re-read under lock found cycle no longer `pending_admin_reactivation`; admin won Step-1 before refund, NO money moved, clean no-op | informational |

**Cardinality note**: all four counters carry a single `tenant` label. Tenant count is bounded (single-tenant deployed; MTA+STD path grows linearly with onboarded organisations, not with members), so cardinality is safe.

**Paging distinction**: ONLY `renewals_reconcile_timeout_transition_failed_post_refund_total` pages on-call (F8-A13 below). The other three are 📉 Report / informational — a non-zero rate is expected under normal admin–cron contention. Do NOT add paging alerts to the informational counters; see § 1 alert philosophy.

#### 23.1.6 Cycle cold-start failures (F8-completion Slice 1)

The two cold-start entry points that create a member's INITIAL renewal cycle each have a failure counter. They differ in error discipline and therefore in severity (see § 23.3 F8-A18 / F8-A19).

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `renewals_bootstrap_cycle_create_failed_total` | counter | `tenant` | `create-member.ts` post-commit `onboardingListeners` swallow loop (`renewalsMetrics.bootstrapCycleCreateFailed`) — the POST-LAUNCH new-member onboarding arm | FR-046 (pipeline coverage) |
| `renewals_import_cycle_create_failed_total` | counter | `tenant` | `scripts/import-members.ts` `commitMembers` per-row catch (`renewalsMetrics.importCycleCreateFailed`), bumped BEFORE the re-throw — the COLD-START import arm | — |

**Error-discipline distinction (load-bearing for the alert severity):**

- `bootstrap_cycle_create_failed` fires from the **only swallow site** in F8-completion. The onboarding listener runs POST-COMMIT in its own tx after the member is already durably created; there is no tx to roll back and no webhook retry to heal it, so a failure is logged + counted + the member create still returns ok. A non-zero rate therefore means **NEW MEMBERS ARE SILENTLY DROPPING OUT OF THE RENEWAL PIPELINE** (no cycle → never reminded → never renewed) with no other surface — **page-worthy** (F8-A18). Replay is safe: createCycleInTx is idempotent (`findActiveForMemberInTx`), so an admin re-trigger heals the member.
- `import_cycle_create_failed` fires from inside the import's batch tx, which does **NOT** swallow — the throw rolls the whole import back atomically. The counter exists so the operator sees WHICH run/row aborted (correlate with the paired error log's row-index). The import is idempotent on re-run after the data is fixed, so this is **operator-facing, not page-worthy on its own** (F8-A19 — informational/alarm).

**Cardinality note**: both counters carry a single `tenant` label (bounded — single-tenant deployed; MTA+STD grows linearly with onboarded organisations, not members). NEVER a member-id / email / company label (PII forbidden in metrics; the uuid/row-index lives in the paired error log only).

### 23.2 SLOs — F8

| SLO | Target | Window | Metric | Action on breach |
|---|---|---|---|---|
| **SC-003** Admin pipeline render | p95 < 500 ms @ 5 k members + 600 in window | rolling 1 d | `renewals.pipeline.load_duration_ms` | alarm `#oncall-platform`; capture trace; check Neon connection pool |
| **SC-005** At-risk recompute per tenant | p95 < 60 s @ 5 k members | per-cron-run | `renewals.at_risk.recompute_duration_ms` | alarm + freeze cron flag-flip until rectified |

**SC-005 index dependency** (R5-WRN-3 staff-review-2026-05-09 Round 2): the at-risk CTE's correlated EXISTS sub-query against `audit_log` for FR-029 factor 8 (recent tier-downgrade signal) requires the partial index `audit_log_f8_tier_change_idx` (migration `0115_f8_audit_log_member_plan_changed_idx.sql`) for the planner to reach `member_plan_changed` rows via Index Scan. Without it the EXISTS branch falls back to a Bitmap Heap Scan + recheck and SC-005 confidence drops below MEDIUM at production scale (>50k audit rows per active tenant per month). DBAs investigating SC-005 latency regressions should `EXPLAIN ANALYZE` the CTE in `gatherAtRiskFactorsForTenant` (`src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts:417`) and verify the planner uses `audit_log_f8_tier_change_idx`.
| **F8 cron dispatch** | p95 < 30 s per tenant | per-cron-run | `renewals.coordinator.duration_ms{cron_kind="dispatch"}` | investigate slow tenants |
| **F8 audit emit failure** | < 0.1 % of state-mutating use-case calls | rolling 1 d | `renewals.coordinator.audit_emit_failed_total` | page on-call (audit invariant Constitution VIII) |
| **F8-SLO-Esc-1** Escalation task queue load (Phase 8 R10 W9) | p95 < 500 ms @ 200 open tasks per tenant | rolling 1 d | `renewals.escalation_task.queue_load_duration_ms` (forward — see § metrics table above) | alarm `#oncall-platform`; check Neon RLS plan + `countMatching` index usage |

**SC-005 measurement evidence (staff-review-2026-05-09 Round-4 closure)**: ran `RUN_PERF=1 pnpm test:integration tests/integration/renewals/at-risk-recompute-perf.test.ts` against Neon Singapore on 2026-05-09 04:05 UTC+7 with 5,000 seeded members:
- `list=5491ms` (pre-recompute eligibility query)
- `cron=10374ms` total batched recompute
- per-member: p50=p95=p99=avg=2.1 ms (CTE-batched UPDATE — single round-trip per 5 k members)
- **6× headroom** under the 60 s budget

### 23.3 Alerts — F8 initial set

| ID | Rule | Severity | Routing |
|---|---|---|---|
| F8-A1 | `renewals.coordinator.tenants_failed_total{cron_kind=*}` ≥ 1 in any 5-min window | alarm | `#oncall-platform` |
| F8-A2 | `renewals.coordinator.audit_emit_failed_total` ≥ 1 in any 5-min window | page | PagerDuty primary |
| F8-A3 | `cron_bearer_auth_rejected_total` ≥ 5 in any 1-min window | alarm + audit-log review | `#oncall-platform` |
| F8-A4 | `renewals.at_risk.recompute_duration_ms` p95 > 60 000 (SC-005) | alarm | `#oncall-platform` + freeze flag-flip |
| F8-A5 | `renewals.pipeline.load_duration_ms` p95 > 500 (SC-003) | alarm | `#oncall-platform` |
| F8-A6 | `lapsed_member_action_blocked` audit emit ≥ 50 in any 1-h window per tenant | info → alarm | check for compromised member account or admin script |
| F8-A7 | `renewal_cross_member_probe` audit emit ≥ 1 in any 1-h window per tenant | alarm | possible IDOR attempt — review actor |
| F8-A8 | `renewals.escalation_task.action_total{outcome="server_error"}` ≥ 3 in any 5-min window | alarm | `#oncall-platform` — investigate transient repo or audit-emit failures (R10 W9 close) |
| F8-A9 | `renewals.manual_plan_change_listener_failed_total{listener,tenant_id}` ≥ 1 in any 5-min window | alarm | `#oncall-platform` — F2 plan-change → F8 supersede/reschedule swallowed an exception (POST-MVP-OBS-7 / R5-C4 close). Without this alert, F2 manual plan change can leave an orphan tier-upgrade-suggestion that the reconcile cron only catches if cycle goes terminal — admins hitting `member_open_uniq` conflict get no diagnostic. The `wrapListener` swallow contract (`f2-plan-change-bridge.ts:77-95`) is correct (F2 plan-flip is source of truth) but MUST be alerted. |
| F8-A10 | `renewals.bounce_hook_failed_total{tenant_id IS NOT NULL}` ≥ 1 in any 5-min window per tenant | alarm | `#oncall-platform` — F8 detect-bounce-threshold use-case threw on a Resend webhook bounce event (R5-C3 split). With the per-tenant tag (vs `null` for upstream DB lookup failures), SRE can trace which tenant's `email_unverified` flag is at risk of staying FALSE. |
| F8-A11 | `renewals_tier_upgrade_audit_emit_failed_total{audit_type, tenant_id}` ≥ 1 in any 5-min window | alarm | `#oncall-platform` — F8 tier-upgrade audit emit failed inside a swallowable catch arm (Staff-R004 close). Drift between the use-case's state-write success and the audit row landing → forensic chain gap per Constitution Principle VIII visibility. Per-`audit_type` slicing distinguishes the 4 known catch sites (member-notify happy/skip/fail + aggregate already-at-target). |
| F8-A12 | `renewals_at_risk_audit_emit_failed_total{audit_type, tenant_id}` ≥ 1 in any 5-min window | alarm | `#oncall-platform` — F8 at-risk audit emit failed inside the skip-below-min-tenure swallowable catch arm (R5-S1 close). Counter is the alert signal (logger.warn alone is invisible to dashboard alerting). |
| F8-A13 | `renewals_reconcile_timeout_transition_failed_post_refund_total` non-zero rate sustained ≥ 15 min | 🚨 page | PagerDuty primary (Renewals/Billing on-call) — Stripe refund succeeded but the F8 cycle-transition kept failing across multiple cron passes; refunded money is stuck on a `pending_admin_reactivation` cycle. The cron self-heals on each pass (F5 short-circuits re-refund), but a SUSTAINED rate means the self-heal is NOT clearing. Runbook: (1) query `SELECT * FROM renewal_cycles WHERE status = 'pending_admin_reactivation' AND tenant_id = '<tenant>'` and cross-check the Stripe refund status for those invoice IDs via F5 payment history; (2) inspect why `transitionStatus` keeps throwing (RLS regression, unique-constraint, Neon connection pool exhaustion); (3) manually transition the stuck cycle once the DB fault is resolved. |
| F8-A14 | `renewals_reconcile_timeout_transition_failed_no_refund_total` — informational only; no alert fires | 📉 report | No page, no Slack — review weekly if the counter is elevated and sustained (signals a systemic tx2 DB fault on the reconcile path, but with zero money at stake; distinguish explicitly from F8-A13 which involves refunded money). |
| F8-A15 | `renewals_reconcile_timeout_refund_orphaned_total` — informational only; no alert fires | 📉 report | No page, no Slack — review weekly; a sustained rate spike warrants checking whether the daily cron cadence + 30-day timeout window are aligned with admin reactivation workflows (accepted residual #6; member already received the refund, admin action was canonical). |
| F8-A16 | `renewals_reconcile_timeout_admin_race_skipped_total` — informational only; no alert fires | 📉 report | No page, no Slack — review weekly; a sustained rate > 5 / cron-pass suggests the nightly cron is overlapping with a peak admin reactivation window; consider adjusting cron schedule to off-peak hours (no money moved on this path). |
| F8-A17 | `rate(renewals_reminders_sent_total{caught_up="true"}) / rate(renewals_reminders_sent_total)` rising above baseline over a 1-h rolling window (healthy cron should have ~0 catch-up sends) | ⚠ warn | `#oncall-platform` — spike in `caught_up=true` dimension signals cron-health degradation: the bounded catch-up recovery path in 063 is compensating for missed dispatch cron passes. Runbook: (1) check cron-job.org dispatch-coordinator recent runs for failures or skips; (2) verify `CRON_SECRET` is still valid on the dispatch route; (3) if catch-up volume exceeds one full day of normal reminder volume, escalate to paging. |
| F8-A18 | `renewals_bootstrap_cycle_create_failed_total{tenant}` non-zero rate sustained ≥ 5 min | 🚨 page | PagerDuty primary (Renewals/Billing on-call) — the POST-COMMIT `createMember` onboarding listener (F8-completion Slice 1) failed to create a new member's initial renewal cycle and the use-case swallowed it (the only swallow site in F8-completion — the member is already durably committed). A non-zero rate means **new members are silently dropping out of the renewal pipeline** (no cycle → never reminded → never renewed) with no other surface. Runbook: (1) read the paired `[create-member] post-commit onboardingListener threw` error log for the affected `tenant` + `memberId` (uuid only — no PII in the metric); (2) diagnose why createCycleInTx threw (plan not resolvable for the member's plan_id, RLS regression, Neon pool exhaustion, pgEnum drift on `renewal_cycle_created`); (3) once fixed, replay is safe — createCycleInTx is idempotent (`findActiveForMemberInTx`), so an admin re-trigger of cycle creation for the affected member heals it without a duplicate. |
| F8-A19 | `renewals_import_cycle_create_failed_total{tenant}` non-zero rate (operator-facing) | 📉 report / alarm on a CI/import run | `#oncall-platform` (informational) — a per-row cycle-insert failure in the one-time member import (`commitMembers`, F8-completion Slice 1) aborted the batch. UNLIKE F8-A18 this does NOT page on its own: the import is in-tx and does NOT swallow, so the whole batch rolled back atomically (no partial state) and the operator re-runs after fixing the data (idempotent). Runbook: (1) read the paired `[import-members] cycle creation failed for row <N>` stderr line for the row-index + member uuid; (2) fix the offending row's `plan_id` / data; (3) re-run `--commit` (idempotent — already-cycled members are a `findActiveForMemberInTx` no-op). Escalate to a page only if the import is on the critical launch path and blocking go-live. |

### 23.4 Forbidden log fields (F8-specific extension to § 3 universal list)

In addition to the universal forbidden fields (passwords, session IDs, tokens, Authorization headers):

- **F8 renewal-link tokens** — only `tokenHash` (SHA-256 base64url) may appear in logs; raw `token` query-string value is forbidden
- **Resend `delivery_id`** — admin-only forensic identifier; not exposed to member-facing API responses or member-tier OTel spans
- **At-risk score `contributions`** — full factor-by-factor breakdown is admin-only (FR-035 demotivation guard); member-facing logs may carry `band` only, never `contributions[]`

### 23.5 Sample rates

Inherits § 22.5: 10 % trace sampling in production; 100 % aggregation on metrics.

### 23.6 Runbooks

- `docs/runbooks/cron-jobs.md` — F8 cron-job.org configuration (extended from F5 + F7 shared file with the 4 F8 coordinators)
- `docs/runbooks/at-risk-perf-regression.md` — SC-005 budget breach (>60 s) workflow
- `docs/runbooks/pipeline-perf-regression.md` — SC-003 budget breach (>500 ms p95) workflow
- `docs/runbooks/audit-emit-loss.md` — Constitution VIII audit-trail-loss escalation (covers F8 + earlier features)

### 23.7 Dashboard — F8 (Vercel Analytics)

- **Top row**: pipeline-load p95 (line, SC-003 target 500 ms), at-risk p95 per tenant (line, SC-005 target 60 s), lapsed-tab visit count (gauge)
- **Second row**: dispatch coordinator duration, at-risk coordinator duration, lapse coordinator duration, reconcile coordinator duration
- **Third row**: tenants_succeeded vs failed (per `cron_kind`), audit emit failed per kind, bearer auth rejected per route
- **Fourth row** (security): `lapsed_member_action_blocked` heatmap, `renewal_cross_member_probe` (alarm-on-1), `f8_role_violation_blocked` (manager-role mutation attempts)

### 23.8 Owner

**F8 section**: The maintainer who ships F8 (currently @Jirawatpyk) is the initial owner of metrics, SLOs, and alerts; ownership transfers to the Renewals product engineer once a dedicated team forms.

### 23.9 `safeMetric` swallow contract — log scrape requirements (Round 5 SUG-6)

The `safeMetric()` wrapper in `src/lib/metrics.ts` swallows OTel adapter
errors via `console.warn` (NOT pino). This is intentional: the metrics
module is loaded by client-bundled paths and pulling pino into the
client bundle is forbidden by the Clean Architecture boundary. Practical
effect for observability:

- Vercel runtime-log aggregation captures BOTH `console.warn` and pino
  JSON lines. Search filters that match only on pino's `{level: ...}`
  shape will miss `safeMetric` swallow events.
- Scrape rules for `metrics_emit_failed_swallowed` should match on the
  string `"[metrics:safeMetric]"` prefix that the wrapper writes
  before the swallowed error. See `src/lib/metrics.ts` for the exact
  format.
- For Sentry/Datadog scrape configs: include `console.warn` lines in
  the F8 + F4 + F5 + F7 metric-failure alert rules — pino-only filters
  miss this swallow class.

This is documented as a known limitation; consolidating to a single
log shape would either pull pino into the client bundle (forbidden)
or lose the structured-JSON property of pino logs. The dual-source
scrape is the deliberate trade-off.

---

## 24. F6 EventCreate Integration — observability

**Lineage**: spec.md § Functional Requirements FR-036; SC-003 webhook ingest p95; plan.md § VII Distributed tracing; round-6 staff-review (2026-05-13) closed agent-flagged BLOCKER (this section was missing — F7 § 22 + F8 § 23 set the parity bar).

F6 ships dark behind `FEATURE_F6_EVENTCREATE=false` until SweCham completes the pre-flag-flip operator checklist (see `specs/012-eventcreate-integration/retrospective.md` § "Pre-flag-flip operator checklist"). All 11 metrics in this section MUST be wired before the production flag-flip; SLO alerts MUST be configured before any tenant onboards. Metrics declared but unwired (idempotency-sweep, pseudonymisation-sweep, secret-rotation) ship their handler in Phase 10 + Phase 8 respectively — the counter declarations exist now so dashboards can subscribe ahead of the handler landing.

### 24.1 Metrics catalogue

#### 24.1.1 Webhook ingest (Phase 3 — shipped)

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `eventcreate_webhook_receipts_total` | counter | `tenant`, `signature_outcome` (5-enum), `processing_outcome` (14-enum) | route.ts step 1-10 | FR-036 #1, SC-002 derived |
| `eventcreate_webhook_ingest_latency_ms` | histogram (ms) | `tenant` | use-case end-to-end | FR-036 #2, SC-003 |
| `eventcreate_webhook_body_oversized_total` | counter | `tenant` | route.ts step 2/3.5 | DoS guard |
| `eventcreate_rate_limit_fallback_total` | counter | `tenant` | events-webhook-deps.ratelimitCheck | Upstash fail-open observability |
| `eventcreate_audit_fallback_double_failure_total` | counter | `tenant`, `primary_stage` (4-enum) | ingest-webhook-attendee catch | FR-037 catastrophic |

#### 24.1.2 Admin surface (Phase 4 — shipped)

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `admin_events_list_p95_ms` (derived from OTel span) | histogram | `tenant.id` | span `admin_events_list` | SLO-F6-002 |
| `admin_events_detail_p95_ms` (derived from OTel span) | histogram | `tenant.id` | span `admin_events_detail` | SLO-F6-003 |

Spans carry bounded-cardinality attributes only: `tenant.id`, `f6.page`, `f6.page_size`, `f6.unmatched_only`, `f6.has_search_query`. EventId is deliberately NOT a span attribute (potential PII / unbounded label).

#### 24.1.3 Background sweep (declared in Group 2 R6-W4 — handler lands Phase 10 T116)

| Metric | Type | Labels | Source | SLO ref |
|---|---|---|---|---|
| `eventcreate_idempotency_sweep_rows_total` | counter | `tenant`, `outcome` (swept|skipped) | (Phase 10) sweep cron handler | FR-036 #11 |
| `eventcreate_pii_pseudonymisation_sweep_rows_total` | counter | `tenant`, `outcome` (pseudonymised|skipped) | (Phase 10) retention cron | FR-036 #10, SC-011 |

#### 24.1.4 Phase 6+ deferred (declaration ships with each phase)

| Metric | Phase | Notes |
|---|---|---|
| `eventcreate_match_rate` | Phase 4+ | observable gauge per tenant; computed from `eventcreate_webhook_receipts_total{processing_outcome=matched_*}` ratio |
| `eventcreate_quota_partnership_decremented_total` | Phase 6 (shipped staff-review-4 WARN-1) | counter labelled tenant + plan tier (plan_tier='unknown' pending PERF-05 Phase 10 follow-up — payload threading) |
| `eventcreate_quota_cultural_decremented_total` | Phase 6 (shipped staff-review-4 WARN-1) | counter labelled tenant + plan tier (plan_tier='unknown' pending PERF-05) |
| `eventcreate_quota_credit_back_total` | Phase 6 (shipped staff-review-4 WARN-1) | counter labelled tenant + cause (refund|archive|relink) + scope (partnership|cultural) |
| `eventcreate_quota_over_quota_warnings_total` | Phase 6 (shipped staff-review-4 WARN-1) | counter labelled tenant + scope (partnership|cultural) — burst threshold alert R10 |
| `eventcreate_csv_import_duration_ms` | Phase 7 | **Shipped as `eventcreate_csv_import_duration_seconds`** (seconds, not ms — staff-review L-NEW-1 2026-05-16 reconciled the deferred-row name drift). Histogram per tenant. |
| `eventcreate_webhook_secret_rotation_total` | Phase 8 | counter per tenant |
| `eventcreate_tenant_ingest_disabled_gauge` | Phase 8 | observable gauge — 1 when tenant disabled |

#### 24.1.5 F6.1 — CSV Import Primary Path + EventCreate Format Adapter (Feature 013, shipped staff-review T061 2026-05-16)

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `eventcreate_csv_adapter_mode_detected_total` | counter | `tenant`, `format` (`eventcreate_csv` \| `generic_csv`) | Emitted once per upload at top of `importCsv` use-case after parser format detection. Feeds rollback-trigger signal per spec § Rollback Plan and FR-025. Adoption tracking signal: drop to zero on tenants known to use EventCreate = header drift alert (see `f6_eventcreate_adapter_drift` below). |
| `eventcreate_csv_error_csv_downloaded_total` | counter | `tenant` | Emitted on successful signed-URL generation in `generateErrorCsvSignedUrl` use-case, AFTER strict-audit emit (`csv_import_error_csv_downloaded`) succeeds. PII-access frequency signal. |
| `eventcreate_csv_import_audit_emit_failed_total{event_type='csv_import_cross_tenant_probe'}` | counter | `tenant`, `event_type` | Wired in `/api/admin/events/import/route.ts` cross-tenant probe failure path (staff-review H-2, 2026-05-16). Alerts on `rate > 0` because each emit failure is a forensic-trail gap on a Constitution Principle I clause 4 security event. Shares the existing `csvImportAuditEmitFailed` counter with `csv_import_completed` / `csv_import_row_failed` / `csv_import_event_mismatch_overridden` / `csv_import_row_state_changed` / `csv_import_row_cancelled_no_prior` / `event_created` so SRE dashboards can `group by event_type`. |
| `eventcreate_csv_safety_net_fallback_total` | counter | `tenant`, `reason` (`result_err` \| `threw`) | Emitted by `importCsv` fingerprint safety-net (FR-019b) on query failure → fail-open path; non-zero rate signals DB/pool instability that is silently masking event-mismatch detection. `reason` discriminates between Result-Err return (`result_err`) and thrown exception (`threw`) — staff-review M-NEW-7 (2026-05-16) added this label to match the actual emit at `metrics.ts:3104`. |
| `eventcreate_bridge_event_attendees_query_failed_total` | counter | `tenant` | Emitted by the F6 → F8 bridge adapter (`drizzleEventAttendeesQuery`) on any DB blip / RLS regression / pool exhaustion. Adapter fails open with `[]` per F8 `EventAttendeesPort` no-throw contract → at-risk scorer reads empty attendance → silent low-risk-scoring drift. **Alert: rate > 0 sustained ≥5 min, priority WARN** — see `docs/runbooks/f6-bridge-eventattendees-degraded.md`. Round 2 R2-I3 added the runbook. |
| `eventcreate_cron_audit_emit_failed_total` | counter | `route` | F6 cron coordinator 401-path audit emit failed; the `cron_bearer_auth_rejected` audit row is lost. Wired via `gateCronBearerOrRespond({metricsCounter})` on all 4 F6 cron routes (B16). Alert on sustained rate > 0 → forensic-trail gap on Constitution Principle I clause 4 security event. |
| `eventcreate_cron_redis_fallback_total` | counter | `route` | F6 cron coordinator rate-limit check fell back to in-memory bucket (Upstash unreachable). Wired via `gateCronBearerOrRespond({rateLimitFallbackCounter})` on all 4 F6 cron routes. Operational signal for Upstash degradation — security gate continues to deny. |
| `eventcreate_match_resolution_invariant_violation_total` | counter | `tenant` | R3.4.2 / IMP-1 — emitted by `drizzleRegistrationsRepository.toAggregate` when `asMatchResolutionView` throws `MatchResolutionInvariantError` (read-time invariant). Migration 0136 CHECK prevents the write-time path; a non-zero rate signals DB CHECK regression OR RLS misconfig surfacing rows that violate the invariant. **Alert: rate > 0 sustained ≥1 min → P1 page** — DB CHECK regression suspected. |
| `eventcreate_grace_state_invariant_violation_total` | counter | `tenant` | R5.1 / Round 4 C-1 — emitted by `drizzleTenantWebhookConfigRepository.toAggregate` + `events-webhook-deps.loadTenantWebhookConfig` when `asGraceState` throws `GraceStateInvariantError` (half-set pair at read time). Migration 0129 CHECK prevents the write-time path; non-zero rate signals DB CHECK regression OR RLS misconfig OR manual UPDATE bypassing the app layer. Mirrors the matchResolutionInvariantViolation pattern. **Alert: rate > 0 sustained ≥1 min → P1 page** — DB CHECK regression suspected. |
| `eventcreate_csv_error_csv_download_rate_limit_exceeded_total` | counter | `tenant` | R6.W R011 / Staff R2 R035 — F6.1 error-CSV download rate-limit hit counter. Emitted by `/api/admin/events/import/{recordId}/error-csv` 429 path when an admin actor exceeds the 20/hr per-(tenant, actor) cap. Bounds PII bulk-exfiltration via compromised admin sessions. **Alert: rate > 5/min sustained ≥10 min → P3 page** — possible insider exfiltration; cross-reference with admin auth session activity. |

### 24.2 SLOs

| SLO ID | Target | Measurement source | Error budget |
|---|---|---|---|
| **SLO-F6-001** webhook ingest p95 | < 300 ms | `eventcreate_webhook_ingest_latency_ms` p95 over 5-min sliding window | 1% per 30d window |
| **SLO-F6-002** admin list p95 | < 500 ms @ 100 events × 25/page | OTel span `admin_events_list` p95 | 1% per 30d |
| **SLO-F6-003** admin detail p95 | < 800 ms @ 500 attendees × 50/page | OTel span `admin_events_detail` p95 | 1% per 30d |
| **SLO-F6-004** idempotency-sweep liveness | rate(`*_sweep_rows_total{outcome=swept}`) > 0 over rolling 48h while table row count > 0 | counter + tenant_webhook_configs row count | 0% — paged on first failure |
| **SLO-F6-005** match-rate availability | `eventcreate_match_rate` gauge ≥ 0.95 (SC-002) | gauge + alerting threshold | informational — soft target |
| **SLO-F6-006** audit completeness | `eventcreate_audit_fallback_double_failure_total` == 0 over rolling 30d | counter | 0% — pages on first occurrence |
| **SLO-F6-007** admin archive/toggle p95 (staff-review-4 PERF-R6-05) | < 5s @ N=50 / < 12s @ N=200 registrations | histograms `eventcreate_archive_duration_ms` + `eventcreate_toggle_duration_ms` emitted from `src/lib/events-admin-deps.ts` via try/finally on both success + error paths | informational at SweCham scale; hard target for MTA tenants with N>200. Bounded above by Vercel function `maxDuration = 60` (PERF-R6-01 closure) and `listForRequota` row cap of 2000 (SEC-R6-01 closure). |

### 24.3 Alerts

| Alert | Condition | Severity | Runbook |
|---|---|---|---|
| `f6_webhook_signature_burst` | rate(`eventcreate_webhook_receipts_total{signature_outcome!='verified'}`) > 5/min per tenant for 10 min | P2 | `docs/runbooks/f6-webhook-signature-burst.md` (Phase 10) |
| `f6_webhook_precondition_burst` | rate(`audit_event_type='webhook_ingest_precondition_failed'`) > 2/min per tenant for 5 min | P2 | `docs/runbooks/f6-webhook-precondition-burst.md` (Phase 10) — Neon connectivity / RLS regression signal. Added R7-E staff-review fix 2026-05-13 closing the round-6 W5 follow-up gap. |
| `f6_admin_event_detail_enumeration` | distinct `event_id_hash` from same `actor_user_id` ≥ 10 within 5 min | P2 | `docs/runbooks/f6-admin-event-detail-not-found.md` (Phase 10 T124+) |
| `f6_cross_tenant_probe_burst` | `cross_tenant_probe` audit rate > 1/min per tenant for 5 min | P1 | (Phase 10 — covers webhook + admin surface) |
| `f6_idempotency_sweep_stalled` | SLO-F6-004 violation | P2 | `docs/runbooks/f6-idempotency-sweep.md` (Phase 10) |
| `f6_audit_fallback_double_failure` | counter increments by ≥1 in 5-min window | P1 page | `docs/runbooks/f6-audit-fallback-double-failure.md` (Phase 10) |
| `f6_rate_limit_fallback_sustained` | rate(`eventcreate_rate_limit_fallback_total`) > 1/min for 10 min | P3 | Indicates Upstash incident — auth surface alert already covers root cause |
| `f6_eventcreate_adapter_drift` | `rate(eventcreate_csv_adapter_mode_detected_total{format='eventcreate_csv'}) / rate(eventcreate_csv_adapter_mode_detected_total) < 0.5` over rolling 24h on tenants known to use EventCreate | P2 | `docs/runbooks/eventcreate-csv-import.md` § 4 — EventCreate header drift detection. Spec § Rollback Plan auto-trigger: > 5 admin issues attributable to F6.1 in 7d post-launch → flip `FEATURE_F6_EVENTCREATE_ADAPTER=false`. |
| `f6_csv_cross_tenant_probe_audit_emit_failed` | rate(`eventcreate_csv_import_audit_emit_failed_total{event_type='csv_import_cross_tenant_probe'}`) > 0 over rolling 5 min | P1 page | Each event = forensic-trail gap on Constitution Principle I clause 4 security event. Investigate Neon connectivity, pool exhaustion, audit-port regression. |
| `f6_csv_error_csv_downloaded_burst` | rate(`eventcreate_csv_error_csv_downloaded_total`) > 5/min per tenant for 10 min | P3 | PII-access burst — possible admin operator audit-trail review session, but also possible compromised admin credentials downloading bulk attendee CSVs. Cross-reference with admin auth session activity. |
| `f6_csv_error_csv_download_rate_limit_exceeded` | rate(`eventcreate_csv_error_csv_download_rate_limit_exceeded_total`) > 5/min per tenant for 10 min | P3 | R8.W / Staff R3 R058 — separate § 24.3 row for the rate-limit-hit counter (catalogue lives in § 24.1.5 line 1324). Non-zero rate means an admin actor is hitting the 20/hr per-(tenant, actor) error-CSV download cap. Possible insider PII-bulk-exfiltration via compromised admin session; differentiate from `f6_csv_error_csv_downloaded_burst` (successful downloads) by reading the underlying counter's `actor` label dimension. Cross-reference with admin auth session activity + recent role changes. |
| `f6_csv_safety_net_fallback_nonzero` | rate(`eventcreate_csv_safety_net_fallback_total`) > 0 per tenant over rolling 5 min | P2 | Staff-review M-R3v2-3 (2026-05-16). Non-zero rate means the FR-019b event-mismatch safety-net query failed (DB error or thrown exception) and the import proceeded WITHOUT the prior-event detection that prevents admin-error mis-uploads. Indicates Neon/pool instability; cross-reference with Neon connection-pool dashboard + recent network events. Resolution: confirm DB recovery, then re-run failed imports to retroactively confirm event-mismatch detection passes. |
| `f6_csv_import_record_stuck_running` | DB-query alert: `SELECT count(*) FROM csv_import_records WHERE outcome = 'running' AND uploaded_at < NOW() - INTERVAL '30 minutes'` > 0 | P3 | Staff-review L-R3v2-3 (2026-05-16). The `'running'` placeholder outcome (migration 0154) is set on the initial INSERT and flipped to a terminal value (`completed`/`timeout`/`partial_failure`/`invalid_header`/`event_not_found`/`event_not_owned_by_tenant`/`unexpected_error`) by `updateOutcome` at use-case end. If the Vercel function crashes between the INSERT and the UPDATE, the row stays `'running'` indefinitely — admins viewing history see "Running…" for an import that completed/failed >30 minutes ago. Implementation note: this is NOT an OTel counter alert (no metric is emitted on crash by design); requires either a cron-job.org periodic SQL check OR a Vercel Postgres scheduled query. At SweCham single-tenant scale 1 admin × ~50 imports/yr the residual rate is near-zero; pages alert only after manual review confirms the row should have been terminal. Resolution: manual UPDATE `outcome` to `'unexpected_error'` after verifying via Vercel function logs (search by `requestId`). |

### 24.4 Forbidden-log-field additions (F6-specific)

`src/lib/logger.ts` REDACT_PATHS covers:
- `webhook_secret_active` + `webhook_secret_grace` (+ nested `*.` `*.*.` depth)
- `X-Chamber-Signature` header value (case variants)
- `attendee_email` + `attendeeEmail` (+ depth-2)
- `attendee_name` + `attendeeName` (+ depth-2) — round-6 S20 fix
- `attendee_company` + `attendeeCompany` (+ depth-2) — round-6 S20 fix
- `EVENTCREATE_PII_PSEUDONYM_SALT` + `pii_pseudonym_salt` (Phase 10)

Stack traces: route-handler + use-case + audit-port catch blocks scrub container paths + `node_modules` + `webpack-internal:///` URLs via `@/lib/redact-stack` before pino log + audit_log JSONB persistence (round-6 W2 fix; full coverage verified by `tests/integration/events/db-unavailable-during-tx.test.ts` showing `[redacted-path]` / `[redacted-file-url]` markers in the fatal-log output).

### 24.5 Dashboard

Recommended Vercel Observability dashboard layout when wiring:
- **Top row**: SLO-F6-001 webhook p95 line graph (30d) + error-budget burn gauge + webhook_receipts_total stacked-area by signature_outcome
- **Second row**: SLO-F6-002 + SLO-F6-003 admin spans (light blue lines) overlaid with admin error-rate counter
- **Third row**: idempotency-sweep cron last-run timestamp gauge + audit-fallback-double-failure counter (must be 0)
- **Fourth row**: cross_tenant_probe rate per tenant (P1 alert visibility) + role_violation_blocked rate (FR-035 informational)

Sample-rate note: histograms emit 100% (low volume — webhook is Zapier-driven at ≤60 req/min/tenant); span sampling follows `@vercel/otel` defaults (head-based, 100% in dev, configurable in prod).

### 24.6 Trace tree

```
webhook_ingest_eventcreate (route span — wraps full pipeline)
├── (rate-limit check — Upstash, auto-instrumented)
├── (loadTenantWebhookConfig — Drizzle, auto-instrumented)
├── (verifyWebhookSignature — pure, no span)
└── (when verified)
    └── ingest-use-case strict-tx
        ├── (idempotency receipt insert — Drizzle)
        ├── (event upsert — Drizzle)
        ├── (attendee match cascade — 4 Drizzle queries)
        ├── (registration insert — Drizzle)
        └── (audit emit — Drizzle inside same tx)

admin_events_list (route span)
└── runListEvents
    └── (Drizzle list + getEmptyContext + getMatchCountsByEventIds — parallelised)

admin_events_detail (route span)
└── runLoadEventDetail
    └── (Drizzle findById + findByEventId 3-parallel — events repo + registrations repo)
```

Tracer name: `swecham.events` (matches the rest of the codebase pattern `swecham.<module>`).

---

## 25. F9 Admin Dashboard — observability (T037 / T099)

Metrics live in `src/lib/metrics.ts` (`insightsMetrics`). Cardinality-safe:
**only bounded labels** (`tenant` slug, `role`, `insight_key`, `outcome`) — no PII
(forbidden-fields hygiene, research R12). US1 (Slice A) catalogue below; Slice B
adds export-job (`export_job_queue_depth`/`duration`/`reclaimed`) + audit-query
(`audit_query_duration_ms`) instruments.

### 25.1 Metrics catalogue

| Metric | Type | Labels | Emitted from | Purpose |
|--------|------|--------|--------------|---------|
| `insights_snapshot_refresh_duration_ms` | histogram | — | snapshot crons | Snapshot recompute latency (backs SC-002 freshness) |
| `insights_snapshot_refresh_total` | counter | `outcome` (ok\|failed), `tenant` | snapshot crons | Refresh ticks by outcome |
| `insights_dashboard_viewed_total` | counter | `role`, `tenant` | `listDashboard` | PII-read volume + SC-012 adoption signal |
| `insights_insight_dismissed_total` | counter | `insight_key`, `tenant` | `dismissInsight` | SC-012 — staff act on / dismiss insights (analyze M2) |

**Deferred (follow-up):** `insights_snapshot_age_seconds` (gauge) — needs a
scrape-time per-tenant cache read; staleness is bounded in the interim by the
~5-min refresh cadence (FR-005) + the SC-013 rollback trigger (snapshot age p95
> 15 min). The live activity feed is NOT snapshot-bound (FR-003), so a just-
occurred event is visible regardless of snapshot age.

### 25.2 SLOs — F9 (US1)

| SLO | Target | Window | Source |
|-----|--------|--------|--------|
| Dashboard primary view render | p95 < 1.5 s @ 5,000 members | 30 d | Vercel Speed Insights (SC-002) — reads the cached snapshot row + last-N audit feed |
| Snapshot freshness (age) | p95 ≤ ~5 min (cadence); hard ceiling 15 min | 1 d | `snapshot_refresh_duration_ms` + refresh cadence; SC-013 ceiling |
| Snapshot refresh success | ≥ 99 % of cron ticks `outcome=ok` | 7 d | `insights_snapshot_refresh_total` |

### 25.3 Alerts — F9

| Alert | Condition | Severity | Runbook |
|-------|-----------|----------|---------|
| Dashboard error rate | `dashboard` route 5xx > **2 %** of loads over 15 min | P2 | Flip `FEATURE_F9_DASHBOARD=false` (SC-013 rollback — reversible in seconds, no deploy) |
| Snapshot staleness | snapshot age p95 > **15 min** (3× cadence) over 15 min | P3 | Check `snapshot-refresh-coordinator` cron-job.org health + `insights_snapshot_refresh_total{outcome=failed}` |
| Cross-tenant probe | any `insights_cross_tenant_probe` audit event | P1 | Principle I §4 — investigate immediately (should be impossible by RLS) |

Tracer name (when traces are added): `swecham.insights`.

