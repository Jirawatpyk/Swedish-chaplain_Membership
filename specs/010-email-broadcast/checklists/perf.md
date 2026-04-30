# Performance & Scalability Requirements Quality Checklist: F7 — Email Broadcast (E-Blast)

**Purpose**: Validate the **performance + scalability requirements** in F7's spec/plan are complete, clear, consistent, measurable, and traceable — before /speckit.tasks. Tests the requirements themselves (unit tests for English), not the implementation.
**Created**: 2026-04-29
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [data-model.md](../data-model.md) · [research.md](../research.md)
**Depth**: Formal release gate (Constitution Gate 4 + Principle VII Perf & Observability)
**Audience**: Reviewer at PR / staff-review (performance-slo-guardian + observability-instrumentor agents)
**Standards reference**: Constitution v1.4.0 Principle VII (Perf & Observability) · `docs/observability.md` § 14 SLO catalogue · F4 SLO baseline (p95 budgets, `@vercel/otel` + Vercel Speed Insights RUM) · Spec § SC-010 (per-surface budgets) · Q6 + Q7 + FR-016a + FR-018
**Companion checklists**: [privacy.md](./privacy.md) ✅ · [security.md](./security.md) ✅ · [ux.md](./ux.md) ✅ · [a11y.md](./a11y.md) ✅ · [i18n.md](./i18n.md) ✅

## Per-Surface Latency Budgets (SC-010)

- [ ] CHK001 Are **6 per-surface p95 latency budgets** explicitly quantified with concrete numbers — compose page TTFB <600ms / submit endpoint <1.2s / admin queue list <500ms @ 1k pending / admin approve & send-now <1.5s / webhook handler <250ms / public unsubscribe page TTFB <400ms? [Measurability, Spec § SC-010 + Q6]
- [ ] CHK002 Are **percentile definitions** (p50 / p95 / p99) specified consistently — i.e., all 6 budgets express p95 with same measurement window (rolling 7-day RUM + monthly synthetic), not a mix of p95/p99? [Consistency, Spec § SC-010]
- [ ] CHK003 Are **enforcement consequences** specified — i.e., "any budget breach in two consecutive monthly RUM windows blocks the next release until remediation lands" per SC-010? [Clarity, Spec § SC-010]
- [ ] CHK004 Are **scale conditions per budget** explicit — admin queue budget specifies "@ 1k pending broadcasts max"; what scale assumption applies to compose page (member quota lookup), submit endpoint (5k recipient cap resolution)? [Coverage, Plan § Performance budgets]
- [x] CHK005 Are **dev vs production budget split** specified — F5 set precedent (SLO-F5-002a/b dev vs prod; Plan § Tech Stack mentions async-receipt-PDF flag); does F7 need a similar dev-relaxed budget for any surface? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Budget framing — single-tier (prod) + dev-relaxed (CHK005, CHK007) explicitly states dev/test environments may exceed budgets by up to 1.5× without blocking PR merges (matching F4 dev-relaxed convention); all SC-010 budgets MUST hold in production RUM windows]
- [ ] CHK006 Is the **TTFB definition** consistent across compose + unsubscribe — both quoted as TTFB but is this server-render time, or full first-paint? [Clarity, Spec § SC-010 + § Q6]
- [x] CHK007 Are **budget exclusions** specified — i.e., what's excluded from p95 budget (Resend RTT excluded from submit endpoint? Network latency excluded from RUM?)? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Budget framing > Excluded from p95 budget explicitly excludes Resend RTT (measured separately as `broadcasts.resend_api_rtt_seconds` histogram), Vercel network egress, browser-side network latency; included: server compute + DB query + sanitiser + audit-emit + serialisation; cold-start INCLUDED]
- [ ] CHK008 Are **measurement methodologies** specified — Vercel Speed Insights for RUM + CI synthetic for budget-pass criterion at PR time + OTel histogram metric per route? [Completeness, Spec § SC-010 + Plan § Observability]

## Throughput & Scale Limits

