# 139 — An erased member's E-Blast never goes out, and the Resend disclosure is audited

**Size**: L (`docs/workflow.md` § Sizes: PII / GDPR erasure, a cross-module read members → broadcasts, a migration in slice 2).
**Status**: slice 1 merged (PR #698). Slice 2 started on 6 Nov 2026, after spec 140 made the import leg the only one (D-042); US2 below is amended to the sites on that code. Plan agreed by the maintainer on 30 Oct 2026; slice 2's placement re-decided on 6 Nov 2026 (US2).
**Source**: spec 138 § "Moved out: erasure" and D-038. `FEATURE_F7_IMPORT_AUDIENCE` may be set only after slice 1 of this spec (and spec 140) have merged.

## Why

An erased member's E-Blast, caught between the pre-send persist of `resend_broadcast_id` and Resend `/send`, can still go out. The draft sent is the one built before the scrub: subject, body and from-name. This is RoPA residual 8b. It has been live on the legacy dispatch leg since F4; the import leg (dark) has the same window.

It has two windows:

- **Same tick.** The erasure lands after the persist and before `/send`. The cascade skips the row as "dispatch begun", and no gate runs again before the send.
- **Next tick.** After a retryable `/send` failure, the next tick probes the inherited id, reads `draft`, and runs the standing gate again. The erased member still answers `ok`, so the pre-scrub Resend draft is sent.

Spec 138 also left a second gap: tick 1 of the import leg discloses the recipient list to Resend, and a hold later deletes that audience. Neither writes an audit row, so the GDPR Art. 30 record has no trace of either. Neither do the other audience deletes.

## Premises checked against the code (30 Oct 2026)

- **The cascade skips dispatch-begun rows.** `cancel-in-flight-broadcasts-for-member.ts:243` returns `dispatch_begun` for `status === 'approved' && resendBroadcastId !== null` and writes nothing. Its deps are `broadcastsRepo`, `audit` and `clock` only: no Resend gateway.
- **The gate does not read erasure.** `_member-send-standing.ts:118-135` reads the halt list, then F8 access. The halt list (`findMembersHaltedForBroadcast`) filters `erased_at IS NULL`, so erasure takes the member *off* it. F8 access (`deriveMembershipAccess`) answers `full` in three cases: a cancelled cycle that has not expired (erasure cancels with a reason other than `coverage_ended`), a completed cycle, or no cycle at all.
- **The only erasure signal is the column.** `members.erased_at` is sticky. It is readable through the members barrel (`drizzleMemberRepo.findErasedAtById`). Erasure leaves `status` and the halt flags unchanged.
- **Erasure order** (`erase-member.ts`): the scrub transaction commits `erased_at` first. The post-commit cascades follow: broadcasts cancel (:760), renewals, and so on. The broadcasts content scrub comes after the cancel (:1026) and rewrites our DB row only. When a cascade is not clean, `member_erased` is withheld and the `reconcile-erasures` cron drives it again.
- **Archive shares the cascade.** `archive-cascade.ts:138` and bulk archive also call `cancelInFlightBroadcastsForMember`.
- **Resend arbitrates DELETE against send** (measured 2026-10-29, spec 138). `DELETE /broadcasts/{id}` answers 200 on draft or scheduled and 403 on queued or sent. `/send` works only on a draft. After a DELETE, `/send` and GET answer 404.
- **The import leg re-mints on `not_found`.** It re-probes after 3 s, mints a new broadcast from the row's content, and persists it with a CAS on `status = 'approved'` (`drizzle-broadcasts-repo.ts:1082-1123`). That is why runbook step 3b must not be used on that leg.
- **The gateway retries.** `deleteBroadcast` goes through `withRetry`: backoffs of 1, 2, 4, 8 and 16 s, so up to 31 s.
- **Existing audit coverage.** Each leg writes `broadcast_send_started` after the send. Nothing is audited at `createAudience`, the contacts push, the tick-1 import, or any audience delete: the hold teardown (`build-audience-tick.ts` `restartAudienceBuild`), the dispatch cleanup (`dispatch-scheduled-broadcast.ts:1214`), `cleanup-orphaned-audiences`, or `reclaim-orphaned-audiences`.

## User stories

### US1 — An erased member's E-Blast is not sent (slice 1; gates the flip)

As the chamber, when a member is erased under GDPR Art. 17 / PDPA § 33, none of that member's E-Blasts reaches Resend's send afterwards, on either dispatch leg.

**Done when:**
- **DE1.** At send time, on both legs, the dispatch gate refuses a member whose `erased_at` is set.
  - The refusal is terminal and `/send` is never called.
  - Erasure is checked before the halt list.
  - A failed erasure read fails closed: the gate is undecided and nothing is sent.
  - The member gets no notification email (skipped explicitly).
  - If the row still carries an id that was never handed over, the gate first deletes that draft at Resend. It refuses only once the draft is `deleted` or `absent`, or the DELETE answers 403 and the leg's own probe read `cancelled` (a cancelled broadcast can never be sent); otherwise it is undecided. A cascade that failed therefore never leaves this row's pre-scrub draft behind. A draft no gate reaches (an E-Blast already terminal, or a reclaim that failed) can stay at Resend unsent: residual 8d.
  - A requester who is **not found** is not refused at dispatch (review round 2, maintainer 30 Oct 2026): erasure never deletes a member row, so a missing one is not evidence of an erasure. On both legs the gate is undecided: nothing is sent, the draft is not deleted, the row stays `approved`, and a warn line `broadcasts.dispatch.requester_not_found` (ids only) is written. Submit, approve and confirm-schedule still refuse a missing member. `broadcasts.requested_by_member_id` has no FK to `members`, so such a row stays approved and unsent until it is cancelled by hand (runbook `member-erasure.md`).
- **DE2.** On erasure, an `approved` row that carries `resendBroadcastId` is handled, not skipped. Every decision on the row is made under the row lock that did the DELETE (review round 1): a cancel decided later, on a status-only CAS, could follow an import tick that re-minted from pre-scrub content. Under the lock the cascade calls `DELETE /broadcasts/{id}` once and, after a 404 or 403, `GET /broadcasts/{id}` once — each with no retry backoff and a 10 s hard timeout; after a 404 it first waits 3 s (`REPROBE_PAUSE_MS`, the import leg's pause before its second not-found), so the lock is held for about 23 s at most (review round 2). A row locked at a status other than the one listed gets no Resend call on that attempt; the cascade re-reads and retries from the status it finds (review round 2):
  - **200:** the row is cancelled in the same transaction; `broadcast_cancelled` carries `resendOutcome: 'deleted'`.
  - **404, and the GET answers not found:** cancelled, `resendOutcome: 'absent'` (two not-founds, as the import leg requires).
  - **403, and the GET answers `cancelled`:** cancelled, `resendOutcome: 'cancelled_at_resend'` (a cancelled broadcast can never be sent; the gate's arm).
  - **404 or 403, and the GET answers `queued`, `sending` or `sent`:** the lock transaction ends with no row write.
    - Then, on its own transaction and under an advisory lock on the broadcast, `broadcast_concurrent_action_blocked` records `dispatchBegun: true` and `resendOutcome: 'already_sent'`, once per broadcast. If that write fails, the row counts as unexpected.
    - A lost race whose re-read finds the row already sending or sent writes the same evidence — only that row, counted as already sent, not as a concurrent skip (review round 2).
    - `member_erased` carries `broadcasts_already_sent_count`, derived at the end of every erasure run from those evidence rows (distinct broadcasts for the member), so a re-drive's count is authoritative.
    - This is residual 8c, stated in the DSR answer.
  - **Any other answer is unexpected (fail closed):** 404 + `draft` / `cancelled` / `unknown` (an inconsistent answer), 403 + `draft` / not found / `unknown` (a restricted key also answers 403), and a retryable, other or timed-out answer from either call. The lock transaction rolls back, the cascade is `cascade_partial_failure`, `member_erased` is withheld, and `reconcile-erasures` drives it again.
- **DE3.** A tick racing the erasure sends nothing.
  - If the cascade's DELETE wins, the tick's `/send` gets 404 and its transition loses to the cancel. The tick's re-read after that 404 takes the row lock, so it waits for the cascade's commit (review round 2).
  - An import-leg tick cannot re-mint. Its persist CAS waits on the cascade's lock and then sees `cancelled`. Its lock step refuses a row that is not `approved`.
- **DE3b.** A tick that loses the race to the cancel logs a concurrent skip at info level, not `server_error`, on both legs.
- **DE4.** Archive and bulk archive are unchanged: a dispatch-begun row is still skipped, and nothing is deleted at Resend. Only erasure selects the new handling, through an explicit cascade input.
- **DE5.** Docs:
  - erasure runbook step 3b no longer asks for a manual Resend action (it now finds residual 8c from evidence and state);
  - RoPA residual 8b is closed for sends (not for every Resend copy), the accepted residual 8c is added, and the open residual 8d records the unsent drafts no gate reaches;
  - runbook step 4 reads `broadcasts_already_sent_count`, and the runbook states that archive never stands in for an erasure;
  - go-live § 6.10's 139 box is ticked;
  - `operational-state.md` is updated;
  - the changelog has an entry;
  - D-040 records the row lock held across at most two bounded Resend calls plus the 3 s pause after a 404 (≈ 23 s).
- **DE6.** Cross-tenant: the new bridge read never returns another tenant's member.

### US2 — Every disclosure of a recipient list to Resend, and every audience delete, has an Art. 30 record (slice 2; does not gate the flip)

**Amended 6 Nov 2026 (slice 2 start).** Spec 140 slice 4 deleted the legacy leg, so its two sites are gone. The maintainer decided on 6 Nov 2026 that both rows are written BEFORE the Resend call, following the broadcasts rule "Gates and audit rows for Resend calls": a function killed after the call must not be able to erase the record. This supersedes the original "written after Resend returns the id" and the payload `outcome`, so a row records a request, not its result.

**Done when:**
- **DA1.** `broadcast_audience_disclosed` is written before the recipient list goes to Resend. The site is tick 1 of the import leg (`buildAudienceTick` → `submitImport`): after the segment id is attached to the row, and before the import's lease gate and `createContactImport`. It carries the recipient count. A refused, failed or timed-out import still has its row, because the row records the request.
- **DA2.** `broadcast_audience_deleted` is written before each delete of a segment that may hold recipients, once per segment:
  - **The restart teardown** (`restartAudienceBuild`: `hold`, `stale_audience`, `audience_missing`): written before its lease gate.
  - **`cleanup-orphaned-audiences`** (`terminal_cleanup`): written from our own row.
  - **`reclaim-orphaned-audiences`** (`orphan_reclaim`): written only when a `broadcast_audience_disclosed` row of this tenant names the segment, and it takes that row's `related_member_id`. Without such a row, this deployment never filled the segment: no row is written, only a warn and a counter (pdpa M-1: never filed under a guessed tenant).
  - **Exempt, with no row:**
    - `reclaimUnattachedAudience`: the reclaim of a segment created on this tick whose attach failed;
    - `_settle-orphan-at-resend.ts`: the orphan drain and erasure settle of `audience_leaked` segments.

    These segments are created before any import, so they never held recipients; the only writer of an audience orphan is `reclaimUnattachedAudience`. This also keeps spec 140 slice 2c's ruling that a drain deletion writes no audit row.
  - A source scan pins the audited and the exempt call sites.
- **DA3.** Both rows carry ids and counts only, never an address or a hash:
  - `broadcast_id`, `related_member_id` (the requester), `resend_audience_id`;
  - `recipient_count` (disclosed only) and `reason` (deleted only);
  - `leg: 'import'` and `actor_role: 'system'`.

  Other properties:
  - The actor is `system:cron`.
  - Retention is as for other F7 rows (5 years).
  - A failed audit write is logged at error level and counted (`broadcasts_audit_emit_failed_total`), and the Resend call still proceeds. So a missing row is not proof that nothing was disclosed.
  - An adapter invariant error stops the call.
- **DA4.** Migration 0327 (0322 was taken by spec 140's dispatch lease) adds both values to `audit_event_type` (idempotent), following every step of the `add-audit-event` skill.
- **DA5.** The RoPA F7 section names these rows as the evidence for disclosure and deletion.

## Out of scope

- Import-leg tick concurrency and the dispatch lease: spec 140.
- `deriveMembershipAccess` answering `full` for a cancelled-not-expired, completed or missing cycle. This is a renewals semantics question; for erased members, DE1 makes it moot.
- Resend team-level contacts that outlive audience membership (residual 8a).
- Archive gaining Resend deletion: rejected by the maintainer on 30 Oct 2026.

## Open questions

None. Decided by the maintainer on 30 Oct 2026:
- close both windows;
- erasure only, not archive;
- add audit events rather than document-only;
- only slice 1 gates the flip.
