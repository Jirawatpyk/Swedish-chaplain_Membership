# Chamber-OS Performance Benchmarks

Append-only log of perf bench runs from `RUN_PERF=1`-gated integration
tests + production-deployment Vercel Speed Insights snapshots. Each
entry pins a timestamp, environment context, and the measured
percentiles so trend regressions are visible across waves.

**Methodology note**: local-dev benchmark runs from Bangkok against
Neon ap-southeast-1 (Singapore) experience 25-50ms TCP+TLS RTT per
query. Production runs from Vercel sin1 (Singapore) experience
5-10ms RTT — the expected 5-10x amplification means local dev tests
naturally exceed SLO budgets that are met in production. Strict SLO
assertion is gated on `PERF_SLO_STRICT=1` env var (set by CI / staging
perf jobs running from production-equivalent infra). Local runs are
smoke + trend-tracking only.

---

## F8 Phase 6 T174 — at-risk recompute @ 500 members (2026-05-08T07:11:37Z)
- env: local dev (BKK → Neon Singapore, ~50ms RTT)
- members: 500
- list query: 233ms
- cron pass: 297_921ms (= 595ms/member; SLO 60_000ms strict=false)
- per-member p50: 591ms · p95: 610ms · p99: 720ms · avg: 595.8ms

**Analysis**: per-member latency dominated by ~6 round-trips to Neon
(member SELECT + invoice agg + tenant settings + setRiskScore prior-
band read + setRiskScore UPDATE + audit emit). At local RTT ~50ms
that's ~300ms of pure RTT + ~300ms processing per member. Production
target (RTT ~5ms): ~30ms RTT + ~30ms processing = ~60ms/member ⇒
~5min for 5,000 members which still exceeds the 60s budget.

**Required optimisation for FR-036 + SC-005 60s @ 5000 SLO**:
- Cache `tenant_renewal_settings` once per cron pass (saves 5,000
  queries; ~25s at production RTT)
- Batch factor-gather in a single CTE returning all members' factors
  at once (saves ~10,000 queries; ~50s at production RTT)
- Bulk UPDATE members' risk_score_* columns + bulk INSERT audit_log
  rows (saves ~10,000 round-trips; ~50s at production RTT)

These optimisations are tracked as a follow-up wave (T159b: batched
CTE adapter). The current adapter (T159, Wave F) is functional + tested
end-to-end (T173+T175 9/9 GREEN); the perf SLO compliance is the only
deferred concern + strict-mode is OFF until the batched path lands.

**UPDATE 2026-05-08 — T159b batched path SHIPPED (Wave G)**:
The `recomputeAtRiskScoresBatch` use-case + new repo+emitter port
methods (bulkSetRiskScores / gatherAtRiskFactorsForTenant /
bulkEmitInTx) collapse the recompute pass into 4 round-trips total.
At 5,000 members on local (BKK→SG, ~50ms RTT) the cron completes in
**7.76 seconds**, well under the 60s budget — `PERF_SLO_STRICT=1`
strict assertion now PASSES from local. Production runs (sin1→Neon,
~5ms RTT) will be even faster. **Speedup: 38× faster** vs the per-
member loop at the same scale.

## F8 Phase 6 T174 — at-risk recompute (2026-05-08T08:46:09.298Z)
- members: 500
- list query: 228ms
- cron pass: 297443ms (SLO 60000ms; strict=false)
- per-member p50: 579ms · p95: 690ms · p99: 763ms · avg: 594.9ms

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T08:49:28.542Z)
- members: 100
- list query: 228ms
- cron pass: 356ms (SLO 60000ms; strict=false)
- per-member avg: 3.56ms (batched — 4 round-trips total)
- recomputed: 0 · skipped<tenure: 100 · failed: 0

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T08:50:20.993Z)
- members: 5000
- list query: 6838ms
- cron pass: 7763ms (SLO 60000ms; strict=true)
- per-member avg: 1.55ms (batched — 4 round-trips total)
- recomputed: 0 · skipped<tenure: 5000 · failed: 0

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T09:09:11.562Z)
- members: 5000
- list query: 6096ms
- cron pass: 6672ms (SLO 60000ms; strict=true)
- per-member avg: 1.33ms (batched — 4 round-trips total)
- recomputed: 0 · skipped<tenure: 5000 · failed: 0

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T12:40:03.359Z)
- members: 5000
- list query: 5644ms
- cron pass: 7761ms (SLO 60000ms; strict=true)
- per-member avg: 1.55ms (batched — 4 round-trips total)
- recomputed: 5000 · skipped<tenure: 0 · failed: 0

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T14:34:33.205Z)
- members: 5000
- list query: 5899ms
- cron pass: 2186ms (SLO 60000ms; strict=true)
- per-member avg: 0.44ms (batched — 4 round-trips total)
- recomputed: 5000 · skipped<tenure: 0 · failed: 0

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T15:29:01.966Z)
- members: 5000
- list query: 3577ms
- cron pass: 16965ms (SLO 60000ms; strict=true)
- per-member avg: 3.39ms (batched — 4 round-trips total)
- recomputed: 5000 · skipped<tenure: 0 · failed: 0