- [ ] CHK009 Is the **5,000 recipient hard cap per single broadcast** (FR-016a / Q7) measurable + enforced at both submit boundary AND dispatch boundary? [Measurability, Spec § FR-016a + Q7]
- [ ] CHK010 Are **rate-limit thresholds** quantified — "10 submissions per member per rolling 24h window" (Spec § Assumptions); is this per-member-per-tenant or platform-global? [Clarity, Spec § Assumptions Rate limit]
- [ ] CHK011 Is the **200 KB body cap** specified with its rendered-HTML-not-source-text basis (Q4) and how the count is performed (post-sanitiser, byte-length of UTF-8)? [Clarity, Spec § Q4 + Plan § Sanitiser]
- [ ] CHK012 Is the **100-entry custom segment cap** (Spec § Assumptions) measurable — i.e., enforced at the submit boundary with a clear error code (`broadcast_custom_recipient_unknown` covers unknown-resolution but is there a separate cap-exceeded code)? [Clarity, Spec § Assumptions Segmentation + Q9]
- [ ] CHK013 Is the **subject 200-character limit** (Q4) enforced at byte boundary or grapheme boundary — resolved by i18n.md CHK030 to grapheme clusters? [Consistency, i18n.md CHK030 + Spec § Q4]
- [ ] CHK014 Is the **1,000 pending broadcasts** queue-list scale assumption justified — i.e., is 1k a hypothetical worst case (SweCham ~131 members × 6 quota = 786 max-yearly) or a known production target? [Clarity, Spec § SC-010 admin queue budget @ 1k]
- [x] CHK015 Is the **per-tenant maximum total broadcasts/year** scale documented — i.e., for the largest tier mix (Premium = 6/yr × N members), is the worst-case annual volume bounded? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Capacity ceilings & throughput (CHK015, CHK020, CHK051, CHK052) explicitly bounds per-tenant annual volume at 75,000 broadcasts/year (5k members × 15/yr Diamond tier ceiling); per-tenant per-day soft cap 5,000; cross-tenant total bounded by Resend account tier; F11 SaaS-billing required for higher]
- [ ] CHK016 Are **concurrency limits** specified for cron dispatch — single cron worker globally, or per-tenant lock parallelism? [Coverage, Plan § Cron dispatch idempotency]

## Resend & External Dependency Performance

- [x] CHK017 Are **Resend Broadcasts API RTT assumptions** explicit — i.e., what p95 RTT is assumed for `POST /broadcasts` (typically 200–800ms per Resend docs); what's the budget for retries? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Budget framing > Excluded from p95 budget makes Resend RTT a separately-measured histogram metric; Plan § Capacity ceilings > Resend rate-limit response defines retry budget (5 retries with exponential backoff 1/2/4/8/16s, 24h max retry window before failed_to_dispatch)]
- [ ] CHK018 Are **Resend webhook delivery SLA assumptions** documented — Resend typically delivers webhooks within seconds of an event; F7 assumes this for SC-008 (95% within 30 min)? [Coverage, Plan § Webhook handling + Spec § SC-008]
- [ ] CHK019 Is the **submit endpoint p95 < 1.2s** budget feasibility analysed — submit must run sanitiser + segment resolution + reservation insert; is sanitiser bounded (DOMPurify on 200KB body)? [Measurability, Spec § Q6 + Plan § Tech Stack DOMPurify]
- [x] CHK020 Are **Resend rate-limit considerations** documented — Resend imposes account-level limits (e.g., per-second + per-day API caps); does F7 spec a back-pressure / queue strategy if Resend rate-limits the dispatcher? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Capacity ceilings > Resend rate-limit response (CHK020, CHK051) — transient 429 → exponential backoff 1/2/4/8/16s × 5 retries; row stays in `approved`; cron retries next 5-min cycle; 24h sustained → `failed_to_dispatch` + admin page; 5xx similar with `broadcast_resend_resource_missing` early-warning at 4th retry; connection timeout/DNS → fail fast, next cycle picks up; >1h sustained → outage runbook]
- [ ] CHK021 Is the **webhook handler p95 < 250ms** budget feasibility analysed — handler runs Svix HMAC-SHA256 verification + DB upsert + audit emit; can this fit within 250ms at p95 with cold-start factored in? [Measurability, Plan § Webhook]
- [ ] CHK022 Are **webhook retry timing assumptions** specified — Resend retries with backoff; does F7 specify max retry duration (idempotency vs. dedup window)? [Coverage, Plan § Webhook idempotency]
- [ ] CHK023 Are **Resend outage degradation requirements** measurable — "after 1h sustained outage admin is paged" (Spec § Edge cases); how is "outage" detected (consecutive failed calls? timeout pattern?)? [Clarity, Spec § Edge cases Resend account-level outage]

## Database Query Performance

