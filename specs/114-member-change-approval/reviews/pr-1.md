# PR-1 — foundation + US1 submit → US2 decide → US3 reject / resubmit

Branch `114-member-change-approval`. Range reviewed: `d6c5028aa..b22f9209b` (the four
implementation commits after the last spec-only commit). Everything dark behind
`FEATURE_MEMBER_CHANGE_APPROVAL` (default OFF, variable ABSENT from Vercel) and the per-tenant
switch (default false).

## Gate output at `b22f9209b` (before round 1)

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` (full) | clean |
| `pnpm vitest run tests/contract/` | 193 files, 2,008 passed, 2 todo |
| members unit + contract + portal + lib + architecture | 278 files / 2,785 passed |
| integration (live Neon `dev`, by path) | repo 8 · submit-atomicity 2 · staff-email-dispatch 2 · decide-rollback 2 · concurrency 2 (2 decides + 50 submits) · member-email-dispatch 2 · tax-document-immutability 1 · tenant-isolation 4 (both directions) — all green |
| `check:i18n` 5,413 keys · `check:layout` · `check:staff-page-guard` (49 guarded) · `check:api-route-guard` (121) · `check:actor-role-truth` (0 fabricated) · `check:portal-guard` · `check:audit-events` · `check:audit-counts` · `check:multi-tenant` (28 tables) · `check:fixme` · `check:dates` · `check:env-example` | all OK |
| `tests/contract/rbac` (baseline 49 pages / 133 APIs, frozen marketing set 51) | 147/147 |
| e2e `tests/e2e/change-requests.spec.ts` (US1–US3, axe) | WRITTEN, NOT RUN — no dev server in the session; the server env needs the flag ON |

## Round 1 — six read-only reviewers (Opus) on `d6c5028aa..b22f9209b`, 2026-09-11

Reviewer stack per `README.md`: `security-engineer`, `pdpa-gdpr-compliance-officer`,
`reliability-guardian`, `drizzle-migration-reviewer`, `thai-tax-compliance-auditor`,
`enterprise-ux-designer` — concurrent, read-only, no subagents. Every finding below was
confirmed against the code before it was fixed (108 rule 2: grep the assertion, not the sentence).
Verdicts: no Critical-in-dark-state from five reviewers; UX raised three Critical (WCAG 1.3.1
table labels, the `/privacy` dead link, a DB failure rendered as an empty queue). Five of six said
**With fixes**, UX said **No** until its three Critical closed.

### Fixed in this round (commit `0a2cbf1ec`)

| # | Lens | Finding | Fix |
|---|---|---|---|
| 1 | UX C1 | diff / decision tables: per-cell labels `sm:hidden` = absent from the accessibility tree ≥ 640 px (WCAG 1.3.1); the header row is `aria-hidden` | `sm:sr-only` on the cell labels in both tables |
| 2 | UX C2 · Privacy I-2 | FR-010 privacy-notice link hardcoded `/privacy` — no such route (404) | link sourced from `env.broadcasts.privacyPolicyUrl` (`TENANT_PRIVACY_POLICY_URL`), hidden when unset; the notice text always renders |
| 3 | UX C3 | `/admin/change-requests` rendered a repo failure as "no change requests are awaiting a decision" (and the deep link as "no request") | every read fault throws to the error boundary with an `M114.admin.queue_page.<arm>` errorId |
| 4 | Rel I-2 · Sec I-2 | `decideChangeRequest` read `erased_at` through `findErasedAtById` (its own `runInTenant` = a second pool connection while holding `FOR UPDATE`; and BEFORE the member lock — an erasure committing in between was invisible → PII written back into an erased record) | new `MemberRepo.findErasedAtByIdInTx`; read AFTER `findByIdInTx` on the same tx |
| 5 | Rel I-1 | two concurrent first submits: the `FOR UPDATE` read locks nothing when no pending row exists; the unique-index loser surfaced as a 500 — and the concurrency test called that acceptable | the conflict re-reads the winner's row and answers `already_pending`; the 50-submit test now asserts 1 submitted + 49 `already_pending`, zero `server_error` |
| 6 | Rel I-3 | staff arm: `resolveMemberNumberPrefix` throws (no Result) → the tick's tx rolled back with `attempts` unbumped → an outbox row retried forever | wrapped: a throw → `null` (transient ladder) |
| 7 | Rel I-4 | a request REPLACED before its staff row was sent still emailed the reviewer the stale diff | staff arm refuses any non-pending request as `request_superseded` (permanent on tick 1, audited); integration case added |
| 8 | Sec I-4 | staff email did not re-check the recipient at send time — an admin disabled between enqueue and dispatch still received member PII | the arm re-reads the active reviewer roster (`listActiveUsersByRole(reviewerRoles())`); a non-member → `recipient_gone` |
| 9 | Rel I-5 · Sec M-1 | `acknowledgeChangeRequest` audited another contact's request (same tenant, row visible) as `member_cross_tenant_probe` | ownership refusal is `not_found` WITHOUT the probe; a repo miss keeps it |
| 10 | Tax I-1 | `affectsTaxDocuments('registered_address')` read the billing state at submission; a proposal that CLEARS the billing group in the same request under-flagged the registered address (the future §86/4 buyer address) | `resultingHasBillingAddress(member, proposal)` — the flag reads the state the approval would leave |
| 11 | Tax I-2 | the billing-group all-or-nothing rule lived only in `update-member.ts`; an incomplete group submitted fine and could never be approved (DB CHECK 23514 → opaque 500) | `validateProposal` refuses a partial group at the missing required lines (`billing_address_incomplete`); the client schema mirrors it with field-level copy |
| 12 | Tax I-3 / I-4 | `billing_country` hint dropped the FR-019 head-office / branch reminder; the TH copy said "the country that issues the invoice" (seller) | all three locales carry the reminder; TH reads "ที่อยู่เรียกเก็บเงินของผู้ซื้ออยู่นอกประเทศไทย …" |
| 13 | Tax M5 | hints never named ใบกำกับภาษี | buyer-name / buyer-address hints do, in all three locales |
| 14 | Privacy I-1 | `member_timeline_v` + the portal timeline surfaced a colleague's `own_contact` request (`contact_id`, `field_keys`) to every portal user of the member — FR-029 / U4; T077 mandated the defect | `timelineList` drops such rows for a member-role viewer whose `viewerContactId` ≠ the row's contact (fail closed when unresolvable); the portal route + page thread the viewer's own contact; T077 amended |
| 15 | Privacy I-3 | `isInMemberAuditSubset` never read `related_member_id` — the subject's DSAR export omitted every decision about their proposal | one more key matched (also closes the pre-existing gap for `auto_email_skipped_no_recipient` / marketing rows) |
| 16 | Privacy I-5 | a gate-narrowed Group B edit was audited identically to a forged Group C key | `member_self_update_forbidden` payload carries `refusal: 'gate_narrowed' \| 'forged'` |
| 17 | Privacy M-6 | the withdraw audit key `reason` sits on the manager redaction deny-list — the closed enum (`member \| replaced \| erasure`) would be redacted, including the Art. 17 closure | key renamed `withdrawn_reason` |
| 18 | Privacy M-7 | forged key NAMES landed unbounded in an append-only table erasure never scrubs | capped at 20 keys × 64 chars, `attempted_fields_truncated` marker |
| 19 | Mig I-1 · Sec M-4 | field-row FK + the replaced-by self-FK were single-column: RI bypasses RLS, so a row of tenant B could reference a request of tenant A | `UNIQUE (tenant_id, id)` on the parent; both FKs composite `(tenant_id, …)`; dev branch converged by ALTER; regression test in `change-requests-repo.test.ts` (23503) |
| 20 | Mig I-2 · Sec I-3 · Priv I-4 · Rel M-8 | migration header claimed the FR-030 erasure scrub "is" done; `ChangeRequestScrubPort` has no implementation or caller (T078, PR-2) | header rewritten in the future tense; `quickstart.md § 3` gained a **pre-flip gates** table naming T078/T070, T087, T102, T072/T074 and the e2e run |
| 21 | Mig M-7 | app-only invariants | DB CHECKs `reason_iff_rejected_ck`, `ack_iff_decided_ck` |
| 22 | Mig M-3 / M-1 | queue index lacked the keyset tiebreak `id`; Drizzle index drifted from the migration | `(tenant_id, state, submitted_at DESC, id DESC)` in both |
| 23 | Mig M-4 | one `mapDbError` catch covered both inserts | the field-row insert has its own catch (`repo.unexpected`) |
| 24 | Mig M-6 | stale test name "count is 37" asserting 42 | renamed |
| 25 | Sec I-1 | `POST /api/portal/change-requests` had NO rate limit; every submit fans one email per reviewer | interim Upstash cap 10 / 24 h per tenant + user (the durable cap's numbers) → 429 `rate_limited` + `Retry-After`; T087 stays the durable rule |
| 26 | Sec M-2 | a deterministic 4xx was not remembered under the Idempotency-Key → a retry answered `idempotency-key-reused` forever | 403 / 404 / 422 refusals are remembered; 429 / 5xx are not |
| 27 | Sec M-3 | a PRESENT but malformed key silently ran un-deduplicated | 400 `invalid_idempotency_key` |
| 28 | Rel M-3 | dispatcher slug guard `{1,64}` vs `asTenantContext` `{1,63}` (a 64-char slug → throw → forever-retry) | `{1,63}` on both new arms |
| 29 | Rel M-6 | contact patch silently dropped when the contact is null | `UseCaseAbort` |
| 30 | Rel M-7 | the decision banner treated 409 `not_decided` as success | 409 → `router.refresh()`; other failures → toast |
| 31 | UX I1 | every dialog error path used a toast while the modal was open (aria-hidden outside the focus trap) | in-dialog `role="alert"` for the arms that keep the dialog open |
| 32 | UX I2 | `AlertDialogContent` has no max-height; the tall reason + note body pushed the footer off-screen | `ConfirmationDialog` bounds its body (`max-h-[50vh] overflow-y-auto`) |
| 33 | UX I3 | initial focus on Cancel while Confirm was disabled by the empty required reason | `ConfirmationDialog.initialFocusRef` (default unchanged); the reason textarea takes focus when a rejection is selected |
| 34 | UX I4 / I9 | reject-only checkbox `disabled` (out of the tab order, its explanation unreachable); accessible name announced twice | `aria-disabled` + inert toggle + `aria-describedby` → the marker; the visible caption is `aria-hidden` |
| 35 | UX I5 | rate-limit copy: browser-locale clock time without a date for a rolling 24 h window; fallback 3600 s; "for today" | `formatLocalisedDate` (date + time, Asia/Bangkok); no time when the server sends none; copy says "the last 24 hours" |
| 36 | UX I6 | focus fell to `<body>` after the 409 / success closes (the trigger unmounts on refresh) | `closedViaSuccessRef` → the `#main-content` fallback |
| 37 | UX I7 | `/admin/change-requests` reachable only from the email deep link | nav item under Membership (`members.read`, hidden while the platform flag is OFF via `visibilityFlag: 'memberChangeApproval'`); nav pins updated |
| 38 | UX I8 / M3 / M6 / M7 / M15 / M16 / M2 | empty state anatomy; "Decided by  on …"; pending hint in muted text; focus lost on Dismiss; ⊘ glyph on Dismiss; banner diff text inheriting the info colour; 6 dead `portal.changeRequests.resubmit.*` keys | `EmptyState` on the queue; `unknownReviewer` fallback; `InlineAlert` warning; focus → `#main-content`; `XIcon`; `text-foreground`; dead keys deleted |

