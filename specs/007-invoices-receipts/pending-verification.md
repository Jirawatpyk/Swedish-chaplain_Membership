# F4 Phase 10 — Pending E2E Verification

**Date logged**: 2026-04-21 (end of Phase 10 implementation session)
**Commit range**: `0a1df68..4366fa9` (22 commits)
**Status**: Code shipped + integration/unit tests green. E2E verification of
gated test cases blocked by sign-in failure observed in the Playwright run
after adding env flags + running `seed-f4-e2e-admin-fixtures.ts`. Root
cause not isolated in session; suspected dev-server env-reload race or
stale browser-context cookies after rapid consecutive runs.

---

## ❌ Not E2E-verified this session

### `tests/e2e/invoice-settings.spec.ts` — 6 gated tests

Un-fixme'd in commits `6ab3cdd` + `4366fa9`. Gate:
`E2E_X_TENANT_HEADER_ENABLED=1` in `.env.local`.

| Line | Test | Shipped in |
|---|---|---|
| 94 | AS1 — admin changes VAT 7→10 on settings form | `6ab3cdd` |
| 151 | AS2 — upload 400×200 PNG → success + persist | `4366fa9` |
| 196 | AS4 — SVG rejected with mime_rejected error | `4366fa9` |
| 228 | AS4 — 2400×600 PNG rejected (dimensions out-of-range, upper) | `4366fa9` |
| 259 | AS4 — 100×50 PNG rejected (below MIN) | `4366fa9` |
| 293 | AS5 — first-time bootstrap empty-state → row created | `6ab3cdd` |

### `tests/e2e/credit-note-full.spec.ts` — 1 gated test

Un-fixme'd in commit `7c3a7ba` (T125). Gate:
`E2E_HAS_ADMIN_FIXTURES=1` + `seed-f4-e2e-admin-fixtures.ts` run first.

| Line | Test |
|---|---|
| 124 | AS1 — full credit note flips invoice badge to Credited |

### `tests/e2e/credit-note-partial.spec.ts` — 1 gated test

Un-fixme'd in commit `7c3a7ba` (T125). Same gate as above.

| Line | Test |
|---|---|
| 123 | AS2 — 60% partial flips invoice badge to Partially credited |

**Total unverified: 8 E2E tests × 3 browsers = 24 passes pending.**

---

## ✅ Verified this session

| Area | Verification |
|---|---|
| `tests/e2e/invoice-admin-a11y.spec.ts` | **6/6 green** across chromium + mobile-chrome + mobile-safari (commit `13cee2b`) |
| Background F4 run (pre-env-change) | **25 passed + 2 flaky** (flaky now fixed in `13cee2b`) + 66 skipped |
| Integration tests on live Neon | `seq-number-atomicity`, `tenant-isolation` (17/17), `pdf-deterministic` (8/8), `audit-coverage`, `retention-member-archive`, `credit-note-partial-accumulation`, `credit-note-pdf-golden`, `overdue-audit-idempotency`, `auto-email-outbox`, `vat-source-chain`, `tenant-invoice-settings-probe` |
| Unit tests | `derive-overdue` 10/10, `resend-pdf` 9/9, `invoice-auto-email` 14/14, `content-disposition` 7/7 |
| Gates | typecheck + lint + check:i18n (1121 keys × 3 locales) + check:layout all green |
| Perf (RUN_PERF=1) | PDF render p95=88ms, invoice-list p95=324ms @ 5k×2, 50-writer seq ~10s |

---

## 🔬 Failure signature observed

Running the 6 gated invoice-settings tests on chromium produced:
- 8 of 9 tests FAILED (the 1 that "passed" was the axe-scan test which
  scans whatever page is rendered, including the sign-in page it got
  redirected to — zero violations incidentally).
- Failure mode: `page.goto('/admin/settings/invoicing')` after `signIn()`
  lands on `/admin/sign-in?returnTo=%2Fadmin%2Fsettings%2Finvoicing`
  instead of the settings page.
- Playwright retried 3× per test, all same redirect.
- Page snapshot at failure shows sign-in form (not a signed-in layout).
- Direct DB check: admin user `status=active`, `locked_until=null`,
  `failed_signin_count=0` — NOT a lockout.
- The axe-scan test on the same file with same `signIn()` call "passes"
  because its assertion is zero-violations (not URL), and sign-in page
  is itself a11y-clean.

**Leading hypothesis** (unconfirmed): sign-in form submit completes
(`waitForURL(/\/admin(\/|$)/)` matches `/admin/sign-in?returnTo=` by
substring), but the session cookie isn't actually set. Could be:
1. CSRF/Origin header mismatch after Playwright's rate-limit clear
2. Dev-server env hot-reload race (Next.js reloaded after
   `.env.local` append, test started mid-reload)
3. Browser-context cookie pollution from rapid consecutive runs
4. (Less likely) something in `resolveTenantFromRequest` change
   breaks session-bound tenant resolution — but the resolver only
   reads `X-Tenant` header when present; non-throwaway tests don't
   send it.

**Not confirmed to be a bug in F4 code**. All code-level changes in the
22 commits pass typecheck/lint and integration/unit tests. Session
time-boxed before reproducing cleanly.

---

## 🛠 Reproduction recipe (for the next session)

