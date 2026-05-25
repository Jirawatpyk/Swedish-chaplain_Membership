# Performance & Observability Requirements Quality Checklist: F9

**Purpose**: Validate that F9's **performance & observability requirements** are
quantified, measurable, and complete across all surfaces — *before* implementation.
Tests the requirements, not the measured latency.
**Created**: 2026-05-25
**Feature**: [spec.md](../spec.md) · constitution v1.4.2 (Principle VII) · `docs/observability.md`
**Depth**: Formal release gate · **Audience**: reviewer

> "Is the budget specified & measurable?" — not "Is it fast?"

## Performance Targets (quantified?)

- [ ] CHK001 Is the dashboard target quantified as **p95 < 1.5 s @ 5,000 members** (not "fast"/"interactive")? [Measurability, Spec §SC-002]
- [ ] CHK002 Are interactive API budgets (p95 < 400 ms) stated for the new F9 endpoints/actions? [Completeness, Constitution VII]
- [ ] CHK003 Are web-vitals budgets (LCP < 2.5s, INP < 200ms, CLS < 0.1) required for the new pages? [Coverage, Constitution VII]
- [ ] CHK004 Is the audit viewer's interactivity target at "tens of thousands of events" quantified, not just described? [Ambiguity, Spec §SC-003, US2]
- [ ] CHK005 Is the SC-003 "under 30 seconds" framed as a **human task time** (not a system-latency budget), and is the underlying query budget separately stated? [Clarity, Spec §SC-003]

## Freshness / Caching

- [ ] CHK006 Is the snapshot refresh cadence quantified (~5 min) and the **max acceptable staleness** stated? [Measurability, Spec §FR-005, research R1]
- [ ] CHK007 Is the event-triggered staleness mechanism specified (audit_log trigger flips `stale`) with a defined upper bound on stale-to-fresh latency? [Clarity, research R1/R2-E1]
- [ ] CHK008 Is the requirement to display the "as of" time stated so users can judge freshness? [Completeness, Spec §FR-005]
- [ ] CHK009 Is the live activity feed's freshness requirement (near-real-time, not snapshot-bound) specified and distinguished from the cached KPIs? [Consistency, Spec §FR-003, research R1/R2-E2]

## Query / Index / Pagination

- [ ] CHK010 Are the per-source keyset indexes for `member_timeline_v` enumerated (invoices/payments/events/broadcasts/renewals/audit), not left as "if missing"? [Completeness, data-model §9/R2-E6]
- [ ] CHK011 Is the audit-viewer index set specified, including `(tenant_id, timestamp DESC)` for the live feed? [Completeness, data-model §9/R2-E4]
- [ ] CHK012 Is keyset (not offset) pagination required for both timeline and audit viewer, with page-size bounds? [Clarity, data-model §5, contracts]
- [ ] CHK013 Is an `EXPLAIN`-backed verification requirement stated (index scans, no full-table sort) at the SC-002 scale? [Measurability, data-model §9/R2-E6]
- [ ] CHK014 Is the benefit-usage query bounded to a single member (cheap live read) with the cross-member aggregate moved to the snapshot? [Clarity, research R2]

## Async Work & Load

- [ ] CHK015 Are export-job throughput/duration expectations and the sync-vs-async threshold (audit ≤10k rows) specified? [Completeness, research R5/R2-E2]
- [ ] CHK016 Is the snapshot coordinator's behaviour at scale (per-tenant fan-out, prioritising `stale`) defined so it stays within the cron window? [Coverage, research R1, contracts]
- [ ] CHK017 Is 10x-growth headroom (≥50k members) acknowledged with a stated revisit trigger? [Coverage, Gap]

## Observability (Principle VII)

- [ ] CHK018 Are the new metrics enumerated (snapshot refresh duration, snapshot age, export queue depth/duration, audit-query latency, export-job reclaim)? [Completeness, research R12, contracts]
- [ ] CHK019 Are SLOs + alert thresholds required to be added to `docs/observability.md` before GA? [Completeness, Constitution VII]
- [ ] CHK020 Is the no-PII-in-labels requirement (tenant-id label only) stated for all F9 metrics? [Clarity, research R12]
- [ ] CHK021 Is structured logging with a request-id correlation required for the new request paths? [Completeness, Constitution VII]

## Rollback / Measurable Outcomes

- [ ] CHK022 Is the rollback trigger quantified (error rate >2% / snapshot age p95 >15 min / any cross-tenant leak) and tied to the `FEATURE_F9_DASHBOARD` kill-switch? [Measurability, Spec §SC-013]
- [ ] CHK023 Is the adoption KPI (SC-012) measurable with a defined tracking source? [Measurability, Spec §SC-012]
- [ ] CHK024 Are all performance success criteria free of unquantified adjectives ("smooth", "quickly", "responsive")? [Ambiguity, Spec §SC-002, US3]

## Notes

- These items gate the `/speckit.verify` perf claims — every quantified budget here must
  have a corresponding measurement (RUM / EXPLAIN / metric) before the Verify gate.
