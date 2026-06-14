C4 fully confirmed and dispositive:
- **EN PASSED 4.0s** (line 251) — same sign-in flow, same plans render, same i18n leak assertions.
- **TH+SV time out at the identical 30.1s** at `plans-i18n-coverage.spec.ts:48` — `getByLabel(/email/i).fill` on `/admin/sign-in`, which runs BEFORE `page.goto('/admin/plans')` (line 53). The test never reaches plans rendering or any i18n key check.
- **plans-list.spec.ts PASSED 8.8s** (line 258) — actually loads `/admin/plans` + switches locale; a real plans/i18n regression would take this down.

This is a dev-server compile/serial-worker timeout on `/admin/sign-in`, not a code regression — proven by the EN case passing the identical flow in the same run.

I have verified every load-bearing claim. Summary of my independent findings:

- **i18n diff**: confirmed exactly 3 insertions, one `errorRateLimited` (renewals namespace) per locale. No broadcast/plans/payment keys touched.
- **dialog/alert-dialog diff**: confirmed pure `data-slot` attribute removal, zero className/width/structural change.
- **All 5 a11y/i18n surfaces + their specs**: confirmed UNTOUCHED in HEAD~12..HEAD (full name-only diff has none of them). The one near-miss (`zapier-walkthrough.tsx` under events) is a color-token swap on an off-path surface, not the relink dialog.
- **C6 metrics.ts** (only shared link to snapshot path): confirmed 256 insertions / 0 deletions, zero references to `broadcastsMetrics`/`auditEmitFailed`/`snapshot` — inert on the measured path.
- **W0-13 attendee-matcher**: confirmed removed only the `db` default + unused singleton; query logic byte-identical.
- **Same-run controls all green**: benefits-page-perf (C6), plans-list + EN plans-i18n (C4), journey 3/3 (everything).
- **Extra finding**: the perf file shows THREE budget misses (snapshot, csv-import-perf, timeline-perf), not one. I verified the csv-import miss exercises the F6 `importCsv` use-case (untouched), NOT the session's Stage-3 member importer — and is the same RTT-topology family. No session regression.

---

# Stage-5 Code-Side Go/No-Go Assessment — Chamber-OS / SweCham

## 1. Verdict headline

**NO session-introduced regressions.** All 12 local failures (9 a11y/i18n + 3 perf budget misses) are pre-existing / dev-mode-flake / high-RTT-topology artifacts on code paths provably untouched by HEAD~12..HEAD. The code side is **ready to hand off to preview + operator gates** — no code blocker exists.

