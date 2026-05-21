# F7.1a Ship-Day Operator Checklist

**Branch**: `014-email-broadcast-advance`
**Scope**: All ship-day operator gates that cannot be executed in a coding session — Fly.io deploy, Vercel env vars, cron-job.org coordinator, flag-flip sequence, staging walkthrough, F7 MVP regression.
**Owner**: F7.1a maintainer + operator on duty
**Status**: SCAFFOLD authored 2026-05-21 (T139-T146 + T142 + T164). Operator MUST work through each ✓ item in order.

> **Prerequisite**: All in-session work for `014-email-broadcast-advance` is complete (Phase 1-6 closed including the Phase 6 polish pass). Run `pnpm lint && pnpm typecheck && pnpm check:i18n && pnpm check:strict-aria && pnpm check:layout && pnpm check:template-seed && pnpm test:integration` from the branch HEAD before starting — all must be GREEN.

---

## Section A — Infrastructure prep (T139, T140, T141)

### A.1 — Fly.io ClamAV deploy (T139)

```bash
# Authenticate (one-time)
fly auth login

# Provision app (one-time per region)
fly launch --copy-config --name clamav-swecham --region sin --no-deploy

# Set the shared secret (one-time; rotate every 90 days)
fly secrets set CLAMAV_SHARED_SECRET="$(openssl rand -hex 32)" -a clamav-swecham

# Deploy
fly deploy -a clamav-swecham

# Verify
fly status -a clamav-swecham                  # expect: state=started, health-checks=passing
fly logs -a clamav-swecham --since=2m         # expect: "clamd[1]: Listening daemon"
```

**Exit criteria**: machine `state=started` AND `health-checks=passing` AND logs show `clamd[1]: Listening daemon`.

### A.2 — Vercel env vars (T140)

Set production env vars via `vercel env add` OR Vercel Dashboard → Project → Settings → Environment Variables:

| Variable | Value | Scope |
|---|---|---|
| `CLAMAV_HOST` | `<fly-app-host-from-A.1>.fly.dev` | Production |
| `CLAMAV_PORT` | `3310` | Production |
| `CLAMAV_SHARED_SECRET` | `<value-from-A.1-fly-secrets>` | Production |
| `FEATURE_F71A_BROADCAST_ADVANCED` | `false` | Production (master kill-switch — flip TRUE in A.4) |
| `FEATURE_F71A_US1_PAGINATION` | `false` | Production |
| `FEATURE_F71A_US2_IMAGES` | `false` | Production |
| `FEATURE_F71A_US7_TEMPLATES` | `false` | Production |

After setting, redeploy: `vercel --prod`.

**Exit criteria**: `vercel env ls --environment=production` shows all 7 vars; deployment succeeds; `/admin/broadcasts/settings` route returns 503 with `feature_disabled` JSON (master flag OFF gates the surface correctly).

### A.3 — cron-job.org coordinator (T141)

1. Log into <https://cron-job.org> with the operator's chamber-ops account.
2. Create new cron job:
   - **Title**: `F7.1a US1 Dispatch Batches`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/dispatch-batches`
   - **Schedule**: every 5 minutes
   - **HTTP method**: POST
   - **Headers**: `Authorization: Bearer ${CRON_SECRET}` (use the production `CRON_SECRET` value)
   - **Retry on failure**: OFF (per platform convention — duplicate dispatches are NOT idempotent at the cron-job.org layer; the application's per-batch idempotency key handles retries internally)
   - **Notifications**: enable on failure → routes to `#oncall-platform` Slack
3. Save + run once manually to verify connectivity.

**Exit criteria**: dashboard entry exists; first manual run returns 200 OK; no audit-row drift in `audit_log` (pre-flag-flip, the cron returns early because the master flag is OFF — verify the 200 OK reflects the "feature disabled" no-op path, NOT a successful dispatch).

---

## Section B — Pre-flag-flip staging validation (T142)

### B.1 — 16-combination flag-matrix test plan (T142)

The 4 feature flags (`MASTER`, `US1`, `US2`, `US7`) yield 2^4 = 16 combinations. Per Constitution VIII Reliability + plan.md § Ship-day flag-matrix, exercise each on STAGING before any production flip.

Critical combinations (these MUST pass on staging):

| # | MASTER | US1 | US2 | US7 | Expected surface state |
|---|--------|-----|-----|-----|-------------------------|
| 1 | OFF | OFF | OFF | OFF | All F7.1a surfaces return 404 (default — pre-launch state) |
| 2 | ON  | OFF | OFF | OFF | `/admin/broadcasts/settings` + `/admin/broadcasts/templates` 200 (UI scaffold visible); per-US APIs return 503 `feature_disabled` |
| 3 | ON  | ON  | OFF | OFF | US1 batch surfaces active (partial_send + retry flow); compose dropdown shows only Blank |
| 4 | ON  | ON  | ON  | OFF | + image-allowlist editor + member inline-image uploader active; ClamAV banner shows on connectivity loss |
| 5 | ON  | ON  | ON  | ON  | All 11 F7.1a surfaces live (full production state) |
| 6 | ON  | OFF | ON  | OFF | US2 image surfaces active without US1 batch — verify US2 standalone path |
| 7 | ON  | OFF | OFF | ON  | US7 template surfaces active; member compose shows 5 starter templates × tenant locale |
| 8 | OFF | ON  | ON  | ON  | All per-US flags ON but master OFF → master kill-switch wins → all surfaces 404 |

