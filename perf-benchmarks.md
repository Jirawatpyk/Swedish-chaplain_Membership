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
