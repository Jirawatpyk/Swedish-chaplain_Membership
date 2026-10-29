# 138 — F7 import leg: a hold abandons the pending import, and the send can never go out twice

**Size**: L (`docs/workflow.md` § Sizes: PII, and more than a day of work). It was first sized M, which was wrong, and corrected on 29 Oct 2026. Application logic on the E-Blast dispatch path. It touches PII (Resend audiences hold member emails), the audit log (`broadcast_send_started`) and the annual E-Blast quota. No migration, no new flag.
**Status**: building. Opened as `fix/f7-import-hold-abandons-import` and brought under `feature-flow` retroactively on 29 Oct 2026, at the maintainer's request. The deviations are disclosed in `plan.md` § Complexity Tracking.
**Source**: the prerequisites for flipping `FEATURE_F7_IMPORT_AUDIENCE`. The maintainer said "แก้เลย" to the false "Resend import stuck" alarm on 29 Oct 2026, and "แก้ใน PR นี้เลย" to the two residuals the first build surfaced.

## Why

With `FEATURE_F7_IMPORT_AUDIENCE` on, an E-Blast goes out in two cron ticks.

- **Tick 1** creates a Resend audience and submits a contact import.
- **Tick 2** confirms the import, then creates and sends the Resend broadcast.

Since #403, a member whose membership is `suspended` (awaiting payment) is **held** at send time. Before this change, the import leg had these defects:

1. A hold that landed after tick 1 left the import pending. `audience_import_stuck_count` then false-alarmed for the whole hold. The stale import could fail the resumed send (`count_mismatch` / `audience_membership_drift`). `hasDispatchBegun` also refused staff cancel and re-time.
2. `resend_broadcast_id` was persisted only after `sendBroadcast`. A tick dying in that window re-entered, minted a second Resend broadcast and **sent to the whole audience again**. With (1)'s fix, a hold in that window would also have deleted the audience of a broadcast that was being sent.
3. Two ticks can work one row at once, because the dispatch cron holds no lease past its scan. Deleting an audience while its broadcast is queued makes Resend **fail** that broadcast silently (measured below). Our row would still advance to `sending`, but no mail would go out. `reconcile-stuck-sending` stamps `sent` only for a resource Resend reports as `sent` (`reconcile-stuck-sending.ts:253`), so the row would stay in `sending` as an unresolved provider status until a human acts. The member's E-Blast is lost silently.

The legacy (non-import) leg is LIVE in production. Its pre-send persist and inherited-id probe are the model this leg follows.

## Premises checked against the code and the provider

