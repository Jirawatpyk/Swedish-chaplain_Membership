# Observability Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **observability + metrics + alerts + runbooks + logging requirements** in spec.md, plan.md, research.md, data-model.md, and contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review`.
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: FR-036 OTel metrics + alerts + runbooks, audit-log payload schema, structured pino logs, SLO tracking, multi-tenant observability, dual-write fallback observability.

## OTel Metrics (FR-036 — 11 metrics)

- [ ] CHK001 - Are all **11 OTel metrics** explicitly enumerated with names + types (counter/histogram/gauge) + labels? [Completeness, Spec §FR-036 + research.md R10]
- [ ] CHK002 - Is the metric-naming convention specified consistently as `eventcreate_*` (matches the upstream system identity)? [Consistency, research.md R10]
- [ ] CHK003 - Are the requirements for `eventcreate_webhook_receipts_total` labels (`tenant_id` + `signature_outcome` + `processing_outcome`) explicit? [Clarity, research.md R10 metric #1]
- [ ] CHK004 - Is the `eventcreate_webhook_ingest_latency_seconds` histogram requirement specified with bucket definitions appropriate for the SC-003 <300ms p95 target? [Clarity, Spec §SC-003 + research.md R10 metric #2]
- [ ] CHK005 - Are the requirements for `eventcreate_match_rate_gauge` specified as a 30-day rolling window per tenant (matches SC-002 measurement)? [Measurability, Spec §SC-002]
- [ ] CHK006 - Are the requirements for `eventcreate_idempotency_sweep_rows_total` specified (per-tenant counter, increments by `rowsDeleted` per cron pass)? [Completeness, Spec §FR-036 round-4 AA1]
- [ ] CHK007 - Are PII-redaction requirements explicit for metric labels (e.g., `member_id_hash` not raw member_id; no raw attendee email in any metric label)? [Coverage, plan.md Constitution Check § VII]
- [ ] CHK008 - Are metric-emission requirements specified to live INSIDE the strict-transactional ACID unit per FR-037 (so metrics don't lie about state)? [Consistency, research.md R6]

## Alerts (FR-036 — 6 alert rules)

- [ ] CHK009 - Are all **6 alert rules** specified with explicit trigger thresholds + measurement windows + severity? [Completeness, Spec §FR-036]
- [ ] CHK010 - Is the signature-rejection-burst threshold quantified (`> 10/min sustained for 5 min per tenant`)? [Clarity, research.md R10 alert #1]
- [ ] CHK011 - Is the match-rate-degradation alert specified relative to SC-002's ≥95% threshold (rolling 24h window per tenant)? [Measurability, research.md R10 alert #2]
- [ ] CHK012 - Is the webhook p95-over-SLO alert tied to SC-003's <300ms budget (rolling 1h)? [Clarity, research.md R10 alert #3]
- [ ] CHK013 - Are CSV-import-failure-spike alert thresholds quantified (`> 3 per tenant per hour`)? [Clarity, research.md R10 alert #4]
- [ ] CHK014 - Is the idempotency-sweep-stalled alert specified to trigger on `rate(eventcreate_idempotency_sweep_rows_total[2d]) == 0` AND `table_row_count` growing? [Coverage, Spec §FR-036 round-4 AA1]
- [ ] CHK015 - Are alert routing requirements specified (to Resend email → maintainer)? [Clarity, research.md R10]

## Runbooks

- [ ] CHK016 - Are all **3 runbooks** specified with file paths + intended audience + entry-point conditions? [Completeness, Spec §FR-036 + research.md R10]
- [ ] CHK017 - Is the signature-failure investigation runbook specified to cover the 5 most likely root causes (wrong secret, post-rotation Zap-not-updated, clock skew, MITM/tampering, credential leak)? [Coverage, research.md R10 runbook #1]
- [ ] CHK018 - Is the match-rate-degradation triage runbook specified with the link to F3 member-onboarding-pace check (most-likely upstream cause)? [Clarity, research.md R10 runbook #2]
- [ ] CHK019 - Is the secret-rotation operational procedure specified end-to-end (rotate → reveal → update Zapier → 24h grace window observation → verify with test webhook)? [Completeness, research.md R10 runbook #3]
- [ ] CHK020 - Are the deferred runbooks documented (Zapier-deprecation-response — authored only if Zapier announces; salt-rotation procedure — at `/speckit.checklist` if pseudonymisation goes live)? [Coverage, research.md R1 + R9]

## Audit Log Payload Schema

- [ ] CHK021 - Is the `audit_log.payload jsonb` column specified as the canonical structured-payload carrier (NOT the legacy `summary` text column) — corrected round-2 M1? [Clarity, contracts/audit-port.md round-2 M1]
- [ ] CHK022 - Are the **43 F6 audit event payload shapes** (original spec scoped 35; extended to 43) specified with TypeScript discriminated-union types per event? [Completeness, contracts/audit-port.md + canonical closed union at `src/modules/events/application/ports/audit-port.ts:76-171`]
- [ ] CHK023 - Is the `severity` field specified as living inside `payload.severity` (no top-level audit-log column)? [Consistency, contracts/audit-port.md round-2 E7]
- [ ] CHK024 - Are queryable JSON-path index requirements specified for high-cardinality fields (e.g., `audit_log(tenant_id, (payload->>'event_external_id'), ...)` if needed)? [Coverage, follow F4 precedent at `audit_log_overdue_once_per_day`]
- [ ] CHK025 - Is the `summary` column convention specified (one-line synopsis ≤500 chars for log-line readability; structured payload in JSONB)? [Clarity, contracts/audit-port.md round-2 M1]

## Structured Logging (pino)

- [ ] CHK026 - Is the pino-forbidden-fields-redact-list extension requirement specified for F6 secrets (`webhook_secret`, `X-Chamber-Signature` header value, attendee email when audit-replay masking required)? [Completeness, plan.md Constitution Check § VII]
- [ ] CHK027 - Is the `pino.fatal` stderr-fallback requirement specified with the `audit_secondary_tx_failure: true` discriminator? [Coverage, research.md R6 round-1 E3]
- [ ] CHK028 - Are correlation-ID threading requirements specified (request_id flows from webhook receipt through all downstream log/audit/metric emissions)? [Clarity, plan.md Constitution Check § VII]
- [ ] CHK029 - Is the requirement that audit-log structured logs are emitted in addition to (not in lieu of) the DB audit_log entry specified? [Clarity, research.md R6 dual-write]

## SLO Tracking

- [ ] CHK030 - Are the F6 SLO budgets quantified (SC-003 p95 <300ms webhook ingest; SC-006 1k CSV rows <60s)? [Measurability, Spec §SC-003 + §SC-006]
- [ ] CHK031 - Is the SC-002 ≥95% match-rate budget measurable via `eventcreate_match_rate_gauge` rolling-30-day? [Measurability, Spec §SC-002]
- [ ] CHK032 - Is the SC-008 secret-rotation 24h-grace measurable via `webhook_secret_grace_used` audit count + `secret_grace_used` post-rotation timestamp? [Measurability, Spec §SC-008]
- [ ] CHK033 - Are the SC-009 100%-cross-tenant-probe-rejection measurable via `cross_tenant_probe` audit count (every attempt audited; zero false negatives)? [Measurability, Spec §SC-009]
- [ ] CHK034 - Is the SC-011 7-day-pseudonymisation-sweep-completion measurable via `pii_pseudonymisation_sweep_run` audit + age delta? [Measurability, Spec §SC-011]
- [ ] CHK035 - Is the SC-012 30-day-erasure-completion measurable via the time delta between `pii_erasure_requested` and `pii_erasure_completed` audits? [Measurability, Spec §SC-012]

## Multi-Tenant Observability

- [ ] CHK036 - Are tenant-scoped metric labels specified consistently (`tenant_id` label on every counter/gauge that varies per tenant)? [Consistency, research.md R10]
- [ ] CHK037 - Are cross-tenant aggregate dashboards (e.g., "match-rate across all tenants") specified vs. tenant-specific drill-downs? [Coverage, plan.md Constitution Check § VII]
- [ ] CHK038 - Are the requirements for separating tenant-scoped logs from system-level logs specified (e.g., cron handlers log per-tenant pass-duration + total tenants-scanned)? [Coverage, research.md R9 multi-tenant cron]
- [ ] CHK039 - Are the F6 metrics' emission requirements specified to use the existing `@vercel/otel` instrumentation (no new observability dependency)? [Consistency, plan.md Primary Dependencies]

## Notes

- This checklist is the canonical observability review gate for F6 per Constitution Principle VII.
- All metrics + alerts + runbooks together satisfy the FR-036 commitment matching F7/F8's ship-readiness bar.
- "[Gap]" items require resolution before `/speckit.implement`; metric label changes require coordination with retention sweep + alert rule wording.
