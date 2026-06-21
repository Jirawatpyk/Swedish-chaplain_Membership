# F7 Broadcast Send Hardening — Design

**Date**: 2026-06-21
**Status**: Approved (brainstorming, revised after specialist review) — pending implementation plan
**Author**: go-live verification follow-up
**Reviewers consulted**: chamber-os-architect, chamber-os-qa-engineer, reliability-guardian (spec-level, 2026-06-21)

## 1. Context & Problem

F7 (Email Broadcast / E-Blast) is recorded as **SHIPPED (PR #23)**, but a go-live
verification sweep on 2026-06-21 drove the full member→admin send flow against the
**real Resend Broadcasts API** for the first time and found that **the broadcast
send path has never actually worked**. Five distinct defects were uncovered, each
revealed only after fixing the previous one:

| # | Defect | Type | Observed failure (runtime) |
|---|--------|------|----------------------------|
| 1 | `RESEND_BROADCASTS_API_KEY` (and the transactional key, and the prod key) restricted to "send emails only" — cannot use the Broadcasts/Audiences API | config / account | `401 restricted_api_key` on `GET /audiences` |
| 2 | Resend broadcast `name` exceeds Resend's 70-code-point limit | **code** | `Field 'name' has a maximum of 70 items` |
| 3 | The `from` field double-wraps when `BROADCASTS_FROM_EMAIL` is `Name <email>` | **code** | `Invalid 'from' field … Received '… <SweCham <noreply@zyncdata.app>>'` |
| 4 | `failed_to_dispatch` holds the member's quota slot **permanently** (terminal state, no re-trigger route) | **code / spec gap** | `broadcast_quota_blocked` (reserved=1) after a failed dispatch |
| 5 | A new Resend audience is created per broadcast and never cleaned up → hits the account's audience/segment **count** plan limit | **design** | `Your plan includes 3 segments. Upgrade to add more.` |

**Root cause of the silence**: the send-path unit tests mock the Resend client with a
lenient fake that does **not** enforce Resend's API contract (name length, `from`
format, audience-count limit). Every contract violation passed CI. The send was never
exercised end-to-end against real Resend.