- [x] CHK024 Are **RLS overhead expectations** documented — F7 enforces tenant isolation via RLS+FORCE; is the per-query overhead bounded (F3 set precedent of <5ms additional per query)? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > RLS overhead bound (CHK024) — per-query RLS overhead MUST be ≤5ms p95 (F3 baseline); achieved by ensuring every composite index carries `tenant_id` as leading column; verified via `EXPLAIN ANALYZE` in integration tests for the 5 hottest F7 queries]
- [x] CHK025 Are **segment-resolution query performance** requirements specified — segment resolver query joins members + plans + suppression at scale (5k members worst case); index strategy quantified? [Measurability, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Segment resolver indexing (CHK025) — `members(tenant_id, plan_id) INCLUDE (primary_contact_email, member_id)` for fast resolution; suppression filter as single anti-join `WHERE primary_contact_email NOT IN (SELECT email_lower FROM marketing_unsubscribes WHERE tenant_id = $1)`; worst-case 5k members + 5k suppressions: <50ms p95 on Neon Singapore]
- [x] CHK026 Is the **quota counter view performance** budget defined — view is computed (NOT stored aggregate) over `members × plans × broadcasts WHERE status='sent'`; at what scale does it need materialization? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Quota counter view (CHK026, CHK059) — computed view until tenant exceeds 100,000 sent broadcasts/year, then converted to materialised view with 5-min refresh (deferred to F7.1); MVP scale (SweCham 786/yr) is sub-10ms; Redis 60s TTL cache is F7.1 optimisation]
- [x] CHK027 Are **advisory lock contention** assumptions documented — `pg_advisory_xact_lock(hashtextextended('broadcasts:'||tenantId||':'||broadcastId, 0))` is per-(tenant, broadcast); how does worst-case contention scale? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Advisory lock contention (CHK027) — per-(tenant, broadcast) lock; collision probability 1/2^64 (effectively zero); worst-case single tenant 1k simultaneous dispatches serialise through lock, cron 5-min cadence + per-tenant fairness bounds to <100/cycle; lock acquisition timeout 5s (vs F4's 30s); F7 not §87-numbering-sensitive so retry next cycle is fine]
- [x] CHK028 Are **suppression-list lookup performance** requirements specified — at-dispatch each recipient checked against `marketing_unsubscribes` (SC-004 zero-leak); index strategy on `(tenant_id, email_lower)`? [Measurability, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Suppression lookup batching (CHK028, CHK058) — single batch query per dispatch run `SELECT email_lower FROM marketing_unsubscribes WHERE tenant_id = $1 AND email_lower = ANY($2::text[])`; worst case 5,000 emails × 1 query (NOT N+1); index `(tenant_id, email_lower)` ensures <20ms execution]
- [x] CHK029 Are **custom-list validation query** budgets quantified — FR-015d resolves each custom entry to members.primary_contact_email OR contacts.email OR event_attendees.email (3 LEFT JOINs per entry × up to 100 entries); is this batched? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Custom-list validation batching (CHK029) — single CTE that UNIONs the 3 source tables and LEFT JOINs against the input array via `unnest($2::text[])`; worst case 100 entries × 1 query = 1 query, sub-30ms p95; complete SQL pattern documented]
- [x] CHK030 Is the **broadcast_deliveries table growth** projected — per broadcast × up to 5k recipients × N broadcasts/year per tenant; does data-model define partitioning or retention pruning? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > broadcast_deliveries growth & retention (CHK030) — worst-case 18.75B rows at 10-tenant SaaS × 5-yr retention; nightly prune cron deletes >5yr; partitioning by `(tenant_id, EXTRACT(YEAR FROM sent_at))` introduced when first tenant exceeds 10M rows (F7.1+); index strategy: 3 composite indexes for per-broadcast rollup + retention prune + recipient history]

## Cron Dispatch Performance & Reliability

- [ ] CHK031 Is the **5-minute cron cadence** justified for SC-008 ("95% within 30 minutes of approval") — can dispatch land within target with 5-min granularity + Resend RTT + webhook propagation? [Measurability, Spec § US6 + SC-008]
- [x] CHK032 Are **cron handler runtime budgets** specified — single run picks up N due-broadcasts; how long can the run hold the cron-job.org Bearer-auth slot before timeout? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Cron dispatch performance & retry policy > Cron handler runtime budget (CHK032) — single cron run MUST complete in ≤4 minutes (5-min cadence with 1-min safety margin against cron-job.org HTTP timeout); worker processes due-broadcasts in batches of 10; ~3s per broadcast × 10 = ~30s/cycle, well within budget]
- [x] CHK033 Is the **stuck-`sending` detection budget** specified — F7 has a `broadcast_resend_resource_missing` event for stuck dispatches; what's the staleness threshold (analogous to F5's `stale_pending_count` 5-min check)? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Cron dispatch performance > Stuck-`sending` detection (CHK033) — broadcast in `sending` with `dispatched_at > 5 min ago` is stuck; separate reconciliation cron (15-min cadence) emits `broadcast_resend_resource_missing` + admin page; after 24h sustained stuck, transitions to `failed_to_dispatch`; mirrors F5 stale-pending-count pattern]
- [ ] CHK034 Are **cron concurrent-worker semantics** measurable — `SELECT FOR UPDATE SKIP LOCKED` + advisory lock per-(tenant, broadcast); test asserts only 1 dispatch even under simultaneous workers (US6 AS3)? [Measurability, Spec § US6 AS3 + Plan § Cron]
- [ ] CHK035 Is the **scheduled-send delay budget** quantified — "broadcast scheduled for T0 dispatched within T0+5min" (US6 AS1); is the 5-min slack acceptable for member-facing display ("we'll send at <date>")? [Clarity, Spec § US6 AS1]
- [x] CHK036 Are **cron retry semantics on transient Resend failures** specified — exponential backoff? Max attempts? Hand-off to dead-letter? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Cron dispatch performance > Cron retry policy (CHK036) — transient failures (429/5xx/timeout) → exponential backoff per CHK020; max 24-hour retry window before final `broadcast_failed_to_dispatch` audit + admin page + member-facing transactional email; no dead-letter queue in MVP (24h window + admin paging is sufficient)]

