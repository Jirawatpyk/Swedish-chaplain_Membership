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

### Round 4 — `/speckit-staff-review-run` (2026-09-06), 5 reviewers, 50 findings

The gate the maintainer runs. Five project reviewers on Opus, one per review
pass, each told that this ledger contains ALLEGATIONS to verify against the
code. Full report: `reviews/review-20260906-152258.md`.

| Pass | Reviewer | Files read | Verdict |
|---|---|---|---|
| 1 Correctness | `reliability-guardian` | 35 | CONDITIONS |
| 2 Security | `security-engineer` | 48 + 7 gates + 225 tests re-run live | APPROVE WITH FIXES |
| 3 Performance | `performance-slo-guardian` | 31 | PASS WITH CONDITIONS |
| 4 Spec + architecture | `spec-compliance-auditor` | 56 | PARTIALLY COMPLIANT, 0 blockers |
| 5 Test quality | `senior-tester` | 45 | **NOT MERGEABLE** |

**1 BLOCKER · 20 WARNING · 26 SUGGESTION · 3 INFO.** Spec coverage 94.9 %
(strict 89.7 %), 0 requirements unimplemented, 0 architecture violations, 0
security blockers.

**The blocker was real and was ours.** Cycle 15's errors HIGH-2 fix added
`cause: errKind('cause' in re ? re.cause : undefined)` to a file already pinned
at 100 % branch. Every test fed a `RepoError` that HAS a cause; the one shape
without it early-returns before the ternary. `Unit + contract coverage vs
pinned thresholds` — a required check — failed at 97.72 %. Two independent
confirmations: the reviewer measured it locally and CI said the same thing to
the character. The ledger's own T060 line ("measured 100/100/100/100") was
stale, written before the branch that broke it.

**The pattern, and it is the point of this round.** Of the 20 warnings, most
are not logic defects — they are **claims stated more strongly than the code
supports**, and most were introduced by cycles 15 and 16, whose entire purpose
was closing "recorded but never read":

| The claim | The code |
|---|---|
| this ledger: carry-forward matches "SweCham's pending import" | the import script bypasses `addInTx` entirely (C1) |
| `0294` header + `schema-contacts.ts`: "PR-D does not use it … drop it if unused" | `state=on` implies the partial predicate verbatim (P1) |
| `observability.md`, written that morning: "a drop to 0 means the filter stopped" | the emit was guarded on a non-zero drop; at SweCham's 0 opt-outs the series never appears (P2) |
| `checklists/security.md` CHK019: "timing-safe 404" | not timing-safe, and `grep timing` in spec + contract returns zero (S3) |
| `domain/contact.ts` ×3: "a new contact always starts in RECEIVES_MARKETING" | false since cycle 15 (C6) |
| cycle 15: "every claim now matches the code beside it" | the same cycle invalidated four test docstrings (T3) |
| three co-signs stamped at `5b818ee8c` | HEAD was five commits later (S1) |