Combinations 9-16 (off-by-default combinations) are smoke-tested but not exhaustively validated — each verifies the "OFF wins" master-flag semantic.

Document results in `specs/014-email-broadcast-advance/qa/flag-matrix-2026-{ship-date}.md` (rename the file at ship-time with the actual date).

**Exit criteria**: combinations 1-8 PASS on staging; no observed regression in F7 MVP behaviour with combination 1; no audit-event drift across combinations.

### B.2 — Staging walkthrough (T136 quickstart § 8)

Walk through `specs/014-email-broadcast-advance/quickstart.md § 8` end-to-end on staging with `MASTER=ON + US1=ON + US2=ON + US7=ON`:

- US1 — submit a broadcast with 12,000 synthetic recipients → 2 batches dispatched → verify partial-send + retry flow.
- US2 — upload an inline image → verify ClamAV scan verdict=clean → image embeds; upload EICAR test signature → verdict=infected → upload rejected.
- US7 — admin authors a template + member picks it from compose dropdown → verify `{{chamber_name}}` substitution + `[bracketed]` survival.

Document findings in `specs/014-email-broadcast-advance/qa/staging-walkthrough-2026-{date}.md` (per-US independent test results + any deviations from quickstart).

**Exit criteria**: all 3 USs' Independent Test criteria PASS on staging.

### B.3 — Manual SR QA on 5 F7.1a surfaces (T135)

Use NVDA (Windows) OR VoiceOver (macOS). For each surface, verify the QA checklist below; document in `specs/014-email-broadcast-advance/qa/sr-qa-2026-{date}.md`.

**Surfaces to test**:
1. Admin batch breakdown (`/admin/broadcasts/[id]` after partial_send state) — table rows announced; status badges announced; retry button focusable + activatable
2. Admin retry confirmation modal (Retry button → AlertDialog) — focus-trap; Esc closes; budget-remaining line announced
3. Admin image-source allowlist editor (`/admin/broadcasts/settings`) — Add/Remove rows; default-row marker announced; error banners announced via `role=alert`
4. Admin template library + editor (`/admin/broadcasts/templates`) — table rows; Starter badge announced; Edit/Delete row actions reach via Tab
5. Member template picker dropdown (compose page) — Combobox role announced; CommandInput typeahead; Tab cycles visible items; Esc restores focus

For each surface: record SR output verbatim for the canonical happy path + at least one error path. Mark PASS/FAIL per surface.

**Exit criteria**: all 5 surfaces PASS — no critical findings (announcement order wrong / focus trap broken / control not reachable). Warnings allowed; documented for F7.1b polish.

### B.4 — F7 MVP regression matrix (T164)

Re-run F7 MVP SC-001 through SC-014 on staging WITH `MASTER=ON + US1=ON + US2=ON + US7=ON`. Document in `specs/014-email-broadcast-advance/qa/f7-mvp-regression-2026-{date}.md`.

Source: `specs/010-email-broadcast/spec.md § Success Criteria` (SC-001 through SC-014). For each SC:
- Re-run the originating verification per F7 MVP spec
- Mark PASS / FAIL / NOT-APPLICABLE
- For any regression: file a blocking issue + halt ship until resolved

**Exit criteria**: zero F7 MVP SC regresses (per SC-010 of F7.1a). Even one regression blocks ship.

---

## Section C — Production flag-flip sequence (T143-T146)

**Pre-condition**: Section A (infra) + Section B (staging) all PASS.

Flip in this order — wait at the verification step before proceeding to the next:

### C.1 — Master ON, all per-US OFF (T143)

```bash
vercel env rm FEATURE_F71A_BROADCAST_ADVANCED --scope=production
vercel env add FEATURE_F71A_BROADCAST_ADVANCED true production
vercel --prod
```

**Smoke test**:
- Admin navigates to `/admin/broadcasts/settings` → UI loads (NOT 404)
- Admin navigates to `/admin/broadcasts/templates` → UI loads (NOT 404)
- Member navigates to `/portal/broadcasts/new` → standard F7 MVP compose (no template picker yet)

**Exit criteria**: surfaces visible; no JS console errors; no audit-event drift (existing F7 MVP audit cadence unchanged).

### C.2 — US7 Templates ON (T144 — lowest risk first)

```bash
vercel env rm FEATURE_F71A_US7_TEMPLATES --scope=production
vercel env add FEATURE_F71A_US7_TEMPLATES true production
vercel --prod
```

**Smoke test**:
- Member compose dropdown shows 5 starter templates × tenant locale (TH for SweCham) + Blank option
- Starter badge appears on seeded rows
- Admin can edit a starter template → confirmation banner appears
- `{{chamber_name}}` substitutes to "SweCham" in a fresh draft

**Exit criteria**: starter templates visible + selectable; `{{chamber_name}}` substitution works; admin authoring functional.