## Cold-Start, Bundle Size, & Frontend Performance

- [ ] CHK037 Is the **Tiptap dynamic-import bundle size** budgeted — Tiptap @^3 + StarterKit weighs ~200KB minified-gzipped; does the compose page lazy-load it to keep TTFB <600ms? [Measurability, Plan § Tech Stack Tiptap dynamic-import]
- [x] CHK038 Are **JS bundle budgets per route** specified — F7 admin queue <X KB, member compose <Y KB; or inherited from F1+F4 bundle baseline? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Frontend performance > JS bundle budget per route (CHK038) — compose ≤180 KB gz (Tiptap lazy), admin queue ≤120 KB gz (TanStack), broadcast detail ≤100 KB gz, member benefits ≤80 KB gz, public unsubscribe ≤30 KB gz (server-only); inherited from F1+F4 baseline 150 KB gz; enforced via `next-bundle-analyzer` CI step]
- [x] CHK039 Are **server-component render budgets** documented for the admin queue list — TanStack Table SSR with 1k rows; is virtualization specified? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Frontend performance > Server-component rendering at scale (CHK039) — TanStack Table v8 with `@tanstack/react-virtual` virtualization, enabled when row count >100 (F3+F4 pattern); at 1k rows, virtualization keeps DOM nodes ≤30 visible rows; SSR initial render ≤100 row stub for SEO + first-paint]
- [ ] CHK040 Is the **hydration cost** budgeted for the compose page — Tiptap is client-only; how is the SSR shell + hydration boundary defined to keep TTFB <600ms? [Coverage, Plan § UX Tiptap dynamic-import]
- [ ] CHK041 Are **public unsubscribe page** performance constraints documented — server-rendered, no JS dependency, <400ms TTFB; what's the database query budget (1 token-verify + 1 upsert + 1 audit emit)? [Measurability, Spec § Q6 + Contracts § unsubscribe-public.md]
- [x] CHK042 Is the **cold-start budget** for webhook + cron handlers specified — Vercel Functions cold-start typically 200–400ms; webhook 250ms p95 budget — how does cold-start affect this? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Cold-start, caching, & memoisation > Cold-start budget (CHK042) — webhook 250ms includes 100ms cold-start tolerance (warm path target ~150ms); cold invocations EXCEED budget but accepted as occasional miss (Resend retries, signature verification short-lived, audit-emit async); cron 4-min budget absorbs cold-start comfortably; no warm-keeping ping in MVP (cost > benefit at SC-008 30-min granularity); revisit at F7.1+ if RUM shows >5% miss]

## Observability, Measurement, & SLO Catalogue

- [ ] CHK043 Are the **OTel metrics** catalogued for F7 — `broadcasts.submitted_total`, `broadcasts.dispatched_total`, `broadcasts.failed_total`, `broadcasts.recipient_count_histogram`, `broadcasts.dispatch_latency_seconds`, `broadcasts.webhook_processing_duration_seconds` etc.? [Completeness, Plan § Observability + § Active Technologies]
- [ ] CHK044 Are **SLO targets per metric** specified — i.e., dispatch_latency_seconds p95 < 1.5s; webhook_processing_duration_seconds p95 < 250ms; with consistent histogram bucketing? [Measurability, Spec § SC-010]
- [x] CHK045 Are **alert rules quantified** — paging thresholds for stuck-`sending` count, complaint-rate per-broadcast >5% (Q14 SC-005 (b)), dispatch-failure rate, Resend webhook signature-rejection spike? [Completeness, Resolved — Plan § Performance & Capacity deep-dive > Observability — metrics, traces, alerts, sample rates > Alert rules catalogue (CHK045) — 8-row table with thresholds + severity + runbooks: stuck_sending P1, complaint_rate>5% P1+halt, dispatch_failure_rate>10%/1h P2, webhook_signature_rejection>5/min P1-security, dispatch_latency_p95>1.5s/30min P3, queue_pending>8000 P2, bounce_complaint_rolling_30d>2% P2+block, member_halt_count>0 P3]
- [ ] CHK046 Is the **alert silencing / runbook reference** specified — analogous to F5's deliverability runbook reference for SC-005 (b) auto-halt? [Coverage, Spec § SC-005 (b) + Plan § Observability runbooks]
- [x] CHK047 Are **distributed trace spans** specified — `member_compose → submit → sanitiser → segment_resolver → reservation_insert → cron_dispatch → resend_api → webhook_receive → audit_emit`? [Completeness, Resolved — Plan § Performance & Capacity deep-dive > Observability > Distributed trace span set (CHK047) — full catalogue of 6 root spans (member_compose_page_load, member_submit_broadcast, admin_approve_send_now, cron_dispatch_scheduled, webhook_receive_resend, public_unsubscribe) with all child spans documented in code-block format including external Resend API span]
- [ ] CHK048 Are **log redaction rules** quantified — recipient emails are PII; are recipient lists logged hashed/truncated/never-raw per F1 logger.ts forbidden-fields convention? [Coverage, security.md cross-reference + Plan § Observability]
- [x] CHK049 Are **sample rates** specified for high-frequency metrics — webhook events fire per-recipient (5k/broadcast); is sampling needed to avoid OTel cost blowup? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Observability > Sample rates (CHK049) — Metrics 100% (lifecycle low-volume); Webhook events 100% (still affordable at peak); Trace sampling 10% prod / 100% dev/staging via OTel `parentbased_traceidratio` + tail-sampler; errors + slow-path requests (>1s) at 100% via tail-sampler; bug investigations request 100% temporarily via env-var override]