## F8 Phase 6 T174 — at-risk recompute BATCHED (2026-05-08T21:05:33.131Z)
- members: 5000
- list query: 5491ms
- cron pass: 10374ms (SLO 60000ms; strict=false)
- per-member avg: 2.07ms (batched — 4 round-trips total)
- recomputed: 5000 · skipped<tenure: 0 · failed: 0

## F8 Phase 10 T261 — loadPipeline @ 1000 members (2026-05-10T05:09:52.855Z)
- members: 1000 (600 in 90-day window)
- samples: 20 (warmup 5)
- p50: 280.1ms · p95: 291.4ms · p99: 291.4ms · avg: 278.0ms
- SLO: <500ms (FR-046/SC-003 @ 5k members; strict=false)
- extrapolation: production target Vercel sin1↔Neon SG (~5ms RTT) ≈ p95/3-5× local-from-BKK (~25ms RTT)

## F8 Phase 10 T262 — dispatchRenewalCycle @ 1000 cycles (2026-05-10T05:11:40.910Z)
- candidates: 1000
- cron pass: 84948ms (SLO 60000ms; strict=false)
- per-candidate avg: 84.95ms
- gateway: stubbed (measures F8 server-side; F1 Resend SLA separate)
- extrapolation to 5k: ~424742ms (linear)

## F8 Phase 10 T264 — evaluateTierUpgrade @ 1000 members (2026-05-10T05:12:11.163Z)
- members scanned: 999
- suggestions created: 0 · already at target: 999 · suppressed: 0 · conflict: 0
- cron pass: 1153ms (SLO 30000ms; strict=false)
- per-member avg: 1.15ms
- extrapolation to 5k: ~5767ms (linear)

## F8 Phase 10 T265 — confirmRenewal (F8-only) @ 50 samples (2026-05-10T05:14:56.048Z)
- samples: 50 (warmup 5)
- p50: 477.2ms · p95: 482.5ms · p99: 484.2ms · avg: 476.7ms
- F4 bridge: stubbed (production total adds F4 invoice creation + F1 rate-limit overhead)
- SLO TTFB: <600ms · total: <1200ms (SC-005)
- bench measures F8 server-side state-transition + audit emit; real TTFB requires HTTP-layer measurement at staging

## F8 Phase 10 T264 — evaluateTierUpgrade @ 1000 members (2026-05-10T06:25:26.274Z)
- members scanned: 999
- suggestions created: 333 · already at target: 666 · suppressed: 0 · conflict: 0
- cron pass: 120103ms (SLO 30000ms; strict=false)
- per-member avg: 120.22ms
- extrapolation to 5k: ~600517ms (linear)

## F8 Phase 10 T264 — evaluateTierUpgrade @ 1000 members (2026-05-10T06:30:09.323Z)
- members scanned: 999
- suggestions created: 334 · already at target: 665 · suppressed: 0 · conflict: 0
- cron pass: 97834ms (SLO 30000ms; strict=false)
- per-member avg: 97.93ms
- extrapolation to 5k: ~489172ms (linear)

## F8 Phase 10 T264 — evaluateTierUpgrade @ 1000 members (2026-05-10T06:49:50.036Z)
- members scanned: 999
- suggestions created: 333 · already at target: 666 · suppressed: 0 · conflict: 0
- cron pass: 2207ms (SLO 30000ms; strict=false)
- per-member avg: 2.21ms
- extrapolation to 5k: ~11035ms (linear)

## F8 Phase 10 T264 — evaluateTierUpgrade @ 5000 members (2026-05-10T06:50:37.404Z)
- members scanned: 4991
- suggestions created: 1664 · already at target: 3327 · suppressed: 0 · conflict: 0
- cron pass: 11377ms (SLO 30000ms; strict=true)
- per-member avg: 2.28ms
- extrapolation to 5k: ~11377ms (linear)
