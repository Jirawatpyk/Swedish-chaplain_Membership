# Go-Live Readiness — SweCham / TSCC (First Tenant)

**Status**: **F9 GATE CLEARED — execution unblocked** (updated 2026-06-12). F9 Admin
Dashboard merged to `main` (PR #29, `1056d5a2`); the `015-admin-dashboard` launch-gating
condition is now MET. Subsequent F4 event-invoice (§105 redesign, PRs #80/#81) + F8 renewal
hardening landed on top. Execution (Stage 0 →) may now proceed. · **Owner**: Jirawatpyk ·
**Created**: 2026-05-30
**Target**: First production hand-off of Chamber-OS to the SweCham / TSCC tenant
(`swecham.zyncdata.app`).
**Launch scope (locked)**: **F1–F9 all features — all merged to `main`.** ✅ `015-admin-dashboard`
(F9) merged. Remaining to launch = operational/data readiness (§ 0+) + flag-flips, NOT feature work.

> This document is the **master launch plan**. It does not replace the
> per-feature specs, the constitution, or the operational runbooks under
> `docs/runbooks/` — it sequences them into a single go-live path and tracks
> what blocks shipping to a real customer with real members.

---

## 1. Why this is "Go-Live Readiness", not "code polish"

The goal is a **real customer using the system in production**, not cleaner
code. Readiness is therefore measured on whether real members + admins can use
the system safely and completely — across the readiness dimensions below
(UI and UX are tracked separately), not one:

| # | Dimension | What "ready" means | Primary evidence |
|---|-----------|--------------------|------------------|
| 1 | **Functional completeness + user flows** | Every golden-path **persona journey** works end-to-end across module seams (horizontal), not just each feature in isolation (vertical) | Journey walkthrough (§ 4 Stage 1) + Playwright golden-path E2E |
| 2 | **Security & compliance** | Tenant isolation, PCI SAQ-A (F5), Thai tax (F4), PDPA/GDPR (F9), audit trail, secrets | `check:multi-tenant`, `check:audit-*`, security review |
| 3 | **Operational readiness** | Env vars set, crons registered, ClamAV up, flags flipped, runbooks live | Vercel dashboard + cron-job.org + this checklist |
| 4 | **Data readiness** | ~131 members / 164 contacts imported correctly + bootstrap admin | Importer dry-run report + live-DB row counts |
| 5a | **UI (visual)** | Looks professional + branded; consistent layout/spacing/typography/theme; SweCham brand identity; clean empty/loading/error visuals; responsive. **Design tokens already exist** (see § 2) — audit verifies *adherence*: no hardcoded colors / arbitrary values bypassing tokens, light/dark parity, no orphan/unused tokens, brand consistency | `ui-ux-pro-max` skill + token-bypass scan (baseline ~0) |
| 5b | **UX (experience)** | No rough edges in flow/feedback/recovery; a11y; microcopy/i18n; keyboard & focus | UX review vs `docs/ux-standards.md`; axe a11y; `check:i18n` |
| 6 | **Stability & performance** | Test suite green, no flaky, SLOs met | Full CI + `RUN_PERF=1` perf gates |
| 7 | **Scope completeness (gap analysis)** | No **missing** specced FRs / customer-needed flows; no **excess** dead code / demo leftovers / unused features | Coverage of `specs/*/spec.md` FRs + `docs/membership-benefits-analysis.md`; dead-code scan |

---

## 2. Current-state snapshot (verified 2026-05-30)

| Fact | Value | Implication |
|------|-------|-------------|
| Active branch | `015-admin-dashboard` | Holds all of F9 |
| Ahead of `main` | **79 commits**, 0 behind | Large but linear merge |
| F9 task completion | **109 / 110 done** | Only **T101** (cron config — operator gate) left; F9 is code-complete |
| Member import tool | **Does not exist** | `seed-demo-members.ts` is demo only; production importer must be **built** (Stage 3) |
| Excel analyzer | `.specify/scripts/analyze_excel.py` | Reusable for column mapping during import build |
| Codebase size | ~130k LOC · 10 modules · 70 routes · 211 components | Audit must fan out, not single-pass |
| Cron runbook | `docs/runbooks/cron-jobs.md` | ~20 external/native cron jobs already catalogued |
| Feature flags | F3–F9 in `src/lib/env.ts` | Flag-flip sequence is an operator gate |
| **Design token system** | **Mature, already exists** — `src/app/globals.css` Tailwind v4 `@theme` + shadcn tokens + WCAG-tuned semantic triads (destructive/success/warning/info × fg+surface), radius scale, Thai-aware fonts, light/dark. Baseline scan: **~0 token bypasses** (0 arbitrary color utils; the only hex hits are a comment + a Stripe-Elements sentinel). | UI audit (5a) = **adherence guard, not a build** |

---

## 3. The roadmap (6 stages, in order)

| Stage | Work | Owner | Gate to exit |
|-------|------|-------|--------------|
| **0. Baseline** ✅ | Run full CI gate suite on current branch; capture deterministic failures | Claude | **DONE 2026-05-31** → `docs/Bug/stage0-baseline.md`. 13/13 static+schema gates green; 6 test reds all root-caused as test-quality/env, **0 product regressions** |
| **1. Readiness Audit** ✅ | Multi-agent fan-out across all dimensions (incl. UI + UX separately) × modules → prioritized findings (P0=launch blocker) | Claude (workflow) | **DONE 2026-05-31** → `docs/Bug/go-live-findings.md` (199 agents). 4 real P0 + 21 real P1 + 211 P2/P3 backlog; F4 Thai-tax = PASS. 3 escalations pending operator |
| **2. Fix P0/P1** ✅ (main batch) | Remediate launch blockers in gated batches | Claude | **P0 4/4 + P1 16/19 DONE** (16 commits, each gated). Remaining deferred to focused tasks (none blocks golden path): P1-9b (P2 cursor), P1-16 (tax_id → importer enforces), P1-4/P1-5/P1-17 (Heavy, feature-sized — see `docs/Bug/go-live-findings.md`) |
| **3. Data importer** ✅ | Build member/contact importer (validate → dry-run → import → rollback); PII-safe | Claude builds / operator runs | **DONE 2026-06-03** → PR #52 merged to `main` (`scripts/import-members/**`). 4 review rounds (R1 15 bugs · R2 regression · R3 2 bugs · R4 1 R3-regression + cross-member flag); 62 tests (51 unit + 11 integration). Operator runs §9 of the gates runbook on the real Excel |
| **4. Operator gates** ✅ (runbook) | Provision Vercel env, register crons, deploy ClamAV, flag-flip | Claude writes runbook / **operator runs** | **Runbook DONE 2026-06-03** → `docs/runbooks/go-live-operator-gates.md` (executable, derived from `src/lib/env.ts` + `cron-jobs.md`). Operator executes; all gates in § 6 checked |
| **5. QA + Go/No-Go** | Full golden-path E2E on preview/staging deploy + final decision | Both | All § 7 criteria PASS |

**Reality check**: this is a **multi-session effort**. P2/P3 (nice-to-have)
findings may be deferred to post-launch without blocking go-live.

### 3.1 Decision authority — DELEGATED to Claude (2026-05-30)

The operator has **delegated scope-decision authority to Claude**, benchmarked
against established market systems, with a **Launch-minimal** risk posture.
Claude decides; the operator is escalated to only for high-stakes ambiguous items.

**Market baseline (reference systems)**: ChamberMaster / GrowthZone (US chamber
standard), Glue Up, Wild Apricot, MemberClicks / Personify, Hivebrite. Used to
detect **embarrassing gaps a customer would notice immediately** — NOT to chase
feature parity with 10-year-old products.

**Risk posture: Launch-minimal (RESOLVED).** When a call is borderline, bias
toward shipping: keep launch scope tight, defer extras to post-launch.

**Decision criteria, in priority order**:
1. `specs/*/spec.md` FRs + user stories (what was promised)
2. `docs/membership-benefits-analysis.md` (real SweCham tier benefits)
3. Market table-stakes (what every membership platform has)
4. **Principle X (Simplicity) as the brake** — when in doubt, don't add

**Gap classification + Claude's default decision**:

| Tier | Definition (vs market) | Claude's default |
|------|------------------------|------------------|
| **Table-stakes** | Every membership platform has it; customer expects it (self-service profile edit, downloadable receipts, password reset, working golden paths) | **Launch-relevant → fix/build** |
| **Competitive / differentiator** | Good but not universal (public directory widget, engagement score, NL search) | **Defer to post-launch** |
| **Excess / scope-creep** | Beyond this customer's need | **Don't add; remove only if provably dead** |

| Finding type | Who decides | Action |
|--------------|-------------|--------|
| Bug / security / a11y / perf defect | **Claude (auto)** | Objective defect — fix through the gate |
| Dead code / demo leftover | **Claude (auto)** | Remove if provably unreferenced; note in report |
| **Missing** table-stakes | **Claude (auto)** | Build it before launch |
| **Missing** competitive/differentiator | **Claude (auto)** | Log as post-launch backlog; do not build now |
| **Excess** feature/UI/UX | **Claude (auto)** | Keep (Simplicity favors not touching shipped behavior) unless dead |
| **High-stakes + ambiguous** (expensive, high customer impact, unclear payoff) | **Escalate to operator** | Present evidence + impact + recommendation; operator signs off |

**Every autonomous scope decision is logged with its rationale** in the Stage 1
findings report, so the operator can audit (and override) any call after the fact.

---

## 4. Stage detail

### Stage 0 — Baseline (cheap, deterministic, first)
Run and capture (no code changes):
```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n \
  && pnpm check:layout && pnpm check:fixme && pnpm check:template-seed \
  && pnpm check:multi-tenant && pnpm check:audit-events && pnpm check:audit-counts \
  && pnpm check:strict-aria && pnpm check:bundle-budgets
pnpm test:integration   # live Neon
# Full pnpm test:e2e is NOT run in Stage 0 (too slow). Decision 2026-05-31:
# E2E runs SCOPED to the touched area during Stage 2 fixes; full golden-path
# E2E is deferred to Stage 5 go/no-go.
```
**Exit**: a known-red list. Anything red here is a fact, not a judgment call —
it grounds Stage 1 so agents don't re-discover what tooling already catches.

### Stage 1 — Readiness Audit (workflow fan-out)
Fan agents across **10 modules + presentation layer**, each scoring all
readiness dimensions (1–7, with UI + UX separate), with adversarial
verification of every P0/P1 finding before it
lands in the report. Output: `docs/Bug/go-live-findings.md`, prioritized:
- **P0** — blocks launch (data loss, cross-tenant leak, broken golden path, PCI/tax/PDPA violation)
- **P1** — must-fix-before-launch (broken secondary flow, a11y blocker, missing i18n on a member-facing surface)
- **P2** — fix soon after launch
- **P3** — backlog / cosmetic

#### Stage 1b — User-flow (journey) audit — HORIZONTAL track
Complements the per-module fan-out. Walk each persona journey end-to-end across
module seams; flag dead-ends, broken handoffs, and missing steps that a
per-module audit cannot see. These same journeys become the Stage 5 golden-path
E2E set.

**Key journeys (SweCham):**
- **Admin**: sign-in → seed/manage plans → add/import members → issue invoice → record/track payment → send broadcast → view dashboard + audit → handle renewal/escalation
- **Manager** (read-only finance): sign-in → view members → view invoices (read-only) → dashboard
- **Member**: receive invitation → set password → complete profile → **view own plan + tier benefits** → view/pay invoice → update profile → request GDPR export → unsubscribe from broadcast → act on renewal reminder

Each journey: confirm every step is reachable, the handoff data is correct, and
i18n + a11y hold along the path. Findings feed `go-live-findings.md` (dimension
1) like any other.

### Stage 2 — Fix P0/P1
Batched by module/dimension; each batch ends with typecheck + lint + targeted
tests + a `[Spec Kit]`-prefixed commit. TDD on any logic fix per Principle II.

### Stage 3 — Member data importer (NEW build)
Real customer data: **~131 members / 164 contacts** from the gitignored Excel
workbook (PII — never committed; runs on operator's machine).
Required pieces:
1. **Column-mapping** from the 2026 Membership Package structure (reuse `analyze_excel.py`).
2. **Validation pass** — required fields, email format, plan-tier match against F2 plans, country codes (i18n-iso-countries), phone E.164.
3. **Dry-run mode** — report what *would* be created/skipped, zero writes.
4. **Idempotent import** — safe to re-run; dedupe by email; threads `tx` via `runInTenant` (RLS — see CLAUDE.md gotcha).
5. **Audit + rollback** — emit `member_created`/`contact_added`; transaction-wrapped so a mid-batch failure rolls back cleanly.
6. **Provisioning order** — tenant → plans → bootstrap admin must precede import (see § 6b for the authoritative order).
7. **Member onboarding ≠ import** — the importer creates member + contact records; **portal access is a separate step** via the F3 invitation flow. Sending ~131 invitation emails is a bulk operation — confirm Resend rate limits + a batched/throttled invite plan (not 131 at once). Decide whether to invite all at launch or stagger.

### Stage 4 — Operator gates → see § 6 checklist

### Stage 5 — QA + Go/No-Go → see § 7 criteria
(No dedicated staging env — QA runs on a Vercel preview deploy; safe since no
real users/data exist yet.)

---

## 5. Merge readiness (015 → main)

**Topology (verified 2026-05-30)**: `main` is at `ded9f976`; `015` branched
directly from it and is 79 commits ahead. Those 79 commits carry **both F7.1a
(Email Broadcast Advanced, PR #27) and F9** — neither is in `main` yet. So a
**single merge `015` → `main` delivers the full F1–F9 launch scope.** F1–F8 base
+ F7 are already in `main`. Consequence: **ClamAV (F7.1a image scanning) is a
launch gate** (§ 6.3), not optional.

F9 is code-complete (109/110). Before merge:
- [ ] Stage 0 baseline green on `015`
- [ ] Stage 2 P0/P1 closed
- [ ] Full CI green (the pipeline in CLAUDE.md § Commands)
- [ ] F9 security co-sign confirmed (Principle IX — already done per T105)
- [ ] Merge `015-admin-dashboard` → `main` (squash or merge per repo convention)
- T101 (cron config) is an **operator gate**, done in Stage 4 — not a merge blocker.

---

## 6. Operator gate checklist (operator runs; Claude produces commands)

Authoritative sources: `src/lib/env.ts` (env schema — app refuses to boot if a
required var is missing/invalid) and `docs/runbooks/cron-jobs.md` (cron
catalogue). This is the consolidated launch view.

> **▶ Executable runbook: `docs/runbooks/go-live-operator-gates.md`** — the step-by-step,
> command-by-command version of this checklist (secret generation, `vercel env add` lines, cron
> table, flag-flip order). Run that top-to-bottom; this § 6 is the summary index.
>
> **Correction (2026-06-03, re-verified against `src/lib/env.ts`)**: the **F5 Stripe block**
> (`STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`,
> `STRIPE_API_VERSION`, `STRIPE_ACCOUNT_ID_SWECHAM`), the **F7 Broadcasts block**
> (`RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `BROADCASTS_FROM_EMAIL`,
> `UNSUBSCRIBE_TOKEN_SECRET`), and `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` are **non-optional in the
> schema → required to BOOT**, even when F5/F7/F8 are dark. The "Feature-specific" grouping below
> is about *when you'd naturally set them*, not about boot-optionality — for a members+invoicing-only
> launch you still must set valid **test-mode** Stripe keys + the F7 secrets + the renewal primary.

### 6.1 Vercel environment variables (production)
> Authoritative list = `src/lib/env.ts` (boot-time zod). Verified against it 2026-05-30.

Required — **app refuses to boot without ALL of these (unconditional)**:
- [ ] `DATABASE_URL` (Neon `ap-southeast-1`, pooled)
- [ ] `AUTH_COOKIE_SIGNING_SECRET` (≥32 bytes)
- [ ] `APP_BASE_URL` (`https://swecham.zyncdata.app`)
- [ ] `APP_ALLOWED_ORIGINS` (CSV; CSRF Origin allow-list) ← **was missing**
- [ ] `TENANT_SLUG` (`swecham`) ← **was missing**
- [ ] `TENANT_TIMEZONE` (optional; defaults `Asia/Bangkok` — set explicitly for clarity)
- [ ] `CRON_SECRET` (≥16 bytes)
- [ ] `RESEND_API_KEY` + `RESEND_WEBHOOK_SIGNING_SECRET` (transactional)
- [ ] `BLOB_READ_WRITE_TOKEN` (F4 invoice PDFs / logos — public store)
- [ ] Upstash: `KV_REST_API_URL` + `KV_REST_API_TOKEN` (rate limiting)
- [ ] `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (≥32; **required unconditionally**, not just when F8 on) ← **was missing**

Feature-specific (set before flipping the feature on):
- [ ] **F5**: `STRIPE_SECRET_KEY`, **`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`** (NEXT_PUBLIC_ prefix mandatory — client bundle), `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`, `STRIPE_ACCOUNT_ID_SWECHAM`, **`STRIPE_LIVE_MODE`** (must agree with key mode; `=true` only in production with `sk_live_`) ← key name + STRIPE_LIVE_MODE corrected
- [ ] **F6**: **`EVENTCREATE_PII_PSEUDONYM_SALT`** (≥32; boot-asserts when F6 on) + **`ZAPIER_DPA_EXECUTED=true`** (boot-asserts in prod when F6 on; also a PDPA §28 / GDPR Art.28 legal gate) ← **whole block was missing**
- [ ] **F7**: `RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET` (≥32), `UNSUBSCRIBE_TOKEN_SECRET` (≥32, distinct from auth secret), `BROADCASTS_FROM_EMAIL`
- [ ] **F7.1a** (when US2 images on): **`CLAMAV_SCAN_URL`** (HTTPS scan-wrapper, e.g. `https://clamav-swecham.fly.dev/scan`) + **`CLAMAV_SCAN_SECRET`** (≥32) — Option D HTTP wrapper, NOT legacy `CLAMAV_HOST`/`CLAMAV_PORT` ← **was missing**
- [ ] **F9**: `EXPORT_DOWNLOAD_TOKEN_SECRET`, `BLOB_PRIVATE_READ_WRITE_TOKEN` (private export store — verified round-trip per T101a)

### 6.2 External cron (cron-job.org) — see `docs/runbooks/cron-jobs.md`
Register the 5-minute-cadence jobs (Vercel Hobby caps native cron at 1×/day).
Key launch-critical entries (Bearer `CRON_SECRET`, **retry OFF** per runbook):
- [ ] F9 `snapshot-refresh-coordinator` `*/5` (**POST**) + `process-export-jobs` `*/5` **(T101)**
- [ ] F7 `dispatch-scheduled` `*/5`, `reconcile-stuck-sending` `*/15`, `dispatch-batches` `*/5`, `split-large-broadcasts` `*/5`, `broadcasts-gauges` `*/5`, **`prune-expired-drafts` `30 4 * * *`** ← was missing
- [ ] F5 `stale-pending-count` `*/5`
- [ ] F8 — **all 7** coordinators: `dispatch-coordinator`, `at-risk-recompute-coordinator`, `tier-upgrade-evaluate-coordinator`, `reconcile-pending-reactivations-coordinator`, `lapse-cycles-on-grace-expiry-coordinator`, `prune-consumed-tokens`, `reconcile-pending-applications` (cadence per `cron-jobs.md`)
- [ ] F6 — **4 jobs**: idempotency sweep (03:30), **PII pseudonymisation sweep (04:00 — compliance-critical)**, error-CSV blob TTL sweep (22:00 UTC), match-rate gauge (hourly)
- [ ] Native `vercel.json` daily jobs present (outbox purge, receipt-pdf reconcile, stale-refund sweep)
> Every endpoint above is **POST** unless `cron-jobs.md` says otherwise; all Bearer `CRON_SECRET`, retry OFF.

### 6.3 ClamAV (F7.1a US2 image-upload scanning) — Option D HTTP wrapper
> Production uses the **Option D HTTPS scan-wrapper** in front of clamd (Vercel
> functions can't join Fly's IPv6-only 6PN). `CLAMAV_HOST`/`CLAMAV_PORT` are legacy dev-only.
- [ ] Fly.io HTTPS scan-wrapper deployed + responding at its public URL (`clamav-daemon-down.md`)
- [ ] `CLAMAV_SCAN_URL` (HTTPS endpoint) + `CLAMAV_SCAN_SECRET` (≥32, matches Fly app secret) set in env (§6.1)
- [ ] Signature freshness OK (`clamav-signature-stale.md`)

### 6.4 Feature-flag flip sequence (production)
Flip on only after each feature's gates above pass:
- [ ] `FEATURE_F3_MEMBERS`, `FEATURE_F4_INVOICING`, `FEATURE_F5_ONLINE_PAYMENT` (⚠️ Stripe LIVE only), `FEATURE_F6_EVENTCREATE` (⚠️ requires `EVENTCREATE_PII_PSEUDONYM_SALT` + `ZAPIER_DPA_EXECUTED=true` first, else boot fails), `FEATURE_F7_BROADCASTS`, `FEATURE_F71A_BROADCAST_ADVANCED`, `FEATURE_F8_RENEWALS`, `FEATURE_F9_DASHBOARD`
- [ ] **F7.1a sub-flags** (staged order, after master): `FEATURE_F71A_US7_TEMPLATES` → `FEATURE_F71A_US2_IMAGES` (needs ClamAV §6.3) → `FEATURE_F71A_US1_PAGINATION` ← was missing

### 6.5 Safety net
- [ ] `READ_ONLY_MODE` flip tested (emergency write-freeze, CLAUDE.md § Commands)
- [ ] Vercel rollback path confirmed (`vercel promote <old-url>`)
- [ ] Neon backup/PITR confirmed before data import

### 6.6 F7 Email Broadcast — send hardening
- [ ] `RESEND_BROADCASTS_API_KEY` has **Full access** (Broadcasts + Audiences), not "Sending access" — verified in dev, staging, prod.
- [ ] `BROADCASTS_FROM_EMAIL` is a valid `local@domain` or `Display Name <local@domain>` (the gateway prepends the member's display name to this address).
- [ ] F7 send hardening PR-1 merged (name ≤70, from un-wrapped, quota released on failed_to_dispatch). PR-2 (ephemeral audience + cleanup) tracked separately.

---

## 6b. Data provisioning order (Stage 3 prerequisite)

Member import has hard prerequisites — run in this exact order in production:
1. **SweCham tenant row** exists (see `docs/runbooks/tenant-onboarding.md`)
2. **2026 membership plans** seeded (`scripts/seed-swecham-2026-plans.ts`)
3. **Bootstrap admin** created (`scripts/seed-bootstrap-admin.ts`)
4. **Neon PITR snapshot taken** (rollback point before bulk write)
5. **Importer dry-run** clean → then real import (threads `tx` via `runInTenant`)
Members reference plan tiers + tenant_id, so 1–2 must precede 5 or the import fails.

---

## 7. Go / No-Go criteria (Stage 5 exit)

Ship only when ALL are true:
- [ ] `main` contains merged F1–F9; full CI pipeline green
- [ ] All P0 + P1 audit findings closed
- [ ] Golden-path E2E green on preview/staging across all platforms (`--workers=1`) — ✅ **journey specs authored 2026-06-03**: `tests/e2e/{admin,manager,member}-journey.spec.ts` (tag `@journey`), each walking its persona across module seams with per-step feature-flag gating. Verified GREEN locally on chromium (all flags on). **Stage-5-exec**: run `pnpm test:e2e --grep @journey --workers=1` on the preview across all 3 browser projects
- [ ] `@a11y` + `@i18n` E2E suites green (WCAG 2.1 AA; EN/TH/SV parity)
- [ ] `RUN_PERF=1` perf gates within SLO (`docs/observability.md`) — ✅ **wired 2026-06-03**: `scripts/run-perf-tests.ts` now runs all 18 RUN_PERF-gated suites (was 5; the F9 `dashboard-perf`/`audit-perf` gap + 11 un-wired F3/F7/F8 suites all added). **Stage-5-exec**: run `pnpm test:perf` against the preview's Neon and confirm every budget passes
- [ ] § 6 operator gates fully checked in production
- [ ] Member data imported; row counts reconciled against source; spot-check 5 members in admin UI
- [ ] Bootstrap admin can sign in; one real member invited + can sign in to `/portal`
- [ ] Rollback + read-only-mode rehearsed
- [ ] Monitoring live: traces + analytics + cron gauges + alert hooks active (`docs/observability.md`)

---

## 8. Risks & open decisions

| Risk / decision | Notes | Status |
|-----------------|-------|--------|
| Member importer is net-new code | Validation + dedupe + RLS-correct tx are the hard parts | Stage 3 |
| Excel PII handling | File is gitignored; runs only on operator machine; no PII in logs | Policy clear |
| 79-commit merge to `main` | Large; ensure no `main` drift; consider merge (not squash) to preserve `[Spec Kit]` provenance | Decide at Stage 5 |
| Hobby-plan cron dependency | cron-job.org is a 3rd-party single point; runbook documents Pro-plan migration path | Accepted |
| Launch date | **No deadline set (2026-05-30).** Decision: **depth-first audit** — sweep all readiness dimensions (1–7) deeply across every module, no fast P0/P1-only shortcut. Quality over speed. | RESOLVED |
| 🟡 **Stripe still in TEST mode** | F5 online payment is not production-live until live keys + products + PromptPay + live webhook are cut over. **Launch-minimal option**: launch members/invoicing first; online payment as a fast-follow once Stripe live. Decide at Stage 4. | OPEN — operator action |
| 🟡 **No privacy policy / PDPA consent** | Importing 131 real members' PII without a privacy notice + lawful-basis/consent is a PDPA/GDPR exposure. Member-facing surfaces, broadcast unsubscribe footer, and GDPR export reference a policy URL. **Blocker for real-data go-live** (legal, operator/customer to produce — Claude cannot author legal text). | OPEN — operator/customer |
| Clear test data before real import | DB holds test data only; must be cleared cleanly (post-PITR-snapshot) before importing real members | Stage 3 |
| First launch (no prod users yet) | No live users/data to preserve → low-risk cutover; QA freely on preview/staging | Resolved (advantage) |
| 🟡 **UAT sign-off owner unassigned** | No one named to accept on SweCham's behalf. Assign before Stage 5 go/no-go. | OPEN — operator |
| `origin/015-f3-hardening` branch | Checked 2026-05-30: `HEAD..origin/015-f3-hardening` is **empty** — nothing stranded there that `015` lacks. | RESOLVED |
| Untracked working-tree artifacts | `review_diff_tmp.txt`, `docs/Bug/Screenshot*.png`, `.claude/skills/ui-ux-pro-max/`, `.claude/settings.json` (modified) — decide commit / gitignore / delete before merge | Housekeeping, pre-merge |
| Monitoring/alerting live at launch | Confirm OTel traces + Vercel Analytics + cron-fed gauges + alert hooks (`docs/observability.md`) are active, not just defined | Stage 4/5 |
| **audit_log purge not enforced** | `audit_log.retention_years` (5y/10y) is set but **no deletion cron exists** — GDPR Art.5(1)(e) / PDPA §37 storage-limitation unmet; rows accumulate indefinitely. Post-launch task: build a purge job. | OPEN — post-launch |
| **No Excel parsing lib** | `package.json` has no `xlsx`/`exceljs` — must `pnpm add` before the Stage 3 importer can compile | Stage 3 pre-req |

---

## 9. Information needed before execution (operator-only knowledge)

These are outside the codebase — Claude cannot determine them. Grouped by the
stage that first needs them.

**Blocks nothing now (Stage 0/1 can start without these):**

**Needed for Stage 3 (data import):** — answered 2026-05-30
- [x] **Production DB state** → **DB currently holds TEST data only.** Implication: before real import we must clear test data (members/contacts/etc.) cleanly — a Stage 3 step, with PITR snapshot first.
- [x] **SweCham tenant + plans** → **seeded, but operator asks Claude to VERIFY again** (action A1 below).
- [~] **Real member Excel** → **operator will provide the real file later, when the system is ready to import.** Build the importer now against the documented 2026 Membership Package structure; final column-map confirmed against the real file at import time.
- [x] **Bootstrap admin** → `jirawat.p@eqho.com` (interim).

**Needed for Stage 4 (operator gates):** — answered 2026-05-30
- [x] **Production env state** → **complete** (all § 6.1 vars set in Vercel).
- [x] **Domain/DNS/SSL** → **yes**, `swecham.zyncdata.app` live on Vercel prod.
- [x] 🟡 **Stripe** → **still in TEST mode.** F5 online payment cannot truly go live until live keys + products/PromptPay + live webhook are cut over. See risk in § 8.
- [x] **Resend** → **ready** (domain verified, sending works).
- [x] **ClamAV** → **done** (F7.1a image scanning ready).
- [x] 🟡 **Legal docs** → **NONE.** No privacy policy / PDPA consent text exists. Handling 131 real members' PII at launch needs these (PDPA/GDPR + broadcast unsubscribe footer + GDPR export reference). See risk in § 8.

**Needed for Stage 5 (QA + go-live):** — answered 2026-05-30
- [x] **No prod in active use yet** → this is a **true first launch**: Vercel project + domain + env are configured but no real users, no real data (test data only in DB). Simplifies go-live — no downtime/migration coordination, no live data to preserve. QA can run on preview/staging deploy freely.
- [x] 🟡 **UAT sign-off owner** → **not assigned yet.** Must name a SweCham approver before the Stage 5 go/no-go. See § 8.

**Derived action**:
- **A1 (Claude, read-only)** — verify SweCham tenant row + 2026 plans seed against the live Neon DB before Stage 3.

**Already resolved**: launch scope (F1–F9), data imported by operator, operator
runs gates, no deadline, scope authority delegated to Claude (launch-minimal).

---

## 0. Preparation phase (active until F9 complete)

**Execution is held** until F9 is complete. "F9 complete" trigger =
_________________ (operator to define — e.g. T101 cron configured + operator's
own final review done). When that fires → start Stage 0.

Work that can proceed NOW (does not depend on F9):

**Track P-A — Claude prepares (no execution, no code changes):**
- [ ] Pre-author the **Stage 1 audit workflow script** (fan-out design, per-module agent prompts, finding schema, token budget) — reviewed + ready to fire on day 1
- [ ] Draft the **member importer spec** (column-map vs 2026 Membership Package, validation rules, dry-run/rollback design) — ready to build once real Excel arrives
- [ ] Create the `docs/Bug/go-live-findings.md` **template** (P0–P3 structure + scope-decision log)
- [ ] Draft the **operator runbook** (exact commands for § 6 gates + § 6b provisioning)

**Track P-B — Operator starts in parallel (long-lead items):**
- [ ] 🟡 **Privacy policy / PDPA consent text** — longest lead, hardest blocker; start with legal/customer now
- [ ] 🟡 **Assign UAT sign-off owner** at SweCham
- [ ] 🟡 **Stripe live-mode prep** — create live products/prices, plan test→live cutover
- [ ] Confirm ClamAV daemon health + Resend domain still verified

**Housekeeping (anytime):** resolve untracked artifacts (§ 8).

---

## 10. Trigger to begin execution

When **F9 complete** fires: run **A1** (verify tenant + plans seed, read-only) +
**Stage 0 baseline** (CI gates → known-red list), then review together before
launching the Stage 1 audit workflow.