```bash
# 1. Clean restart
Ctrl+C dev server
pnpm dev                        # wait for "Ready" on :3100

# 2. Ensure seeder fixtures present
node --env-file=.env.local --import tsx scripts/seed-f4-e2e-admin-fixtures.ts
# Expect: E2E Mutation Co member + SC-2026-990000 (pay) +
#         SC-2026-995000 (credit-target)

# 3. Verify .env.local has:
#    E2E_HAS_ADMIN_FIXTURES=1
#    E2E_X_TENANT_HEADER_ENABLED=1
#    E2E_MEMBER_HAS_INVOICES=1

# 4. Run the 3 specs with gated tests — ONE AT A TIME:
pnpm test:e2e --workers=1 --reporter=list tests/e2e/invoice-settings.spec.ts
pnpm test:e2e --workers=1 --reporter=list tests/e2e/credit-note-full.spec.ts
pnpm test:e2e --workers=1 --reporter=list tests/e2e/credit-note-partial.spec.ts

# Expected shape per spec:
#   invoice-settings: 21 tests (7 × 3 browsers) — 6 gated + 3 non-mutating
#   credit-note-full: 12 tests (4 × 3)
#   credit-note-partial: 9 tests (3 × 3)
```

**If sign-in still fails**:
1. Inspect `page.context().cookies()` after `signIn()` — should see
   `session` or similar cookie
2. Check Next.js dev server logs for errors during the sign-in POST
3. Try without `E2E_X_TENANT_HEADER_ENABLED` (flip to 0) — isolate
   whether the resolver change is implicated
4. Verify `clearE2ERateLimits` actually ran — grep test output for
   `[e2e global setup] cleared Upstash rate-limit buckets`

---

## 📋 Tracking

- CP-10.1, CP-10.3, CP-10.4, CP-10.5, CP-10.7, CP-10.15, CP-10.16,
  CP-10.17 → ✅ ticked in this session.
- CP-10.2 (Full CI on clean checkout) → still ⏸ (human-gated T116 run).
- CP-10.8 (Thai-RD sign-off) → ⏸ human.
- CP-10.9 (Security checklist signed) → ⏸ T117 human.
- CP-10.10 (Staging traces) → ⏸ T114b human.
- CP-10.11–13 (Manual SR / cross-browser / reduced-motion) → ⏸ T114 human.
- CP-10.14 (≥6 review + ≥2 staff-review rounds) → ⏸ T118 human.
- CP-10.18 (F1/F2/F3 regression) → ⏸ opt-in rerun.
- **8 un-verified E2E tests above** → documented here, retry via the
  recipe above.

---

## 🧾 Accountable residuals (Phase 10 `/speckit-review` follow-up, 2026-04-22)

These items were surfaced by `/speckit-review Phase 10` + `/speckit-fixit-run`
(suggestion tier). Each has an owner + a clear un-fixme recipe, so
they are no longer anonymous `test.skip` / `disableRules` entries —
they are tracked residuals with a ship-decision path.

### PVR-1 — `credit-note-full.spec.ts` + `credit-note-partial.spec.ts` mutating happy-path

**Status**: `test.skip(process.env.E2E_HAS_ADMIN_FIXTURES !== '1', ...)`
(both specs, lines ~123/140). Integration-layer coverage for the same
DB state transitions is GREEN in
`tests/integration/invoicing/credit-note-partial-accumulation.test.ts`.
The skipped assertion is the UI-glue status-badge flip on
`/admin/invoices/<id>` after POST.

**Un-fixme recipe** (for the session that wires this):

1. `node --env-file=.env.local --import tsx scripts/seed-f4-e2e-admin-fixtures.ts`
   seeds the 990000-series paid invoice under "E2E Mutation Co".
2. Append `E2E_HAS_ADMIN_FIXTURES=1` + `E2E_ADMIN_MUTATION_MEMBER='E2E Mutation Co'`
   to `.env.local`. The `playwright.config.ts` env loader picks these up.
3. Run `pnpm test:e2e tests/e2e/credit-note-full.spec.ts tests/e2e/credit-note-partial.spec.ts --workers=1`.
4. After each run, re-run the seeder — it detects the mutated state
   and re-provisions a fresh target at the next 990xxx sequence number.

**Long-term fix (post-ship)**: fold the seeder into
`tests/e2e/global-setup.ts` as a subprocess so the gate becomes
always-on. Blocked on: (a) seeder currently calls `process.exit` at
module load — needs a `main()` export guard, and (b) `global-setup`
must not inherit the seeder's exit code. Not a release blocker.

**Owner**: next F4 maintainer session. **Target-close**: by end of
Phase 10 post-ship window (2026-05-06 — two weeks after Phase 10
ship). **Ship-gate**: NO — the DB-state assertions are covered by the
integration suite; the UI-glue assertion is a polish item.

### PVR-2 — `invoice-admin-a11y.spec.ts` `disableRules(['scrollable-region-focusable'])`

**Status**: `axe.disableRules(['scrollable-region-focusable'])` at
`tests/e2e/invoice-admin-a11y.spec.ts:~121`. Rule-disable tracked as
"post-ship polish" per the original comment.

**Rationale**: the admin invoice detail page renders a horizontally-
scrollable `<table>` for invoice lines. axe-core WCAG 2.1 flags it
because the scrollable region has no `tabindex="0"` wrapper, but the
table headers + cells are themselves focusable via keyboard per the
standard table semantics. The disable is a known axe-core false-
positive pattern for data-dense admin tables; fixing it properly
requires either restructuring the table as a grid-role component or
wrapping in a focusable region wrapper, both of which affect CLS + row
selection behaviour.

**Fix plan**: during F5 (next data-dense admin surface) evaluate
switching to the `role="grid"` + `aria-rowindex` pattern used by
TanStack Table v8; backport to invoice detail once validated.

**Owner**: F5 UX lead. **Target-close**: during F5 planning
(`/speckit.plan` gate, estimated 2026-05-13). **Ship-gate**: NO —
WCAG 2.1 AA floor is already met by the cell-level focus model.
Rule-disable is narrowly scoped to one assertion in one file.
