# Performance Requirements Quality Checklist: F7.1a — Email Broadcast Advanced

**Purpose**: Validate that performance requirements for US1 (Pagination dispatch), US2 (Image upload + ClamAV scan), and US7 (Template snapshot + picker latency) are quantified, measurable, traceable, and aligned with Constitution v1.4.0 Principle VII (Performance & Observability).
**Created**: 2026-05-18
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [research.md](../research.md)
**Scope**: Pre-implementation requirements quality gate (Standard depth, ~30 items)

**Note**: This checklist tests REQUIREMENTS QUALITY (Are SLOs quantified? Are budgets traceable?) — NOT performance test results.

## SLO Targets (Success Criteria)

- [x] CHK001 Is the 10k-recipient dispatch SLO quantified with both wall-clock budget (≤10 min) AND zero-duplicate-send invariant? [Measurability, Spec SC-001]
- [x] CHK002 Is the 50k-recipient dispatch SLO quantified with budget (≤45 min) AND recoverability requirement (per-batch failure handling)? [Measurability, Spec SC-002]
- [x] CHK003 Is the ClamAV image-scan latency SLO quantified at the 95th percentile (≤500ms p95 for files ≤2 MB)? [Measurability, Spec SC-005 + FR-013]
- [x] CHK004 Is the template-snapshot-to-editor latency SLO quantified at the 95th percentile (≤500ms p95)? [Measurability, Spec SC-007a]
- [x] CHK005 Is the retry-success-rate SLO quantified for partially_sent broadcasts (≥95% recoverable within 3 manual retries)? [Measurability, Spec SC-006]
- [ ] CHK006 Are SC-001 and SC-002 targets traceable to specific Constitution Principle VII budgets (LCP/INP/API p95)? [Traceability, plan.md § Performance Goals]

## Resource Budgets (Throughput + Memory)

- [x] CHK007 Is the per-batch concurrency cap (default 4, tenant-range 1-8) tied to a measurable invariant (e.g., Resend account-level rate-limit headroom)? [Clarity, Spec FR-002 + research § 2]
- [x] CHK008 Are Vercel Function timeout requirements for dispatch handler explicitly bounded (≤300s per per-batch operation)? [Completeness, plan.md Technical Context]
- [x] CHK009 Is the Vercel Function memory budget specified for dispatch handler (1024 MB inherited from F7 MVP)? [Clarity, research § 6]
- [x] CHK010 Is the ClamAV Fly.io VM resource budget specified (shared-cpu-1x@256mb; ~250 scans/day target)? [Clarity, research § 1 + plan.md Tech Context]
- [x] CHK011 Are Postgres connection-pool requirements per request specified (Drizzle singleton)? [Completeness, research § 6]

## Latency Budgets per Surface

- [x] CHK012 Is the admin-batch-breakdown UI render budget specified (≤300ms TTFB derived from compose TTFB)? [Clarity, research § 6]
- [x] CHK013 Is the image-upload + scan combined latency budget specified (≤2s p95 for 5 MB image)? [Measurability, research § 6]
- [x] CHK014 Are per-batch dispatch latency budgets specified (≤180s for 10k recipients to Resend)? [Clarity, research § 6]
- [x] CHK015 Is the webhook ingestion latency budget preserved from F7 MVP (≤250ms p95)? [Consistency, research § 6]

## Scalability Limits

- [x] CHK016 Is the 50,000-recipient hard ceiling specified at BOTH submit boundary AND dispatch boundary (defence-in-depth)? [Consistency, Spec FR-007]
- [x] CHK017 Is the Resend per-audience cap (10,000) explicitly documented as the per-batch primitive? [Clarity, Spec FR-002 + research § 2]
- [ ] CHK018 Are template-picker dropdown scaling requirements specified at upper bound (e.g., 200 templates @ 10k-member tenant)? [Coverage, plan.md critique E8 cross-link]
- [x] CHK019 Are starter-template seed scale requirements specified (15 rows × N tenants; 100-tenant horizon scenario)? [Clarity, research § 6 storage cost analysis]
- [x] CHK020 Are per-tenant-storage cost bounds specified for the broadcast_templates table (~5 KB × 15 = 75 KB per tenant)? [Measurability, research § 6]

## Observability Requirements (Principle VII metrics + alerts)

- [x] CHK021 Are the 5 new OpenTelemetry metrics specified with exact name + labels + units? [Completeness, plan.md Constitution Check VII]
- [x] CHK022 Are the 4 new alert thresholds quantified (e.g., `clamav_signature_age >48h critical`, `partial_send_rate >5% warn`)? [Clarity, plan.md Constitution Check VII]
- [x] CHK023 Is the `clamav_signature_age_hours` metric source specified (probed via `CLAMD VERSION` socket call, NOT a manual signal)? [Clarity, plan.md Principle VII]
- [x] CHK024 Are distributed-tracing spans specified for batch-split → parallel-dispatch → per-batch-webhook flow (US1)? [Completeness, plan.md Principle VII]
- [x] CHK025 Are distributed-tracing spans specified for upload → virus-scan → bind-to-draft flow (US2)? [Completeness, plan.md Principle VII]
- [x] CHK026 Is structured-log redaction specified for sensitive fields (image bytes, attachment signed URLs, raw PII)? [Completeness, plan.md Principle VII]

## Edge Cases + Degradation

- [x] CHK027 Are degradation requirements specified for Resend account-level rate-limit events (per-batch retry behaviour)? [Edge Case, Spec FR-005 + research § 2]
- [ ] CHK028 Are degradation requirements specified for ClamAV daemon unreachable (≥2 min) — does upload fail-closed or queue-pending? [Edge Case, spec edge case + critique P10 — verify clarity]
- [x] CHK029 Are degradation requirements specified for >50k recipient broadcasts at submit boundary (reject + which error code)? [Edge Case, Spec FR-007]
- [x] CHK030 Are degradation requirements specified for >5 MB image upload (reject + locale-aware error code `broadcast_image_too_large`)? [Edge Case, Spec FR-012]

## Verification Mechanism

- [x] CHK031 Is each SLO target tied to a specific test mechanism (perf bench, integration test, e2e Playwright trace)? [Traceability, plan.md tests/ tree]
- [x] CHK032 Are perf-bench tests env-gated (50k full-fixture) AND CI-runnable (7500-recipient smoke per critique E11)? [Coverage, plan.md tests/ tree]
- [ ] CHK033 Is the SC-007a snapshot perf bench fixture specified (template body size; member tier)? [Measurability, plan.md tests/ tree — `template-snapshot-decoupling.test.ts`]
- [x] CHK034 Are runbook + alerting thresholds aligned (alert fires → runbook action sequence documented)? [Consistency, plan.md Constitution Check VII + Polish phase tasks T124-T126]

## Cost + Operational Posture

- [x] CHK035 Is the Fly.io ClamAV cost specified (~$1.94/month or free tier; documented operating cost)? [Clarity, research § 1]
- [x] CHK036 Is the per-scan cost trajectory specified at SaaS scale (250 scans/day → 1000+/day projection vs Fly.io VM capacity)? [Measurability, research § 1]

## Notes

- Items marked `[Gap]` indicate missing performance requirements; items with `[Spec §...]` reference existing requirements being validated.
- All SLO budgets above MUST be re-verified by perf benches before `/speckit.verify` gate.
- Total: 36 items across 8 categories.
- Pass criteria: ≥90% items ✓ before `/speckit.tasks` execution.
