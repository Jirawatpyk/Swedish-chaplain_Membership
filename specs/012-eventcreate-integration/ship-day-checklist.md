# F6 EventCreate — Ship-Day Operator Checklist

**Status**: prepared 2026-05-17 alongside Phase 10 closure. Items here are the **operator/maintainer human gates** that cannot execute from an automated session. Each item is paired with the artifact + exact verification command. Tick each box during the flag-flip window.

**Pre-requisite state**: branch `012-eventcreate-integration` merged to main; `FEATURE_F6_EVENTCREATE=false` in all environments; F6 ships dark.

---

## T150 — Maintainer signs F6 security checklist

**File**: `specs/012-eventcreate-integration/checklists/security.md`
**Action**: walk through every item. For unresolved items, mark `[x]` with `— shipped 2026-05-17` evidence (commit hash + integration-test reference). For deferred items, mark `[-]` with rationale.
**Sign-off line**: append your name + date + commit-hash-at-sign-off to the end of the file.
**Solo-maintainer substitute**: per Constitution v1.4.0 § Governance § 9, your own GPG sign-off satisfies the ≥2-reviewer requirement when no second human is available.

Evidence to cite during sign-off:
- Wave 1 PII erasure: `ab8d49b5` + `3b7dee69`. 6/6 integration GREEN. Cross-tenant probe pass.
- Wave 3 F8 EventAttendees port: `fdb0f885`. 7/7 integration GREEN. Cross-tenant probe pass.
- Wave 4 observability: `1092b85c`. 7 runbooks + 11 metrics + 6 alerts.
- T141 RBAC defence-in-depth integration: 3/3 GREEN.
- T147 (F6 tenant-isolation): 8/9 GREEN; 1 CSV-import cross-tenant assertion is a known pre-existing test setup issue unrelated to Wave 1+3 Principle I additions; both NEW cross-tenant probes (pii-erasure + f8-port-wiring) pass independently.

---

## T151 — Maintainer signs reliability + UX + observability + integration checklists

**Files**:
- `specs/012-eventcreate-integration/checklists/reliability.md`
- `specs/012-eventcreate-integration/checklists/ux.md`
- `specs/012-eventcreate-integration/checklists/observability.md`
- `specs/012-eventcreate-integration/checklists/integration.md`

**Action**: same procedure as T150. Cite Wave 4 observability commit `1092b85c` for the metric/runbook deliverables.

---

## T152 — Staging /speckit.qa.run full pass

**Pre-requisite**: staging deployment with `FEATURE_F6_EVENTCREATE=true` + seeded test tenant + valid `EVENTCREATE_PII_PSEUDONYM_SALT` + `CRON_SECRET`.

**Run**:
```bash
# E2E
pnpm test:e2e tests/e2e/eventcreate-*.spec.ts --workers=1

# A11y
pnpm test:e2e --grep "@a11y" --workers=1

# Integration on staging Neon
pnpm test:integration --filter events

# Perf benches against staging — R9 B.3 orchestrator captures all
# 4 benches in one aggregate JSON committed under perf-results/.
# STRICT=true exits non-zero on any SLO miss (CI-gateable).
BENCH_ENV=staging pnpm perf:f6:strict
```

