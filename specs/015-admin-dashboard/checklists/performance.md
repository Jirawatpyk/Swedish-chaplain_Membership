# Performance & Observability Requirements Quality Checklist: F9

**Purpose**: Validate that F9's **performance & observability requirements** are
quantified, measurable, and complete across all surfaces — *before* implementation.
Tests the requirements, not the measured latency.
**Created**: 2026-05-25
**Feature**: [spec.md](../spec.md) · constitution v1.4.2 (Principle VII) · `docs/observability.md`
**Depth**: Formal release gate · **Audience**: reviewer

> "Is the budget specified & measurable?" — not "Is it fast?"

## Performance Targets (quantified?)

- [x] CHK001 Is the dashboard target quantified as **p95 < 1.5 s @ 5,000 members** (not "fast"/"interactive")? [Measurability, Spec §SC-002] → VERIFIED 2026-05-25: SC-002 + plan Perf Goals.
- [x] CHK002 Are interactive API budgets (p95 < 400 ms) stated for the new F9 endpoints/actions? [Completeness, Constitution VII] → VERIFIED 2026-05-25: plan Perf Goals (p95 < 400 ms).
- [x] CHK003 Are web-vitals budgets (LCP < 2.5s, INP < 200ms, CLS < 0.1) required for the new pages? [Coverage, Constitution VII] → VERIFIED 2026-05-25: plan Perf Goals.
- [x] CHK004 Is the audit viewer's interactivity target at "tens of thousands of events" quantified, not just described? [Spec §FR-008, §SC-003] → RESOLVED 2026-05-25: FR-008 sets p95 < 1 s for a filtered query at ≥50,000 events.
- [x] CHK005 Is the SC-003 "under 30 seconds" framed as a **human task time** (not a system-latency budget), and is the underlying query budget separately stated? [Clarity, Spec §SC-003] → VERIFIED 2026-05-25: SC-003 (human task) + FR-008 (query p95 < 1 s).

## Freshness / Caching

- [x] CHK006 Is the snapshot refresh cadence quantified (~5 min) and the **max acceptable staleness** stated? [Measurability, Spec §FR-005, research R1] → VERIFIED 2026-05-25: FR-005 (~5 min, staleness ≤ cadence) + SC-013 (p95 < 15 min rollback) + research R1.
- [x] CHK007 Is the event-triggered staleness mechanism specified (audit_log trigger flips `stale`) with a defined upper bound on stale-to-fresh latency? [Clarity, research R1/R2-E1] → VERIFIED 2026-05-25: research R1/R2-E1 + data-model §1; upper bound via cadence + SC-013.
- [x] CHK008 Is the requirement to display the "as of" time stated so users can judge freshness? [Completeness, Spec §FR-005] → VERIFIED 2026-05-25: FR-005.
- [x] CHK009 Is the live activity feed's freshness requirement (near-real-time, not snapshot-bound) specified and distinguished from the cached KPIs? [Consistency, Spec §FR-003, research R1/R2-E2] → VERIFIED 2026-05-25: FR-003 + research R1 (feed live, KPIs cached).

## Query / Index / Pagination

- [x] CHK010 Are the per-source keyset indexes for `member_timeline_v` enumerated (invoices/payments/events/broadcasts/renewals/audit), not left as "if missing"? [Completeness, data-model §9/R2-E6] → VERIFIED 2026-05-25: data-model §9 item 5 enumerates all six.
- [x] CHK011 Is the audit-viewer index set specified, including `(tenant_id, timestamp DESC)` for the live feed? [Completeness, data-model §9/R2-E4] → VERIFIED 2026-05-25: data-model §9 item 6.
- [x] CHK012 Is keyset (not offset) pagination required for both timeline and audit viewer, with page-size bounds? [Clarity, data-model §5, contracts] → VERIFIED 2026-05-25: data-model §5 (50/max 100) + contracts (audit keyset, limit 1..100).
- [x] CHK013 Is an `EXPLAIN`-backed verification requirement stated (index scans, no full-table sort) at the SC-002 scale? [Measurability, data-model §9/R2-E6] → VERIFIED 2026-05-25: data-model §9 Index-verification note + tasks T098.
- [x] CHK014 Is the benefit-usage query bounded to a single member (cheap live read) with the cross-member aggregate moved to the snapshot? [Clarity, research R2] → VERIFIED 2026-05-25: research R2.

## Async Work & Load

- [x] CHK015 Are export-job throughput/duration expectations and the sync-vs-async threshold (audit ≤10k rows) specified? [Completeness, research R5/R2-E2] → VERIFIED 2026-05-25: research R5/R2-E2 + tasks T046.
- [x] CHK016 Is the snapshot coordinator's behaviour at scale (per-tenant fan-out, prioritising `stale`) defined so it stays within the cron window? [Coverage, research R1, contracts] → VERIFIED 2026-05-25: research R1 + contracts (coordinator fan-out, prioritise stale).
- [x] CHK017 Is 10x-growth headroom (≥50k members) acknowledged with a stated revisit trigger? [Coverage, Spec §Assumptions] → RESOLVED 2026-05-25: Assumptions add a ~20k-member revisit trigger for the snapshot/index strategy.

## Observability (Principle VII)

- [x] CHK018 Are the new metrics enumerated (snapshot refresh duration, snapshot age, export queue depth/duration, audit-query latency, export-job reclaim)? [Completeness, research R12, contracts] → VERIFIED 2026-05-25: research R12 + contracts cron-endpoint metrics.
- [x] CHK019 Are SLOs + alert thresholds required to be added to `docs/observability.md` before GA? [Completeness, Constitution VII] → VERIFIED 2026-05-25: plan VII + research R12 + tasks T099.
- [x] CHK020 Is the no-PII-in-labels requirement (tenant-id label only) stated for all F9 metrics? [Clarity, research R12] → VERIFIED 2026-05-25: research R12 + plan VII.
- [x] CHK021 Is structured logging with a request-id correlation required for the new request paths? [Completeness, Constitution VII] → VERIFIED 2026-05-25: plan VII (structured logs with request-id).

## Rollback / Measurable Outcomes

- [x] CHK022 Is the rollback trigger quantified (error rate >2% / snapshot age p95 >15 min / any cross-tenant leak) and tied to the `FEATURE_F9_DASHBOARD` kill-switch? [Measurability, Spec §SC-013] → VERIFIED 2026-05-25: SC-013.
- [x] CHK023 Is the adoption KPI (SC-012) measurable with a defined tracking source? [Measurability, Spec §SC-012] → VERIFIED 2026-05-25: SC-012 (benefit-view + insight action/dismiss counters; tasks T037/T068).
- [x] CHK024 Are all performance success criteria free of unquantified adjectives ("smooth", "quickly", "responsive")? [Spec §SC-002, §FR-016] → RESOLVED 2026-05-25: FR-016 now quantifies incremental timeline load (p95 < 500 ms/page); SC-002 quantified earlier (p95 < 1.5 s).

## Notes

- These items gate the `/speckit.verify` perf claims — every quantified budget here must
  have a corresponding measurement (RUM / EXPLAIN / metric) before the Verify gate.
- **Requirements-quality verification PASS (2026-05-25)**: all 24 items confirmed
  specified. The *measurements* (RUM / EXPLAIN / metric emission) remain Verify-gate
  actions per tasks T098/T099.
