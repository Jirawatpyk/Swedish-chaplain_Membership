# Quickstart validation — PR-3 (T113), 2026-09-15

`quickstart.md` § 1 walked on the shared `dev` Neon branch through the dev server on `:3100`
(`FEATURE_MEMBER_CHANGE_APPROVAL=true` in its env; the e2e seed flips the SweCham tenant setting
ON in `beforeAll` and restores it in `afterAll`). Each story's walkthrough is the RED acceptance
test's manual twin, so the evidence per story is the real-browser run of
`tests/e2e/change-requests.spec.ts` on chromium at the PR-3 head (`68a3f9abe`), plus the
manual observations noted below. Personas: `e2e-member-empty` (primary contact, good standing),
`E2E_ADMIN_*`, `E2E_MANAGER_*`, `E2E_SUPER_ADMIN_*`; the secondary-contact persona is still not
seeded (research § V4), so the two secondary cases skip by name.

| Story | quickstart § 1 step | Evidence (e2e, chromium, 2026-09-15) | Deviation |
|---|---|---|---|
| US1 | phone edit → "awaiting review" banner, contact row unchanged; already-pending inline | 3 passed / 1 skipped (secondary) | none |
| US2 | admin deep link → review page → de-select one row + reason → both portals agree; manager read-only | 3 passed | none |
| US3 | reject all with a reason → banner, record unchanged → resubmit prefilled → dismiss sticks | 2 passed | none |
| US4 | queue filter → review; member-record section; portal history; axe at 320 px | 3 passed / 1 skipped (secondary) | **fixture, not product**: at 320 px a strict-mode locator once resolved `queue-table` to TWO elements — the instant React swaps the streamed content in for the Suspense fallback; the test now waits for exactly one table. A Playwright retry re-runs `beforeAll` in a fresh worker and re-seeds the row as pending, so the axe walk reads the combobox names on the decided view and runs its table / Apply / axe checks on the pending view. |
| US5 | withdraw with confirmation; resubmit twice → one pending; the 11th → 429 + retry time | 3 passed | none |
| US6 | setting OFF (confirmed, names the count) → member gate `immediate`, pending row still readable; ON → dashboard row + nav badge; `/admin/audit` shows the setting event; axe on the card at 320 px | 3 passed | **dev server only**: the first `PATCH /api/admin/settings/member-changes` compiles the route (~6 s under Turbopack); the confirm button shows its spinner and the modal stays open past a 5 s expectation. The test waits for the modal to close (60 s). Not reproducible on a production build. |

Not walked by hand — covered by unit / contract tests on the same tree instead (named so the
record does not overstate what a person saw):

- the `/admin/settings` hub card for admin vs manager and its flag gating —
  `tests/unit/app/admin/settings/settings-index-permissions.test.ts`;
- the FR-032 note in the OFF state with the count linking to the queue, the plain-text state
  line, one toast (UX H2 / M3) — `tests/unit/members/presentation/approval-switch.test.tsx`
  (the e2e asserts the note's link `href` in both states);
- the icon-rail tooltip "Change requests (N)" (UX L3) —
  `tests/unit/components/layout/nav-item-badge.test.tsx`;
- the dashboard age in whole days, never a date (UX M2 / L5) —
  `tests/unit/app/admin/dashboard/needs-attention-change-requests.test.tsx`;
- the gauges tick's members half (zero-fill, flag-off forget, broadcasts-half failure) —
  `tests/contract/broadcasts/cron-broadcasts-gauges.contract.test.ts`.

Hit by hand on the dev server after the e2e run (`GET /api/internal/metrics/broadcasts-gauges`
with the dev `CRON_SECRET`, 2026-09-15 23:35): `ok: true`, `broadcastsGaugesOk: true`,
`membersGaugesOk: true`, `membersGaugesSkipped: null`, `membersPendingTenantCount: 0`,
`membersPendingTotal: 0`, `membersOldestAgeSecondsMax: 0` — the e2e `afterAll` had already
wiped the seeded request, so the zero is the zero-fill path (the tenant is observed from
`tenant_member_settings`, not from a request row), which is the C9 "0 means 0" behaviour § 27.1
promises.

No spec deviation found; the two rows marked "fixture" / "dev server only" are recorded in the
e2e file's comments and in `reviews/pr-3.md`.