## Degradation, Capacity Planning, & Edge Conditions

- [ ] CHK050 Are **degradation requirements under high load** specified — what happens when admin queue list query exceeds 500ms p95 budget (auto-paginate? cache? warn admin?)? [Coverage, Spec § SC-010 + Plan § UX]
- [x] CHK051 Are **resend-rate-limit responses** specified — if Resend returns 429, does cron dispatcher exponential-backoff? Park broadcast back to `approved`? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Capacity ceilings > Resend rate-limit response (CHK020, CHK051) — transient 429 → exponential backoff 1/2/4/8/16s × 5 retries; row stays in `approved` after exhaustion; cron retries next 5-min cycle; 24h sustained → `failed_to_dispatch` audit + admin page]
- [x] CHK052 Are **queue-overflow degradation** requirements specified — what happens at 10k pending broadcasts (10× SC-010 assumption)? Is there a backpressure on submit? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Capacity ceilings > Queue overflow (CHK052) — at 10× SC-010 assumption (10k pending), submit endpoint surfaces 503 `broadcast_queue_full` with bilingual message "Submission queue is full — try again in 15 minutes"; admin queue header shows red banner "Queue overflow — N pending (cap: 10k)" with deep-link to bulk-approve; safety valve, alert fires at 8k pending]
- [x] CHK053 Are **member-facing latency display rules** specified — "Submitting…" spinner timeout (3s? 10s?); failure mode if submit endpoint exceeds p99 budget? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Frontend performance > Member-facing latency display (CHK053) — "Submitting…" spinner timeout 8 seconds (covers p99 + Resend RTT spike); on timeout → toast "Taking longer than expected — your broadcast may still be processing. Refresh to check status." with `aria-live="polite"`; submit button disabled until server response or 12s hard timeout (then re-enables for retry)]
- [ ] CHK054 Are **future-tenant scale projections** documented — FR-018 says future tenants ≤5k members; F7 budgets must hold at that ceiling, not just SweCham's 131? [Clarity, Spec § Q6 + FR-018]
- [x] CHK055 Is the **per-tenant resource isolation** documented — RLS prevents data leak but what about a noisy-neighbour tenant submitting 1000 broadcasts/hour saturating cron? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Capacity ceilings > Per-tenant noisy-neighbour mitigation (CHK055) — cron dispatcher uses per-tenant fairness with round-robin tenant traversal; sorts by `tenant_id ASC, scheduled_for ASC`; per-(tenant, broadcast) advisory lock + round-robin naturally bounds parallel dispatch to 1 broadcast per tenant per cron worker run; multi-worker scaling preserves property via consistent-hash-by-tenant]

## Caching, Optimisation, & Memoisation

- [x] CHK056 Are **server-component caching strategies** specified for the admin queue list — Next.js 16 Cache Components opportunity; or always-fresh? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Cold-start, caching, & memoisation > Cache Components strategy (CHK056) — admin queue list uses Next.js 16 Cache Components with `revalidate: 30s` per-tenant cache key; member benefits page `revalidate: 60s` per-(tenant, member); broadcast detail NO caching (audit timeline must be fresh); public unsubscribe NO caching (token-bound idempotent)]
- [x] CHK057 Are **estimated_recipient_count memoisation** rules specified — segment resolution at compose time vs. at dispatch time; is the count cached on the broadcast row at submit? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Cold-start, caching, & memoisation > Recipient-count memoisation (CHK057) — `estimated_recipient_count integer NOT NULL` cached on broadcasts row at submit time; compose-page preview re-computes on segment change (no cache); at dispatch, if `submitted_at < NOW() - INTERVAL '24 hours'` recipient list re-resolved fresh to catch member churn; otherwise cached count trusted (>95% dispatch within 24h)]
- [x] CHK058 Are **suppression-list query optimisation** documented — per-recipient lookup at dispatch is N queries; is it batched into one `WHERE email = ANY($1)` per dispatch run? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Suppression lookup batching (CHK028, CHK058) — single batch query `SELECT email_lower FROM marketing_unsubscribes WHERE tenant_id = $1 AND email_lower = ANY($2::text[])`; worst case 5,000 emails × 1 query NOT N+1; index `(tenant_id, email_lower)` <20ms]
- [x] CHK059 Are **quota-counter caching strategies** specified — view is computed-not-stored; at higher scale this becomes a hot read; is materialization triggered by row count threshold? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > Database query performance > Quota counter view (CHK026, CHK059) — computed view until tenant exceeds 100,000 sent broadcasts/year, then materialised view with 5-min refresh (deferred to F7.1); MVP scale (786/yr) sub-10ms; Redis 60s TTL is F7.1 optimisation]

