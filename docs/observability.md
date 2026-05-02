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
