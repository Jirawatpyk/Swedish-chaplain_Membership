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

### Round 1 — five reviewers in parallel (2026-09-06), 51 findings, all closed in cycles 9–12

| Reviewer | Verdict | Findings | Closed in |
|---|---|---|---|
| `pdpa-gdpr-compliance-officer` | 2 BLOCKERS + 1 HIGH + 1 MEDIUM + 4 LOW | B-1 opt-out never read by dispatch · B-2 staff outranks self · H-1 ROPA · M-1 Art. 14 residual · L-1..L-4 | cycle 10 (B-1) · cycle 9 (B-2, L-1) · cycle 12 (H-1, M-1 recorded) · cycle 10 (L-2 array bind) · L-3/L-4 recorded in ROPA + below |
| `security-engineer` | APPROVE WITH FIXES | HIGH-1 (= B-1) · MEDIUM-1 `member_id` bumps `last_activity_at` on a STAFF action · LOW-1 removed contact probes · LOW-2 probe failure swallowed · LOW-3 one bind per address · LOW-4 `page` unbounded · LOW-5 seed guard fails OPEN | cycle 10 · cycle 9 · cycle 9 · cycle 9 · cycle 10 · cycle 11 · cycle 11 |
| `enterprise-ux-designer` | Ship with follow-ups | H1 search box does not re-sync · H2 Clear drops focus · H3 no optimistic state · H4 pre-flight row leaves under focus · H5 skeleton CLS · H6 SV preset overflows 320 px · M1–M10 · L1–L8 | cycle 11 (all HIGH + MEDIUM; L1 L2 L3 L4 L5 L8); L6 + L7 recorded below |
| `mobile-a11y-ux-reviewer` | Needs fixes | 2 HIGH (= H6, H4) · 7 MEDIUM (badge `aria-label`, region "Data table", optimistic, re-sync, trigger name, link at rest, skeleton) · 8 LOW | cycle 11 (all HIGH + MEDIUM; LOW 10 12 13 17); 11 14 15 16 recorded below |
| `i18n-translation-reviewer` | SHIP (fix-optional) | M1 SV preset +31 % · M2 SV eligible clips · L1–L11 | cycle 11 (M1 M2 L1 L2 L3 L4 L5 L7 L8 L9 L10 L11); L6 recorded below |

**Cycle 9 (privacy B-2 + security MEDIUM-1 / LOW-1 / LOW-2)** — FR-025 AMENDMENT: the
person's own opt-out outranks staff (409 `self_opted_out`; a self "off" over a staff record
is recorded as the person's objection, source `self`, audited); the staff switch renders no
control for `off_by_contact` / `unsubscribed`; staff toggles audit `related_member_id`
(a staff action is not member activity — the live-Neon guard proves
`members.last_activity_at` moves only for the contact's own action, the 0009 trigger
reads `member_id`); a removed in-tenant contact is `removed` → 404 without the probe
audit; the probe write's Result is read and logged. Commits `72b046c6d` (red) →
`326a97906` (green).

**Cycle 10 (privacy B-1 / security HIGH-1 + LOW-3)** — the opt-out is honoured AT
DISPATCH: `MembersBridgePort.filterMarketingOptedOut` → F3 `filterMarketingOptedOutEmails`
→ `ContactRepo.findMarketingOptedOutEmailLowers` (`lower(email)`, live rows, RLS +
explicit `tenant_id`, ONE `text[]` array bind); `resolveSegmentRecipients` runs it after
the suppression anti-join on EVERY segment kind (members, tier, attendees, custom list),
reports `droppedByPreference` separately from orphans, emits
`broadcasts_marketing_opt_out_filter_count{tenant}`, and the bridge THROWS on a failed
lookup — never fail-open onto people who objected. Proved on live Neon through the REAL
bridge (`tests/integration/broadcasts/marketing-opt-out-dispatch.test.ts`, 4 cases:
all_members, custom list with an opted-out secondary, lower(email)/removed/RLS, bridge).
The audience page's unsubscribe-list predicates bind one array each (LOW-3). 17 bridge
fixtures gained the stub. Commits `364d1b271` (red) → `06cfed9b3` (green).