## Conflicts, Assumptions, Documentation

- [ ] CHK060 Is the **assumption that "Resend Broadcasts handles bulk dispatch internally"** explicit — F7 calls Resend API once per broadcast, not once per recipient; this is a critical performance assumption requiring explicit documentation? [Assumption, Plan § Resend Broadcasts]
- [ ] CHK061 Is the **assumption that "Vercel Functions cold-start is acceptable for webhooks"** documented — webhook 250ms budget is tight for cold-start; is the function kept warm via cron pings or accepted as occasional miss? [Assumption, Plan § Webhook Node runtime]
- [ ] CHK062 Are **F4/F5 baseline budget references** explicit — F7 budgets cite "mirrors F4 invoice-list" + "mirrors F5 initiate budget"; are the baselines load-tested at comparable scale? [Traceability, Spec § Q6 + Plan § Performance budgets]
- [ ] CHK063 Are **performance-related critique findings** (Round 2 R2-NEW-3 stuck-sending reconciliation, Round 1 P10 mobile-compose-wizard performance) traceable to specific FRs / spec sections / plan sections? [Traceability, Critique reports under critiques/]
- [ ] CHK064 Is the **`docs/observability.md` § 14** SLO-catalogue cross-reference explicit for F7? [Traceability, Plan § Constitution Check Principle VII]
- [x] CHK065 Is **performance regression detection** specified for the CI pipeline — i.e., do PR checks include a synthetic load run, or only the monthly RUM windows? [Coverage, Resolved — Plan § Performance & Capacity deep-dive > CI regression detection (CHK065) — every PR runs `scripts/synthetic-load-broadcasts.ts` exercising 5 critical paths; PR FAILS if p95 exceeds SC-010 budget by >10% for any route; nightly job runs same script against staging Neon Singapore at full 5k member fixture; RUM windows cover production p95 over rolling 7-day + monthly enforcement window per SC-010]

## Notes