**Two genuine correctness finds**, both on the carry-forward that cycle 15 had
just added and reviewed four times: it guarded ONE of three insert paths, so
`POST /api/members` and the import script re-subscribed people who had objected
(C1 — fail OPEN); and it selected the latest row *carrying* an objection rather
than the latest row for the address, so an opt-IN could be undone by a
long-removed row (C2 — silently discarding the person's own decision).

**Closed in five commits** (`b33f4a503`, `472317bcb`, `e6e8d6ebf`,
`0b574a30c`, `0ae9d89c3`): 45 accepted and fixed, 2 rejected with reasoning,
1 decided where two reviewers contradicted each other.

- **Rejected — C4** (explicit `tenant_id` on the new write): correct
  implementation needs a signature change rippling through ~40 call sites; the
  version that avoids it must read `current_setting('app.current_tenant')`,
  the same source RLS reads, so it is not an independent layer. RLS FORCE is
  proven live in both directions (FR-052). Follow-up ticket, as both reviewers
  proposed.
- **Rejected — T6** (integration cases share state): Vitest runs a file
  serially by contract and each case asserts its own precondition, so it fails
  loudly. Restructuring ~700 lines of live-Neon tests risks more than it fixes.
- **Decided — A7 vs C11**, which pointed opposite ways on the same flag. Split
  by meaning: the page for CHOOSING a broadcast audience may follow
  `FEATURE_F7_BROADCASTS` (without broadcasts it has no function); a person's
  OBJECTION may not, because it is a privacy record. FR-035 gained the
  AMENDMENT; the switch stays ungated.

Six AMENDMENT blocks (FR-022a, FR-024, FR-027, FR-027a, FR-031b, FR-053a) close
the "authorised only by a review ledger" class the spec's own § rules exist to
prevent.

**Verification at `0b574a30c`** (the last source commit; only the co-sign
re-stamp follows): `pnpm test:coverage` **exit 0, zero threshold errors** ·
full unit + contract 1224 files / 13642 tests · fifteen static gates · lint 0 ·
typecheck 0 · live Neon `contact-marketing-opt-out` 28,
`contact-marketing-routes` 8, `contact-marketing-opt-out-guard` 4,
`primary-contact-read-agreement` 7, `marketing-audience-query` 8 (+3 scale
cases moved to the nightly sweep).

### Cycle 16 — the gate that was running on nothing (found at push, 2026-09-06)

Not a review round. The branch's first successful push printed, after four green
module gates:

```
[pre-push] no integration test imports src/app/api/admin/contacts/[contactId]/marketing/route.ts — skipping
[pre-push] no integration test imports src/app/api/portal/profile/marketing/route.ts — skipping
[pre-push] no integration test imports src/app/api/portal/profile/route.ts — skipping
```

The API-route gate (#339) had nothing to run for any route PR-D adds. Their
contract tests mock `@/lib/contact-marketing-deps`, `@/modules/members`,
`@/lib/idempotency` and `@/lib/tenant-context`, so they pin the routes' SHAPE —
status codes, order of checks, RFC 7807 bodies — and nothing about the wiring
underneath. Route → real deps builder → real use case → real repo → RLS → audit
had only ever been exercised by e2e, which has no CI job. That is the
`void-pdf-reconcile` shape exactly: green everywhere, unproven where it counts.

`tests/integration/members/contact-marketing-routes.test.ts` closes it — six
cases against live Neon, mocking `@/lib/auth-session` only: a staff "off" writes
all three 0294 columns AND its audit row (`related_member_id`, no address); the
same state again is `unchanged` with no second row; a `manager` is refused with
the row untouched; a member's own "off" is stamped `self` and audited under
`member_id`; staff get 409 `self_opted_out` and the objection survives; and
`GET /api/portal/profile` reports `off_by_contact` on the own contact only. It
joins `integration-smoke.yml`, which is required on `main` (that job already
sets `E2E_X_TENANT_HEADER_ENABLED: 'true'`, and `rateLimiter.check` falls back to
an in-memory bucket when Upstash is unreachable — both checked, not assumed).

**Two mutation facts, measured.** The file's first draft claimed to prove the
repo's UNDER-LOCK FR-025 guard. Disabling that guard left all six cases GREEN —
the use case's pre-read refuses first — while
`contact-marketing-opt-out-guard.test.ts` failed 2 of its 4. So the new file
proves the refusal REACHES THE CLIENT, and the TOCTOU leg stays where round 2
put it. The header now says that instead of implying more; a test's docstring is
a claim, and claims get mutation-checked like any other.

Also closed here: `docs/observability.md` § 22.1 was missing BOTH metrics this
feature added — `broadcasts_marketing_opt_out_filter_count{tenant}` (cycle 10)
and `broadcasts_suppression_lookup_failed{tenant, op}` (cycle 15). The second
exists precisely so a degraded-but-silent suppression outage becomes visible;
leaving it out of the inventory is the same "recorded but never read" shape it
was written to close. And in `src/lib/metrics.ts` the new method had been
inserted BETWEEN `marketingOptOutFilterCount`'s docblock and its body, so the
surviving comment described the wrong function.

**Verification at HEAD `7e06cd7a7`**: lint 0 · typecheck 0 · pre-push
`tests/integration/members` 96 passed / 1 skipped (97) · the new file 6/6 and
`contact-marketing-opt-out-guard` 4/4 with the guard restored. The three commits
after `631f3c651` are tests + docs + comments only — no production behaviour
changed — so the three co-signs stand as re-affirmed. Coverage against the
pinned thresholds is CI-verified only (`pnpm vitest run tests/unit tests/contract`
is NOT `pnpm test:coverage`); the required job is the verdict.

### Round 3 — `/speckit.review` (2026-09-06), 5 agents, 60 findings, all closed in cycle 15

The user-invoked gate. Config had no `review-config.yml`, so all six agents were
enabled by the extension defaults; scope was the branch diff (`main...HEAD`, 130
files). The five analysis agents ran in parallel on Opus.

| Agent | Verdict | Findings |
|---|---|---|
| `code-reviewer` | no blocker | H1 a self opt-out was lost on remove → re-add of the same address · M1 `eligible=on` was not counted as narrowing · L1 `AUDIENCE_COUNT_ID` exported from a `'use client'` module · L2/L3 |
| `pr-test-analyzer` | **NOT mergeable** | **B-1 a unit test was RED on the branch** · H-1 the "write + audit commit together" claim was only proved against a stubbed `runInTenant` · H-2 an uncovered branch · M-1..M-6 · V-1..V-3 vacuous tests |
| `silent-failure-hunter` | no blocker | HIGH-1 the suppression lookup was swallowed in six places with no log · HIGH-2 `RepoError.cause` dropped at every layer · M-1..M-5 · LOW-1..LOW-4 |
| `type-design-analyzer` | mergeable | HIGH-1 `refused_self_opted_out` could be ignored (not a discriminated union) · MEDIUM-1 two representations of the actor · MEDIUM-2..4 · LOW-1..3. Ratings: encapsulation 4/5, invariant expression 4/5, usefulness 5/5, enforcement 3/5 |
| `comment-analyzer` | no blocker | H1–H4 + M1–M4 + L1–L8, all comment rot: four cycles changed behaviour and updated the NEAREST comment, never the mirrors in other files |

**B-1 was real and was fixed first**: cycle 13 widened the suppression fetch to
every `state` filter and added `emailLowerNotIn` to both `off_*` legs, but only
the integration test was updated — `list-marketing-audience.test.ts` still
asserted the old "no suppression fetch" behaviour and the branch carried a red
required check. It also left line 144 (`off_by_contact` → `optOut: 'self'`)
uncovered. Closed by splitting that case per leg, each asserting the exclusion,
plus a case pinning that the UNFILTERED view still skips the fetch. The lesson
is the one this repo already has written down: after changing a use case, run
the WHOLE module suite, not the files you happened to touch.

**Cycle 15** closed the rest:

- **types HIGH-1 + MEDIUM-1** — `ContactRepo.setMarketingOptOutInTx` now takes ONE
  `SetMarketingCommand` (`{kind:'off', actor, byUserId, at}` | `{kind:'on', actor}`)
  and returns a DISCRIMINATED `SetMarketingOutcome` whose `refused_self_opted_out`
  arm carries no `contact`. The FR-025 guard that took four cycles to get right is
  now something `tsc` enforces: six call sites had to narrow before reading
  `.contact`, which is exactly the check that was previously optional. The actor is
  stated once, so a payload and an `opts.actorSource` can no longer disagree.
- **code H1** — a contact's OWN objection follows the ADDRESS: `addInTx` carries a
  `self` opt-out forward from the most recent row with that `lower(email)` in the
  tenant (removed rows included). A `staff` opt-out does NOT follow — it is an
  operational setting on a row, not the person's objection. This is the shape
  SweCham's pending secondary-contact import has, and it is the difference the spec
  claimed ("the same objection as the unsubscribe link") but the code did not give.
  Proved on live Neon in both directions.
- **errors HIGH-1** — `makeMarketingSuppressionLookup` logs (class only, via
  `errKind`) and counts `broadcasts_suppression_lookup_failed{tenant, op}` before
  re-throwing. Six `catch {}` blocks upstream degrade on that throw; none of them
  could see it, so a sustained outage was invisible until staff filed a ticket.
  The parse branch keeps returning "not suppressed" but with the HONEST reason in
  the comment and a debug breadcrumb: the two email grammars are identical, so the
  branch is unreachable — the old reason ("the list only holds parsed values") was
  false, because the multi-batch webhook path brands without parsing.
- **errors HIGH-2** — `RepoError.cause` is carried into the logs at the bridge, the
  toggle use case and the audience read. A statement timeout, an RLS refusal and a
  violated 0294 CHECK used to be one indistinguishable `repo.unexpected`.
- **errors MEDIUM-2** — a degraded suppression read no longer answers `on` or either
  `off_*`: those filters are DEFINED by the list, so answering without it listed
  people who had unsubscribed under "on" and inflated the count on the FR-027a
  pre-flight page. The unfiltered view is unaffected (it only labels rows).
- **errors MEDIUM-1/3/5, LOW-2** — the audience read logs its repo failure (the page
  renders an EmptyState from a Result, so `error.tsx` never sees it); the portal
  names every refusal (503 `suppression_unavailable` with a new key in three
  locales, 409 by code); a bridge throw at dispatch is a typed
  `dispatch.server_error`, not the `uncaught_error` class that pages someone.
- **code M1** — `narrowed` (default eligibility included) drives the count copy and
  the empty state, and the Clear CTA lifts the eligibility leg; a tenant whose
  members are all inactive was being told "No contacts yet" with no way back.
- **code L1 / types MEDIUM-4** — `AUDIENCE_COUNT_ID` moved to a server-safe module;
  the bridge answers with the CALLER's own values so a case difference cannot fail
  open.
- **tests H-1, M-1..M-6** — live-Neon proof that the write and its audit row roll back
  together; the portal PATCH pins the state it derives after a successful "off"
  (unsubscribed / unavailable) and its 503; `ReadOnlyBanner` has its own suite; the
  audience table pins "read-only viewer sees no switch"; the memoised bridge pins
  that the opt-out lookup is NOT cached; the FR-052 audience-query proof joined the
  required smoke job.
- **comments H1–H4, M1–M4, L1–L8** — every claim now matches the code beside it.

**Recorded, not changed**: the idempotency reservation is not released on a failed
request (errors MEDIUM-4 / code L2) — that is the repo-wide convention and both UI
clients mint a fresh key per request; the behaviour is now WRITTEN into contract
§1 so the next integration author does not discover it as a 24-hour 409.
`scrub-contacts-pii-column-coverage.test.ts` remains an allow-list rather than a
behavioural scrub test (tests V-2) — the classification is what that gate is for,
and the retention decision itself was settled in the privacy round.

**Verification after cycle 15 (HEAD `631f3c651`)**: lint 0 · typecheck 0 ·
`check:i18n` 5290 keys × 3 · thirteen static gates OK · **full unit + contract run
green — Test Files 1224 passed, Tests 13640 passed** · live Neon:
`contact-marketing-opt-out` 26 (incl. the rollback and carry-over proofs) ·
`contact-marketing-opt-out-guard` 4 · `marketing-opt-out-dispatch` 4 ·
`marketing-audience-query` · contract `profile-marketing` + `contact-marketing` 32 ·
e2e `admin-marketing-audience` + `portal-marketing-toggle` 12 passed / 1 flaky
(dev-server warm-up, passed on retry), exit 0.

An earlier draft of this paragraph claimed, at HEAD `5b818ee8c`, a green "unit
sweep of every folder the cycle touched". It was not green. Dropping the `?.`
from `src/app/api/members/_serialise.ts` (types MEDIUM-3) made `Contact.marketing`
genuinely required, and 24 hand-built Contact fixtures across five
`tests/contract/members` files and one `tests/unit/members/infrastructure` file
did not carry it. The sweep I ran covered the folders I had EDITED, not the
folders that CONSUME the type I had tightened — which is the same miss as B-1 in
this very round, one commit later. Fixed in `631f3c651`; the counts above are
from the full run, which is the only sweep that can make this claim.

### Round 2 — two fresh-eyes whole-branch reviews (2026-09-06), 28 findings, all closed in cycles 13–14

Two `whole-branch-reviewer` passes over the full diff, launched after cycle 12: one on
the parent model (Fable — the verdict of record per the maintainer's instruction) and one
on Opus. Both found the same top issue independently.

| Reviewer | Verdict | Findings |
|---|---|---|
| whole-branch (Fable) | MERGEABLE, "close #1 before or right after merge" | MEDIUM-1 TOCTOU on the FR-025 guard · MEDIUM-2 ROPA rationale claims a safeguard the code does not give · MEDIUM-3 contract §1 stale · LOW-4 audit-port comment · LOW-5 Undo toast says "left the view" · LOW-6 portal switch not optimistic · LOW-7 `off_*` filters list suppressed rows |
| whole-branch (Opus) | NOT MERGEABLE (on the same TOCTOU) | HIGH-1 = TOCTOU · HIGH-2 Undo drops focus on `<body>` (sonner dismisses the toast after the action) · M-3 `?state=banana` reaches a label as a raw key · M-4/M-5 = Fable's MEDIUM-2 / LOW-4 · M-6 the new integration proofs gate nothing on `main` · M-7 the suppression adapter untested · M-8 debounce survives unmount · M-9/M-10 header/badge clipping in fixed columns · M-11 the page serves while the flag hides it · M-12 the integration harness guard was not fail-closed · M-13 0294 index comment claims a use PR-D has not got · M-14 three live regions · M-15 = LOW-6 · M-16 scrub rationale mis-states the `self` case · LOW-17 `droppedByPreference` trusts the bridge · LOW-18 audience query without an explicit tenant predicate · LOW-19 skeleton box mismatch · LOW-20 stray border / sub-24-px link · LOW-21 seven comment drifts |

**Cycle 13 (MEDIUM-1 / HIGH-1 + Fable's set)** — `setMarketingOptOutInTx` takes the actor's
source and re-checks the FR-025 AMENDMENT on the LOCKED row: staff "on" over a `self`
record is `refused_self_opted_out` (no write) — the use case's pre-read stays as the fast
path; a self opt-out committed between the read and the write still wins. Proved on live
Neon (`contact-marketing-opt-out-guard.test.ts`, 4 cases) + use-case unit cases; every
direct repo writer now states who is acting (the argument is required, not optional).
Undo's toast no longer claims the row left the view (LOW-5); the portal switch flips
optimistically and rolls back (LOW-6); `state=off_by_staff` / `off_by_contact` exclude
suppressed addresses (LOW-7 — the badge says "unsubscribed", so the filter must agree);
the ROPA retention rationale now says what the column IS (no-PII actor record; the audit
trail is authoritative; it is NOT an address-keyed suppression — only
`marketing_unsubscribes` survives erasure); contract §1 carries the real payload
(`related_member_id` for staff, `actor_role`) and the 409 `self_opted_out` / 503
`suppression_unavailable` / 429 rows; the audit-port comment says the self/staff split.

**Cycle 14 (Opus's set)** — the Undo action resolves its focus target (the switch if
still in the DOM, else the count line) BEFORE `send` and focuses it after (HIGH-2, unit ×2);
`?state` / `?kind` are NARROWED against the allowed lists before any label (M-3); the
search debounce is cleared on unmount (M-8); `droppedByPreference` is measured
(before − after), never the bridge's word (LOW-17); header cells wrap and the `state` /
`switch` / `memberStatus` columns are sized for the longest locale (M-9/M-10); the page
calls `notFound()` when `FEATURE_F7_BROADCASTS` is off and the member-page deep link is
gated the same way (M-11, unit: no read happens after the gate); the degraded panel is a
`note` and the count line steps aside at zero so the `EmptyState` is the one announcement
(M-14); one shared `tests/helpers/db-host-guard.ts` behind BOTH the integration harness
and the e2e seed client, fail-closed on a match AND on an empty list (M-12, unit ×5);
`contact-marketing-deps.ts` has its own unit suite — the "unparseable → not suppressed"
branch is pinned WITH its reason (the list only holds parsed values) and a repo failure
throws (M-7); the three PR-D live-Neon proofs are in `integration-smoke.yml`, the
required check on `main` (M-6); the 0294 index comment says the index is RESERVED for
PR-C and unused here, with an `EXPLAIN` obligation (M-13); the scrub-coverage rationale
records that the `self` case keeps the erased subject's own user id at parity with
`linked_user_id` (M-16); explicit `tenant_id` predicate on the audience query (LOW-18);
skeleton body = `w-full` + min-width and the action skeleton may grow (LOW-19); the
badge-group border paints only when the group is non-empty and the deep link is a ≥ 24-px
target (LOW-20); the seven comment drifts corrected, incl. tasks.md's deployment line —
PR-D DOES change the dispatch audience (LOW-21). `unavailable` is no longer muted (it is
a state).

**Recorded, not changed**: the `<caption>` and the region `aria-label` carry the same
string (LOW-21 item) — kept on purpose: the region and the table are distinct landmarks
and the members table sets the same precedent (WCAG 1.3.1 for table navigation). The
`?.` on `c.marketing` in `_serialise.ts` stays: it guards hand-built fixtures in older
tests, as its comment says.

**Verification after cycle 14 (HEAD in the co-sign footers)**: unit/RTL suites touched
(members, broadcasts, components, lib, e2e-helpers) green; `pnpm check:i18n` OK 5289 keys ×
3; the eleven static gates OK; `pnpm lint` 0 on every touched file; `pnpm typecheck` 0
(the `.next/dev/types/routes.d.ts` parse errors seen twice were the dev server rewriting
the generated file mid-run — 0 errors outside `.next`); live Neon:
`contact-marketing-opt-out` 22 · `contact-marketing-opt-out-guard` 4 ·
`marketing-opt-out-dispatch` 4 · `marketing-audience-query` (+ the suppressed staff-off
contact) · 6 broadcasts dispatch/audience files; full `pnpm test` after cycle 12: 1219 files
/ 13581 tests green (the one failure was the `.env.example` harness-only key, closed by the
`HARNESS_ONLY_KEYS` allow-list with positive controls); e2e `admin-marketing-audience` 10/10
(3-locale 320 px, member-page axe, preset focus) + `portal-marketing-toggle` 3/3, re-run
after cycle 14.

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