### Why each defect matters for go-live
- #2 and #3 make **every** TSCC E-Blast fail (the from-name `{member} via {tenant full
  name}` is long; the configured `BROADCASTS_FROM_EMAIL` is the wrapped form).
- #4 means a member who hits any dispatch failure loses their annual E-Blast benefit
  with no recovery (`failed_to_dispatch` is terminal — confirmed
  `broadcast-status-transitions.ts:47` `failed_to_dispatch: []` — with no re-trigger
  route anywhere).
- #5 means even with all code fixed, sending stops once the tenant accumulates more
  Resend audiences than its plan allows.

## 2. Goals, Success Criteria, Non-Goals

**Goal**: Make F7 broadcast send work end-to-end against real Resend, and add tests
that fail loudly if any of the five defects regress.

**Success criteria**
1. member compose → submit; admin approve; dispatch → **`resend_broadcast_id` set and
   status → `sent`** (Resend accepts + sends).
2. A **contract-faithful** Resend SDK fake makes the gateway tests go RED if defect #2,
   #3, or #5 returns; the quota unit test is inverted so #4 cannot silently pass.
3. A `failed_to_dispatch` broadcast does **not** hold the member's quota slot.
4. A gated real-Resend staging smoke (with a long from-name + wrapped from-email
   fixture, so it also exercises #2/#3) passes before ship.

**Non-goals**
- Redesigning the compose/review/quota **UI** (it works).
- **The F7.1a batch path (`dispatch-broadcast-batch.ts`) is NOT fixed for #5** — it
  creates one audience **per batch** (a second audience-growth source), but it is dark
  behind the 10k split-threshold (SweCham's 131 members never trigger it). Fixes #2/#3
  (name/from) ARE applied there since the identical bug exists; the per-batch audience
  growth (#5) is explicitly deferred. Spec must not imply #5 is fixed system-wide.
- Changing the Resend Broadcasts choice itself (kept for unsubscribe management,
  analytics, separate reputation pool).

## 3. Design Decisions (approved, revised after review)

### D1 — Quota on permanent dispatch failure → **release the slot**
`countForMemberQuota` will count only `submitted` + `approved` as "reserved"; a
`failed_to_dispatch` broadcast no longer holds the slot. `failed_to_dispatch` is
terminal with no re-trigger edge, so holding = permanent lockout; releasing is the
correct member-facing behavior. The failed broadcast's content/recipients are not
recovered — the member re-composes.

**spec.md is internally contradictory and must be reconciled.** `spec.md` **AS2**
(line 324) says the reservation "remains held (NOT released — admin can manually
re-trigger)", but **FR-003** (line 369) already says reserved =
`COUNT(status IN ('submitted','approved'))` and MUST be released on
`failed_to_dispatch`. D1 adopts FR-003. The current repo SQL
(`drizzle-broadcasts-repo.ts:810`) was a deliberate "Verify-fix R3" that **added**
`failed_to_dispatch` to satisfy AS2. Reversing it requires (see Fix 4) editing the SQL,
**inverting the pinned unit test that encodes the old contract**, fixing the
"Do-NOT-release" comments, and amending AS2 with a Complexity-Tracking note — not a
one-line change.

Confirmed no side effects: `failed_to_dispatch` is terminal (no double-spend), and the
`broadcasts_quota_year_only_on_sent` CHECK ties `quota_year_consumed` to `sent`/
`partial_delivery_accepted` only — D1 changes a read-side count, not that column, so no
constraint conflict. No audit gap (the `failed_to_dispatch` status is already audited
when it occurs; the release is a derived read).

### D2 — Resend audience → **ephemeral audience per send + delete-after-terminal**
*(revised from the original single-reusable choice — see "Why not single reusable")*

Keep the existing **per-broadcast** `resend_audience_id`. Per send: create a fresh
audience, add the broadcast's recipients, create + send the broadcast. After the
broadcast reaches a **terminal** state and a **grace window** has elapsed (webhooks
settled), a **cleanup cron** deletes the Resend audience and marks it removed. This
bounds the tenant's live audience count without sharing a mutable audience across
sends.

**Why not single reusable (the originally-chosen option):** all three reviewers
flagged it as unsafe:
- Resend's `addContactsToAudience` is **append-only** (no replace/clear-all primitive;
  only `removeContactFromAudience` per email), and `sendBroadcast` is **async** (the
  recipients materialize after the call returns). A per-tenant lock released after the
  send call returns does not cover the async window → a concurrent broadcast B clears+
  re-fills the shared audience while A's send is still materializing → **A sends to B's
  recipients: a cross-member PII leak + wrong delivery.**
- `resend_audience_id` is consumed **per broadcast** by the shipped **COMP-1 US3-C**
  GDPR sub-processor erasure cascade (`subprocessor-erasure-adapter.ts` +
  `listMemberResendAudienceContactsInTx`, `drizzle-broadcasts-repo.ts:1326`), which
  removes an erased member from each broadcast's audience. A single shared audience
  collapses that to a no-op.

Ephemeral-per-send fixes #5 equally (count stays bounded via cleanup), eliminates the
shared-mutable-audience race entirely, keeps per-broadcast ids (COMP-1-compatible), and
needs **no new audience-id storage** (so no new RLS surface).

### D3 — Regression protection → **contract-faithful SDK fake (CI) + gated real-Resend smoke (staging)**
Two-layer, to avoid the lenient-mock trap that hid all five defects:
- A **contract-faithful fake of the Resend SDK client** (`getResendBroadcastsClient`,
  following the existing `tests/unit/broadcasts/infrastructure/resend-remove-contact.test.ts`
  seam) drives the **real gateway**. It enforces: broadcast `name` ≤ 70 code points,
  `from` must be `email` or `Name <email>` with no nested `<>`, and the audience
  **account-count** limit (throws the `'N segments'`-shaped error on the (limit+1)th
  `audiences.create`). The gateway-contract assertions run against the real gateway so
  the `from`-composition line actually executes.
- The existing **`BroadcastsGatewayPort`-level fake** stays for the dispatch
  **error-mapping** suite (it injects `{kind:'retryable'|'permanent'|…}` and must not
  re-test the wire contract). We do **not** "replace the lenient mock everywhere" — that
  would break ~20 sibling error-mapping tests; we add the strict SDK fake only at the
  gateway-contract seam.
- A **gated real-Resend staging smoke** (`describe.skipIf` reachability/key probe,
  mirroring `tests/integration/broadcasts/image-virus-scan-flow.test.ts`) drives
  compose→approve→dispatch with a **deliberately long from-name + wrapped
  `BROADCASTS_FROM_EMAIL`**, asserting `resend_broadcast_id` set + `delivered@resend.dev`
  receives. The smoke proves liveness; the contract-fake owns regression protection.

### D4 — Interaction with COMP-1 US3-C member erasure (explicit)
Ephemeral-per-send **keeps** per-broadcast `resend_audience_id`, so the erasure cascade
keeps working while a broadcast's audience is live. After the cleanup cron deletes an
audience, a later erasure request for a recipient of that broadcast must treat
`removeContactFromAudience` returning 404 (audience/contact already gone) as a
**successful no-op** — the data is already erased at the sub-processor. The cleanup grace
window and this 404-as-success handling are in scope for the audience PR. This section
exists because the original single-audience design would have silently broken the
erasure proof (the same class of bug COMP-1 itself once had).

## 4. The Five Fixes

### Fix 1 — Resend key permission (config, already applied)
Ship-checklist item: `RESEND_BROADCASTS_API_KEY` must have **Full access** (Broadcasts +
Audiences), not "Sending access"; verify in dev, staging, prod (`.env.production` /
Vercel). No code change.

### Fix 2 — Broadcast name ≤ 70 (code, PR-1)
**Extract the existing inline Unicode-safe truncation** at
`dispatch-scheduled-broadcast.ts:574` into a pure helper
`resendDashboardName(fromName, subject)` that builds `` `${fromName} — ${subject}` `` and
caps the **whole result** to ≤ 70 code points (spread-based, preserving the existing
60-cp subject slice; define the precedence explicitly — fromName kept, trailing subject
truncated). Use it in both `dispatch-scheduled-broadcast.ts` and
`dispatch-broadcast-batch.ts`. Unit test (100% line+branch — pure fn): long fromName
alone → ≤70; code-point (not UTF-16) measurement; trailing surrogate pair not split;
precedence when both long.

### Fix 3 — `from` bare-email extraction (code, PR-1)
In the gateway, extract the bare address from `input.fromEmail` (may be `Name <email>`
or bare) **reusing the existing parser at `env.ts:332`** (`/<([^>]+)>\s*$/`) before
composing `` `${fromName} <${bare}>` ``. Unit test (100% line+branch): `Name <email>` →
bare; bare → bare; composed `from` never nests `<>`. Tested **against the real gateway**
via the SDK fake (not a port-level fake, which never runs this line).

### Fix 4 — Quota release on failed_to_dispatch (code, PR-1) — **four edits**
1. `countForMemberQuota` (`drizzle-broadcasts-repo.ts:810`): drop `failed_to_dispatch`
   from the reserved `IN (...)` set.
2. **Invert the pinned unit test** `tests/unit/broadcasts/application/compute-quota-counter.test.ts:180`
   ("R3 Tests-Gap#1: failed_to_dispatch holds the reservation") — it hand-mocks the repo
   and will NOT auto-fail on the SQL change; it must be rewritten to assert `reserved:0`.
3. Fix the misleading "Do-NOT-release" comments: the repo comment block
   (`drizzle-broadcasts-repo.ts:785-810`) **and** the VO docstring
   (`quota-counter.ts:17-29`).
4. Amend `spec.md` AS2 (line 324) to match FR-003 + add a Complexity-Tracking /
   "AS2 superseded by D1" note.

Plus integration tests (live Neon): (a) a member with a `failed_to_dispatch` broadcast
has `reserved=0` and can submit again; (b) **the producing transition** — drive a
dispatch to `failed_to_dispatch` via a permanent gateway error, then assert
`computeQuotaCounter` returns `reserved:0` (extend `dispatch-failure-notification.test.ts`).

### Fix 5 — Ephemeral audience + cleanup cron (code, PR-2)
- Per send: create audience → add recipients → create + send broadcast (largely the
  existing per-broadcast flow; keep `resend_audience_id` on the broadcast).
- Add a **cleanup cron** that finds terminal broadcasts whose `resend_audience_id` is
  set and whose terminal timestamp is past a grace window, deletes the Resend audience,
  and marks it removed. Bounds the live audience count (fixes #5).
- D4 erasure-compat: handle `removeContactFromAudience` 404 as success.
- Audience-limit error classification: decide permanent vs retryable-after-cleanup (with
  the cleanup cron keeping the count bounded, a transient overflow is plausibly
  retryable); the contract-fake tests this path.
- **Cross-member concurrent-send integration test** (Review-gate blocker for PR-2):
  two concurrent sends for the same tenant deliver to their own recipients only (proves
  no cross-member leak — the failure mode the single-audience design had).
- Idempotency: per-broadcast audience create already has orphan-prevention (reuse
  `broadcast.resendAudienceId`, persist immediately); preserve it.

## 5. Testing

- **Unit** (100% line+branch): `resendDashboardName` (Fix 2), bare-email extractor (Fix 3).
- **Contract** (SDK fake → real gateway): name ≤70, `from` no-nested-`<>`, audience
  account-count limit. Plus the inverted quota unit test (Fix 4.2).
- **Integration** (live Neon): quota release at both the count and the producing
  transition (Fix 4); the cross-member concurrent-send test + audience cleanup (PR-2).
- **Smoke** (gated, real Resend, staging): liveness + #2/#3 exercise via the long-name /
  wrapped-from fixture; `describe.skipIf` reachability gate per the ClamAV pattern.
- **Coverage**: the gateway is excluded from coverage (`vitest.config.ts:77`) and
  broadcasts files have no per-file thresholds — so the two pure helpers carry 100%
  line+branch thresholds; the dispatch error→`failed_to_dispatch` mapping is asserted
  explicitly (hand-written, since the harness can't gate it).
- **Disambiguation**: "recipient cap (5k/broadcast, existing `audience-cap.test.ts`)" is
  a different limit from "Resend audience-COUNT plan limit (#5, new)". Name them
  distinctly so #5 is not mistaken for already-covered.

## 6. Delivery — two PRs

Per the split decision. Each off `origin/main`, TDD (RED→GREEN), Conventional Commits.

- **PR-1 — send-unblock (small, urgent — unblocks the SweCham 131-member send)**:
  Fix 1 (doc) + Fix 2 (name cap) + Fix 3 (from bare email) + Fix 4 (quota release, all
  four edits + integration tests) + the contract-faithful SDK fake covering name/from +
  commit the already-written `scripts/reset-broadcast-quota.ts` utility. Reviewer: ≥1
  (no new PII surface; quota + dashboard label only).
- **PR-2 — audience redesign (after PR-1)**: Fix 5 (ephemeral audience + cleanup cron +
  D4 erasure-compat + audience-limit classification) + the audience-count contract-fake
  + the cross-member concurrent-send integration test. **Reviewer: ≥2, one signing the
  security checklist** — this touches recipient-email PII + the COMP-1 GDPR erasure
  surface; the cross-member integration test is a Review-gate blocker (Constitution
  Principle I cross-tenant/cross-member isolation).

## 7. Cleanup carried from the verification session (verification-gated)

Each item gets a "verified removed" check:
- [ ] Revert the temporary name/from patches left uncommitted on branch
      `084-comp1-review-fixes` (re-done properly in PR-1 off main).
- [ ] Remove the temporary `jirawat.p@eqho.com` contact on test member "E2E Mutation Co"
      (contact_id `969c81ba-af8d-45e6-9f5d-c1afe7cb45c1`).
- [ ] Remove the leftover e2e-member test broadcasts (the reset script handles this).
- [ ] Delete the two stray Resend audiences created during testing (Resend dashboard or
      PR-2's cleanup work).
- [ ] Confirm `scripts/reset-broadcast-quota.ts` uses simulated/dummy data only (it has
      a test-member guard) before committing it in PR-1.
- The finalFocus a11y fix (unrelated) is already delivered as PR #116.

## 8. Open Questions / Risks

- **R1 (no longer blocking)**: Resend audience snapshot-vs-live semantics. Ephemeral-
  per-send does not share a mutable audience across concurrent sends, so the live-read
  race is gone. Snapshot semantics only matter if single-reusable is ever revisited as a
  future optimization — out of scope now.
- **Audience-limit error classification** (permanent vs retryable-after-cleanup): settle
  during PR-2; the contract-fake must test the chosen path.
- The contract-fake's limits (70, audience count) are derived from observed Resend errors
  on 2026-06-21; pin them to Resend's documented limits during implementation with a
  source comment.
