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

The row is not `approved`, so no dispatch tick works it, and the pass takes no row lock. The pass runs only in erasure mode.

| DELETE once | GET once | Outcome | Count | Test |
|---|---|---|---|---|
| `deleted` | — | cleared | `resend_drafts_cleared` +1 | unit "terminal draft deleted" + ED1 integration |
| `absent` | — | cleared | `resend_drafts_cleared` +1 | unit "terminal draft already absent" |
| `forbidden` | `present{canceled\|failed\|queued\|sending\|sent}` | retained at the processor | `resend_copies_retained` +1 | unit it.each + ED2 integration |
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
3. **Order and count rule.** The pass runs AFTER the in-flight loop and BEFORE the already-sent count read. A row the loop has just cancelled still holds its id and is listed (DELETE → `absent` → cleared), so a first run and a re-drive report the same numbers (the DE3 / R-H1 integration expectations now show `resendDraftsCleared: 1` and, where the fake answers `deleted` every time, a second DELETE). The counts are DERIVED per run, like `alreadySentCount`: the pass never writes the row, and `member_erased` is written only by a run in which every listed row was decided, so the completing run's counts are whole. A `forbidden` + `cancelled` in-flight row (`cancelled_at_resend`) is counted `resend_copies_retained` on every run. A row that moved to `sending` before the cascade reached it can be in BOTH `broadcasts_already_sent_count` (evidence) and `resend_copies_retained`; both are true (RoPA 8c / 8d). The pass has no per-member time bound; `reconcile-erasures` checks its budget between members.
4. **ED4, an undecided DELETE on a halted / ended refusal.** Not mirrored from the erased arm: left `approved`, the row could be sent once a halt is lifted, and a permanent Resend answer would hold it there for ever. Both legs refuse terminally and record `resendDraftOutcome: 'undeleted'` (`deleted` / `absent` / `cancelled` / `none` otherwise) in the `broadcast_failed_to_dispatch` payload; the erasure cascade's terminal pass reaches that draft if the member is erased. The shared helper is renamed `deleteDraftBeforeRefusal` (with `refusal: 'erased' | 'standing'` in its log lines, `broadcasts.dispatch.refused_draft_*`); the erased arms keep their `member_erased_draft_not_deleted` message (`ERASED_DRAFT_NOT_DELETED`).
5. **ED5 callers.** The legacy leg's `advanceToSending` already maps a `BroadcastConcurrentMutationError` from the same tx to `broadcast_invalid_state_transition` (no behaviour change; the row was rolled back before). The import leg did not: a lost attach was logged as the critical `sent_but_row_unattachable` ("the row is gone"), which would fire for a sibling that had already flipped the row to `sending`. It now routes a lost attach CAS into the transition-lost re-read (benign `transition_already_sending`, or the critical `sent_but_transition_lost` for a cancel that won); only `BroadcastNotFoundError` is `sent_but_row_unattachable`. Pinned by two unit cases.
6. **Stuck signal.** Gauge `members_erasure_stuck_count{tenant}` = still_pending + error + deferred at the end of every `reconcile-erasures` tick, 0 included (a lower bound when the 50 cap fills). No query change. `docs/observability.md` § 14.8 has the row and an alert (> 0 for 4 ticks).
7. **Test-plan deviations.** The cascade-port contract row is covered by the adapter unit test (`broadcasts-cascade-adapter.test.ts`, both arms), which is the port↔adapter boundary; no separate `tests/contract/` file. ED1 / ED3 integration call the cascade directly (the DE3 precedent); that `member_erased` carries the counts and is withheld on `cascade_partial_failure` is pinned in `erase-member.test.ts`.
8. **Mutation proofs (from `14eac06e6`).** (a) drop `eq(broadcasts.status, 'approved')` from `attachResendIds` → the SQL-shape case fails; (b) write `already_sent` evidence on a retained copy → 5 retained cases fail; (c) drop `countUnexpected` in the terminal catch → 11 cases fail. Each restored byte-for-byte and re-grepped.

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