- Check items off as completed: `[x]`
- For each unchecked item, log resolution path: (a) update spec/plan to address, (b) accept gap with rationale in Notes section, (c) defer to /speckit.tasks discovery task with stakeholder owner.
- Items marked `[Gap]` represent missing requirements; staff-reviewer signing this checklist must confirm each gap is intentionally accepted or addressed.
- This checklist tests **requirements quality**, not implementation. Implementation verification happens at /speckit.verify gate.
- 65 items total (CHK001–CHK065). Constitution Gate 4 expectation for sensitive features (~30 items minimum; F7's perf complexity — 6 surfaces × multiple paths × external deps — warrants ~60+ items mid-range coverage). perf is the **6th of 6** expected checklists for F7 (privacy + security + ux + a11y + i18n done) — completes Gate 4 sensitive-feature coverage.
- **Cross-references**: CHK013 (subject byte vs grapheme) cross-links to i18n.md CHK030; CHK048 (log redaction) cross-links to security.md CHK020 + privacy.md CHK048; CHK054 (5k future-tenant scale) cross-links to security.md tenant-isolation; CHK045 (alert rules) cross-links to security.md CHK057 (halt-state alerting); CHK037 (Tiptap bundle) cross-links to a11y.md CHK030 (Tiptap shimmer).
- Sign-off per Constitution Principle VII Perf & Observability — `performance-slo-guardian` + `observability-instrumentor` agents run the staff-review pass; SC-010 is a Review-Gate blocker.

## Quality Dimension Summary

| Dimension | # Items | Coverage |
|-----------|---------|----------|
| Completeness | 7 | 6 latency budgets + measurement methodology + OTel metrics + traces + alert rules |
| Clarity | 10 | Percentile definitions, TTFB definition, scale assumption, scheduled-send delay, future-tenant projection |
| Consistency | 2 | Percentile across surfaces, byte-vs-grapheme alignment with i18n.md |
| Coverage | 30 | Resend RTT, webhook retry, RLS overhead, advisory lock, suppression lookup, queue overflow, sample rates, log redaction |
| Measurability | 9 | 5k cap, 200KB body, 100 custom, 1k queue, 30-min SC-008, dispatch latency budget, cron worker semantics, FR-015d batching, regression detection |
| Traceability | 3 | F4/F5 baseline references, Round 1+2 critique findings, observability.md § 14 cross-ref |
| Assumption | 2 | Resend bulk-dispatch, Vercel cold-start tolerance |
| Conflict-resolution | 0 | (none expected — perf is mostly additive to other checklists) |
| Gap markers | **0 open** | All 26 originally-flagged perf gaps (CHK005, CHK007, CHK015, CHK017, CHK020, CHK024–CHK030, CHK032, CHK033, CHK036, CHK038, CHK039, CHK042, CHK045, CHK047, CHK049, CHK051–CHK053, CHK055–CHK059, CHK065) resolved in plan.md § UX Implementation Patterns > Performance & Capacity deep-dive (2026-04-29) — see Resolved-in-Place section below |

Total: **65 items** across 9 categories. Aligns with Gate 4 "formal release gate" depth expectation. **All gap markers resolved 2026-04-29** — checklist is Gate-4 ready pending /speckit.review staff sign-off (performance-slo-guardian + observability-instrumentor agents).

## Resolved-in-Place (2026-04-29)

The 26 perf `[Gap]` markers identified at checklist creation have been resolved by adding the **Performance & Capacity deep-dive** subsection to `plan.md § UX Implementation Patterns`. Resolutions grouped by sub-section:

### Budget framing (CHK005, CHK007, CHK065)

| ID | Resolution Path |
|----|-----------------|
| CHK005 | Single-tier (prod) budgets per SC-010 + dev-relaxed 1.5× tolerance (matches F4 convention); all SC-010 budgets MUST hold in production RUM |
| CHK007 | Excluded: Resend RTT (separate `broadcasts.resend_api_rtt_seconds` histogram), Vercel network egress, browser-side latency. Included: server compute + DB + sanitiser + audit-emit + cold-start |
| CHK065 | CI synthetic load (`scripts/synthetic-load-broadcasts.ts`) on every PR; fails if p95 >10% over budget; nightly staging full-5k-member fixture; RUM 7-day + monthly enforcement |

### Capacity ceilings & throughput (CHK015, CHK020, CHK051, CHK052, CHK055)

| ID | Resolution Path |
|----|-----------------|
| CHK015 | Per-tenant 75k broadcasts/yr ceiling (5k members × 15/yr Diamond); per-day soft cap 5k; cross-tenant bounded by Resend account tier |
| CHK020 + CHK051 | Resend 429 → exponential backoff 1/2/4/8/16s × 5 retries; row stays `approved`; cron retries next cycle; 24h sustained → `failed_to_dispatch` + admin page; 5xx similar with `broadcast_resend_resource_missing` early-warning |
| CHK052 | Queue overflow at 10× SC-010 (10k pending) → submit endpoint 503 `broadcast_queue_full` + admin queue red banner + alert at 8k pending |
| CHK055 | Per-tenant fairness via cron round-robin tenant traversal + per-(tenant, broadcast) advisory lock — natural compute isolation alongside RLS data isolation |

### External dependency assumptions (CHK017)

| ID | Resolution Path |
|----|-----------------|
| CHK017 | Resend RTT separately measured; retry budget 5 retries with exponential backoff, 24h max retry window before final failure |

### Database query performance (CHK024, CHK025, CHK026, CHK027, CHK028, CHK029, CHK030, CHK058, CHK059)

| ID | Resolution Path |
|----|-----------------|
| CHK024 | RLS overhead ≤5ms p95 (F3 baseline); `tenant_id` always leading column in composite indexes; `EXPLAIN ANALYZE` verified in integration tests |
| CHK025 | `(tenant_id, plan_id) INCLUDE (primary_contact_email, member_id)`; suppression as single anti-join; <50ms p95 at 5k members + 5k suppressions |
| CHK026 + CHK059 | Computed view until tenant exceeds 100k sent/yr, then materialised view 5-min refresh (F7.1); MVP sub-10ms; Redis cache F7.1 |
| CHK027 | Per-(tenant, broadcast) advisory lock; collision 1/2^64; lock acquisition timeout 5s; F7 retry next cycle (not §87 numbering-sensitive) |
| CHK028 + CHK058 | Single batch query `WHERE email = ANY($1)` per dispatch; 5k addresses × 1 query NOT N+1; index `(tenant_id, email_lower)` <20ms |
| CHK029 | Single CTE UNIONs 3 source tables + LEFT JOIN against `unnest($2::text[])` input; 100 entries × 1 query <30ms |
| CHK030 | 18.75B row worst-case at 10-tenant SaaS × 5-yr retention; nightly prune cron deletes >5yr; partitioning `(tenant_id, year)` introduced when first tenant exceeds 10M rows (F7.1+); 3 composite indexes |

### Cron dispatch performance & retry (CHK032, CHK033, CHK036)

| ID | Resolution Path |
|----|-----------------|
| CHK032 | ≤4 minutes total runtime (5-min cadence with 1-min safety margin); batches of 10 broadcasts/run; ~30s/cycle in practice |
| CHK033 | Stuck-`sending` threshold 5 min; reconciliation cron 15-min cadence emits `broadcast_resend_resource_missing` + admin page; 24h sustained → `failed_to_dispatch` |
| CHK036 | Transient → exponential backoff per CHK020; max 24h retry window then `failed_to_dispatch` + member transactional email; no DLQ in MVP |

### Frontend performance (CHK038, CHK039, CHK053)

| ID | Resolution Path |
|----|-----------------|
| CHK038 | JS bundle budgets per route: compose ≤180KB / queue ≤120KB / detail ≤100KB / benefits ≤80KB / unsubscribe ≤30KB gz; `next-bundle-analyzer` CI |
| CHK039 | TanStack Table v8 + `@tanstack/react-virtual` virtualization at >100 rows; ≤30 visible DOM nodes at 1k rows; SSR ≤100 row stub |
| CHK053 | Submit spinner 8s timeout → toast "Taking longer than expected — refresh to check status" with `aria-live="polite"`; submit button disabled to 12s hard timeout |

### Cold-start, caching, memoisation (CHK042, CHK056, CHK057)

| ID | Resolution Path |
|----|-----------------|
| CHK042 | Webhook 250ms includes 100ms cold-start tolerance; warm path target 150ms; cold invocation EXCEEDS budget but accepted (Resend retries, async audit-emit, sub-second hash verification); cron 4-min absorbs comfortably; no warm-keeping ping in MVP |
| CHK056 | Admin queue Cache Components `revalidate: 30s` per-tenant; member benefits `revalidate: 60s` per-(tenant, member); broadcast detail + unsubscribe NO caching |
| CHK057 | `estimated_recipient_count` cached on broadcast row at submit; re-resolved fresh at dispatch if >24h; otherwise cached count trusted (>95% dispatch <24h) |

### Observability — alerts, traces, sample rates (CHK045, CHK047, CHK049)

| ID | Resolution Path |
|----|-----------------|
| CHK045 | 8-row alert table with thresholds + severity + runbooks (stuck_sending P1; complaint_rate>5% P1+halt; dispatch_failure_rate P2; webhook_signature_rejection P1-security; latency_p95 P3; queue overflow P2; rolling 30d bounce/complaint P2+block; member_halt_count P3) |
| CHK047 | 6 root spans documented + child spans: member_compose_page_load, member_submit_broadcast (sanitise/resolve/reserve/lock/insert/audit), admin_approve_send_now (load/transition/resend-api/audit), cron_dispatch_scheduled, webhook_receive_resend (verify/upsert/audit), public_unsubscribe (verify/upsert/audit) |
| CHK049 | Metrics 100%; webhook events 100%; trace sampling 10% prod / 100% dev/staging via OTel `parentbased_traceidratio` + tail-sampler; errors + slow-path >1s at 100% via tail-sampler |

All 26 items are now marked `[x]` with the resolution path + plan section recorded inline.

## Cross-references

- **plan.md § UX Implementation Patterns > Performance & Capacity deep-dive (perf.md gaps closure 2026-04-29)** — primary resolution surface for all 26 gap markers
- **plan.md § Constitution Check > Principle VII Perf & Observability** — sign-off requirement
- **plan.md § Tech Stack** — Resend Broadcasts API, Tiptap dynamic-import, Vercel Functions runtime
- **plan.md § Cron dispatch idempotency** — companion narrative for CHK027 + CHK032 + CHK033
- **spec.md § SC-010** — 6 per-surface p95 budgets baseline
- **spec.md § Q6** — performance budgets framing rationale
- **spec.md § Q7 + FR-016a** — 5,000 recipient hard cap
- **spec.md § Q14 SC-005 (b)** — complaint-rate per-broadcast >5% auto-halt (CHK045 alert #2)
- **spec.md § US6** — cron dispatch acceptance scenarios (CHK032 + CHK033 budgets)
- **spec.md § Edge cases > Resend account-level outage** — extended by CHK020 + CHK051 retry policy
- **spec.md § Key Entities > Quota Counter** — CHK026 + CHK059 materialisation rule
- **data-model.md § broadcast_deliveries retention rule** — CHK030 retention prune
- **data-model.md § marketing_unsubscribes** — CHK028 + CHK058 index strategy
- **`docs/observability.md` § 14 SLO catalogue** — CHK045 alert rules destination + CHK047 trace span standards
- **scripts/synthetic-load-broadcasts.ts** (NEW per CHK065) — CI regression detection script
- **scripts/check-i18n-coverage.ts** — companion CI script (i18n.md CHK054)
- **F4 inheritance** — CHK005 dev-relaxed convention + CHK038 JS bundle baseline (150KB gz)
- **F5 inheritance** — CHK033 stale-pending-count pattern (15-min reconciliation cron)
- **Companion checklists**: privacy.md ✅ · security.md ✅ · ux.md ✅ · a11y.md ✅ · i18n.md ✅ — all 6/6 done; **F7 Gate 4 COMPLETE**
