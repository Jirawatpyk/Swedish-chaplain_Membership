# Plan: 140 — E-Blast keeps one dispatch leg, behind a dispatch lease

Spec: `specs/140-eblast-one-leg/spec.md` · Size: L · Agreed by the user on: 31 Oct 2026

## Approach

This spec is four slices, in build order. Each slice is reviewed and merged before the next one starts.

1. **Erasure reaches terminal rows (#699).**
   - The erasure cascade's `delete_then_cancel` mode also lists the member's rows outside `IN_PROGRESS_BROADCAST_STATUSES` (minus `sent`) that still hold a `resend_broadcast_id`. It deletes each draft with the bounded `deleteBroadcastOnce`.
   - A 403 is probed once with `retrieveBroadcastOnce`. A non-draft answer is recorded as a copy retained at the processor. Anything undecided withholds `member_erased`.
   - At source, the plain `refuse` arm deletes its draft before it fails the row, as `refuse_erased` already does. `attachResendIds` gains a status CAS.
2. **The lease.**
   - Migration 0322 adds a lease token and an expiry on `broadcasts`, and a content-free orphan-id table.
   - The import tick claims the row under the existing `lockForUpdate`.
   - Before each irreversible Resend call it re-checks the lease with a margin larger than the call's timeout.
   - The token joins every CAS the tick writes.
   - Creates are never retried in-process. Every leak case writes an orphan-id row, and `cleanup-audiences` drains those rows.
   - The legacy leg skips rows that carry import columns.
3. **Error classes and import-leg table fixes:**
   - the name cap;
   - `canceled`;
   - the status readers;
   - the id choke point;
   - `contacts.remove` encoding;
   - `reconcile-erasures` rotation.
4. **Retirement (D-042).**
   - Delete the legacy leg and the flag.
   - Set a configurable ceiling of 900.
   - Use the Segments API names.

**Alternatives not taken:**
- **A tick-level lease.** An overlapping tick would only skip, where a per-row lease lets two ticks share the work. Architect review, 31 Oct.
- **"TTL > maxDuration" as the only guard.** Vercel's kill semantics are DOCUMENTED per invocation, not per process. Architect BLOCKER.
- **A Resend-side listing sweeper for leaked drafts.** A broadcast's name carries no row id; the maintainer, 31 Oct.
- **Retiring the legacy leg first.** That would flip the import leg live without a lease, which D-038 forbids.

**Paths kept compatible:** the legacy leg, until slice 4 (usage line in `spec.md` § Premises: 0 rows, 2026-10-30; `FEATURE_F7_BROADCASTS` ON). It is protected only enough to roll back safely: the refuse arm deletes its draft, and from slice 2 it skips import rows.

## Files and modules

Rules: `.claude/rules/modules/broadcasts.md`, `members.md` (the erasure cascade), `architecture.md` (tenancy, migrations).

**Slice 1**
- `src/modules/broadcasts/application/use-cases/cancel-in-flight-broadcasts-for-member.ts`: the terminal-draft pass, its outcome table and counts.
- `application/ports/broadcasts-repo-port.ts` and `infrastructure/drizzle-broadcasts-repo.ts`:
  - a new `listTerminalWithResendIdOwnedByMember`;
  - a status CAS on `attachResendIds`.
- `application/ports/broadcasts-gateway-port.ts`: a third documented exception for an id read from the row.
- `application/use-cases/build-audience-tick.ts` (refuse arm) and `dispatch-scheduled-broadcast.ts` (refuse arm): delete the draft before the terminal write.
- `src/modules/members/**`:
  - `erase-member.ts`: the new counts go into the `member_erased` payload;
  - the broadcasts cascade port and adapter: carry the counts;
  - `reconcile-erasures`: a stuck gauge.
- Docs:
  - `docs/compliance/processing-records.md` 8d / 8b / :262;
  - `docs/runbooks/member-erasure.md` (g), 3b, 4;
  - the changelog.

**Slice 2:** migration 0322; the repo lease methods; `build-audience-tick.ts`; `_persist-minted-broadcast-id.ts`, `_reclaim-minted-broadcast.ts`; `resend-broadcasts-gateway.ts` (signals, no retry on create); `cleanup-orphaned-audiences.ts`; the dispatch cron route (scan filter, time budget, TTL); `dispatch-scheduled-broadcast.ts` (skip import rows).

**Slice 3:** `resend-broadcasts-gateway.ts` (the classifier and the second reader); `build-audience-tick.ts`; `format/resend-dashboard-name.ts`; the `reconcile-erasures` route.

**Slice 4:** these are deletions, mapped in the 31 Oct exploration:
- the legacy use case, its deps maker, `addContactsToAudience`, `deleteContactGlobally`, `audienceDriftDetected`;
- the cron branch, the flag in `env.ts` and `.env.example`;
- the legacy-only tests.

Also: the new ceiling env, the Segments names, `docs/decisions.md` D-042, go-live § 6.10, `operational-state.md`, the RoPA, the runbooks and `observability.md`.

## Data model and migration

- **Slice 1:** n/a. The counts ride the existing `member_erased` payload.
- **Slice 2, migration 0322** (the `new-migration` skill):
  - `broadcasts.dispatch_lease_token uuid NULL` and `dispatch_lease_expires_at timestamptz NULL`, with `CHECK ((dispatch_lease_token IS NULL) = (dispatch_lease_expires_at IS NULL))`.
  - The table `broadcast_orphaned_resend_ids`: `tenant_id`, `broadcast_id`, `resend_broadcast_id`, `reason`, `created_at`, `deleted_at`. It holds no content, and RLS and FORCE are on.
  - Unflagged on deploy, and inert until slice 2's code writes to it.
  - Rollback: a revert commit. The columns and the table are harmless when unused.
- **Slices 3 and 4:** n/a.

## Slices

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | Erasure deletes reachable drafts; refusals delete their draft | ED1–ED5 | pdpa-gdpr, security, reliability, spec-compliance | `140-eblast-one-leg-s1` | — · open |
| 2 | Lease + fencing token + pre-call check; bounded calls; no retry on creates; orphan ids; legacy skips import rows | DL1–DL8 | drizzle-migration, security, reliability, pdpa-gdpr, spec-compliance | `140-eblast-one-leg-s2` | — · open |
| 3 | Error classes + import-leg table fixes | DT1–DT4 | security, reliability, spec-compliance | `140-eblast-one-leg-s3` | — · open |
| 4 | Retire the legacy leg, drop the flag, ceiling 900, Segments names, D-042 | DR1–DR4 | security, pdpa-gdpr, reliability, i18n, spec-compliance | `140-eblast-one-leg-s4` | — · open |

## Test plan

### State table: slice 1, the terminal-draft pass

The row is not `approved`, and the pass takes no row lock: Resend's draft-only DELETE and `/send` settle a race with `reconcile-stuck-sending` or an import restart (review round 1). The pass runs only in erasure mode.

| DELETE once | GET once | Outcome | Count | Test |
|---|---|---|---|---|
| `deleted` | — | cleared | `resend_drafts_cleared` +1 | unit "terminal draft deleted" + ED1 integration |
| `absent` | — | cleared | `resend_drafts_cleared` +1 | unit "terminal draft already absent" |
| `forbidden` | `present{canceled\|failed}` | retained at the processor (unsent) | `resend_copies_retained` +1 | unit it.each + ED2 integration |
| `forbidden` | `present{queued\|sending\|sent}` | already sent (8c evidence row, once; review round 1) | `broadcasts_already_sent_count` (derived) | unit it.each + integration "…written once…" |
| `forbidden` | `present{draft\|unknown}` / `not_found` / `retryable` / `other` | unexpected | — (withholds `member_erased`) | unit it.each |
| `retryable` / `other` | — | unexpected | — | unit + ED3 integration (re-drive) |
| empty id | — | not listed | — | repo SQL-shape case |

### Test plan rows (slice 1)

| Done-when line | Test that goes red first (file, name) | Level |
|---|---|---|
| ED1 | `tests/integration/broadcasts/erasure-terminal-drafts.test.ts` "an erased member's failed_to_dispatch draft is deleted and counted" | integration |
| ED2 | same file, "a 403 + canceled copy is counted as retained, not as already sent" | integration |
| ED3 | same file, "a retryable answer withholds member_erased and the re-drive clears it" | integration |
| outcome table | `tests/unit/broadcasts/application/cancel-in-flight-broadcasts-for-member.test.ts`, the terminal-draft `it.each` | unit |
| ED4 | `build-audience-tick` unit "a halted refusal deletes the row's draft before the terminal write" + the legacy twin in `dispatch-scheduled-broadcast.test.ts` | unit |
| ED5 | `drizzle-broadcasts-repo` SQL-shape "attachResendIds carries status='approved'" + integration "a non-approved row is not written" | unit + integration |
| counts reach the payload | `erase-member` unit "member_erased carries resend_drafts_cleared / resend_copies_retained" | unit |
| cascade port | `tests/contract/` broadcasts-cascade-port case for the new fields | contract |

The cross-tenant check is the new repo method's integration case, with a second tenant's terminal row for the same member uuid. The e2e specs are n/a for slice 1 (no UI); the rows for slices 2–4 are written when each slice starts.

## Constitution Check

| Principle | Result |
|---|---|
| I Privacy & Security | Pass. Every new repo method is tenant-fenced in `runInTenant`, with a cross-tenant integration case. 8d shrinks. |
| II Test-First | Pass. RED commit per row. |
| III Clean Architecture | Pass. members reaches broadcasts only through the cascade port and adapter. |
| IV PCI | n/a |
| V i18n | Slice 4 only (the ceiling message, EN/TH/SV). |
| VI Inclusive UX | Slice 4 only (the refusal copy). |
| VII Perf & Observability | Pass. Every Resend call is bounded (slice 1 uses the `*Once` 10 s calls); the stuck gauge is added. |
| VIII Reliability | Pass. Fail-closed table; slice 2's fencing. |
| IX Code Quality | Pass. |
| X Simplicity | Pass. No new dependency. |

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| Solo-maintainer review (PII / erasure / audit). The five checks in `review-and-ship` § 2 are evidenced per slice in § Evidence: (1) the security-engineer + senior-tester staff review; (2) the pdpa sign-off; (3) the RED-first commits; (4) Verify on :3400 with the sink address only; (5) the changelog + RoPA in the diff | No second human reviewer | — |
| The terminal-draft pass runs without a row lock | The row is terminal, so no dispatch tick works it; Resend's draft-only DELETE settles the race | Taking `lockForUpdate` would add up to 10 s of lock per row, for no ordering gain |

## Evidence

Filled in at Verify, one block per slice.

### Slice 1 — build notes (decisions made while building)

Commits: `5ab2a9abd` test (RED), `14eac06e6` feat (GREEN). RED ran first: the unit, contract and integration rows above failed on the missing method, fields and arms (98 unit/contract failures; 5/5 integration in `erasure-terminal-drafts.test.ts`).

1. **What the terminal list holds.** Every `BROADCAST_STATUSES` value outside `IN_PROGRESS_BROADCAST_STATUSES`, bar `sent`: `draft`, `sending`, `rejected`, `cancelled`, `failed_to_dispatch`, `partially_sent`, `partial_delivery_accepted`, `expired_no_member_response`; `resend_broadcast_id` NOT NULL and `<> ''`. Derived from the Domain constant (`terminalDraftStatusPredicate`). `sending` / `partially_sent` / `partial_delivery_accepted` hold a handed object: the DELETE answers 403 and the probe records it retained. `sent` is left out: its copy is known undeletable and the F7 retention sweep owns it.
2. **`failed`.** `normaliseStatus` read it `unknown`. Only `retrieveBroadcastOnce` names it now (`RetrieveBroadcastOnceOutcome`'s present status widened by `'failed'`); `RetrievedBroadcastResource['status']` and `normaliseStatus` are unchanged, so both dispatch legs and `reconcile-stuck-sending` still refuse it as `unknown`. The in-flight arm of the cascade still treats `failed` as unexpected. Gap: DELETE on `failed` is UNMEASURED (research Q4 row); only a 403 + `failed` reaches "retained", anything else stays undecided and shows on the stuck gauge.
3. **Order and count rule** (superseded in part by review round 1 below: no second DELETE, and a handed copy is 8c evidence, not retained). The pass runs AFTER the in-flight loop and BEFORE the already-sent count read. A row the loop has just cancelled still holds its id and is listed (DELETE → `absent` → cleared), so a first run and a re-drive report the same numbers (the DE3 / R-H1 integration expectations now show `resendDraftsCleared: 1` and, where the fake answers `deleted` every time, a second DELETE). The counts are DERIVED per run, like `alreadySentCount`: the pass never writes the row, and `member_erased` is written only by a run in which every listed row was decided, so the completing run's counts are whole. A `forbidden` + `cancelled` in-flight row (`cancelled_at_resend`) is counted `resend_copies_retained` on every run. A row that moved to `sending` before the cascade reached it can be in BOTH `broadcasts_already_sent_count` (evidence) and `resend_copies_retained`; both are true (RoPA 8c / 8d). The pass has no per-member time bound; `reconcile-erasures` checks its budget between members.
4. **ED4, an undecided DELETE on a halted / ended refusal.** Not mirrored from the erased arm: left `approved`, the row could be sent once a halt is lifted, and a permanent Resend answer would hold it there for ever. Both legs refuse terminally and record `resendDraftOutcome: 'undeleted'` (`deleted` / `absent` / `cancelled` / `none` otherwise) in the `broadcast_failed_to_dispatch` payload; the erasure cascade's terminal pass reaches that draft if the member is erased. The shared helper is renamed `deleteDraftBeforeRefusal` (with `refusal: 'erased' | 'standing'` in its log lines, `broadcasts.dispatch.refused_draft_*`); the erased arms keep their `member_erased_draft_not_deleted` message (`ERASED_DRAFT_NOT_DELETED`).
5. **ED5 callers.** The legacy leg's `advanceToSending` already maps a `BroadcastConcurrentMutationError` from the same tx to `broadcast_invalid_state_transition` (no behaviour change; the row was rolled back before). The import leg did not: a lost attach was logged as the critical `sent_but_row_unattachable` ("the row is gone"), which would fire for a sibling that had already flipped the row to `sending`. It now routes a lost attach CAS into the transition-lost re-read (benign `transition_already_sending`, or the critical `sent_but_transition_lost` for a cancel that won); only `BroadcastNotFoundError` is `sent_but_row_unattachable`. Pinned by two unit cases.
6. **Stuck signal.** Gauge `members_erasure_stuck_count{tenant}` = still_pending + error + deferred at the end of every `reconcile-erasures` tick, 0 included (a lower bound when the 50 cap fills). No query change. `docs/observability.md` § 14.8 has the row and an alert (> 0 for 4 ticks).
7. **Test-plan deviations.** The cascade-port contract row is covered by the adapter unit test (`broadcasts-cascade-adapter.test.ts`, both arms), which is the port↔adapter boundary; no separate `tests/contract/` file. ED1 / ED3 integration call the cascade directly (the DE3 precedent); that `member_erased` carries the counts and is withheld on `cascade_partial_failure` is pinned in `erase-member.test.ts`.
8. **Mutation proofs (from `14eac06e6`).** (a) drop `eq(broadcasts.status, 'approved')` from `attachResendIds` → the SQL-shape case fails; (b) write `already_sent` evidence on a retained copy → 5 retained cases fail; (c) drop `countUnexpected` in the terminal catch → 11 cases fail. Each restored byte-for-byte and re-grepped.

### Slice 1 — Verify (31 Oct 2026, on `4ca3ab9fb`)

`run-chamber-os` setup:
- the branch on :3400 from the `f140` worktree, dev Neon, tenant `swecham`;
- the live Resend Broadcasts account, recipient `delivered@resend.dev` only;
- a super-admin through the real `POST /api/members/{id}/erase`.

The probe was a throwaway spec, never committed. The seeds were removed afterwards, and so were the run-1 seeds, which had been refused because the first sign-in was the non-super admin.

| Done-when | Evidence |
|---|---|
| ED1 | A `failed_to_dispatch` row holding a real Resend `draft`. Erase → `200 cascadesComplete:true`. GET the draft → **404**. `member_erased` has `resend_drafts_cleared:1, resend_copies_retained:0, broadcasts_already_sent_count:0`. |
| ED2 | A `cancelled` row whose id is a Resend broadcast cancelled while queued (GET answers `canceled`). Erase → `200 cascadesComplete:true`, and Resend still answers `canceled`. `member_erased` has `resend_drafts_cleared:0, resend_copies_retained:1, broadcasts_already_sent_count:0`. |
| ED3 | Integration `erasure-terminal-drafts.test.ts` "a retryable answer withholds member_erased and the re-drive clears it" (a retryable answer cannot be provoked live). |
| ED4 | Unit tests on both legs (`build-audience-tick-failure-paths.test.ts`, `dispatch-scheduled-broadcast.test.ts`). Not driven live: a live run would need a halted member with a due row and a real draft. |
| ED5 | `broadcast-erasure-terminal-sql-shape.test.ts` (the status CAS), plus the mutation proof (a) above. |
| Wrong input | Erase with `identityVerified:false` and no `verificationMethod` → **400** `invalid_body`, and the draft is still `draft`. |

### Slice 1 — review round 1 (code-review high, pdpa, security, reliability; 31 Oct 2026)

RED `8b501e5ca`, GREEN `421541cad`; docs in the commit after them. The unit and contract rows went red first (43 failures). The two new integration cases (the handed copy written as evidence, and the builder on the BYPASSRLS owner) were committed with the RED tests but run only after GREEN; at RED the builder they import did not exist.

| Finding | Disposition |
|---|---|
| code-review #1, #2 · pdpa M-1 · security L3 — a handed copy was counted as retained | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). A 403 followed by `queued` / `sending` / `sent` goes through `recordAlreadySent`: its own tx, the `broadcasts-evidence:` advisory lock, and `broadcastRecorded` checked first, so it is written once per broadcast. A row the in-flight arm already evidenced is not written again (unit "…evidence row already exists…"; integration "…written once…"). `resend_copies_retained` now counts unsent copies only (`canceled` / `failed`). **Residual:** a `queued` copy is NOT cancelled at Resend in this slice, because the gateway has no cancel method (RoPA 8c / 8d). |
| reliability H-1 · code-review #6 — the pass had no time bound | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). An optional `deadlineAt` runs through the members cascade port, the adapter and `EraseMemberMeta`. The erase route and `reconcile-erasures` set it to start + 270 s, which leaves room inside the 300 s `maxDuration` for the row in progress (two bounded 10 s calls). Archive sets none. Rows not reached by the deadline count as unexpected and log `terminal_deadline_reached`. The deadline bounds only the terminal pass; the in-flight loop keeps spec 139's bound (D-040). |
| reliability L-2 · code-review #3 — a second DELETE on rows the in-flight loop had just cancelled | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). When the in-flight loop settled a row at Resend in the same run, the terminal pass counts it from that settlement (`deleted` / `absent` → cleared, `cancelled_at_resend` → retained) and makes no call. The R-H1 integration expectation is back to one DELETE. |
| reliability L-1 — the gauge freezes or misleads | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). A baseline `stuck.length` is observed before the loop, the end value after it, and 0 while the kill switch is off. A failed candidate query observes nothing new, and this is stated in `observability.md` and in the metric's docblock. |
| reliability M-1 · code-review #4 · security L2 — a standing refusal versus a sibling's send | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). `deleteDraftBeforeStandingRefusal` probes a 403 once. Handed → a concurrent skip on both legs (`broadcast_invalid_state_transition`, no terminal write, no email, warn `refused_draft_handed_by_sibling`). Otherwise `undeleted`, and `resendDraftErrClass` takes a closed value: `forbidden`, `retryable`, `other` or `threw`. |
| 429 point (pacing) | **No change.** Resend's documented limit is 10 req/s per team (research § Limits & plan: DOCUMENTED rate-limit; MEASURED `ratelimit-policy: 10;w=1`, 2026-09-08). The ~2.08 req/s in the codebase is *measured serial throughput* (RTT ≈ 0.48 s), not a limit. The pass is serial, so it stays near 2 req/s and needs no pacing. A 429 is `retryable` and leads to unexpected and a re-drive. |
| code-review #5 — a transient DELETE on the refuse arm leaves the draft until erasure | **Carried to slice 2.** That slice's orphan-id table and the choke point "any `failTerminally` on a row holding a draft id reclaims it" own it. spec.md ED4 is amended to say what is built (this also closes pdpa L-2). |
| code-review #7 — `subprocessorErasure` lost its JSDoc | **Fixed** (GREEN `421541cad`). `stuckCount` now has a docblock of its own. |
| code-review #8 — the list read whole rows | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). `TerminalBroadcastDraftRef` is `{broadcastId, status, resendBroadcastId}`, read by the exported builder `terminalDraftsForMemberQuery` inside `runInTenant`. The SQL-shape case pins that it reads three columns. |
| code-review #9 — runbook "an `unknown` status such as `failed`" | **Fixed** (docs commit). It now uses the outcome strings that are actually logged. |
| security L1 — the cross-tenant claim overstated what was proven | **Fixed** (RED `8b501e5ca`, GREEN `421541cad`). An integration case runs the same builder on the BYPASSRLS `db` and proves the application predicate alone. The header now says the repo case proves both layers together. |
| pdpa L1 — "anything but a 403 + a recognised status is undecided" | **Fixed** (docs commit). RoPA 8d now says that a 404 means Resend holds no such broadcast, so nothing is retained. |
| pdpa L3 — "no dispatch tick works a terminal row" is false for `sending` | **Fixed** (GREEN `421541cad`). The cascade docblock now says that Resend's draft-only DELETE and `/send` settle the race. |
| pdpa L4 — the runbook TERMINAL query names statuses by hand | **Fixed** (docs commit). It now says the list mirrors `IN_PROGRESS_BROADCAST_STATUSES` + `sent`, and limits the count rule to "until the retention sweep", as cleared + retained + handed. |
| code-review #10 — one Resend answer classifier for both cascade arms | **Carried to slice 3** ("one status reader"). |
| DELETE on a `failed` broadcast is unmeasured | **Carried to slice 3** (the measurement; research Q4). |

Mutation proofs (from `421541cad`, each file restored byte for byte and checked clean):
- handed → `resendCopiesRetained += 1` instead of evidence: 5 tests red.
- removing the settled-this-run skip: 1 red.
- the deadline check made inert: 2 red.
- the sibling-handed branch made inert in the wrapper: 9 red across the gate and both legs.
- removing the legacy leg's handed return: 3 red.

### Slice 1 — review round 2 (code-review high, pdpa and reliability re-checks; 31 Oct 2026)

Commits: RED `d1becc51b`, a test-only fix `8e5db36e6`, and GREEN `7499b8f2f`. Docs land in the commit after them.

At RED the unit and contract rows failed (14). The four ED4 integration cases were committed with the RED tests, but the file did not compile there: an apostrophe in a title broke it, fixed in `8e5db36e6`. They cover behaviour slice 1 had already built (code-review #8 asked for them on real Postgres), so they pass against both the RED and the GREEN code.

| Finding | Disposition |
|---|---|
| code-review #1 · reliability N1 — the deadline starves sub-processor propagation | **Fixed** with option (a) (RED `d1becc51b`, GREEN `7499b8f2f`). `subprocessorErasure.propagate` now runs before every post-commit cascade. This is safe for three reasons: it reads only `capturedSubprocessorPairs` from the atomic tx, not any cascade's outcome; it does not gate `member_erased`, because it never flips `allCascadesClean`; and it is the one step a re-drive cannot repeat. Its own cost is no longer counted against the broadcasts deadline, and the cascades after broadcasts are all re-drivable. Option (b) was not taken: it would shorten every erasure's budget and still leave propagate behind the pass. |
| code-review #9 — two deadline constants | **Fixed** (GREEN `7499b8f2f`). `src/lib/erasure-cascade-deadline.ts`: `erasureCascadeDeadline(start, maxDuration)` = start + maxDuration − 30 s reserve. Each route passes its own `maxDuration`. |
| reconcile-erasures: a late member gets only the rest of the tick | **Accepted, as stated.** A row not reached withholds `member_erased` and the next tick (30 min later) continues. Every re-drive is idempotent, and the stuck gauge shows a member that never completes. |
| pdpa N-1 · code-review #2 — old deliveries treated as erasure evidence | **Fixed** (RED `d1becc51b`, GREEN `7499b8f2f`). The list leaves out `SENDING_STARTED_BROADCAST_STATUSES` (sending, sent, partially_sent, partial_delivery_accepted). **Verified** before removing `sending`: neither leg writes it before `/send`. The import leg writes it in the transition after the send (`build-audience-tick.ts`, `applyTransition(…'sending'…)` after `sendBroadcast` or a probed accepted send). The legacy leg writes it only in `advanceToSending`, which is reached after the send, after a replayed send, or when the probe saw an earlier tick's send (`dispatch-scheduled-broadcast.ts`). The other two statuses are reachable only through `sending` (the transition table). The handed arm stays for listed rows: integration "a failed_to_dispatch row whose copy Resend queued…". |
| code-review #3 — a re-drive re-spends calls on the cleared prefix | **Refuted with numbers.** Only an `approved` row is ever minted an id (dispatch legs only). Its exits are `sending` (unlisted), `cancelled`, and `changes_requested` / `in_design`; the last two answer `sending_started` once dispatch has begun. So the listed rows are only (a) failures after a mint and (b) the erasure's own cancels. Each one is a staff-approved E-Blast. The yearly allowance is ≤ 15 (Partnership; 6 / 3 / 1 for the other tiers, `membership-benefits-analysis.md`). Measured counts: prod 0 broadcast rows (2026-10-30), and on dev, `max(rows per member)` in the listed statuses with an id = none (`pnpm db:query`, 2026-10-31). Re-spending on an already-cleared row costs one 404, about 0.48 s RTT (research § Limits), not the 10 s bound. At 5 s per call, 270 s holds 54 calls; the realistic per-member count is a handful. The stuck gauge catches a member that never completes. No ordering change. |
| code-review #4 — a deadline deferral counted as stop-the-line | **Fixed** (RED `d1becc51b`, GREEN `7499b8f2f`). It now has its own label, `deferred`, with a debug line per row, and still withholds `member_erased`. |
| code-review #5 — stale comments | **Fixed** (GREEN `7499b8f2f`). The `member_erased` payload comment and the repo port docblock now say that handed copies are 8c evidence and retained = canceled / failed. |
| code-review #6 — the standing gate dropped the probe's reading | **Fixed** (RED `d1becc51b`, GREEN `7499b8f2f`). A `cancelled` reading is now cleared (`cancelled`). Otherwise the class is from a closed set: `probe_draft`, `probe_not_found`, `probe_retryable`, `probe_other` or `threw`. Each non-handed outcome is logged with the probed status (and `err: errKind(e)` on a throw), never provider text. |
| code-review #7 — the gauge forced 0 while paused | **Fixed** (RED `d1becc51b`, GREEN `7499b8f2f`). While paused it reads the real candidate count, capped at 50. A failed read observes nothing new, and the pause still answers 200. |
| code-review #8 — no ED4 on real Postgres | **Fixed** (RED `d1becc51b`, test fix `8e5db36e6`). `eblast-send-time-standing.test.ts` has four cases, two per leg: a halted refusal deletes the draft and records `resendDraftOutcome`; a 403 + handed probe makes no terminal write and writes no audit rows (no member notice). |

Mutation proofs (from `7499b8f2f`, each file restored byte for byte, tree clean):
- propagate moved back after the cascades: 1 red.
- `sending`-started statuses back in the list: 1 red.
- `deferred` → `unexpected_error`: 2 red.
- every probe class collapsed to `probe_other`: 3 red.
- the cancelled-reading clear made inert: 1 red.
- the paused count dropped: 1 red.

## Rollout

- **Slice 1:** unflagged. It changes only the erasure cascade (erasure mode) and the two legs' refuse arm. Rollback: a revert.
- **Slice 2:** migration 0322 runs on deploy. The lease applies to the import leg only, which is dark. The legacy leg's skip of import rows is live.
- **Slice 4:** makes the import leg live for every tenant at deploy.
  - Before the merge, the maintainer runs a prod read-only count of `approved` and `sending` rows (D-034). The number goes into D-042 and the PR.
  - Rollback: a revert, which is safe because of slice 2's skip.
  - 139 slice 2 must merge before the first prod E-Blast goes through the import leg. That gate is dated in `operational-state.md`.

## Risks

| Risk | How we notice |
|---|---|
| Erasure re-drives forever on a permanent Resend error | The `reconcile-erasures` stuck gauge; ED3 |
| A terminal draft is deleted while Resend is sending it | Not possible: DELETE answers 403 on queued/sent (MEASURED 2026-10-29); probed |
| Slice 4 hits the Free-plan cap | The ceiling of 900 at submit; DR3 |
| A wire change deletes contacts account-wide | DR4's contract assertion |
