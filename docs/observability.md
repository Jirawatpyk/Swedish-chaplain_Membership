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
| `outbox.dispatch.failures_total` | counter | `{notification_type, reason}` | `permanently_failed` flips after 5 retries |
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
| `members.api.latency_ms` p95 | > 1 s for 5 consecutive min | Alarm → check Neon query plan, pg_trgm index health. |

#### Medium severity (notify on-call, investigate next business hour)

| Event / Metric | Threshold | Action |
|---|---|---|
| `member_self_update_forbidden` | ≥ 5 events in 10 min per actor | Investigate forged portal payload; possible script or compromised member session. Time-to-triage: 10 min. |
| `outbox.dispatch.failures_total` | ≥ 3 failures in 30 min | Check Resend rate limits and outbox `retry_count` distribution. |
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