### Deferred with a written owner (not silently dropped)

| Finding | Where it lives now |
|---|---|
| Privacy I-4 / Sec I-3 / Mig I-2 — FR-030 erasure scrub (T078 + T070) + outbox cancel by `memberId` | `quickstart.md § 3` pre-flip gate (PR-2) |
| Sec I-1 durable cap + coalescing (T087) | pre-flip gate (PR-2) |
| Sec I-5 — reviewer directory is cross-tenant by construction (F10 `user_tenants`); no `tenants` table exists to build a runtime tripwire on today | documented in `active-users-by-role-repo.ts` + `members-change-request-deps.ts`; F10 follow-up |
| Tax M7 — FR-022 test covers the billing-address branch only; add a billing-less member case | PR-2 test follow-up |
| Tax M6 / M8 — a billing CLEAR hint; primary-ness frozen at submission | PR-2 UX follow-up (M8 is a courtesy line, not a §86/4 particular) |
| UX M1 (edit page tab title), M4 (review loading skeleton height), M5 (persistent link underline on two links), M8 (list `aria-label` / no h2 above the table), M9 / M10 (portal form headings vs fieldsets), M11 (`RequiredMark`), M12 (server 422 copy per rule), M13 (queue `limit: 50`, no paging — T072/T074), M14 (route-level `error.tsx`), M17 (SV dash consistency), M18 (language field moved unflagged — documented in the PR description) | PR-2 UX pass |
| Rel M-1 (no refused metric for `not_pending` / `member_erasing` / `contact_removed` / `not_found`), M-2 (`deriveOutcome` throws), M-4 (idempotency remember — closed here), M-5 (read paths use the `FOR UPDATE` finder) | Rel M-5 → PR-2 (a non-locking `findPendingBySubmitter`); M-1 / M-2 accepted as-is (bounded label set; unreachable after `checkCoverage`) |
| Privacy M-8 (raw `userId` in four new page logs — pre-existing pattern), M-9 (`member_change_approval_setting_changed` i18n lands with PR-3), M-10 (`ON DELETE CASCADE` vs FR-030 accountability — a documented trade-off) | recorded |
| Mig M-2 (unindexed FK columns `decided_by_user_id`, `submitted_by_contact_id`, `replaced_by_request_id`), M-5 (per-field UPDATE loop in `decideInTx`) | PR-2 migration follow-up |
| Whole-branch seam pass (`whole-branch-reviewer`) | runs after round 1 lands |