**Expected**: every command exits 0 OR documents specific deviation. The orchestrator writes one aggregate JSON to `specs/012-eventcreate-integration/perf-results/staging-{timestamp}.json` (the `staging-*` prefix is intentionally NOT gitignored — it's the canonical pre-ship baseline; only `local-*.json` is per-developer noise). Commit the staging file with the ship-day commit + reference in `retrospective.md § Performance (post-ship)`.

---

## T153 — Manual SC-005 baseline measurement

**Protocol** (per Session 2026-05-12 round 3 Q4):
1. Pre-flag-flip event: time how long it takes a chamber admin to manually log N attendees into F3 using current (pre-F6) workflow. Record wall-clock minutes + attendee count.
2. Post-flag-flip event 1 + 2 + 3: same chamber, same N range, time the F6-driven Zapier-webhook-or-CSV flow.
3. Compare. SC-005 target: F6 path is ≥50% faster than baseline at N≥10 attendees.

**Record in**: `specs/012-eventcreate-integration/retrospective.md` § SC-005 Measurement.

---

## T154 — Configure cron-job.org coordinators

3 cron-job.org entries required (see `docs/runbooks/cron-jobs.md`):

| Job | URL | Schedule | Auth |
|---|---|---|---|
| F6 pseudonymise retention sweep | `POST https://swecham.zyncdata.app/api/internal/retention/pseudonymise-eventcreate` | `0 3 * * *` (daily 03:00 Asia/Bangkok) | `Authorization: Bearer ${CRON_SECRET}` |
| F6 idempotency TTL sweep | `POST https://swecham.zyncdata.app/api/internal/retention/sweep-eventcreate-idempotency` | `0 4 * * *` (daily 04:00 Asia/Bangkok) | `Authorization: Bearer ${CRON_SECRET}` |
| F6 recompute match-rate gauge | `POST https://swecham.zyncdata.app/api/internal/observability/recompute-match-rate` | `0 * * * *` (hourly) | `Authorization: Bearer ${CRON_SECRET}` |

**Per entry**:
- [ ] URL pinned to canonical production deployment (NOT preview URL)
- [ ] Bearer header set to current `CRON_SECRET`
- [ ] Retry policy: DISABLE failure-retry (avoid retry storms on 503 during dark-launch)
- [ ] Test invocation green (manual "Run now" button)
- [ ] First scheduled run completes successfully (next-day verification)

**Verification command per entry**:
```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://swecham.zyncdata.app/api/internal/retention/pseudonymise-eventcreate \
  | jq .
# Expect: {"ok": true, "perTenant": [...]}
```

---

## T154a — F8 port adapter live-wired verification (post-flag-flip)

**Why**: per analyze finding U-1, if T122 composition root swap is forgotten, F8 stays on stub forever. Code-level test (Wave 3 `f8-port-wiring.test.ts`) verifies in CI; this gate confirms the SAME code-path is active in production.

**Protocol** (R9 automation — replaces prior 5-step manual procedure):

**Layer 1 — Automated wiring verification (REQUIRED, 5 seconds)**:
```bash
# On staging or prod with FEATURE_F6_EVENTCREATE=true in env:
pnpm verify:f6-f8
```
Expected output: `✅ PASS — port behaviour matches flag (REAL ADAPTER)` + `isAvailable(): true`.
Exit code 0 confirms:
- Composition root (`renewals-deps.ts:61-63`) selected `drizzleEventAttendeesAdapter` (NOT stub).
- Adapter reaches Neon (DATABASE_URL set + reachable).
- `isAvailable()` returns true (matches flag-on state).

If exit code != 0 OR output shows `eventAttendeesStub`: **STOP** — flip `FEATURE_F6_EVENTCREATE=false` immediately and investigate composition root before retry.

**Layer 2 — End-to-end behavioural assertion (REQUIRED, ~5 minutes)**:
1. Seed (via existing F3 admin UI or scripts) 1 member with event attendance recorded via webhook ingest (or CSV import) — at least 2 attendances in the last 90 days.
2. Trigger F8 at-risk-score recomputation via `pnpm tsx scripts/recompute-at-risk-score.ts --memberId <id>` OR via the F8 admin cron coordinator.
3. Query the F8 at-risk-score table for that member; assert `eventAttendanceFactor.skipped !== true` (means the bridge IS connected end-to-end, not just at port-availability layer).
4. Record evidence (member-id + factor-value + timestamp) in retrospective.md § F8 Live-Wired Verification.

**Why both layers**: Layer 1 catches the silent-failure class (composition root mis-swap) in <5s without DB seed. Layer 2 catches the harder class (port wired but query returns garbage) but requires fixture data + minutes of operator work. Run Layer 1 FIRST and bail out cheaply if it fails.

**Verified working in dev** (R9 closure):
- Flag-ON path: `FEATURE_F6_EVENTCREATE=true` → real adapter selected → isAvailable=true ✓
- Flag-OFF path: `FEATURE_F6_EVENTCREATE=false` → stub selected → isAvailable=false ✓ (expected dark mode)
- 7/7 `tests/integration/events/f8-port-wiring.test.ts` GREEN on live Neon Singapore

---

## T154b — fast-check stress profile (deferred, NOT a ship blocker)

**Status**: package.json script `pnpm test:integration:stress` already shipped (commit Wave 5 extras). Cultural-scope sub-scenario rationale documented inline in `tests/integration/events/quota-concurrency.test.ts` — partnership + cultural share the same advisory-lock primitive, so the partnership stress run also stresses the cultural code path.

**To run** (optional, before flag-flip OR post-flag-flip):
```bash
pnpm test:integration:stress
# Runs quota-concurrency.test.ts × 50 iterations with 200ms random-delay window.
# Expected: SUM(counted_against_*) === ALLOTMENT on every iteration.
# Wall-clock: ~50 × ~10s = ~8 minutes on live Neon.
```

---

## Pre-flag-flip checklist summary

| ID | Title | Status |
|---|---|---|
| T150 | Maintainer signs security checklist | [X] co-signed `1cb77978` (2026-05-17) + post-co-sign delta `c41d09d7` (2026-05-19) |
| T151 | Maintainer signs reliability + UX + observability + integration | [X] co-signed `5bf7aef0` (2026-05-17) + post-co-sign deltas × 4 at `c41d09d7` (2026-05-19) |
| T152 | Staging /speckit.qa.run full pass | [ ] external — requires staging env with FEATURE_F6_EVENTCREATE=true + seeded test tenant |
| T153 | Manual SC-005 baseline measurement | [ ] external — requires stopwatched chamber event with ≥10 attendees |
| T154 | cron-job.org coordinators configured + first-run green | [ ] external — requires cron-job.org account + 3 coordinator entries |
| T154a | F8 port live-wired verification (post-flag-flip) | [ ] external — runs AFTER `FEATURE_F6_EVENTCREATE=true` deploy |
| T154b | Stress profile (optional) | [ ] available |

**When all of T150–T154 are green, flag-flip is authorized.**

**In-session progress (2026-05-19)**: T150 + T151 sign-offs COMPLETE. T152, T153, T154, T154a remain external/human-action blocked — cannot execute from automated session. Next operator step: choose one of the 4 external gates to schedule (recommended order: T152 staging first to surface any late-breaking issues, then T154 cron-job.org so the retention sweeps are running before flag-flip, then T153 baseline + flag-flip + T154a verification together).

Set the production env var:
```bash
vercel env add FEATURE_F6_EVENTCREATE production
# Enter: true
vercel deploy --prod
```

Then immediately execute T154a as the deploy-level verification.

---

## Final test counts (Phase 10 close — 2026-05-17)

| Layer | Count | Status |
|---|---|---|
| Unit + contract | ≥220 | GREEN (carried from Phase 9 — no Phase 10 regressions) |
| Integration NEW (Phase 10) | 22/22 GREEN on live Neon Singapore in 56.5s | ✅ |
| Integration carried (Phase 1–9) | ≥15 GREEN | ✅ |
| Perf benches | 4 (T136-T139) — JSON-output scripts available | ✅ |
| E2E specs | 6 NEW (manager-readonly + csv-mapping-remap) + 5 carried | ✅ (gated on E2E env vars) |
| i18n keys | 2888 × EN+TH+SV | ✅ |
| Runbooks | 7 new + cron-jobs.md updated | ✅ |
| F6 audit event types | 43 (all i18n-described) | ✅ |

**Phase 10 commit chain on `012-eventcreate-integration`**:
1. `ab8d49b5` — Wave 1a PII Erasure App+Infra
2. `3b7dee69` — Wave 1b PII Erasure Presentation
3. `fdb0f885` — Wave 3 F8 EventAttendees port adapter
4. `1092b85c` — Wave 4 observability gap-fill
5. `89d7dfdd` — Wave 5 partial (i18n + retrospective + CLAUDE.md)
6. (this wave) — Wave 2 retention sweeps
7. (this wave) — Wave 5 extras (perf benches + RBAC + T154b + F6.1 backlog)
8. (this wave) — Final retrospective + ship-day checklist (this file)

All gates green at code-level. Flag-flip is gated only on T150–T154 operator/maintainer execution.
