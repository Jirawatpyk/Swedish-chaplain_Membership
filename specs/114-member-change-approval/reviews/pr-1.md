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

Checklist checkboxes in `checklists/{security,privacy,tax}.md` remain reviewer-owned and are
ticked only at `/speckit.review` (T112); each reviewer's per-CHK evidence is in its round-1
report (see the co-sign footer template in `README.md`).