## 2. Stage-5 § 7 criteria (the 9 verifiable code-side criteria; #1–#5 + the data/safety/monitoring gates)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | main + CI green | **PASS (code-presence) / NEEDS-operator (CI run)** | HEAD=e899c231==origin/main; F1–F9 modules all merged + tracked. Full CI pipeline run is operator-executed, not verified here. |
| 2 | All P0 + P1 closed | **BLOCKED-operator (reconcile)** | P0 4/4 closed per artifacts. P1 tally unreconciled in stale Stage-1 doc (16/19 vs 21 actionable) with explicit post-launch deferrals (P1-4/5/16/17, P1-9b). Operator must reconcile against live tracker / current main. Not a regression — a tracking gap. |
| 3 | @journey E2E green | **PASS** | 3/3 chromium GREEN after all session changes (admin+manager+member golden paths). |
| 4 | @a11y / @i18n E2E green | **NEEDS-preview** | 193 pass / 9 fail / 3 flaky / 14 skip. All 9 fails = pre-existing 320px-reflow + dev-server sign-in timeout flake on untouched surfaces (see §3). Re-run against `pnpm build` preview. |
| 5 | RUN_PERF green | **NEEDS-preview** | 3 budget misses, all high-RTT-topology (Bangkok→Neon-SG ~25ms/RTT). Same-run co-located control (benefits-page-perf, EXPLAIN 0.036ms) passed all budgets. Authoritative gate = PERF_SLO_STRICT on preview's co-located Neon. |
| 6 | § 6 operator gates (env/cron/ClamAV/flags) | **BLOCKED-operator** | Code ready; Vercel env vars, ~20 cron-job.org jobs, ClamAV Fly.io deploy, flag-flip sequence all human-run. |
| 7 | Member data imported + reconciled | **BLOCKED-operator** | Importer code DONE (PR #52). Real Excel + clean DB + run + reconcile are operator-only. |
| 9 | Rollback + read-only rehearsed | **BLOCKED-operator** | READ_ONLY_MODE + `vercel promote` + Neon PITR rehearsal is operator-only. |
| 10 | Monitoring live | **BLOCKED-operator** | OTel + Analytics + cron gauges + alerts defined in code; operator confirms ACTIVE. |

(§ 7 criterion #8 bootstrap-admin is operator-only; there is no #11 — § 7 tops out at 10.)

## 3. The 12 local failures — classified

| Cluster | finalVerdict | Session regression? | Why (one line) |
|---------|--------------|---------------------|----------------|
| C1 broadcast-a11y T192 (320px reflow) | needs_preview_run | **No** | Compose surface + spec untouched in range; 60px overflow deterministic on all 3 retries = 320px dev-chrome artifact (spec is prod-build-only). |
| C2 broadcast-i18n T197 (TH 320px) | pre_existing | **No** | Same untouched compose surface; T197@1280px TH passes — isolates to narrow viewport, not a TH-key change (i18n diff = 1 renewals key). |
| C3 pay-sheet T407 (iPad 44px CTA) | pre_existing | **No** | Pay-sheet/sheet.tsx untouched; CTA passes 320px+1920px, fails only iPad at 30.4s = full-test timeout (panel never rendered) = documented stub/Fast-Refresh flake. |
| C4 plans-i18n TH+SV | pre_existing | **No** | Dispositive: EN passes identical flow same run; TH/SV time out at sign-in `getByLabel(email)` (line 48) BEFORE plans render; plans-list.spec passes. Dev-server serial-worker compile flake. |
| C5 relink AS1/AS2/FR-014/FR-035 | pre_existing | **No** | Relink route/dialog/search/use-case/spec all untouched. Only events touch = `zapier-walkthrough.tsx` color-token swap (off-path). W0-13 matcher change is signature-only (query byte-identical). FR-014 = pre-existing test/code text mismatch from PR #26. |
| C6 snapshot-perf p95=683 | topology_expected | **No** | Snapshot hot path untouched; metrics.ts (only shared link) = 256 insertions/0 deletions, zero refs to broadcastsMetrics/auditEmitFailed. Same-run benefits-page control passed (EXPLAIN 0.036ms) → pure RTT. |
| (extra) csv-import-perf timeout (200 rows/78.9s) | topology_expected | **No** | Exercises F6 `importCsv` (`@/modules/events`, untouched) — NOT the session's Stage-3 member-importer CLI. ~394ms/row over pg_trgm fuzzy + ~25ms RTT = topology, same family as C6. |
| (extra) timeline-perf p95=584 vs 300 | topology_expected | **No** | members/timeline path untouched in range; RTT-dominated, same topology family. |

**None overturned to session_regression.** The adversarial refutations survived on every cluster; I independently re-verified the load-bearing diffs (i18n, dialog, metrics, W0-13) and same-run controls.

Note: the brief said "perf = 1 topology miss (fail-fast)" but the actual perf file did NOT fail-fast — it ran all suites and shows **3** budget misses (snapshot, csv-import, timeline). All three are RTT-topology; the two extra ones are on untouched paths. This does not change the verdict but the operator should expect 3 budget lines to clear on co-located preview, not 1.

## 4. Operator-only blockers (gate REAL-DATA go-live; code cannot close)

1. **Privacy policy / PDPA consent text** — 🟡 HARD legal blocker for real data; operator/customer must author (Claude cannot). Longest-lead item.
2. **Member data import + reconciliation** — operator provides gitignored Excel (~131 members), clears TEST data post-PITR, runs importer, reconciles.
3. **Production env vars in Vercel** — incl. boot-required F5 Stripe (TEST keys ok) + F7 Broadcasts + `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` even for members-only launch.
4. **~20 cron-job.org jobs** — F9 process-export-jobs (T101, last F9 task), F8 coordinators, F6 PII-pseudonymisation sweep, etc. (Bearer CRON_SECRET, retry OFF).
5. **ClamAV Fly.io scan-wrapper** deploy + `CLAMAV_SCAN_URL`/`_SECRET`.
6. **Feature-flag flip sequence** — incl. `ZAPIER_DPA_EXECUTED=true` (legal DPA gate, boot-fails F6 otherwise) + Stripe LIVE before F5.
7. **Stripe live-mode cutover** — 🟡 (deferrable under launch-minimal fast-follow).
8. **UAT sign-off owner** — 🟡 must name a person before Stage-5 go/no-go.
9. **Preview/staging deploy** — operator creates Vercel preview; Stage-5 @journey + RUN_PERF execution runs there.
10. **Rollback + READ_ONLY_MODE + Neon PITR rehearsal.**
11. **Monitoring confirmed live** (OTel/Analytics/gauges/alerts active).

(Companion code task, not a gate: audit_log retention-purge cron does not exist — GDPR Art.5(1)(e)/PDPA §37 storage-limitation; post-launch.)

## 5. Recommendation

**CODE-READY — pending operator + preview. No code blocker exists; ship to preview/staging now.**

- The adversarial pass found **zero** session-introduced regressions across all 12 failures. Every failing surface is provably untouched in HEAD~12..HEAD (verified against the complete name-only diff), the only two genuine shared links (dialog `data-slot` removal; metrics.ts) are demonstrably inert (attribute-only / additive-only), and every failure has a passing same-run control on the same code path (EN plans-i18n, benefits-page-perf, journey 3/3).
- **Nothing must be fixed in code first.** The 9 a11y/i18n fails (criterion #4) and 3 perf misses (criterion #5) route to the **preview run**: build-prod CSS will clear the 320px-reflow assertions, co-located Neon will clear the RTT budgets, and a non-dev-server run will clear the sign-in/Fast-Refresh timeout flakes. Recommend `pnpm test:e2e --grep @a11y|@i18n --workers=1` + `PERF_SLO_STRICT` RUN_PERF against the preview deploy to confirm.
- The remaining gates are **operator/legal**, not code: criterion #2 needs a P1 tracker reconciliation against current main (deferred ≠ closed in the stale Stage-1 doc), and §4 items 1–11 are human-run. The hard real-data blocker is the **privacy policy / PDPA consent text** (operator/customer).

Relevant files: `C:\Users\Jirawat.p\Documents\Swedish chaplain_membership\docs\Bug\journey-regression-2026-06-03.txt`, `...\docs\Bug\a11y-i18n-2026-06-03.txt`, `...\docs\Bug\perf-runnability-2026-06-03.txt`, `...\docs\go-live-readiness.md` (§7 criteria, §8 risks).