**Cycle 11 (UX + a11y HIGH/MEDIUM, security LOW-4 / LOW-5, i18n)** — filters re-sync
from the URL when not focused and Clear hands focus to the search input first (H1/H2);
the switch flips optimistically, rolls back on refusal, stays disabled until the refresh
settles, and under a state-filtered view hands focus to the next row's switch (else the
count line) BEFORE the refresh with a "left the view" toast note (H3/H4); skeleton = real
44-px row pitch, 8 columns by default, `aria-busy` on the loading container (H5 / a11y 9);
the preset action wraps + SV copy shortened + the 320-px e2e runs for all three locales
(H6 / i18n M1 / CHK033); badge explanation is sr-only TEXT with the semantic warning
tokens (M2/M6 / a11y 3); table region named in the viewer locale, `table-fixed` +
`<colgroup>`, `role="list"`, link at rest, `overflow-wrap:anywhere` (M1/M3/L8 / a11y
4/8/12); count copy distinguishes "no contacts yet" (`countAll`) and a degraded empty
read (M4); select triggers name label + value and size to content (M5 / a11y 7);
portal state text is `text-foreground` and the switch is `aria-describedby` its state +
hint (M7 / a11y 11); shared `ReadOnlyBanner` replaces the ad-hoc note and the directory's
local copy (M8); the member page groups badge + switch as a pair outside the status-badge
cluster, which is now `role="group"` + `empty:hidden` — the bare labelled `<div>` was an
axe `aria-prohibited-attr` VIOLATION the moment it rendered empty, caught by the new
member-page axe sweep (M9 / CHK035); the dead `audienceLink` key is wired as a deep link
into the audience filtered by member (M10 / i18n L1); `onChanged` dead prop removed (L1);
pagination silenced under the page's own live count (L2); `/admin/marketing/error.tsx`
(L3); preset `aria-current` (L5). Security LOW-4: `?page` clamped to
`MARKETING_AUDIENCE_MAX_PAGE` = 100 000. LOW-5: `openSeedClient` REFUSES to open when
`TEST_DB_HOST_BLOCKLIST` is unset/empty (fail-closed) and `.env.example` documents the
variable. i18n: subscription badge + its 5 dead keys deleted (L2), SV `hen` → `kontakten`
(L3), toast periods (L4), TH `ไม่สำเร็จ` (L5), TH calque (L7), SV `själv` (L9), doc
namespace (L10), subtitle grammar (L11). New e2e: test 6 → three locales @ 320 px, test 7
+ axe on the member page, test 8 — pre-flight preset toggle keeps keyboard focus in the
table.

**Cycle 12 (docs)** — ROPA: recipient-side basis split out as legitimate interest with
the D3 LIA, the per-contact preference recorded as a processing activity with its two
audit events, the Art. 14 attestation residual recorded as a PR-C gate condition (privacy
H-1 / M-1); contract §3 says "select filters + Clear", not "chips" (ux CHK009) and
describes the optimistic / focus hand-off behaviour; FR-050a written (ux CHK033);
`docs/observability.md` span tree names the opt-out filter + metric.

**Recorded, not changed (with reasons)**

- UX L6 — the portal has no Undo. Intentional: FR-030c binds Undo to the STAFF switch;
  the person's own change is a one-click reversal on the same screen.
- UX L7 — "Changed" shows Asia/Bangkok time with no TZ hint for an SV viewer. Consistent
  with every other timestamp in the admin (renewals, audit viewer); a global TZ hint is a
  cross-feature UX decision, not a PR-D one.
- a11y 14 — switch hit area 48×30 / 56×34 px meets FR-035c (≥ 24) and WCAG 2.5.8; the
  ux-standards § 9.1 44×44 mobile target is a design-system decision for the Switch
  primitive (every switch in the app).
- a11y 15 — the unchecked switch track (`bg-input`) is 1.26:1 against a white card in
  light mode: a PRE-EXISTING primitive issue (`src/components/ui/switch.tsx`), now
  prominent because this page makes the switch a primary control ×50. Follow-up ticket for
  the primitive; not changed here to avoid a repo-wide visual change inside a feature PR.
- a11y 16 — at 320 px the state column is partly clipped until scroll; same treatment as
  the members directory and within FR-035c ("container scroll, never the page").
- i18n L6 — TH "inactive" wording is split three ways in the corpus (`หยุดใช้งาน` /
  `ไม่ได้ใช้งาน` / `ไม่ใช้งาน`); PR-D keeps the portal form. Unifying is a corpus-wide edit.
- privacy L-3 — `marketing_opt_out_by_user_id` for `source='self'` is the data subject's
  own user id, kept through the scrub at parity with `linked_user_id`; swept together when
  F1 user erasure lands (recorded in the ROPA retention table).
- privacy L-4 — `member_erased` / `contact_removed` reasons and the erased badge can never
  render on the audience page (the query starts from `removed_at IS NULL`, and the scrub
  stamps `removed_at`). Correct outcome — erased people never appear; the vocabulary stays
  for the compose-time count feedback (PR-C).

**Verification after cycle 12 (HEAD in the co-sign footers)**: unit/RTL suites touched
(members, broadcasts, components, lib, e2e-helpers) green; `pnpm check:i18n` OK 5289 keys ×
3; the eleven static gates OK; `pnpm lint` 0 on every touched file; `pnpm typecheck` 0
(the `.next/dev/types/routes.d.ts` parse errors seen twice were the dev server rewriting
the generated file mid-run — 0 errors outside `.next`); live Neon:
`contact-marketing-opt-out` 22 · `marketing-opt-out-dispatch` 4 · `marketing-audience-query`
· 6 broadcasts dispatch/audience files; e2e `admin-marketing-audience` 10/10 (3-locale
320 px, member-page axe, preset focus) + `portal-marketing-toggle` 3/3.

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