## Round 2 — the same six lenses re-review the FIXES (`b22f9209b..0a2cbf1ec`), 2026-09-11

108 rule 1: a fix is re-reviewed by the lens that found the defect, against the assertion, not the
sentence. Each reviewer read its own round-1 rows, opened the fix, and said CLOSED / PARTIAL / NOT
CLOSED per finding, then looked for regressions the fixes introduced. Verdicts: security **With
fixes** (3 residuals), privacy **With fixes** (I-1 residual + 2 new), reliability **With fixes**
(1 regression + 3 new), migration **Ready (dark)** with 2 parity notes, tax **With fixes** (3 copy
+ 1 rule), UX **No** until the `unknownReviewer` key lands where the page reads it, then With fixes.

### Per-lens outcome

| Lens | Round-1 rows | Round-2 verdict | What round 2 changed |
|---|---|---|---|
| Security | 25–28 all CLOSED | residuals R-1 / R-2 / R-3 | R-1 `listActiveUsersByRole` throws → the tick's tx rolled back with `attempts` unbumped (the same class as Rel I-3) → wrapped, a throw → `null`; R-2 `viewerContactId` was OPTIONAL so a new caller silently read as "unresolvable = drop everything" → REQUIRED `string \| null`, every staff caller passes `null` explicitly; R-3 the FR-029 projection ran AFTER `redactEvents` → moved before it, so a future deny-list entry for `contact_id` cannot fail it open. I-5 (cross-tenant roster) stays documented: cross-tenant by construction, no `tenants` table to tripwire on. |
| Privacy | 14–18 CLOSED; I-1 PARTIAL | I-1 residual + M-7 residual + I-3 residual | I-1: the projection only dropped `own_contact`; a colleague's MIXED row still carried `field_keys` naming their own fields → mixed rows keep the company part, lose `field_keys` / `fields` for anyone but the submitter; `decided` + `withdrawn` rows are projected too (they carry `scope` + `contact_id` now — audit-port contract, 0301 header, T078 / T082 updated). I-3 residual: the SQL arm of `gdpr-audit-subset-repo.ts` never matched `related_member_id` (only the app predicate did) → SQL arm added. M-7 residual: `member-self-update.ts` still wrote unbounded attacker-named keys → `boundForbiddenKeys` at both sinks + `attempted_fields_truncated`. |
| Reliability | 5–9 CLOSED | N-1 / N-2 / N-3 + one regression | Regression (from I-1's fix): the conflict re-read answered `already_pending` even when the winner's proposal DIFFERED → `sameProposal` check; a different proposal takes one bounded retry through the replace path; the re-read failing is logged (`conflict_reread_failed`) and falls through to `server_error`. N-1 the miss-path metric label was hardcoded `no_template_handler` while the audit row carried the true reason → `permanentFailure(type, miss ?? 'no_template_handler')`, union widened. N-2 `acknowledge` not-owner refusal was invisible (no audit, no metric) → `refused{reason='not_owner'}`. N-3 the recipient was matched by the FROZEN address → outbox `context_data.reviewerUserId`, matched by id at send time, sent to the CURRENT address; rows without an id fall back to the address. |
| Migration | 19–24 CLOSED | 2 parity notes | Drizzle `schema-change-requests.ts` still declared the field-row FK single-column and the queue index without `.desc()` → composite `foreignKey()` in the table extras, `.desc()` on `submitted_at`; `scripts/verify-schema.ts` gains 0300 canaries (UNIQUE `(tenant_id, id)`, both composite FKs incl. `condeferrable`, the tenant settings column). `fillLines` stored `''` for a blank line, which the group CHECK counts as present → `''` → `null`. |
| Tax | 10–13 CLOSED | rule + copy | Rule: `resultingHasBillingAddress` treated a proposal that ADDS a billing group as "on record" — staff may reject the billing part and approve the registered address → narrowing rule: only a CLEAR changes the answer (registered flagged when the member has none, whatever the proposal adds); M7's billing-less case is now a unit test. Copy: Thai script removed from EN / SV `taxHint`; TH `billingIncomplete` / `billingAddressSection` / the diff label / both email builders say ที่อยู่สำหรับออกใบกำกับ; the hint names ภ.พ.20 in all three locales. |
| UX | 29–38 CLOSED except M3 | Blocker + 4 | Blocker: the round-1 script inserted `unknownReviewer` under `admin.plans.toast` (the first `"deactivated"` key) while both pages read `admin.changeRequests.review.unknownReviewer` → moved (×3 locales). `ConfirmationDialog` rendered an empty scroll box for `children={false}` → `Children.toArray().length > 0`. Decision table: no-permission rows used `aria-disabled` + `opacity-50` (a focusable, half-visible control) → native `disabled` for `!canDecide`; `aria-disabled` + `aria-describedby` only for `contact_removed`; e2e assertion → `toBeDisabled()`. In-dialog `role="alert"` mounted WITH its text → always-mounted region + `scrollIntoView`. Queue: `EmptyState` stacked under a deep-link notice → suppressed. Rate limit: the bucket counted ATTEMPTS while FR-008 counts created requests → `peek` before the use case, `check` only on `submitted`. TH `rateLimited` politeness aligned. |

### Objections to round-1 deferrals

None sustained. Tax M7 (billing-less member case) is closed by the new unit case instead of
waiting for PR-2. Everything else in the deferred table above keeps its owner; two operator gates
were added to `quickstart.md § 3` (`TENANT_PRIVACY_POLICY_URL`, the palette entry) and the
idempotency 24 h note sits under the T078 row.

### Verification (this round)

`pnpm typecheck` · `eslint` on the 35 touched files · `check:i18n` (5416 keys × 3) ·
`check:layout` / `api-route-guard` / `staff-page-guard` / `actor-role-truth` / `audit-events` /
`fixme` / `dates` · unit + contract suites for change-requests, timeline, the dialog, nav parity ·
live-Neon: `change-requests-{repo,submit-atomicity,staff-email-dispatch(+recipient_gone),concurrency,tenant-isolation}`,
`timeline{,-multisource}`, `f3-timeline-integration` (`timeline-perf` skips without its perf env).
e2e still unrun (no dev server).

## Round 3 — whole-branch seam pass (`whole-branch-reviewer`, fable) on `cf1495550..23be93038`, 2026-09-11

The last pass that sees every commit at once. Baseline correction first: `git merge-base
origin/main HEAD` is `cf1495550`, not `d6c5028aa` — the eight spec / chore commits before the
foundation commit are NOT on `main` and merge with this PR (161 files, +18690/−494). No BLOCKER.
Verdict **With fixes**: the "dark" claim was false on the flip-then-unflip path, and the rollback
matrix omitted three unflagged behaviour changes the review rounds themselves introduced.

| # | Sev | Finding | Verified | Outcome |
|---|---|---|---|---|
| 1 | MEDIUM | kill-switch did not contain the two F114 outbox arms: rows queued while the flag was ON kept dispatching member PII to staff after the operator flipped it OFF (F4 has the R7-B4 query-time filter; F114 had zero flag reads in the dispatcher) | grep `memberChangeApproval` in `outbox-dispatch/route.ts` = 0 → RED integration case (flag OFF → row `sent`) | **fixed** — `baseReadyFilters` excludes both types while `!env.features.memberChangeApproval`; rows stay `pending`, attempts 0, and drain when the flag returns; integration case `platform flag OFF …` in `change-requests-staff-email-dispatch.test.ts` (both dispatch suites now pin the flag via an `env` mock — `.env.local` does not carry it) |
| 2 | MEDIUM | unflagged + undisclosed: the DSAR audit subset matches `related_member_id` for every member on merge (also closes the pre-existing `auto_email_skipped_no_recipient` / marketing gap) | ledger row 15 + `quickstart.md` matrix | **disclosed** — matrix "Unflagged and live on merge" re-derived from the final tree (bullets, incl. a DPO note) |
| 3 | MEDIUM | two more unflagged hunks: (a) `ConfirmationDialog` body wrapper on 9 existing dialogs; (b) `member_self_update_forbidden` payload/summary shape on the flag-OFF path, contradicting the "byte-identical (SC-011)" docblocks | diff count = 9; `member-self-update.ts:16,108` | **disclosed + reworded** — both in the matrix; the docblocks now say the WRITE path is byte-identical and name the audit-sink change; the bounded keys are kept in both modes on purpose (privacy M-7 protects the append-only table regardless of gate) |
| 4 | MEDIUM (dark) | `request_superseded` was a `permanently_failed` + `email_dispatch_failed` audit + `outbox_permanent_failures_total` increment — an on-call page (`observability.md` alarm `rate > 0` / 5 min) for a member fixing a typo, until US5 coalescing (PR-2) | read; reachable only with the flag ON | **fixed** — silent skip: terminal status + `last_error` kept for the operator, NO audit (the replacement is already `member_change_request_withdrawn{replaced}`), its own `outbox_superseded_total{notification_type}` counter (watch only, not alerted); `request_superseded` removed from the `permanentFailure` union; integration case asserts no `email_dispatch_failed` row |
| 5 | MEDIUM | docs written in `ddb37903b` never re-derived after rounds 1–2: the matrix; `observability.md` reason set; `metrics.ts` "§ 14" pointer | grep | **fixed** — matrix re-derived; `outbox_permanent_failures_total` reason set lists `attachment_sha_mismatch`, `request_gone`, `recipient_gone`; `outbox_superseded_total` row added; the pointer names § 14.1 |
| 6 | LOW | `pendingCount` / `oldestAgeSeconds` docblock claimed a gauges tick that has no caller | grep = 0 in `src/` | **fixed** — docblock says "NO caller yet: Phase 8 (T102, pre-flip gate)" |
| 7 | LOW | the staff schemas accept `''` / untrimmed text for description, role_title and address lines while the form sends `nullable(trim())`; a record holding `''` produced a spurious "(empty) → (empty)" row on every submit | logic read; prod values unmeasured | **fixed** — `normaliseText` applied to BOTH sides of the diff (`seenFor`, `proposedFor`, `normaliseAddress`): trim, `''` → null; three unit cases in `domain-policies.test.ts` (RED first) |
| 8 | LOW | the profile page and the gate GET read the pending row with the `FOR UPDATE` finder (tail latency against a concurrent decide; no correctness issue) | read | **deferred** — already Rel M-5 in the round-1 table: a non-locking `findPendingBySubmitter` in PR-2 |
| 9 | LOW | 0300 edited in place: if the first version was journaled on the shared `dev` branch, dev ≠ prod | ASSUMED by the reviewer | **refuted** — `pnpm db:verify` against dev: "13 canaries present", incl. `member_change_requests UNIQUE (tenant_id, id) + composite child FKs (mig 0300)` (dev was converged by ALTER in round 1) |
| 10 | LOW | `listVisibleToUser` (dead in PR-1 — the US4 history route) returns a `mixed` row's contact-target VALUES to a non-submitter; FR-029 | read; no caller in `src/app` | **deferred to PR-2 (US4)** — strip contact-target fields from `mixed` rows for non-submitters in the history serialiser; noted on T072 |
| 11 | LOW | branch scope: the eight pre-foundation commits (`.claude/workflows/spec-review-panel.js`, `.gitattributes`, `.specify/.gitignore`, the spec artefacts) ride along | `git merge-base` | **disclosed** in the PR body |

Refuted by the reviewer (kept here so the next pass does not re-open them): no `err()` after a
write inside `runInTenant`; lock order submit (pending → member) / decide (request → member →
contacts) consistent; no nested `runInTenant` under a lock; RLS `ENABLE + FORCE` on both tables and
every `*InTx` threads `tx`; round-2 contract consumers all updated (5 `timelineList` call sites,
`reviewerUserId` ×2 + fallback, `not_owner`, widened `permanentFailure` union, conflict retry ×2);
audit truth (`check:actor-role-truth` green; `member_id` on submit / forged, `related_member_id`
on decide / replaced, `member_timeline_v` COALESCEs both); the 5-places rule for the seven enum
values; three-way field rules (submit superRefine / decide re-validate / DB CHECK); every new route
404s before session work and both admin pages `notFound()` before the permission gate;
`patchesOf` is fail-closed (`void _exhaustive`); `reason-confirmation-dialog` move byte-identical.

## Round 4 — the e2e run (dev server, flag ON), 2026-09-11

`tests/e2e/change-requests.spec.ts`, `--workers=1`, chromium + mobile-safari: **8 passed, 1
skipped** (the secondary-contact case has no persona yet — research § V4). What the run found:

| # | Kind | Finding | Outcome |
|---|---|---|---|
| 1 | product (a11y) | Base UI's `Checkbox` renders `disabled` as `data-disabled` + `tabindex=-1` on a `<span role="checkbox">` — NO `aria-disabled` — so round 2's switch from `aria-disabled` to native `disabled` for a manager's read-only row left assistive tech reading it as toggleable (`toBeDisabled` saw "enabled") | fixed — both cannot-toggle cases carry `aria-disabled`; only the permission case leaves the tab order |
| 2 | fixture | `skipUnlessFlagOn` probed the MEMBER gate route after a STAFF sign-in (US2 / US3) and read the 403 as a failure | 401 / 403 now prove "flag on"; the tenant-mode check applies to the member's 200 only |
| 3 | fixture | `page.request.post(…/decide)` sent no `Origin`; the proxy's CSRF allow-list answers `missing-origin` → 403 | `headers: { Origin }` as the other specs do |
| 4 | fixture | `getByLabel('Company name', { exact: true })` — a required field's label carries the aria-hidden `RequiredMark` | non-exact match for required fields |
| 5 | fixture | the Dismiss click landed before hydration (dev mode) and no-oped | `toPass` retry around an idempotent click (the `admin-pending-reactivation` precedent) |
| 6 | fixture | the dialog-focus assertion expected Cancel; round 1 moved initial focus to the REQUIRED reason when a rejection is present | assertion follows the round-1 design |
| 7 | environment | the shared `dev` branch held **3,774 ACTIVE admin users leaked by `createActiveTestUser`** (`deleteTestUser` is a bare `db.delete(users)` whose FK failures are swallowed by `.catch(() => {})` at 116 call sites); every submit fanned one outbox row out to each — a ~3 min transaction holding the member row lock, so the browser timed out | operator-approved cleanup: those users are now `status = 'disabled'` (ids kept for reversal); the leak's root cause (the helper) is a repo-wide chore, not F114 — see the PR body |

The fan-out itself is O(reviewers) inside ONE transaction; fine for SweCham's staff count, and
US5's coalescing (T087, PR-2) is the owner of any bound.

## Round 5 — `/pr-review-toolkit:review-pr` on PR #360 (five read-only reviewers, Opus), 2026-09-11

code-reviewer · pr-test-analyzer · silent-failure-hunter · comment-analyzer · type-design-analyzer,
each briefed with rounds 1–4 so nothing already closed was re-raised. No Critical logic defect;
the blockers were silent failures and comment rot. Every claim below was verified against the
code before it was fixed (108 rule 2).

### Fixed in this round

| # | Lens | Finding | Fix |
|---|---|---|---|
| 1 | silent-failure #1 | `/portal/edit` read a pending-request FAULT as "no pending request", prefilled from the live record, and the member's next submit REPLACED their proposal (staff row closed as `request_superseded`, silently) | `readOwnPendingRequest` (`src/lib/portal-own-pending.ts`, unit-tested): a fault → the page's load error, never null |
| 2 | silent-failure #3 | a decision whose member email was skipped (contact gone / unlinked) left only an `info` line | the decided audit event carries `member_notified` + `member_notification_skipped: 'recipient_gone'` (DSAR-visible); `members_change_request_decision_email_skipped_total{tenant,reason}` |
| 3 | silent-failure #4 | a 2xx whose body is not one of the three outcomes was announced as "nothing to submit" | only `outcome === 'nothing_to_submit'` says so; anything else on a 2xx is the generic error (unit case, real fetch stub) |
| 4 | silent-failure #2 | the dispatcher's two new `catch {}` blocks discarded the error; every fault reached the operator as `no_template_handler` | both log `err: errKind(e)` under `cron.outbox_dispatch.change_request.{roster,prefix}_read_failed` (the file's own R-3 rule) |
| 5 | silent-failure #5 | zero reviewers → 201, no email, no signal (the T102 gauges have no caller) | `members_change_request_no_reviewers_total{tenant}` (alert: any non-zero rate); unit-pinned |
| 6 | silent-failure #6 · tests I-3 | three hand-copied viewer-contact resolvers, all fail-closed to null with no log (the viewer lost their OWN rows too); one had no try/catch | ONE `resolveOwnContactId` (`src/lib/portal-own-contact.ts`) used by the route, the page and the dashboard section; logs on both fault arms; 4 unit cases |
| 7 | silent-failure #8 | the decide route answered a committed decision with a FABRICATED member (`companyName: ''`, `memberNumber: 0`, `archived: false`) when the view re-read failed; the 409 arm dropped its repo error | 200 with the bare request + `viewUnavailable: true` (contract case); the 409 arm logs `already_decided_read_failed` |
| 8 | silent-failure #9 / #10 / #11 | `tx_aborted` logs carried only `re.code` (= `repo.unexpected`); the gate route built a `cause` and logged the wrapper; the conflict re-read's Result-err arm was unlogged (round 2 said it was) | `cause: errKind(…)` on all four; the Result arm logs `conflict_reread_failed` (unit case) |
| 9 | code #1 | the portal diff table labelled `seen` (the value AT SUBMISSION) "Current" in three locales — staff who edit the record after the submit make the member's "current" a lie | `portal.changeRequests.diff.seen` ("Value when you submitted" / "ค่าตอนที่คุณส่ง" / "Värde när du skickade in"); `current` stays the staff table's live value |
| 10 | types F1 | `FIELD_ORDER` hand-copied as `string[]` (a tenth key sorts to −1) | `= PROPOSABLE_FIELD_KEYS` |
| 11 | types F5 | `{ decisions: [] }` reached the use case (stopped only by coverage) | `.min(1)` on the body schema (contract case) |
| 12 | tests I-1 / I-2 / I-4 / I-5 / I-6 | round-2/3 fixes that survived a revert: `boundForbiddenKeys` (0 tests), `refusal: 'forged'` unasserted, "sent to the CURRENT address" (both arms), the member-arm kill-switch, the nav dark-ship entry | pinned: 25-key forged body → 20 keys / 64 chars / truncated; forged-under-approval; reviewer + contact address change between enqueue and send (live Neon); flag-OFF on `member_change_request_decided_member`; `/admin/change-requests` hidden while the flag is absent |
| 13 | comments C1–C3, I1–I15, S1–S10 | prose written before rounds 1–3 and never re-derived: the flag-reader inventory ("one place" → twelve), the decide docblock's "proxy 503", the matrix's dialog count (3, not 9) and summary-prefix claim, "Order of checks" missing two arms, `viewerContactId` "omit", the tax context "at submission", the Drizzle docblock, coalescing in the present tense ×3, the missing `/admin/settings/member-changes` surface, `db:verify` "7 enum values", `contracts/notifications-and-audit.md` (`reason` → `withdrawn_reason`, `contact_id`/`scope`, users locale, 0300 → 0301), `replaced_by_request_id` missing from two payload contracts, the peek-then-consume rationale, the superseded semantics, line/count rot | all rewritten to what the code does |

### Round 6 — the Suggestions, closed (the maintainer asked for all of them)

| Finding | Closure |
|---|---|
| code #2 — the review compared a RAW live value with the normalised `seen` (a `'CEO '` record read "changed since submitted") | `groupBRecordOf` reads the record through `normaliseText` (trim, `''` → null) — the same rule both sides of the diff apply; unit case |
| code #3 — the remembered `Idempotency-Key` response carried proposed values for 24 h in Redis, outside the FR-030 scrub | the remembered body is ids + outcome only (`rememberableBody`); a replay answers the reduced body (the client reads `outcome` only); contract case asserts no value in it |
| code #4 · types F11 · tests I-7 · tests Q-2 — `rate_limited` had no metric, a dead use-case arm, a dead route handler and a dead contract case | the route's 429 emits `refused{rate_limited}`; the arm, the handler and the test are gone (T087 adds the use-case arm with its audit event) |
| code #5 — "nothing differs" answered `nothing_to_submit` while a proposal was pending | answered inside the tx after the pending read: `already_pending` with the pending request (withdrawing is US5); unit cases both ways |
| silent-failure #7 — the account page's Result-err arm hid the language form silently | the arm logs `portal.account.contact_language_read_failed` like its catch twin |
| silent-failure #12 / #13 — bare client catches; one toast for four statuses; a radio that disagreed with the record after a failed save | `console.error` on both catches; the language form reverts to the last SAVED value and names 503 / 429 (`readOnlyToast` / `rateLimitedToast` ×3 locales) |
| silent-failure #14 / #15 — an unparseable 200 after a COMMITTED decision reached `queueMicrotask(throw)`; `outcome ?? 'approved'` vs `?? 'rejected'` | the success path parses with `.catch(() => null)` and toasts the neutral `toast.recorded` (×3 locales) when the outcome is unknown; the banner renders nothing for a null outcome instead of guessing |
| silent-failure #16 · types F2 — `overlayFields` had no exhaustiveness arm | `default: never` — a tenth key fails the build |
| silent-failure #17 — three reads collapsed to a silent 404 | a missing member / erasure row is logged (`change-request.review.member_missing`) before the deliberate 404 |
| silent-failure #18 — `taxHintFor` `default: return null` | the four never-tax-affecting keys are explicit; `default: never` |
| silent-failure #19 — a change-request row with an ABSENT / unknown `scope` passed the projection unstripped | fail closed: only `company` is everyone's, `mixed` is stripped, anything else is dropped for anyone but its own contact; unit case |
| silent-failure #20 — `request_gone` for a missing member / submitting contact | the `PayloadMiss` docblock states the semantics (request, member or submitting contact gone); the decided arm now closes a NON-decided request as `request_superseded`, not "gone" |
| silent-failure #21 — `as unknown as Contact` stand-ins | `removedContactStandIn`: a FULL `Contact` (removed, unlinked, non-primary, empty text, no opt-out) shared by decide + review |
| silent-failure #22 — `validation_error` with empty `issues` | the two re-validation refusals name the field (`contact.phone`, `company.billing_address.country`) |
| types F3 — `key` / `target` independent | the repo DERIVES `target` from the key (`PROPOSABLE_FIELD_TARGET`); the stored column is query convenience |
| types F4 — audit payload contracts were comments | `ChangeRequestAuditPayload` type map; the three emit sites write `payload: { … } satisfies …` — the `member_id` / `related_member_id` split and `withdrawn_reason` are compiler-checked |
| types F6 — the state machine lived only in the DB | `DecidedChangeRequest` / `WithdrawnChangeRequest` + `isDecided` / `isWithdrawn`; `changeRequestInvariantViolation` PARSES every row at the DB → Domain seam (a contradicting row → `repo.unexpected`); the three consumers that re-derived the invariant (decide's `already_decided`, the metric, the dispatcher's decided arm) narrow instead. The full discriminated union was NOT adopted on purpose: every fixture and serialiser would have to build one variant at a time, for no invariant the seam parse does not already enforce |
| types F7 — `decideInTx` ignored the affected row count | each field UPDATE asserts exactly one row, else the tx rolls back |
| types F8 — `jsonb` cast on read | `parseProposedValue`: a string, null or an address of string / null lines, else a corrupt row |
| types F9 — `as RepoError` at three catch sites | `isRepoError` (checked narrowing) at all three |
| types F10 — `member.status: string` | `Member['status']` on both view types |
| tests Q-1 / Q-4 / Q-5 / I-8 / I-9 | test title honest about the fake; the lock-race loser's 409 filled from the recorded row (FR-018); keyset paging on EQUAL `submitted_at` (live Neon); the lock-then-erasure order pinned; `contacts: []` both ways |
| comments I6 / I11 | the eight `membersMetrics` rows (the two gauges marked "no emitter until T102") + the FR-037 alert rows in `observability.md`; a 0301 enum canary in `verify-schema` (13 canaries) |

Not closed, and why: types F6's full discriminated union (above) — the seam parse + the guards give the same guarantee without the fixture churn.

## Round 7 — the second toolkit pass re-reviews the FIXES (`8c1c09c6d..48b9abb68`), 2026-09-12

The same five read-only lenses (Opus) applied 108 rule 1 to rounds 5–6. Verdicts: every code closure held; the round-5/6 PROSE lagged the code, and the fixes had opened a handful of seams. No Critical logic defect; one red assertion (the second `AUDIT_EVENT_TYPES` pin) was already fixed in the tree before this round. Everything below is closed in this round's commit.

### Closed (tests first — RED, then the code)

| Finding | Closure |
|---|---|
| silent-failure N1 — `listReviewers()` throws out of the submit route (no Result) | `try/catch` before the tx → `server_error` + `change-request.submit.roster_read_failed`; the no-reviewers warn + metric now fire only when a request was CREATED (a no-op submit no longer pages) |
| silent-failure R1 — the dispatcher's decided arm closed a NON-decided request as `request_superseded` (silent) | unreachable by construction (the row is enqueued inside the decide tx) so it stays LOUD: new `PayloadMiss` `request_not_decided` → permanent + `email_dispatch_failed` audit + `outbox_permanent_failures_total{reason}`; the `PayloadMiss` docblock is now per arm |
| silent-failure R3 — a corrupt row surfaced as a bare `repo.unexpected` | `ChangeRequestRowError` (named for `errKind`) + `logger.error` at every throw with the ids (never a value) |
| silent-failure / types #3 — `resolveOwnContactId` answered `null` on a FAULT, so the timeline dropped the viewer's own rows silently | `Result<string \| null, {code}>`: the API route answers 500 + `portal.timeline.own_contact_read_failed`, the page throws to its boundary, the dashboard preview renders the B2 "unavailable" card; `ok(null)` is still "not linked" |
| silent-failure — the edit page's resubmit read had an unlogged Result-err arm | logged (`M114.portal.edit.resubmit_read_failed`); the member still gets the live form |
| silent-failure — two bare client catches; a dead 429 branch in the language form | `console.error` on both; the 429 branch + `rateLimitedToast` ×3 removed (the profile route has no rate limit) |
| types #2 — the seam parse checked state columns only | `changeRequestInvariantViolation` also checks every field row: decided ⇒ each has an outcome, pending ⇒ none does, `appliedAt` ⇔ approved; `decideInTx` asserts no undecided row remains |
| types F7 residual — `decideInTx` coverage | the loaded rows are re-checked after the UPDATEs (above) |
| types F9 residual — `isRepoError` accepted a `repo.conflict` without `reason` | `reason` must be a string |
| types S6 — `already_decided` carried three nullable fields for one fact | `decided: { byUserId, at, outcome } \| null` (null = the lock-race loser; the route fills it from the recorded row) |
| types S5 — `rememberableBody` was built by subtraction | built by construction (`RememberableBody`, listed keys + `replay: true`); the contract documents the reduced replay |
| types #4 / comments F18 — the removed-contact stand-in forged an `Email` | `groupBRecordOf` takes `GroupBContactRecord` (four columns) and the stand-in is exactly that |
| types N3 — three `as FieldOutcome` casts after the coverage check | one checked `outcomeOf` lookup |
| types — `fields[].outcome` typed `\| undefined`; the withdrawn payload allowed NEITHER member key | tightened; two-variant union (`member_id` xor `related_member_id`) — the #336/#337 class is now a compile error; docblock says what the compiler checks and what it does not |
| types — `isDecided` imported from Domain by the dispatcher | exported from the barrel; the dispatcher imports `@/modules/members` |
| types — `ListByMember.memberId: MemberId \| string` | `MemberId`; the dashboard section passes `asMemberId` |
| comments F17 — "a contradicting row is a corrupt row" with no enforcement | an unknown `field_key` throws (`isProposableFieldKey`); the target is derived, the stored column is convenience only; `parseProposedValue` also rejects an unknown address line |
| comments F15 / code R1 — "already awaiting review" shown when the member typed the RECORD back while a different proposal is pending | `already_pending` carries `unchanged: boolean`; the form shows `alreadyPendingUnchanged` (×3 locales) |
| comments F14 — the submit docblock's step 5 contradicted round 6 | rewritten; the two contract sentences too |
| code N — `normaliseText` duplicated in decide; `_serialise.ts` re-export | the Domain export; the route imports `@/lib/change-request-portal-view` |
| tests — `completeness.test.ts` pinned 37 | 42 (the second of the "2 test counts"); atomicity asserts `members.last_activity_at` bumped; decide cases: whitespace-only reason no write, country `ZZ` names `company.billing_address.country`, the tx-abort cause; the toast / banner / language-form component tests |
| comments F1–F6, F8–F13, F16, F18 — quickstart (0300 AND 0301; the 13 canaries; two staff emails in PR-1; the fifth fixture; the SQL flip until PR-3; the count by SQL not the unemitted gauge), the three contracts (reduced replay; `already_pending` + `unchanged`; 429 metric-only; `staffNotified` semantics; coalescing = T087; platform-default locale; `actor_role`; underscored metric names + `not_owner` + the two new counters; the errorId sentence), `policies.ts` headline, the Drizzle docblock (8 named + 10 anonymous CHECKs; `db:verify` reads SQL not this file), `env.ts` reader list, the route's 429 sentence, the guard's PR-1 withdraw note, 0300's NO ACTION timing, the dispatcher's superseded comment, the metrics docblocks (underscored; T102 adds the emitter only), the alert tables (one High table incl. the > 14 d page; one Medium table with the > 7 d warning), this ledger's counts | all rewritten to match the code |

### Verification (this round)

`pnpm typecheck` · full `pnpm lint` · `check:i18n` · unit + contract (`tests/unit/members`, `tests/unit/portal`, `tests/unit/lib`, `tests/contract/{members,portal}`: 284 files green) · integration on live Neon dev: `change-requests-{repo,submit-atomicity,concurrency,decide-rollback,member-email-dispatch,staff-email-dispatch}`, `audit/completeness`, `outbox-permanent-failure-metrics` (8 files, 74 tests green).

Checklist checkboxes in `checklists/{security,privacy,tax}.md` remain reviewer-owned and are
ticked only at `/speckit.review` (T112); each reviewer's per-CHK evidence is in its round-1
report (see the co-sign footer template in `README.md`).