- The legacy leg already persists `resend_broadcast_id` before the send (`attachBroadcastId`, F4 #353). It probes an inherited id with `retrieveBroadcast` before re-sending (`dispatch-scheduled-broadcast.ts` Step 1b). The import leg had neither.
- `audience_import_stuck_count` (`src/app/api/internal/metrics/broadcasts-gauges/route.ts`) filters on `audience_import_id IS NOT NULL AND audience_import_completed_at IS NULL AND status = 'approved'`. It does not filter on `resend_broadcast_id`.
- `reclaim-orphaned-audiences` deletes only audiences whose broadcast **row** is gone. An audience left unreferenced on a live `approved` row would never be swept. Neither would the erasure path, which finds audiences through the row. So an audience is never deleted before the row stops pointing at it, and a "detach first, delete later" order is rejected.
- The dispatch cron (`dispatch-scheduled/route.ts`) uses `FOR UPDATE SKIP LOCKED` only on its scan. `maxDuration = 300` equals the cadence. Two overlapping ticks on one row are therefore possible.
- **Resend, measured 2026-10-29** on the production Broadcasts account, sending only to `delivered@resend.dev`:
  - `DELETE /broadcasts/{id}`:
    - `scheduled` → 200, and a later GET returns 404;
    - `queued` → **403** `validation_error` "Only draft or scheduled broadcasts can be deleted", and the send still completes.
  - `DELETE /audiences/{id}` while its broadcast is `queued` → 200, and the broadcast goes to **`failed`** within 5 s with no mail sent.
  - After an audience is deleted:
    - GET of its completed import → still `completed`;
    - `POST /contacts/imports` into it → **404** "Segment not found";
    - `POST /broadcasts` on it → **404** "Audience not found";
    - GET of the audience → 404.
  - `failed` and `scheduled` are real broadcast statuses. `normaliseStatus` maps both to `unknown`, and this change keeps it so (see DW5).
  - `/send` on a broadcast that is no longer `draft` returns **422 `validation_error` "Only draft broadcasts can be sent or scheduled"**. This holds whatever `Idempotency-Key` is sent: the same key, a different key, or none. It also holds after the broadcast reaches `sent`. In this test exactly one email reached the sink.
    - So Resend itself prevents a second send.
    - But `classifyResendError` maps 422 to `permanent`, and the `409 → idempotency_conflict` replay arm is never reached.
    - Result: on both legs, a second `/send` of an accepted broadcast is recorded as `failed_to_dispatch`, the member gets the "not sent" email and the quota slot is released, all for mail that was delivered.

## Done when

1. **A hold abandons the pending import.**
   - Trigger: a tick-2 hold on a row with a pending import and nothing handed to send.
   - A CAS claims the row before anything is deleted. It clears only the import columns, and keeps `resend_broadcast_id` and `resend_audience_id`.
   - Then the draft broadcast (if any) and the tick-1 audience are deleted at Resend.
   - Then one narrow CAS clears `resend_broadcast_id` and `resend_audience_id` together. Its predicate is `audience_import_id IS NULL`, and both values must still equal what was deleted.
   - Afterwards `audience_import_stuck_count` no longer counts the row, and `broadcasts_audience_import_abandoned_on_hold_total{tenant}` increments.
2. **A lost claim touches nothing.** If the CAS loses (another tick moved the row), nothing is deleted at Resend and the tick still returns the hold.
3. **The sender is fenced.** Every import-leg `attachBroadcastId` is fenced on the row's `audience_import_id`.
   - On the fresh-mint path, the single pre-send persist is the fence.
   - On the inherited-id path, the id is re-asserted once, fenced, immediately before `sendBroadcast`.
   - Fence lost (a hold claimed the row): nothing is sent, only a broadcast this tick minted is reclaimed, and the row keeps no bid from this tick.
   - Fence double race: the sender passes the fence, the hold claims and deletes the broadcast, and the sender's `/send` then gets 404. The sender re-reads the row, and if the bid or the import id is no longer its own, it returns non-terminal (the hold won). It records no `failed_to_dispatch` and sends no member email.
   - Proved against real Postgres both ways: claim first → fenced attach loses; attach first → claim loses.
4. **A partial abandon self-heals.** A later held tick that finds `approved` + import NULL redoes the broadcast delete, the audience delete and the narrow clear, on whatever ids the row still carries.
   - A 403 on the broadcast delete ("already out") stops the abandon. The bid and the audience stay on the row.
   - The next tick's probe then answers `queued` / `sent`, and the row catches up on the handed path (`advanceToSending` with no import id). It is neither deleted nor re-sent.
5. **No send can go out twice.** The broadcast id is persisted in its own transaction before `sendBroadcast`. A re-entered tick holding an inherited id probes it first:
   - `queued` / `sending` / `sent` → no second send. The standing gate, the import poll and the count checks are skipped, and the row advances to `sending` with the `broadcast_send_started` audit row.
   - `draft` / `cancelled` → the inherited id is reused (no second `createBroadcast`) and sent with the same idempotency key.
   - `not_found` → the dead id is never sent to. A fresh mint replaces it through a CAS that swaps the bid only while it still equals the dead value, fenced on the import id (`replacesResendBroadcastId`).
   - `failed` (and `scheduled`) stay `unknown` → refused fail-closed, like any status this build cannot read. Two reasons: the union is also read by the LIVE `reconcile-stuck-sending`, and the fence closes the one path that produced `failed` (decided 29 Oct 2026; recovery is in `broadcast-audience-build.md` § C).
   - `unknown`, or a probe throw of any class → refused fail-closed: the row stays `approved`, no FR-021 clock starts, nothing is recorded as failed and the member is not emailed. A retryable throw is retried, never budgeted or stamped.
6. **A dead audience self-heals.** When Resend answers 404 for a missing audience (`createBroadcast`, `createContactImport`) on a row with nothing handed to send, the import leg clears the audience and import columns, and any dead bid, by CAS and returns non-terminal.
   - The CAS predicate is `approved`, import = expected (or NULL on tick 1), audience = expected.
   - The next tick runs a fresh tick 1. No `failed_to_dispatch` is recorded and no member email is sent.
   - On `createBroadcast`, the "404 → audience missing" classification is opt-in and only the import leg passes it. A gateway unit test pins the legacy classification unchanged (no resource id → `permanent`).
7. **No `''` sentinels.** A row whose `resend_broadcast_id` is `''` does not loop. The handed path never writes `''` into `resend_audience_id`.
8. **The legacy leg is unchanged except where stated.** The shared persist-before-send and reclaim helpers keep the legacy leg's log names, metric labels and error shapes byte-identical, proved by its unit suites and `dispatch-persist-before-send` / `eblast-approved-exit-vs-dispatch` integration. The deliberate live changes, each listed in the PR with its own test (with the shared helpers, a refactor with no behaviour change, that makes five live surfaces):
   - a non-retryable inherited-id probe throw is now refused fail-closed;
   - a non-retryable `/send` failure is probed (DW12): `queued`/`sending`/`sent` → advanced as sent; `draft`/`cancelled` → today's terminal path; anything else → a non-terminal refusal;
   - an empty `resend_broadcast_id` (`''`) is accepted by `attachBroadcastId`'s CAS instead of looping.

   `normaliseStatus`, `classifyResendError` and `reconcile-stuck-sending` are unchanged. Every live change is a commit that can be reverted on its own.
9. **Staff can cancel or re-time a held E-Blast** once its import has been abandoned, because `hasDispatchBegun` is false. The maintainer confirmed this on 29 Oct 2026.
10. **Docs say what the code does.** Updated:
    - `docs/runbooks/eblast-approval.md`, `docs/runbooks/broadcast-audience-build.md` § C.4, `docs/runbooks/cron-jobs.md`;
    - `docs/observability.md` (catalogue, stuck-alarm row, § 29.8);
    - `docs/go-live-readiness.md` § 6.10;
    - `docs/changelog.md`;
    - the `hasDispatchBegun`, `cancel-in-flight-broadcasts-for-member` and gateway-port docblocks;
    - no "before the flag flips" line left for these defects.

11. **Every new or changed repo method has a cross-tenant layer-1 assertion.** This covers the claim, the narrow clear, the fenced attach and the replace-dead-bid CAS, in the style of `audience-import-repo.test.ts:622` (Principle I).
12. **A refused second `/send` is not recorded as a failure.** This applies on both legs, and the legacy leg is LIVE.
    - When `sendBroadcast` fails non-retryably, the broadcast is probed.
    - `queued` / `sending` / `sent` → the send is treated as accepted. The row advances to `sending`; there is no `failed_to_dispatch`, no member email and no released slot.
    - `draft` or `cancelled` (a scheduled send Resend cancelled, so never sent; the reading Step 1b gives it) → today's terminal handling.
    - Any other answer, or a failed probe → refused fail-closed and non-terminal.
    - Tested on both legs. The comments and docs that called a second `/send` UNMEASURED now cite the 2026-10-29 measurement.
13. **Remaining unmeasured behaviour is labelled.** DELETE on a `sending` / `sent` broadcast (only `queued` was measured) is marked UNMEASURED in code and docs.

## Out of scope

- Flipping `FEATURE_F7_IMPORT_AUDIENCE`. That is a Vercel env change the maintainer makes, and setting it is a production deploy.
- A dispatch lease or claim column on `broadcasts` (a migration). The row-level CAS fence covers the overlap without one.
- Paginating `getAudienceContactCount`, a known residual of the drift check.

## Open questions

None left for this spec. The erasure question moved out (below).

## Moved out: erasure (spec 139, blocks the flag flip)

- **Verified by reading the code on 29 Oct 2026. Not fixed here.**
  - The erasure cascade (`cancel-in-flight-broadcasts-for-member.ts:229`) skips an `approved` row that carries `resend_broadcast_id` as "dispatch begun".
  - The send-time standing gate (`_member-send-standing.ts:131-133`) reads only the halt list and the F8 access.
  - Erasure cancels the member's renewal cycle with a reason other than `coverage_ended`, so `renewal-cycle.ts` answers `full` while `expiresAt` is in the future.
  - Result: an erased member's E-Blast caught between the pre-send persist and the send can still go out.
- **Already live on the legacy leg since F4.** The import leg has the same window.
- **Fix:** it needs a cross-module port (members → broadcasts), so the maintainer chose (29 Oct 2026) to do it as its own spec, **139**. 139 must merge before `FEATURE_F7_IMPORT_AUDIENCE` is flipped.
