# Runbook — `broadcasts_perf_regression`

**Owner**: Platform on-call
**Severity**: warn (UX degradation; not data integrity)
**Source signal**: Vercel Speed Insights p95 latency budget breach on any of 6 F7 surfaces; OTel histogram alerts (compose page TTFB > 600ms · submit endpoint > 1.2s · admin queue list > 500ms · admin approve & send-now > 1.5s · webhook handler > 250ms · public unsubscribe page TTFB > 400ms — all per SC-010 / Q6)
**Audit events**: none (perf regression is metric-only)
**Last reviewed**: 2026-04-29 (Batch D T032 spec scaffolding)
**Status**: SPEC — emit sites + observability metrics land Phase 3+ (T036+); operational triage assumes the Phase 3+ instrumentation is in place.

---

## Symptom

One or more F7 surface p95 latency budgets are breached. Specific budgets per SC-010 / Q6:

| Surface | Budget | Metric |
|---------|--------|--------|
| Compose page TTFB | < 600ms | `broadcasts.compose.ttfb_ms` p95 |
| Submit endpoint | < 1.2s | `broadcasts.submit.duration_ms` p95 |
| Admin queue list | < 500ms @ 1k pending | `broadcasts.admin_queue.duration_ms` p95 |
| Admin approve & send-now | < 1.5s | `broadcasts.approve_send_now.duration_ms` p95 |
| Webhook handler | < 250ms | `broadcasts.webhook.duration_ms` p95 |
| Public unsubscribe page TTFB | < 400ms | `broadcasts.unsubscribe.ttfb_ms` p95 |

## Why this matters

Submit + approve + webhook are interactive surfaces — sustained > 2× budget breach erodes admin/member confidence; recipients abandoning unsubscribe-page flow means we'd fail PDPA §32 / GDPR Art. 21 "right to object" obligations if links aren't honoured promptly.

The submit + approve & send-now budgets are intentionally generous (1.2s + 1.5s) — they include sanitiser cost on member-supplied HTML up to 200KB + Resend API RTT. Anything beyond budget indicates a regression vs. these documented exceptions (Constitution Principle VII allows the deviation per `specs/010-email-broadcast/plan.md § Complexity Tracking`).

---

## Triage steps (in order)

1. **Identify which surface is breaching**.
   - Vercel Speed Insights → filter routes by F7 paths (`/portal/broadcasts/*`, `/admin/broadcasts/*`, `/api/broadcasts/*`, `/api/admin/broadcasts/*`, `/unsubscribe/*`, `/api/webhooks/resend-broadcasts`).
   - Cross-check against OTel histograms in observability dashboard.

2. **Correlate with recent deploys**.
   - Vercel Deployments → if the regression started immediately after a deploy → roll back via `vercel rollback <previous-deployment-url>`.

3. **Identify the bottleneck**.
   - For submit endpoint: trace the OTel span tree (sanitiser → segment-resolver → repo insert → audit emit → notification enqueue). Identify which span is dominating p95.
   - For approve & send-now: split between application work (`approve-broadcast` use-case) vs Resend API RTT (`broadcasts.gateway.send.duration_ms`). Resend RTT > 800ms triggers a *Resend service incident* signal — see [broadcasts-dispatch-failure.md](./broadcasts-dispatch-failure.md).
   - For admin queue: query plan analysis. The `broadcasts(tenant_id, submitted_at DESC) WHERE status='submitted'` partial index (migration 0064) should make this a constant-time scan; if not, EXPLAIN ANALYZE the actual query.
   - For compose page TTFB: bundle-size regression. Run `pnpm build:analyse` to check Tiptap chunk size. Tiptap StarterKit ≈ 80KB gzipped baseline; sustained growth beyond that requires audit.

4. **Check Neon connection pool saturation**.
   - Neon Console → Compute → Connection metrics → connection_count vs `DATABASE_POOL_MAX` (10 in prod default).
   - If saturated → temporarily raise `DATABASE_POOL_MAX` via Vercel env (no code change needed) + redeploy.

5. **Check Vercel Functions cold-start rate**.
   - Cold starts add ~500ms-1s p95 in worst case. Fluid Compute reuses instances across requests so steady-state is fast — sustained cold-start rate > 5% may indicate function instance churn.
   - Increase `runtime` config `maxDuration` if cold starts correlate with timeout-driven instance recycling.

---

## Escalation

- **Resend API RTT > 1s sustained** → engage Resend support; consider regional fallback (Resend has US + EU data centres; chamber currently uses EU).
- **Neon query plan degraded** → engage Neon support; check for missing indexes or stale statistics (`ANALYZE broadcasts;`).
- **Bundle size regression > 200KB** → halt feature rollout; trace the dep + revert; engage F7 feature engineer.

---

## Recovery

After fix is deployed:

1. Verify p95 returns within budget across 1h soak window.
2. Document the regression cause + fix in Spec Kit retrospective.
3. If the fix shifted the p95 budget definition (e.g., new SC-010 amendment) → update `specs/010-email-broadcast/plan.md § Complexity Tracking` with a Constitution Principle VII deviation entry.

---

## Prevention

- Pre-merge perf benchmarks via `pnpm test:perf` (Phase 3+ T117 covers virtualization budgets).
- `pnpm build:analyse` in CI checks bundle budgets per perf.md CHK038.
- Vercel Cron + p95 alerts catch regressions within 15 min of deploy.
- Quarterly perf review per Spec Kit `/speckit.review` Performance gate.