### C.3 — US2 Images ON (T145 — depends on Fly.io ClamAV healthy)

**Pre-condition**: `fly status -a clamav-swecham` shows `health-checks=passing` AND production env has `CLAMAV_HOST` + `CLAMAV_PORT` + `CLAMAV_SHARED_SECRET` set per A.2.

```bash
vercel env rm FEATURE_F71A_US2_IMAGES --scope=production
vercel env add FEATURE_F71A_US2_IMAGES true production
vercel --prod
```

**Smoke test**:
- Admin opens `/admin/broadcasts/settings` → allowlist editor visible
- Admin adds a hostname → row appears
- Member compose page renders inline-image uploader on the Tiptap toolbar
- Member uploads a small JPG → verdict=clean → image embeds
- Member uploads an EICAR test file → verdict=infected → upload rejected with locale-aware banner

**24-hour watch**: monitor `image_scan_duration_ms{verdict=clean}` panel — median should stay <200ms; p95 <500ms. `broadcasts.clamav_signature_age_hours` should stay <24h (signatures refresh daily via freshclam).

**Exit criteria**: 5 synthetic uploads PASS (allowlist test, clean image, infected EICAR, large image rejected, banner shows on ClamAV disconnect); 24h metric panel stays in SLO budget.

### C.4 — US1 Pagination ON (T146 — highest risk, last)

**Pre-condition**: cron-job.org coordinator from A.3 is active. C.2 + C.3 stable for ≥24h.

```bash
vercel env rm FEATURE_F71A_US1_PAGINATION --scope=production
vercel env add FEATURE_F71A_US1_PAGINATION true production
vercel --prod
```

**Smoke test (SweCham only — ~131 members, well under 5k F7 MVP cap)**:
- Member submits a broadcast targeting all members → single batch (recipient count < 10,000)
- Admin views `/admin/broadcasts/[id]` → batch breakdown collapsible visible with 1 batch
- Wait 5 min → cron-job.org coordinator should fire → batch transitions to `sent`
- Verify dispatch metrics `broadcasts.batch_dispatch_duration_ms{batch_index=0}` recorded

**7-day watch**: monitor `partial_send_count` + `dispatch_concurrency_saturation`. Both should be near-zero at SweCham scale. Roll out to second tenant ONLY after 7-day stability window (per plan.md US1 rollout strategy).

**Exit criteria**: cron dispatches a synthetic broadcast successfully; no `partial_send` events at SweCham scale; per-batch metrics emit on every dispatch.

---

## Section D — Post-flag-flip closure (T149)

After all 4 flags are flipped + each per-US 24h watch period has passed (cumulative ~3-5 days):

1. Update `tasks.md` to mark T139-T146 as `[X]` with the actual ship date.
2. Update `CLAUDE.md` Recent Changes with the final ship summary.
3. Re-snapshot `docs/observability/f7-mvp-baseline-2026-{ship-date}.md` (T137) replacing the `<TBD>` placeholders with live SQL results.
4. Tag the final implementation commit per T149:
   ```bash
   git tag -a "f71a-shipped-$(date +%Y-%m-%d)" -m "[Spec Kit] feat(F7.1a): ship dark + flag-flip complete — all 164 tasks closed"
   git push origin "f71a-shipped-$(date +%Y-%m-%d)"
   ```

**Exit criteria**: tasks.md 100% closed; CLAUDE.md updated; baseline doc has real numbers; tag pushed; PR for the branch closed via squash-merge to `main`.

---

## Rollback procedure

If any verification step FAILS critically at any flip phase:

1. Immediately flip the failed per-US flag OFF:
   ```bash
   vercel env rm FEATURE_F71A_US{N}_{NAME} --scope=production
   vercel env add FEATURE_F71A_US{N}_{NAME} false production
   vercel --prod
   ```
2. Verify the surface returns 503 `feature_disabled` (or the equivalent locale banner).
3. If MULTIPLE flags are problematic OR root cause is unclear: master kill-switch via `FEATURE_F71A_BROADCAST_ADVANCED=false` — disables ALL F7.1a surfaces in one redeploy.
4. Document the incident in `docs/observability/incidents-log.md` + open a follow-up issue.
5. Do NOT re-attempt the flip until root cause is identified + fix is in a deployed commit.

---

## Cross-references

- F7.1a plan kill-switch criteria: `specs/014-email-broadcast-advance/plan.md`
- F7.1a quickstart § 8 manual walkthrough + § 9 infrastructure setup: `specs/014-email-broadcast-advance/quickstart.md`
- ClamAV runbooks (post-deploy): `docs/runbooks/clamav-signature-stale.md` + `docs/runbooks/clamav-daemon-down.md`
- Partial-send runbook: `docs/runbooks/broadcast-partial-send-recovery.md`
- F7.1a observability (metrics + alerts): `docs/observability.md § 22.9` + `§ 22.10`
- Baseline + promotion criteria: `docs/observability/f7-mvp-baseline-2026-{ship-date}.md` + `specs/014-email-broadcast-advance/f71b-backlog.md § Promotion criteria`
