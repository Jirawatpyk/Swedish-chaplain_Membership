# 108 PR-D — review ledger (US4 + US6: contact marketing state + audience page)

**Branch**: `108-pr-d-contact-marketing` (from `main` @ `eeb38018f`, 2026-09-06)
**Built with**: `/speckit-superb-tdd PR-D` — 8 RED → GREEN cycles, one `test(108): … (red)`
commit and one `feat(108): … (green)` commit per cycle (see `git log --oneline main..`).

## T060 — gate output (2026-09-06)

| Gate | Result |
|---|---|
| Baseline before work (`pnpm test`) | 1207 files · 13370 passed · 2 todo · exit 0 |
| `pnpm typecheck` (after the last edit) | exit 0 |
| `pnpm lint` on every touched file | 0 errors, 0 warnings |
| `pnpm check:i18n` | OK — 5291 keys in all 3 locales |
| `check:staff-page-guard` | OK — 48 pages (47 guarded + 1 exempt); `/admin/marketing/audience` → `contacts.read` |
| `check:api-route-guard` | OK — 120 route files; `POST /api/admin/contacts/[contactId]/marketing` → `contacts.marketing` |
| `check:portal-guard` | OK — 19 routes, no new exemption (`PATCH /api/portal/profile/marketing` goes through `requireMemberContext`) |
| `check:layout` | OK — page + loading pair consistent |
| `check:actor-role-truth` / `check:authorization-role-reads` | OK (0 fabricated; `actor_role` in the audit payload is the session role passed through) |
| `check:fixme` · `check:dates` · `check:env-example` · `check:env-boot` · `check:template-seed` · `check:money-recipient` · `check:audit-events` · `check:audit-counts` | all OK |
| `pnpm vitest run tests/contract/rbac/ tests/contract/members/ tests/contract/portal/` | green (rbac 7 files, members 32 files, portal 10 files) |
| `pnpm test tests/unit/auth tests/unit/nav tests/unit/members tests/unit/components/…` | green (members unit folder 161 files) |
| `pnpm test:integration tests/integration/members/contact-marketing-opt-out.test.ts` | 19 passed (schema, repo write, cross-tenant RLS, production composition, FR-025, FR-033 guard) |
| `pnpm test:integration tests/integration/members/marketing-audience-query.test.ts` | 10 passed — page 1 at 20,000 contacts ≈ 0.5 s (SC-004 budget 3 s) |
| `pnpm test:e2e tests/e2e/admin-marketing-audience.spec.ts --workers=1 --project=chromium` | see § E2E below |
| `pnpm test:e2e tests/e2e/portal-marketing-toggle.spec.ts --workers=1 --project=chromium` | see § E2E below |
| Full `pnpm test` (unit + contract) after the last edit | see § Full suite below |

Coverage pins added to `vitest.config.ts`: `set-contact-marketing-opt-out.ts` 100% L/B/F/S
(measured 100/100/100/100); `list-marketing-audience.ts` + `domain/marketing-reason.ts`
measured 100% under `tests/unit/members/**` (Domain 100% line rule).

### E2E

First run surfaced a real defect: `src/lib/marketing-audience-filter.ts` value-imported
`asMemberId` from the members barrel and was imported by the client filter bar, which pulled
the Drizzle repos (and `next/cache` via payments) into the browser bundle — the page h1 never
rendered. Fixed (type-only import + cast); documented in memory. Second run: audience walks
1–5 green; the TH/SV locale walks signed in AFTER setting the locale cookie (helper looks for
EN labels) — test-harness fix; the portal walk found the `e2e-member` persona not linked to a
member on this dev branch (pre-existing environment state, also reported by the F6 seed) —
the spec now seeds a linked member itself when none exists.

Third run (audience + portal): 10 passed, 1 failed — a strict-mode locator collision on
"Unsubscribed" (test-harness fix, `exact: true`). Fourth run (portal only): the axe sweep
found a PRE-EXISTING `definition-list` / `dlitem` violation on /portal/profile (three
`DetailField`s wrapped in a grid-span `<div>` inside the `<dl>`); fixed by giving
`DetailField` a `className` prop (source fix, included in the cycle-8 commit).

**Final e2e result** (`--workers=1 --project=chromium`):
`admin-marketing-audience.spec.ts` **7/7 passed** (toggle off → Undo → two audit rows under
two keys; manager read-only; FR-027a preset; axe; EN/TH/SV; 320 px; member detail) ·
`portal-marketing-toggle.spec.ts` **3/3 passed** (self off/on; unsubscribed → no control;
axe). The e2e-member persona was not linked to a member on this dev branch (environment,
also reported by the F6 seed); the portal spec seeds and removes a linked member itself.

### Full suite

`pnpm test` after the last source edit: **1216 files passed, 1 failed → 13523 tests passed,
2 todo** (999 s). The one failure was `portal-profile-body.test.tsx` — the page-boundary
test's partial `@/lib/env` mock could not serve the broadcasts barrel's logger once the
profile page composed the suppression lookup; fixed by stubbing
`@/lib/contact-marketing-deps` + the toggle in that test (re-run: `tests/unit/app/portal`
+ `tests/unit/members/presentation` 78 files green). `pnpm typecheck` exit 0 after the last edit.

## Review rounds (T066)

_Pending — reviewer stack per `reviews/README.md`: `security-engineer`,
`pdpa-gdpr-compliance-officer`, `enterprise-ux-designer` (+ `mobile-a11y-ux-reviewer`,
`i18n-translation-reviewer`) → 3 `/speckit.review` passes → `/speckit.staff-review` →
fresh-agent re-review; co-sign `checklists/security.md`, `checklists/privacy.md`,
`checklists/ux.md` (add the SV/TH length-variance note to FR-050 — ux CHK033)._

## Decisions taken during the build (differ from or refine the brief)

1. **`state=on` excludes suppressed rows AT THE QUERY.** The FR-027a preset must list only
   people who will receive; re-labelling suppressed rows after a per-page lookup would show
   them under "on". The use case fetches the tenant's (bounded) suppressed set through the
   widened `MarketingSuppressionLookupPort` and passes it to the repo as an email leg; new
   OPTIONAL `MarketingUnsubscribesRepo.listEmailLowers` on the broadcasts side.
2. **Unknown suppression → `'unavailable'` even when the row is opted out** (FR-031a read
   literally: "neither on nor off"). `state=unsubscribed` with an unreadable list returns an
   empty page + `degraded` rather than every row.
3. **The audit payload carries `actor_role`** (session role, passed through — never a
   literal), alongside `member_id` / `contact_id` / `source`.
4. **The member page's two-state `SubscriptionBadge` is replaced** by the five-state
   `MarketingStateBadge`, so the member page and the audience page always agree.
5. **The nav item and the ⌘K entry are hidden with the Engagement section when
   `FEATURE_F7_BROADCASTS` is off** (`visibilityFlag: 'broadcastsEnabled'`) — the page is
   about E-Blast recipients; "permanent" in FR-035 means not a temporary pre-flight page.
6. **The portal toggle renders plain text for `unsubscribed`** (no control) and a disabled
   switch for `unavailable`; the primary contact sees the FR-033 note.
7. **`serialiseContact` (admin API) exposes the three opt-out columns**; the portal
   serialiser exposes only `marketing.state`, and only on the caller's own contact (FR-032).
