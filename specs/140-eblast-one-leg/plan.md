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
| 1 | Erasure deletes reachable drafts; refusals delete their draft | ED1–ED5 | pdpa-gdpr, security, reliability, spec-compliance | `140-eblast-one-leg-s1` | #713 · done |
| 2a | Bounded Resend calls (one signal spans every attempt, C = 10 s); no in-process retry on creates; the legacy leg skips import rows; `propagate` bounded | DL5a, DL7, DL8, carry R3 | security, reliability, pdpa-gdpr, spec-compliance | `140-eblast-one-leg-s2` | #719 · done |
| 2b | Lease + fencing token + pre-call check + budget; migration 0322; orphan-id table + drain; `failTerminally` choke point; the live-lease legacy skip | DL1–DL4, DL5b, DL6, carries R4 + R1 #5 | drizzle-migration, security, reliability, pdpa-gdpr, spec-compliance | `140-eblast-one-leg-s2b` | — · open |
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

### Slice 2 — split into s2a (bounded Resend calls) and s2b (the lease)

`chamber-os-architect` drafted this section from the code at `b65ddbe5e`. On 31 Oct 2026 the maintainer chose:
- **split.** s2a = gateway bounding, no in-process retry on creates, and the legacy skip of import rows. It has no migration. s2b = the lease, migration 0322, the orphan-id table, the drain and the `failTerminally` choke point.
- **a timed-out create writes an orphan row with no id** (`create_unconfirmed`), counted in a gauge. This is s2b.
- **any status change by a writer that does not hold the lease clears it,** in `applyTransition`. This is s2b.

Carries re-homed (D-043):
- R3 (`propagate` time bound) → s2a;
- R4 (the evidence-lock concurrency test) → s2b;
- R1 #5 (the refuse-arm transient DELETE) → s2b.

**s2a covers:** state-table cells 22 and 24, the "not retried" half of cell 15 (DL5a), DL8 and R3. **s2b covers** every other cell, DL5b and the live-lease legacy skip (cell 23, which needs 0322).

#### s2a test plan rows (RED first)

| Line | Test (file · name) | Level |
|---|---|---|
| DL5a | `tests/unit/broadcasts/infrastructure/resend-gateway-bounded-calls.test.ts` · "createBroadcast / createAudience / createContactImport: one request on a 5xx and on a timeout" | unit |
| DL8 | same file · it.each over every port method · "aborts at callTimeoutMs on a hung fetch" (50 ms) | unit |
| one signal across retries | same file · "a retried GET never exceeds C in total" | unit |
| DL7 | `dispatch-scheduled-broadcast.test.ts` · "the legacy leg skips a row that holds import columns" (cell 22); cell 24 is unchanged (existing suite) | unit |
| R3 | `subprocessor-erasure-adapter` unit · "propagate with a hung gateway returns within pairs × C + 1 s" | unit |
| contract | `tests/contract/resend/broadcasts-sdk.contract.test.ts` · creates send one request; the signal reaches `fetch` | contract |

#### s2a Verify (D-044)

The maintainer runs `/verify`. Claude prepares the seeds and does not drive the change.
- **Live:**
  - DL7: an `approved` row with import columns, flag OFF, GET the dispatch cron → `import_row_skipped`, with no `resend.*` line;
  - a wrong Bearer → 401;
  - an erasure of a terminal row holding a real **draft** → 404 at Resend.
- **Test-only:** DL5a, DL8 and R3, because they need a hung or failing provider.
- Resend goes to the sink address only. No `/send` and no cancel.

The full state table and the s2b plan follow.

#### Approach

1. **Migration 0322** (`new-migration` skill; `when` after 0321's):
   - `SET LOCAL lock_timeout = '5s'` (0311 precedent), reset as the last statement.
   - `broadcasts.dispatch_lease_token uuid NULL`, `dispatch_lease_expires_at timestamptz NULL`; `CHECK ((dispatch_lease_token IS NULL) = (dispatch_lease_expires_at IS NULL))`. Catalogue-only ADD COLUMN, no backfill.
   - `broadcasts_immutable_after_submit_fn` re-created: the GUC arm's blocklist gains both lease columns, so the erasure scrub cannot move a lease. The normal arm is a blocklist and needs nothing (0311 header, "WHY THE TRIGGER IS TOUCHED AT ALL"). `ALTER FUNCTION … SET search_path` repeated.
   - `broadcast_orphaned_resend_ids`: `tenant_id` (same type as `broadcasts.tenant_id`), `orphan_id uuid DEFAULT gen_random_uuid()`, `broadcast_id uuid NOT NULL` (**no FK**: `row_vanished` exists by definition, and retention / prune hard-delete rows), `resend_broadcast_id text NULL`, `reason text NOT NULL CHECK (reason IN (…the 8 below))`, `created_at`, `settled_at timestamptz NULL`, `outcome text NULL CHECK (outcome IN ('deleted','absent','retained','handed'))`.
     - PK `(tenant_id, orphan_id)`; partial UNIQUE `(tenant_id, resend_broadcast_id) WHERE resend_broadcast_id IS NOT NULL` (writers use `ON CONFLICT DO NOTHING`); partial index `(tenant_id, created_at) WHERE settled_at IS NULL` for the drain.
     - `CHECK ((resend_broadcast_id IS NULL) = (reason = 'create_unconfirmed'))`, `CHECK ((settled_at IS NULL) = (outcome IS NULL))`, `CHECK (resend_broadcast_id IS NULL OR btrim(resend_broadcast_id) <> '')`.
     - RLS ENABLE + FORCE, policy `tenant_id = current_setting('app.current_tenant', true)`; `chamber_app` gets SELECT / INSERT / UPDATE, no DELETE. Holds no content.
   - **Deviation from the agreed data model** (plan.md § Data model lists `deleted_at`): `settled_at` + `outcome` instead, because a `canceled` draft answers 403 for ever (MEASURED 2026-10-30, research Q1) and must settle as `retained`, not "deleted"; and `resend_broadcast_id` is nullable for DL5 (premise P1 below).

2. **Claim** (repo `claimDispatchLease`; replaces the step-1 tx body, `build-audience-tick.ts:431-438`, inside the same tx after `lockForUpdate`):
   ```sql
   UPDATE broadcasts
      SET dispatch_lease_token = gen_random_uuid(),
          dispatch_lease_expires_at = clock_timestamp() + make_interval(secs => $ttl_s)
    WHERE tenant_id = $slug AND broadcast_id = $id
      AND status = 'approved'
      AND (dispatch_lease_token IS NULL OR dispatch_lease_expires_at < clock_timestamp())
   RETURNING dispatch_lease_token;
   ```
   - `clock_timestamp()`, not `now()`: `now()` is the tx start, and `lockForUpdate` (`repo:922-929`) can wait ~23 s behind an erasure (D-040), which would stamp the lease 23 s short.
   - No row + status `approved` → skip `lease_held` (`broadcasts.audience_import.lease_held`, info), no Resend call. Not `approved` → the existing `wrong_status` skip.
   - Every lease statement carries `tenant_id = $slug`, runs in `runInTenant`, and calls `assertTenantBoundTx` first.
   - The scan (`route.ts:180-187`) adds `AND (dispatch_lease_token IS NULL OR dispatch_lease_expires_at < now())`, so held rows do not fill the 50.

3. **Release** (repo `releaseDispatchLease`, own tx, in a `finally` around the whole tick):
   ```sql
   UPDATE broadcasts SET dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL
    WHERE tenant_id = $slug AND broadcast_id = $id AND dispatch_lease_token = $mine;
   ```
   - No status predicate: the row may be `sending` or `failed_to_dispatch` by then, and `markAudienceImportCompleted` (`repo:1442`, no status predicate) runs after `sending`.
   - 0 rows is not an error (a non-holder exit already cleared it). A failure logs `lease_release_failed`; the lease then expires (≤ 2 ticks, row 13 of the table).
   - **Non-holder exits clear the lease** (concretises "hold and cancel also clear the token"): plain `applyTransition` NULLs both columns on any status change, in the same place it resets `dispatchFirstFailedAt` (`repo:974-980`). That covers staff cancel, confirm-schedule cancel, withdraw, start-formatted-version and the erasure cancel. The holder's own transitions go through a new `applyTransitionUnderLease` (token in the WHERE, columns left for the release).

4. **Pre-call lease check** (repo `checkDispatchLease`, own short tx), before each of `createAudience`, `createContactImport`, `createBroadcast`, `sendBroadcast`, `deleteAudience`, `deleteBroadcast` / `deleteBroadcastOnce` on the import leg:
   ```sql
   SELECT 1 FROM broadcasts
    WHERE tenant_id = $slug AND broadcast_id = $id
      AND dispatch_lease_token = $t
      AND dispatch_lease_expires_at > clock_timestamp() + make_interval(secs => $headroom_s)
      FOR UPDATE;
   ```
   - The design's "UPDATE" is realised as `SELECT … FOR UPDATE`: the same row lock, so the check queues behind an erasure's lock (D-040 order) and then sees a cleared token; it writes nothing, so `broadcasts_set_updated_at` does not fire.
   - 0 rows → no call; skip `lease_lost` (token gone) or `lease_expiring` (headroom short). The import-id-null restart (`:912`, no claim today) is covered: its two deletes are preceded by this check.

5. **Constants** (one module, `application/use-cases/_dispatch-lease.ts`; `C` lives in the gateway port so infrastructure reads it from there):

   | Constant | Value | Derivation | Label |
   |---|---|---|---|
   | `C` = `RESEND_CALL_TIMEOUT_MS` | 10 000 | D-040's `*Once` bound; ≈ 20× the RTT 0.48 s; import POST 412 ms, import GET 306 ms | MEASURED 2026-09-08 (research § Limits, endpoint table) |
   | `E` erasure row-lock hold | 23 000 | 10 s DELETE + 3 s pause + 10 s GET | D-040 |
   | `P` = `REPROBE_PAUSE_MS` | 3 000 | existing | code |
   | `N` Resend calls, longest path | 9 | probe, re-probe, `getContactImport`, `getAudienceContactCount`, `createBroadcast`, `sendBroadcast`, refused-send probe, then `failTerminally`'s reclaim: `deleteBroadcastOnce` + `retrieveBroadcastOnce` | counted from the code |
   | `k` lock waits per row | 2 | the claim, plus one pre-call check (one cascade per row per tick) | ASSUMED |
   | `D` DB + resolve, one row | 15 000 | ~15 short statements + one `resolveRecipients` at the 900 ceiling | **ASSUMED**: build step measures p99 on dev (seeded 900) and replaces it |
   | `W_max` | 154 000 | k·E + N·C + P + D = 46 + 90 + 3 + 15 | derived |
   | `M` = `LEASE_MARGIN_MS` | 15 000 | ≥ C (design rule) + 5 s for the post-call CAS | derived |
   | pre-call headroom | 25 000 | C + M | derived |
   | `LEASE_TTL_MS` | 330 000 | > `maxDuration` 300 s (second line) and ≥ W_max + M = 169 s | derived |
   | row-start cutoff | 131 000 | maxDuration − W_max − M = 300 − 154 − 15 | derived |

   - The route passes `{ tickStartedAt, maxDurationMs }` into deps and starts no row after the cutoff (the rest stay `approved`, unleased, for the next tick). `MAX_PER_TICK` stays 50.
   - A dead holder: claimed at t, expires t + 330 s, so the t + 300 tick skips the row and the t + 600 tick reclaims it: about 2 ticks, documented in `broadcast-audience-build.md`.
   - D-040's 23 s figure does not change (C = the `*Once` bound).

6. **Bounded calls** (`resend-broadcasts-gateway.ts`):
   - **One signal per call**, `AbortSignal.timeout(C)`, spanning every attempt. `withRetry` (`:227-271`, 6 attempts + 31 s backoff) backs off only while the remaining budget exceeds the next backoff + 1 s. A per-attempt timeout would make a retried call 6C + 31 s and break "call timeout ≤ margin".
   - SDK calls pass `{ signal }` through `RequestOptions` (resend 6.35: `post` / `get` / `delete` spread `options` into `fetch`, `index.mjs:1764-1819`). An aborted SDK call comes back as `application_error`, `statusCode: null` (`index.mjs` outer catch), which `httpStatusOf` reads as retryable `network`. An abort while reading the body rethrows `signal.reason` (`index.mjs:1707`): the adapter maps a `TimeoutError` / `AbortError` to retryable `timeout`.
   - `importFetch` drops from 30 s (`:1091`) to C.
   - **Creates are never retried** (security H-3): `createAudience`, `createBroadcast`, `createContactImport` make one attempt. GET, DELETE and `/send` retry inside C. This applies to both legs (shared adapter).
   - `removeContactFromAudience` is a DELETE: it keeps retrying, now inside C, so `propagate` is bounded by (pairs × C). See premise P2.
   - The factory takes `callTimeoutMs` so DL8 can run a hung fake at 50 ms (`AbortSignal.timeout` runs on real timers; fake timers do not advance it).

7. **Fencing token in every CAS.** A branded `LeaseToken`; each method takes `lease: LeaseToken | null` as a **required** parameter (the legacy leg passes `null` explicitly). An optional parameter is the "forgotten at a call site" class. With a token: `AND dispatch_lease_token = $t`. The 12 sites are listed in the test plan. A lost token throws `BroadcastConcurrentMutationError` with `observedStatus: 'lease_lost'` (`throwConcurrentMutation` reads the token), and every caller maps it to a concurrent skip, never a failure write. `failTerminally`'s catch (`:2463`) learns this arm, so a lost lease is not `cleanup_failed`.

8. **Orphan-id writers** (`ON CONFLICT DO NOTHING`, own tx, best-effort; a failed insert logs and is the accepted 8d residual):

   | reason | Where | id |
   |---|---|---|
   | `attach_lost` | `_persist-minted-broadcast-id.ts:109`, when the reclaim fails | minted |
   | `row_vanished` | `:113`, when the reclaim fails | minted |
   | `persist_failed` | `:142`, when the reclaim fails | minted |
   | `read_back_failed_kept` | `:139` | minted |
   | `dead_broadcast_replaced` | `build-audience-tick.ts:1865-1871` | the replaced id |
   | `dead_broadcast_kept` | `build-audience-tick.ts:967` | the kept id |
   | `terminal_reclaim_undecided` | the `failTerminally` choke point (item 10) | the row's id |
   | `create_unconfirmed` | `createBroadcast` answered retryable with `subKind` `network` / `timeout` (status 0 or an abort: a timeout cannot be told from a request that never arrived). Not a 429 (`subKind: 'api'`, `gateway:197-208`), which created nothing. A 5xx is a judgment call (the request may have landed): proposed as included, to decide at review | **NULL** |

   Only `createBroadcast` writes orphan rows:
   - An unconfirmed audience is named `broadcast-<tenant>-<id>` (`build-audience-tick.ts:1452`). The daily `reclaim-orphan-audiences` cron exists for exactly that (`vercel.json:13`).
   - An unconfirmed import lands in an audience the row still references, so the next tick's `stale_audience` teardown removes it (`:1441-1443`).

   `_reclaim-minted-broadcast.ts` returns `'reclaimed' | 'leaked'` so the persist helper knows when to write the row. Both legs write rows (the helper is shared).

9. **The drain**: `cleanupOrphanedAudiences` gains a second pass after the audience loop, at the same concurrency of 5, up to 20 rows:
   - It lists unsettled rows with a non-null id, older than the grace period, **and no `broadcasts` row in the tenant holding that id** (`NOT EXISTS … b.resend_broadcast_id = o.resend_broadcast_id`). `read_back_failed_kept` keeps the resource because the id may be on the row (`_persist-minted-broadcast-id.ts:139-144`).
   - `deleteBroadcastOnce`: `deleted` / `absent` settle as such. `forbidden` → `retrieveBroadcastOnce`: `canceled` / `failed` → `retained`, `queued` / `sent` → `handed` (8c). Anything else stays for the next tick.
   - The settle is a CAS on `settled_at IS NULL`. A 4th documented port exception: an id read from this table.
   - `create_unconfirmed` rows are never drained. They feed the gauge `broadcasts_orphaned_resend_ids_unconfirmed{tenant}` (the 8d residual, with a Review-by date).
   - The `cleanup-audiences` route declares no `maxDuration` today. It gets `300`, and the drain stops at 240 s.

10. **One reclaim choke point** (pdpa M-1): `failTerminally` re-reads the row's `resend_broadcast_id`. When one is held and no earlier arm settled it this tick, it runs a pre-call check, then slice 1's `deleteDraftBeforeRefusal`, **before** the terminal tx:
    - `deleted` / `absent` / `cancelled` / `failed` → terminal, with `resendDraftOutcome`;
    - handed → a concurrent skip: no terminal write, no member email;
    - undecided → an orphan row `terminal_reclaim_undecided`, then terminal.

    The two refuse arms already delete first and pass `draftSettled`, so nothing is deleted twice. `enqueueDispatchFailureNotification` (`:2541`) still runs only after the CAS commits.

11. **The legacy leg skips import rows** (decision 8). In `dispatchScheduledBroadcast` step 1 (`:494-511`), inside the lock tx: a row with `audience_import_id` or `audience_import_submitted_at` set → `broadcasts.dispatch.import_row_skipped`, return `broadcast_invalid_state_transition`, no Resend call. **Extension (P3):** a live lease token is skipped too (`lease_held`).

12. **Docs** (in the slice's diff):
    - RoPA 8d: the residual narrows to `create_unconfirmed` plus the DB-down and crash-between-mint-and-persist cases, with a Review-by date; also the `:255` item the design names.
    - `docs/observability.md`: the unconfirmed-orphan gauge and the `lease_held` / `lease_lost` / `lease_expiring` / `lease_release_failed` log names.
    - `docs/runbooks/broadcast-audience-build.md`: the lease and the ~2-tick delay after a dead holder; the stale runbook `:77`.
    - D-040's 23 s figure is unchanged (C = the `*Once` bound).
    - #699 closes on merge.

#### State table: slice 2 (writers × row status × lease × Resend answer)

Lease: none / live-mine / live-other / expired. "Holder" = the tick that claimed. 29 cells; identical cells are collapsed.

| # | Writer | Status | Lease | Resend / other | Decision | Test (file · name) | Split |
|---|---|---|---|---|---|---|---|
| 1 | tick A | approved | none | — | claim → token | `dispatch-lease-repo.test.ts` · "claim on an unleased approved row returns a token" (new) | a |
| 2 | tick A | approved | expired | — | claim takes over, new token | same · "claim takes over an expired lease" (new) | a |
| 3 | tick A / B (overlap) | approved | live-other | — | `lease_held`, 0 gateway calls, 0 writes | `import-leg-lease-pair.test.ts` · DL1 both orders (new); unit `build-audience-tick-lease.test.ts` · "a held lease skips with no gateway call" (new) | a |
| 4 | tick A | not approved | any | — | `wrong_status` skip | `dispatch-lease-repo.test.ts` · "claim refuses a non-approved row" (new) | a |
| 5 | holder | approved | live-mine, headroom ≥ C+M | — | irreversible call made | `build-audience-tick-lease.test.ts` · "pre-call check passes → call made" (new) | a |
| 6 | holder | approved | live-mine, headroom < C+M | — | no call, `lease_expiring`, release | same · "within C+M of expiry no call is made" (new) + repo "check refuses inside the headroom" | a |
| 7 | stale holder (lease expired + retaken) | any | live-other | — | every pre-call check false; every CAS 0 rows; no column written | `dispatch-lease-repo.test.ts` · it.each "stale token → 0 rows" over the 12 CAS + the check (new) | a |
| 8 | holder, after a mint | approved | live-other at attach | — | concurrent skip; reclaim; orphan row if the reclaim fails | `build-audience-tick-lease.test.ts` · "a lost-token attach is a concurrent skip and the mint is reclaimed" (new) | a |
| 9 | holder → `failTerminally` | approved | lost | — | no terminal write, no email, concurrent skip | same · "a lost lease never writes failed_to_dispatch" (new) | a |
| 10 | holder → `failTerminally` | approved | live-mine | row holds a draft: deleted / absent / canceled / failed | reclaim, then terminal with `resendDraftOutcome` | same · it.each "choke point clears the draft" (new) | a |
| 11 | same | same | same | 403 + handed | concurrent skip, no terminal | same · "choke point: a handed draft is a skip" (new) | a |
| 12 | same | same | same | undecided | orphan `terminal_reclaim_undecided`, then terminal | same · "choke point: undecided writes an orphan row" (new) + `orphaned-resend-ids.test.ts` | a |
| 13 | holder dies | approved | live-mine (dead) | — | scan excludes until expiry (≤ 330 s), then row 2 | `cron-dispatch-scheduled.contract` · "the scan excludes a live lease" (new) | a |
| 14 | holder, end of tick | any | live-mine / cleared | — | release; 0 rows not an error | `dispatch-lease-repo.test.ts` · "release clears only my token, any status" (new) | a |
| 15 | holder → `createBroadcast` | approved | live-mine | timeout / retryable | one attempt; orphan `create_unconfirmed` (id NULL); FR-021 path | gateway `resend-gateway-bounded-calls.test.ts` · "createBroadcast is not retried" (new) **(b)** + `build-audience-tick-lease.test.ts` · "a retryable create writes create_unconfirmed" **(a)** | **a+b** |
| 16 | erasure (D-040) | approved | none / live-other | holds the row lock, then cancels | claim waits ≤ 23 s, then `wrong_status` skip | `dispatch-lease-erasure-order.test.ts` · DL3 (new, `chamber_app`) | a |
| 17 | erasure | approved | live-mine (A mid-tick) | cancels (`applyTransition` clears the lease) | A's next check waits, sees no token → no call; A's CAS → 0 rows | same · "a cascade cancel mid-tick ends the holder" (new) | a |
| 18 | erasure | approved | live-mine | undecided, no write | lease untouched; A continues after the lock | `erasure-vs-dispatch-begun.test.ts` (existing, re-run) | a |
| 19 | staff exit (cancel, schedule-cancel, withdraw, new version) | approved | any; `hasDispatchBegun` true | — | refused `sending_started` (existing) | existing `eblast-approved-exit-vs-dispatch.test.ts` | — |
| 20 | staff exit | approved | live-mine; `hasDispatchBegun` false (tick-1 window) | — | exit allowed; lease cleared; A stops at its next check / CAS; a left audience is torn down by cleanup (terminal) or by the next tick 1 (`stale_audience`) | `dispatch-lease-repo.test.ts` · "a non-holder status change clears the lease" (new) | a |
| 21 | staff re-time (approved → approved) | approved | live-mine | — | lease kept (no status change) | same · "a same-status write keeps the lease" (new) | a |
| 22 | legacy leg | approved | any | import columns set | `import_row_skipped`, no call | `dispatch-scheduled-broadcast.test.ts` · DL7 (new case) | b |
| 23 | legacy leg | approved | live-other; no import columns | — | `lease_held` skip (P3 extension) | same · "legacy skips a live lease" (new) | a (needs 0322) |
| 24 | legacy leg | approved | none / expired; no import columns | — | unchanged | existing suite | b |
| 25 | drain | — | — | id still on a `broadcasts` row | skipped | `cleanup-orphaned-audiences.test.ts` · "an id a row still holds is not drained" (new) | a |
| 26 | drain | — | — | DELETE deleted / absent | settled as such | same · it.each (new) + `orphaned-resend-ids.test.ts` DL6 | a |
| 27 | drain | — | — | 403 + canceled / failed → retained; + queued / sent → handed | settled | same · it.each (new) | a |
| 28 | drain | — | — | retryable / other / 403 + draft | left for next tick | same · it.each (new) | a |
| 29 | drain | — | — | id NULL (`create_unconfirmed`) | never drained; counted in the gauge | same · "unconfirmed rows are counted, not drained" (new) | a |
| — | `reconcile-stuck-sending` | sending > 24 h (`route.ts:110`) | — | — | **disjoint**: no live lease outlives 330 s; no cell | — | — |
| — | retention sweep | terminal only | — | — | **disjoint**; it hard-deletes rows, hence no FK on the orphan table | — | — |

#### Test plan rows (slice 2)

RED first: every row below except the two marked *already green* (they pin existing behaviour) and the positive controls (they must fail on a mutant instead).

| Line / CAS | Test that goes red first (file · name) | Level |
|---|---|---|
| DL1 | `tests/integration/broadcasts/import-leg-lease-pair.test.ts` · "two concurrent ticks: one audience, one import, one broadcast, one /send" × {A first, B first} (barrier in the fake gateway) | integration (Neon pair) |
| DL2 | `dispatch-lease-repo.test.ts` it.each below + `build-audience-tick-lease.test.ts` · "an expired holder makes no Resend call after expiry" | integration + unit |
| DL3 | `dispatch-lease-erasure-order.test.ts` · "the claim waits behind an erasure row lock, then skips the cancelled row" | integration, `chamber_app` |
| DL4 | `dispatch-lease-repo.test.ts` · "two tenants, one uuid: claim and release touch only their own row", as `chamber_app`, plus the BYPASSRLS-owner builder case (application predicate alone; s1 security L1 precedent) | integration |
| DL5 | gateway · "createBroadcast / createAudience / createContactImport: one request on a 5xx and on a timeout" + tick unit · "a retryable create writes create_unconfirmed" | unit |
| DL6 | `tests/integration/broadcasts/orphaned-resend-ids.test.ts` · "a failed reclaim writes an orphan row and the drain settles it" (fake gateway) + RLS cross-tenant read case | integration |
| DL7 | `dispatch-scheduled-broadcast.test.ts` · "the legacy leg skips a row that holds import columns" | unit |
| DL8 | `tests/unit/broadcasts/infrastructure/resend-gateway-bounded-calls.test.ts` · it.each over every port method: "aborts at callTimeoutMs on a hung fetch" (50 ms; MSW `delay('infinite')`) | unit |
| CAS 1 `attachAudienceId` | repo it.each "stale token → 0 rows" + SQL shape "carries tenant + token" (`broadcast-lease-sql-shape.test.ts`, new) | integration + unit |
| CAS 2 `attachAudienceImport` | same pair | |
| CAS 3 `attachBroadcastId` (persist + handed path) | same pair | |
| CAS 4 `attachResendIds` | same pair | |
| CAS 5 `applyTransitionUnderLease('sending')` | same pair | |
| CAS 6 `applyTransitionUnderLease('failed_to_dispatch')` | same pair + "no member email on a lost lease" (unit) | |
| CAS 7 `releaseAudienceImport` | same pair | |
| CAS 8 `releaseResendAudience` | same pair | |
| CAS 9 `clearDispatchRetryClock` | same pair | |
| CAS 10 `markDispatchRetryStarted` | same pair | |
| CAS 11 `markAudienceImportCompleted` | same pair | |
| CAS 12 the no-import restart's deletes | tick unit · "the stale-audience restart checks the lease before each delete" | unit |
| claim / release | rows 1, 2, 4, 14 above | integration |
| plain `applyTransition` clears the lease | `dispatch-lease-repo.test.ts` · rows 20, 21 | integration |
| scan filter + cutoff | `cron-dispatch-scheduled.contract` · "the scan excludes a live lease" · "no row starts after maxDuration − W_max − M" | contract |
| TTL / budget pin | `tests/unit/broadcasts/application/dispatch-lease-budget.test.ts` · "TTL > maxDuration", "TTL ≥ W_max + M", "cutoff = 300 − 154 − 15 s", "C ≤ M"; positive control: a TTL of 300 s and a cutoff of maxDuration − M each fail | unit |
| migration 0322 | `pnpm db:migrate` on dev + `db:verify`; `eblast-immutability-trigger.test.ts` · "the redaction GUC cannot move the lease columns" (new); the pair CHECK and the orphan CHECKs (`eblast-0308-check-constraints.test.ts` pattern) | integration |
| positive controls | SQL-shape gate fails when its parse yields 0 CAS (`;\r?\n`, rules.md); mutation: drop the token from one CAS → its stale-token case goes red | unit |
| two-tick happy path *already green* | `audience-import-two-tick.test.ts` (re-run with the lease) | integration |
| erasure undecided *already green* | `erasure-vs-dispatch-begun.test.ts` | integration |

e2e: n/a (no UI).

#### Carried into slice 2 from slice 1 (D-043; each closes here)

| From | Finding | Closing test |
|---|---|---|
| R4, senior-tester LOW–MEDIUM | The `broadcasts-evidence:` advisory lock has no concurrency test; the terminal pass records evidence with no row lock | `already-sent-evidence.test.ts` · "two concurrent recorders, one being the terminal pass with no row lock, write one evidence row" (the Neon pair harness from DL1; both orders) |
| R3, reliability note | `subprocessorErasure.propagate` has no time bound: `removeContactFromAudience` runs `withRetry` (~31 s) on an untimed SDK call (`gateway:620`, `subprocessor-erasure-adapter.ts:114`) | adapter unit · "propagate with a hung gateway returns within pairs × C + 1 s and counts each as failed" (DL8's 50 ms factory) |
| R1, code-review #5 (+ pdpa L-2) | A transient DELETE on the refuse arm leaves the draft until erasure (plan.md:211) | rows 10–12: `build-audience-tick-lease.test.ts` · "choke point: undecided writes an orphan row", and `dispatch-scheduled-broadcast.test.ts` the legacy twin; DL6 drains it |

#### Verify plan (D-044)

The maintainer runs `/verify`; Claude prepares the worktree, the `.env.local` and the seeds, and never drives the change.
- **Driven surface:** the dispatch cron and the `cleanup-audiences` cron on :3400.
- `isF7ImportAudienceEnabled()` needs both flags (`feature-flags.ts:91`): the worktree's `.env.local` only, never Vercel.
- **Live (nothing undeletable left):** the scan skipping a live foreign lease; an expired lease taken over and released (tick 1 only); the legacy skip; the drain on a uuid-shaped id that does not exist.
- **Not live:** tick 2 (a `/send` leaves a `sent` broadcast Resend will not delete). The step-3 import upserts the sink contact, which is deletable.
- **Test-only:** DL1 (Neon pair, both orders), DL2 (needs a forced expiry mid-run), DL3 (erasure lock order), DL4 (two tenants as `chamber_app`), DL5 (needs a hung provider), DL8 (hung fake), and DL6's real-draft delete (integration with a fake).

Ready to paste:

```
/verify PR #<s2-PR> · worktree <s2-worktree> · branch 140-eblast-one-leg-s2 · :3400, Neon dev, tenant swecham.
Done-when, live: the lease mechanics behind DL1/DL2 (claim, scan exclusion, takeover of an expired lease, release); DL6 drain wiring (the 'absent' arm); DL7. DL1 itself is the Neon pair test; DL2-DL5 and DL8 are test-only: read their CI rows.
Safety: Resend sink delivered@resend.dev only; stop at tick 1 (never let a tick-2 /send run); never set either flag in Vercel. Before step 1, check the shared Resend account holds <= 1 non-General segment (Free allows 3, General is one; research § Limits): R3's tick 1 creates one. Run step 4 only after the DL7 unit case is green in CI: a broken skip would let the legacy leg reuse R3's audience and /send.
Setup: .env.local has FEATURE_F7_BROADCASTS=true and FEATURE_F7_IMPORT_AUDIENCE=true. Seeds (prepared): R2 approved+due, sink recipient, foreign lease expiring in +24 h (no step, restart included, ever lets the scan pick it); R3 approved+due, sink recipient, foreign lease expired 1 min ago; O1 orphan row, resend_broadcast_id = a random uuid, created_at 2 h ago (past the 1 h grace).
0. pnpm db:query "SELECT count(*) FROM broadcasts WHERE tenant_id='swecham' AND status='approved' AND scheduled_for <= now()" must be 2 (R2, R3). Any other row: stop (dev litter would be dispatched).
1. curl -H "Authorization: Bearer $CRON_SECRET" localhost:3400/api/cron/broadcasts/dispatch-scheduled
   Expect: R2 not processed, its token and expiry unchanged; R3 import_submitted, its token replaced then NULL (log lease_claimed -> lease_released), audience_import_id set. Read with pnpm db:query.
2. Wrong input: the same GET with a wrong Bearer -> 401; R2 and R3 unchanged since step 1.
3. GET /api/cron/broadcasts/cleanup-audiences.
   Expect: O1 settled_at set, outcome 'absent' (a 404 for a non-existent id is ASSUMED; if Resend answers otherwise, O1 stays unsettled: report it). The same tick also deletes the Resend audience of any terminal dev row past the grace: expected, not a finding.
4. Set FEATURE_F7_IMPORT_AUDIENCE=false, restart :3400, GET dispatch-scheduled.
   Expect: R3 (it holds import columns since step 1) logs broadcasts.dispatch.import_row_skipped, no resend.* line for it, row unchanged; R2 not processed.
Teardown (not evidence): run the prepared step "r3-terminal" (R3 -> failed_to_dispatch on dev). Its updated_at is then now(), and cleanup-audiences waits out GRACE_MS = 1 h (route.ts:44), so GET cleanup-audiences again after >= 1 h and confirm R3.audience_deleted_at is set (the segment is freed).
Report each step against its Done-when line.
```

#### Split (decided by the maintainer, 31 Oct 2026: s2a first, then s2b)

Split. The cells fall into two lifecycles that share one cell:
- **(a) the leased row:** cells 1–14, 16–18, 20–21, 23 and 25–29: **25 cells**. These are the claim, the token CASes, the pre-call checks, the budget, the orphan table, the drain, the choke point and migration 0322.
- **(b) gateway bounding, no retry on creates, the legacy import-column skip:** cells 22 and 24: **2 cells**, plus DL8, which is not a row cell. No migration and no multi-writer table. It also closes carry R3 (propagate).
- **Shared or neither:** cell 15 is shared (below). Cell 19 is existing behaviour. 25 + 2 + 1 + 1 = 29.
- **The straddler:** DL5 (cell 15). "Not retried" belongs to (b); "writes an orphan row" needs (a)'s table. Write DL5 as DL5a in s2a and DL5b in s2b.
- **s2a = (b) first.** C, and with it W_max, the TTL and the cutoff, comes from (b). The same applies to cell 23 (the legacy live-lease skip): it needs 0322, so it goes in s2b.
- **D-043 bookkeeping.** The carries named "slice 2" must be re-homed in the agreed plan: R3 → s2a; R4 and R1 #5 → s2b.
- **Risk.** s2a changes the **live** legacy leg and erasure: there are no create retries, and every call gives up in 10 s instead of 31 s or more. A transient create failure now waits for the next tick, inside the FR-021 hour.

#### Premises the code contradicts (accepted 31 Oct 2026)

- **P1.** DL5's orphan row cannot carry an id. A timed-out create returns none. The SDK's outer catch gives `application_error` with `statusCode: null`, and `httpStatusOf` reads that as `retryable/network`, so a timeout looks the same as a request that never arrived (`gateway:160-164`, `index.mjs` fetchRequest). → `resend_broadcast_id` must be nullable for `create_unconfirmed`, and those rows are never drained.
- **P2.** "Only GET, DELETE and `/send` retry" conflicts with "removes the up-to-31 s retry inside eraseMember". `removeContactFromAudience` is a DELETE (`gateway:620-640`), and `propagate` is the step a re-drive cannot repeat (plan.md round 2). → Keep its retry, bound it inside C.
- **P3.** The legacy skip rule (import columns) misses a tick-1 row that has a live lease and a `resend_audience_id` but no import yet. `hasDispatchBegun` ignores the audience id (`in-progress-statuses.ts:84-89`), and the legacy leg reuses `resend_audience_id` (`build-audience-tick.ts:2259-2264`). → The legacy leg also skips a live lease.
- **P4.** 0322 must amend the immutability trigger's GUC blocklist (0311 header); the design omits this.
- **P5.** The claim must use `clock_timestamp()`. `now()` after `lockForUpdate` (`repo:922-929`) can be ~23 s stale.
- **P6.** "Call timeout ≤ margin" holds only if one signal spans `withRetry`'s 6 attempts (`gateway:227-271`).
- **Minor.**
  - The pre-call "UPDATE" is realised as `SELECT … FOR UPDATE`.
  - The enqueue is at `:2541`, not `:2508`.
  - `createContactImport` is a raw fetch with 30 s (`:1091`), not an SDK call.
  - `cleanup-audiences` declares no `maxDuration`.
  - The plan's `deleted_at` becomes `settled_at` + `outcome`.
  - The cleanup log line writes `cause: e.message` (`cleanup-orphaned-audiences.ts:147`), against the log-hygiene rule. It predates s2, but s2 touches the file.

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

1. **What the terminal list holds** (superseded by round 2: every sending-started status is now left out, as `sent` is). Every `BROADCAST_STATUSES` value outside `IN_PROGRESS_BROADCAST_STATUSES`, bar `sent`: `draft`, `sending`, `rejected`, `cancelled`, `failed_to_dispatch`, `partially_sent`, `partial_delivery_accepted`, `expired_no_member_response`; `resend_broadcast_id` NOT NULL and `<> ''`. Derived from the Domain constant (`terminalDraftStatusPredicate`). `sending` / `partially_sent` / `partial_delivery_accepted` hold a handed object: the DELETE answers 403 and the probe records it retained. `sent` is left out: its copy is known undeletable and the F7 retention sweep owns it.
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
| ED4 | Unit tests on both legs (`build-audience-tick-failure-paths.test.ts`, `dispatch-scheduled-broadcast.test.ts`), and since review round 2 four real-Postgres cases in `eblast-send-time-standing.test.ts` (per leg: a halted refusal deletes the draft and records `resendDraftOutcome`; a 403 + handed probe writes nothing). Not driven live: a live run would need a halted member with a due row and a real draft. |
| ED5 | `broadcast-erasure-terminal-sql-shape.test.ts` (the status CAS), plus the mutation proof (a) above. |
| Wrong input | Erase with `identityVerified:false` and no `verificationMethod` → **400** `invalid_body`, and the draft is still `draft`. |

**Re-Verify on the final head `3a3248a1d` (31 Oct 2026, after review rounds 1–6).** It used the same setup and the same probe, and its seeds were removed afterwards. Every result matched the first run:

| Done-when | Evidence |
|---|---|
| ED1 | Erase → `200 cascadesComplete:true`. The draft → **404**. `member_erased` has `resend_drafts_cleared:1, resend_copies_retained:0, broadcasts_already_sent_count:0`. |
| ED2 | Resend answers `canceled`. Erase → `200 cascadesComplete:true`. `member_erased` has `resend_drafts_cleared:0, resend_copies_retained:1, broadcasts_already_sent_count:0`. |
| Wrong input | **400** `invalid_body`, and the draft is still `draft`. |

**Gates on `3a3248a1d`.** The coordinator ran them one at a time, after the subagent had stopped:

| Gate | Result |
|---|---|
| `pnpm check` | exit 0 (run by the builder after the last code commit) |
| Contract | 260 files, 2913 passed, 2 todo |
| Unit (`broadcasts`, `broadcast`, `members`, `lib`) | 563 files, 6412 passed |
| Integration: broadcasts | 6 files, 51 passed |
| Integration: members | 10 files, 53 passed (the touched files, plus `erase-member*`, `reconcile-erasures` and `find-stuck-erasures`) |
| Full `pnpm test:coverage` | not run locally: low memory killed two runs. CI runs it. |

**Review close.** Round 7 was a targeted confirmation of the round-6 commits. It returned no High and no Medium (`[]`), so the stop rule ends the review. The Lows still open are listed in the PR.

**The maintainer's `/verify` (31 Oct 2026, before merge, on `8e8c740fe`): PASS.** This is the Verify evidence under D-044. Claude's own drives above came before that rule and are kept as history. The run used the branch on :3400, dev Neon, and the live Resend account with the sink address only. No broadcast was sent or cancelled, so nothing undeletable was left behind.

| Done-when / probe | Observed |
|---|---|
| ED1 | A `failed_to_dispatch` row holding a real draft. Erase as super-admin → 200 `cascadesComplete:true`. The draft → **404**. `member_erased` has `resend_drafts_cleared:1, resend_copies_retained:0, broadcasts_already_sent_count:0`. |
| Probe: ordinary admin | **403**. The draft is untouched. |
| Probe: wrong method | `GET` on the erase route → **405**. |
| Probe: wrong input | `identityVerified:false` → **400** `invalid_body`. The draft is untouched. |
| Probe: erase twice | 200, and a **second** `member_erased` row is written. This is probably pre-existing and is tracked as #717, outside this spec. |

ED2 was left out of the command on purpose: its setup cancels a queued broadcast, and Resend cannot delete a cancelled one. ED2 is covered by `erasure-terminal-drafts.test.ts`. The full report is on PR #713.

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

### Slice 1 — review round 3 (`/code-review high`; pdpa APPROVE, reliability MERGEABLE; 31 Oct 2026)

Commits: RED `b7787b8b1` and GREEN `59a30c0fd`. Docs land in the commit after them. At RED, the unit and contract rows failed on the missing `deferredCount`, the failed-clears case, the 60 s reserve and the paused count.

| Item | Disposition |
|---|---|
| 1 — the runbook's stale `failed` reading | **Fixed** (docs). The recognise list and the grep names now use `forbidden_probe_failed` / `absent_probe_failed` (the bounded probe names `failed`). The recovery paragraph says the in-flight arm treats `failed` as undecided until slice 3, while a terminal row records it as retained and a standing refusal clears it. |
| 2 — the reserve is too thin | **Fixed** (RED `b7787b8b1`, GREEN `59a30c0fd`). `ERASURE_CASCADE_RESERVE_MS` is now 60 s. Its docblock names the worst case it covers: one row (DELETE 10 s + GET 10 s, each `AbortSignal.timeout`-bounded, + the evidence tx), then the later cascades (DB-only), `member_erased` and the response. **Aligned:** `reconcile-erasures` now stops starting members at the same deadline (maxDuration − 60 s = 240 s, the value its old `TIME_BUDGET_MS` had), so there is one rule and no second constant. |
| 3 — a deferral still logs as an error one layer up | **Fixed** (RED `b7787b8b1`, GREEN `59a30c0fd`). `deferredCount` runs from the cascade output through the partial port arm and the adapter. When `unexpectedErrorCount === deferredCount`, `erase-member` logs at warn ("deferred by the deadline; the re-drive continues") with the count. `member_erased` is still withheld. |
| 4 — a standing refusal's 403 + `failed` | **Fixed** (RED `b7787b8b1`, GREEN `59a30c0fd`). It now clears as an unsendable copy with `draftOutcome: 'failed'`, the measured status name, recorded in `resendDraftOutcome`. |
| 5 — metric parity | **Fixed** (RED `b7787b8b1`, GREEN `59a30c0fd`). Rows settled by the in-flight loop in the same run now emit `terminal_draft_cleared` / `terminal_copy_retained`, so a first run and a re-drive show the same series. |
| 6 — RoPA 8d and runbook wording · pdpa L-5 / L-6 | **Fixed** (docs). Both now say "bar every sending-started status (`sending`, `sent`, `partially_sent`, `partial_delivery_accepted`)". The stuck-import producer is named by the status it ends in: `failed_to_dispatch` (`audience_import_stuck`, after the 30-minute limit). |
| 7 — a log field | **Fixed** (GREEN `59a30c0fd`). The paused-count failure logs `err: errKind(e)`. |
| 8 — the paused gauge takes locks | **Fixed** (RED `b7787b8b1`, GREEN `59a30c0fd`). `countStuckErasuresInTx` runs the same anti-join as a plain count, **uncapped**, with no `FOR UPDATE` / `SKIP LOCKED` and no `LIMIT` (pinned by SQL shape). A paused tick therefore locks nothing and counts a member that is being erased concurrently. |
| 9 — hoist the deadline | **Fixed** (GREEN `59a30c0fd`). `const cascadeDeadline = erasureCascadeDeadline(startedAt, maxDuration)` is computed once per tick, and the wrapper is gone. |
| 10 — drop the cast | **Fixed** (RED `b7787b8b1`, GREEN `59a30c0fd`). `deleteDraftBeforeRefusal`'s `undecided` result carries the `resendBroadcastId` it DELETEd, and the standing wrapper reads it from there. |
| pdpa verification note — the legacy post-send 409 replay | **Residual, recorded.** `dispatch-scheduled-broadcast.ts` (the `idempotency_conflict && sendAttempted` arm) writes `sending` on an *inferred* acceptance, with no probe. Three reasons it stays: a 409 from `/send` has never been observed (MEASURED 2026-10-29: a repeated `/send` answers 422, and `Idempotency-Key` is inert on broadcasts); it is legacy-only, and that leg is deleted in slice 4; and slice 3 reclassifies 409. |
| reliability note — propagate has no time bound of its own | **Carried to slice 2.** `removeContactFromAudience` runs `withRetry` (up to ~31 s), and the SDK call has no timeout. Slice 2 bounds every broadcasts gateway call (DL8). |

Mutation proofs (from `59a30c0fd`, each file restored byte for byte, tree clean):
- reserve back to 30 s: 1 red.
- the warn branch for a pure deferral made inert: 1 red.
- `deferredCount` not incremented: 2 red.
- the parity metric on a settled row dropped: 1 red.
- `failed` no longer clears: 1 red.
- the paused count back to the locking `findStuckErasuresInTx`: 1 red.

**Solo-maintainer review, check (1)** (Complexity Tracking): evidenced by the security-engineer review (round 1, signed) and the senior-tester review (round 4, SHIP-READY).

### Slice 1 — review round 4 (`/code-review high`, senior-tester SHIP-READY, spec-compliance COMPLIANT; 31 Oct 2026)

Commits: RED `2fe15d7e0` and GREEN `fb57cd688`. Docs land in the commit after them. At RED, the floor, gauge, error-class and single-warn rows failed. Three rows passed already because they strengthen an assertion or cover built behaviour: the exact-deadline asserts and the live count case. The machine was short of memory, so per the coordinator only the scoped tests ran, plus the single integration file `find-stuck-erasures.test.ts` (3/3).

| Item | Disposition |
|---|---|
| code-review #2 — no floor for a late member (a round-3 regression) | **Fixed** (RED `2fe15d7e0`, GREEN `fb57cd688`). The cascade deadline stays start + maxDuration − 60 s (240 s). `reconcile-erasures` now starts no member after `erasureMemberStartCutoff` = deadline − `ERASURE_MEMBER_START_FLOOR_MS` (30 s, one row) = 210 s. `cutoff + FLOOR ≤ deadline` is pinned by a test, with a positive control (a cutoff AT the deadline fails). |
| code-review #3 · senior-tester MEDIUM — `countStuckErasuresInTx` never ran on live Postgres | **Fixed** (RED `2fe15d7e0`). `find-stuck-erasures.test.ts` now has a case where tenant A counts 1 (not its complete or live members) and tenant B's stuck member is not counted; the count also agrees with the candidate list. |
| code-review #4 — the anti-join exists twice | **Fixed** (GREEN `fb57cd688`). `stuckErasurePredicate(tenantSlug)` is one fragment used by both queries; the `audit_log` tenant filter stays load-bearing. |
| code-review #7 — the gauge had two meanings | **Fixed** (RED `2fe15d7e0`, GREEN `fb57cd688`). It is now the uncapped, non-locking count everywhere: paused, before the loop and after it. The capped-list value and its "lower bound" caveat are gone. The baseline stays, because it survives a tick killed mid-loop. |
| code-review #8 — log hygiene | **Fixed** (RED `2fe15d7e0`, GREEN `fb57cd688`). `err: errKind(e)` is used at the three `reconcile-erasures` sites. The cascade's top-level error now carries `errKind(e)`, never `e.message`, and that is what the adapter's `err` field logs. |
| code-review #9 — a noisy warn | **Fixed** (RED `2fe15d7e0`, GREEN `fb57cd688`). On a standing refusal's 403 the probe decides, and one line is logged for the final outcome. The runbook greps none of these names. |
| code-review #10 — hook timeouts | **Fixed** (RED `2fe15d7e0`). The explicit `120_000` is dropped from the new `erasure-terminal-drafts.test.ts` only. |
| senior-tester LOW — a deadline assert that cannot fail | **Fixed** (RED `2fe15d7e0`). Both route contract tests now assert the deadline = start + 300 s − `ERASURE_CASCADE_RESERVE_MS`, within 5 s. |
| code-review #1 — the reserve docblock said every later cascade is DB-only | **Fixed** (GREEN `fb57cd688`). The reserve covers the DB work after broadcasts. The directory cascade's Vercel Blob `del` calls (up to 1 logo and 100 archives) have no timeout: a known, unbounded, pre-existing path, for a follow-up issue. No AbortSignal is added in this slice. |
| spec-compliance Mediums (docs) | **Fixed** (docs commit). observability (the uncapped, non-locking count), changelog (the 240 s deadline and the sending-started exclusion), spec.md ED2 ("On a terminal row") and ED4 (the unsendable clears and the `probe_*` classes), the ED4 Verify row (4 integration cases), build note 1 marked superseded, and the SQL-shape test name and comment. |
| senior-tester LOW–MEDIUM — the `broadcasts-evidence:` advisory lock has no concurrent test | **Carried to slice 2.** The lease tests there bring a Neon pair harness; the evidence lock's concurrency case uses it. |

Mutation proofs (from `fb57cd688`, each file restored byte for byte, tree clean):
- the floor set to 0: 2 red.
- the end-of-tick gauge back to still_pending + error + deferred: 1 red.
- the cascade's error back to `e.message`: 1 red.
- the premature unconfirmed warn back: 1 red.

### Slice 1 — review round 5 (targeted; all round-4 items confirmed closed; 31 Oct 2026)

Commits: RED `af1143e5c` and GREEN `af56a75cc`. Docs land in the commit after them. The machine was short of memory, so only the scoped tests, the mutation proofs and `pnpm check` ran.

At RED the logging rows and the one-tx baseline failed. Two route cases were already green, because the behaviour existed since round 4: the floor pin, and `err` at the three log sites. The mutation proofs below show that both bind. In the GREEN commit, the base-helper test's expected shape gained the new `probedStatus` field (a shape change, not a behaviour assertion).

| Item | Disposition |
|---|---|
| MEDIUM — the floor was not pinned at the route | **Fixed** (RED `af1143e5c`). A `reconcile-erasures-route` contract case steps the clock so m3 is reached at 220 s, between the 210 s cutoff and the 240 s deadline. It asserts m3 is not started (`deferred: 1`, `budget_deferred` with `budgetMs: 210000`). Mutation: the loop checking `cascadeDeadline` again turns it red. The tautological cutoff test is replaced by fixed arithmetic (a 300 s route's cutoff = start + 210 s). |
| MEDIUM — the runbook | **Fixed** (docs). `cron-jobs.md`: the `deferred` row is now the 210 s member-start cutoff (the 240 s cascade deadline, i.e. a 60 s reserve, less the 30 s floor), `budgetMs: 210000`. The 504 row says the cutoff is checked between members, and that the terminal pass stops at the deadline. |
| LOW — stale texts | **Fixed.** The gauge test's name and docblock and the "~240 s" title (RED `af1143e5c`); the `countStuckErasuresInTx` port docblock, which now says it is the gauge's only value on every tick (docs). |
| LOW — route log fields | **Fixed** (RED `af1143e5c`). One case asserts `expect.objectContaining({ err: expect.any(String) })` for `query_failed`, `uncaught` and `stuck_count_failed`. |
| LOW — one log line per refusal | **Fixed** (RED `af1143e5c`, GREEN `af56a75cc`). `deleteDraftBeforeRefusal` logs nothing on `undecided`; its result carries `probedStatus` and `err` (the class). The erased arms log their one line through `recordRefusedDraftUndecided`. The standing wrapper logs one line with `probedStatus`, the DELETE `outcome` and the final `observedResendStatus`. The two `*_threw` line names are gone; the runbooks grep none of these names. |
| LOW — the baseline in the candidate tx | **Fixed** (RED `af1143e5c`, GREEN `af56a75cc`). The baseline count runs inside the candidate tx, so a tick makes two `runInTenant` calls, not three. A count failure there fails the tx: `query_failed`, 500, nothing observed. |
| The renewals cascade's raw `e.message` (`cancel-in-flight-cycles-for-member.ts:544` → `renewals-cascade-adapter.ts:98`) | **Out of scope.** It predates this branch and is outside the diff; tracked as issue #711. |

Mutation proofs (from `af56a75cc`, each file restored byte for byte, tree clean):
- the route loop checks `cascadeDeadline` instead of `memberStartCutoff` (the check reverted, not the constant): 1 red.
- the baseline read outside the candidate tx again: 1 red.
- a warn added back to `deleteDraftBeforeRefusal`'s threw arm: 1 red.
- the legacy erased arm's line removed: 1 red.
- the DELETE `outcome` dropped from the standing line: 3 red.

### Slice 1 — review round 6 (targeted; round-5 items confirmed closed; 31 Oct 2026)

Commits: RED `e700b0e93` and GREEN `5f8fe56a2`. Docs land in the commit after them. Only the scoped tests, the mutation proofs and `pnpm check` ran. The gate's pinned 100% coverage was re-checked under the broadcasts unit and contract suites (100/100/100/100).

| Finding | Disposition |
|---|---|
| Medium (findings 2, 3, 7, 8) — round 5 put the baseline count inside the candidate tx | **Reverted** (RED `e700b0e93`, GREEN `5f8fe56a2`). The baseline count is back in its own short `runInTenant`, after the candidate tx has committed, as in round 4. One round trip fewer was not worth a new failure mode: a count failure failed the whole tick, and the uncapped anti-join ran while up to 50 `FOR UPDATE` row locks were held. A failed count logs `stuck_count_failed`, observes nothing new, and the tick continues. That path is pinned by a contract case (the members are still re-driven). The route and port docblocks are back to the round-4 meaning; observability and cron-jobs never carried the round-5 wording. |
| Medium (findings 1, 4, 5, 6) — the erased arms' log line | **Fixed** (RED `e700b0e93`, GREEN `5f8fe56a2`). `deleteDraftBeforeErasedRefusal` owns the erased arms' one `refused_draft_delete_unconfirmed` line, with the fields the standing line carries (`probedStatus`, `outcome`, `errClass`, `err`). Both legs call it and nothing else. `recordRefusedDraftUndecided` is removed. It is pinned per leg; the import leg had no such test before. The undecided result now carries `probedStatus` already mapped (`null` → `not_found`), so neither wrapper has an untested branch; the base test's expected shape follows. |
| Low (finding 9) — the standing line repeats `errClass` when it equals `outcome` | **Kept, listed.** Dropping it changes the line's field set, which two tests pin, and it is cosmetic; a later slice can drop it. |

Mutation proofs (from `5f8fe56a2`, each file restored byte for byte, tree clean):
- the erased wrapper's log call made inert: 3 red (the gate test and both legs).
- the baseline count put back inside the candidate tx: 2 red.

### Slice 2a — build notes (decisions made while building)

Commits: `1c69a7611` test (RED: DL5a, DL8, P6, R3, the contract rows), `b9c554d29` fix (GREEN), `3246521af` test (RED: DL7), `68831a89c` fix (GREEN). RED ran first: 40 failures across `resend-gateway-bounded-calls.test.ts`, `subprocessor-erasure-propagate-bound.test.ts` and the new `broadcasts-sdk.contract.test.ts` block (e.g. "createAudience aborts at callTimeoutMs on a hung fetch (50 ms)" → `expected 'still running' to deeply equal { thrown: { kind: 'retryable', …(1) } }`; "createAudience answered 5xx sends one request" → 6 attempts), then 2 for DL7 ("the legacy leg skips a row that holds import columns (audience_import_id)" → `expected { ok: true, …(1) } to deeply equal { ok: false, error: { …(2) } }`).

1. **Shape.** `createResendBroadcastsGateway({ callTimeoutMs })` (default `RESEND_CALL_TIMEOUT_MS`, exported from `broadcasts-gateway-port.ts` for s2b); `resendBroadcastsGateway` is that factory's default instance, so the barrel, `broadcasts-deps.ts` and the members adapter are unchanged. No port method was added.
2. **One signal, one mapping site.** `boundedCall` replaces `withRetry`. It mints the signal and a `Date.now()` deadline once per call. After a failure it rethrows a non-retryable error untouched; then, if the signal has aborted, it throws `retryable` / `timeout` whatever the failure looked like (the SDK's `application_error` with `statusCode: null`, a raw `TimeoutError`, a body aborted mid-read). A backoff is taken only while the budget left exceeds it + 1 s (`RETRY_MIN_ATTEMPT_MS`). `Date.now()` because the fake-timer suites advance `Date`: under them a retried call now stops at 4 attempts (t = 0, 1, 3, 7 s).
3. **Creates.** `createAudience`, `createBroadcast` and `createContactImport` call it with `retry: false`. `addContactsToAudience` is also a POST but keeps its per-contact retry (the 429 backoff, BUG-028), each contact with its own 10 s; the brief named only the three creates.
4. **Raw calls.** `importFetch` takes the caller's signal (the 30 s `IMPORT_FETCH_TIMEOUT_MS` is gone) and wraps `res.text()`, so a stalled body is classified, not an untyped throw. The `*Once` calls read the same `callTimeoutMs` (default 10 s, unchanged; so DL8's 50 ms case covers them), and a body that will not read answers `retryable` (it was `''`, so a stalled 2xx on `retrieveBroadcastOnce` read `other`; both are fail-closed cells in D-040's table).
5. **Signal on the wire.** resend 6.35 `post` / `get` / `delete` spread `requestOptions` into the `fetch` init (`node_modules/resend/dist/index.mjs`, `fetchRequest` → `fetch(url, options)`); the contract block reads `signal` off the stubbed `fetch`'s own arguments, so the existing snapshots are unchanged.
6. **DL7.** In step 1's lock tx, after `findByIdInTx`. It returns `null`, so the result is the existing `broadcast_invalid_state_transition` / `unknown_or_already_processed`; the route (`dispatch-scheduled/route.ts`, the legacy switch) buckets it `concurrent_skip` with a warn line: no failure, no email, no route change. The eligibility query does not filter import columns, so the skip is reachable.
7. **Pins that moved** (GREEN commit, old behaviour): the contract suite's six-attempt cases → 4 (GET / DELETE / `/send` / contacts) or 1 (createAudience); the retried network failure is now pinned on `deleteAudience`; `resend-broadcasts-gateway-contract` 429 exhaustion → 4 calls; `resend-contact-import` "429 then 201" → one submit that rejects `retryable/api`; three `toHaveBeenCalledWith` cases gain the `{ signal }` argument.
8. **Test-plan deviations.** P6 runs at C = 2 100 ms, because no backoff fits 50 ms; two cases: a 5xx then a hang (one signal vs per-attempt) and a fast 5xx every time (the budget guard). DL8 adds a positive control (the cases cover `Object.keys` of the gateway) and three stalled-body cases. R3 is a sibling file (`subprocessor-erasure-propagate-bound.test.ts`), because the existing adapter test replaces the gateway with `vi.fn`; it runs the real gateway at 50 ms.
9. **Mutation proofs (from `68831a89c`, each reverted byte for byte and the fix line grepped back).** M1 `op(signal)` → a per-attempt `AbortSignal.timeout` → P6 "a 5xx, then a hang" fails. M2 the budget check → `false` → P6 "keeps failing fast" fails. M3 `createAudience` `retry: true` → DL5a createAudience 5xx fails. M4 drop `!ctx.retry ||` → the three DL5a 5xx cases fail. M5 `false &&` on the import-column check → both DL7 cases fail. M6 drop `{ signal }` from `contacts.remove` → R3 fails.
10. **Carries closed (D-043).** R3 (the `propagate` time bound, carried from slice 1 review round 1 and re-homed to s2a): closed by `subprocessor-erasure-propagate-bound.test.ts` (real gateway at 50 ms, three hung pairs return within 3 x C + 1 s) and mutation M6. R4 and R1 #5 stay with s2b.
11. **Live-path change** (plan § Risk): the legacy leg and erasure no longer retry a create, and every call gives up after 10 s instead of ~31 s or more (or never, for a hung SDK call).

### Slice 2a — Verify: the maintainer's `/verify` (31 Oct 2026, on `9e05e70dc`): PASS

The branch ran on :3400 with the import flag OFF, against dev Neon, tenant `swecham`, using the Resend sink only. Dev had 0 due `approved` rows before the seed.

| Done-when / probe | Observed |
|---|---|
| DL7 | A due `approved` row with import columns set. The cron answered 200 `processed:1, concurrent_skip:1` and logged `broadcasts.dispatch.import_row_skipped` for that `broadcastId`. No Resend line appeared during the tick. The row was unchanged, `updated_at` included. |
| Probe: wrong Bearer | **401** `unauthorized`. The row was unchanged. |
| Probe: second tick | Skipped again. The row was unchanged. |
| Erasure with bounded calls | A `failed_to_dispatch` row holding a real draft. Erase returned 200 `cascadesComplete:true`, the draft then answered **404**, and the payload carried `resend_drafts_cleared:1`. |
| DL5a, DL8, R3 | Test-only: they need a provider that hangs or fails. |

Finding for review: the route logs a DL7 skip at **WARN**, as `cron.broadcasts.dispatch.concurrent_skip`, after the INFO `import_row_skipped`.

### Slice 2a — re-Verify: the maintainer's `/verify` after review round 1 (1 Nov 2026, on `147bf6150`): PASS

| Done-when / probe | Observed |
|---|---|
| DL7 (scan exclusion) | A due `approved` row with import columns set. Cron → 200 `processed:0`, `concurrent_skip:0`, `import_row_skipped:0`. No log line names the row, and the row is unchanged (`updated_at` included). |
| Probe: wrong Bearer | **401**, and the row is unchanged. |
| Probe: second tick | `processed:0`, and the row is unchanged. |
| Erasure + propagate deadline | Erase → 200 `cascadesComplete:true`. The draft → **404**. `member_erased` has `resend_drafts_cleared:1`. `subprocessor_erasure_propagated` is written with `resend_outcome:ok`. The member had no live-audience pairs, so the deadline cut itself was not exercised live; it is covered by unit tests. |

### Slice 2a — review round 1 (`/code-review high 719`, security APPROVE, reliability MERGEABLE, pdpa APPROVE WITH CONDITIONS; 1 Nov 2026)

**Review metrics:** round 1 · 6 + 3 + 3 + 2 items (code-review, security, reliability, pdpa) · cap: ≥ 2 full + ≤ 2 targeted.

**Plan rows added before the fixes (D-043).** Two of the fixes are new mechanisms:

| Mechanism (asked by) | State / rule | Test that goes red first |
|---|---|---|
| `propagate` takes the caller's `deadlineAt` (pdpa H-1, reliability L2) | Before each pair: if the time left is under C, stop. Each pair not attempted counts as `failed`, so the `subprocessor_erasure_propagated` row is always written before `maxDuration` and is never a false `ok` | adapter unit · "propagate stops at the deadline and counts the untried pairs as failed"; `erase-member` unit · "propagate receives the cascade deadline" |
| The flag-OFF scan excludes import rows; the DL7 skip has its own outcome (code-review #3, reliability M1) | With the import flag OFF, the due scan adds `audience_import_id IS NULL AND audience_import_submitted_at IS NULL`. The use-case check stays as a backstop. A backstop skip returns a distinct kind, `import_row_skipped`: the route counts it under its own key and logs it at INFO, not as `concurrent_skip` WARN | `cron-dispatch-scheduled.contract` · "flag OFF: the scan excludes import rows" + "a backstop import-row skip is counted as import_row_skipped at info" |

**Closures:**

| # | Finding | Closure |
|---|---|---|
| CR#1 | `retry:false` on creates also stops the retry on a 429, which created nothing | **Fix:** creates still retry on a 429 (`subKind: 'api'`) inside the budget; 5xx, network and timeout make one attempt. Test: "a create retries a 429 but not a 5xx or a timeout". **Done:** RED `6741e22cb`, GREEN `82b804b1e` |
| CR#2 + security M | A loop of port calls (`addContactsToAudience` per contact, `listAudiences` per page) runs N × C, not C | **Docs fix:** DL8 and the docblocks say "per request". **Carried to s2b** (Medium; s2b names the cron time budget, D-043): a per-invocation budget for multi-request port calls. **Docs done:** `0554c615e` (factory docblock), `043a72c9c` (spec DL8, broadcasts rule), `2b9ef241b` (observability § 22.14) |
| CR#3 + reliability M1 | A DL7-skipped row strands silently and starves the scan | **Fix:** the plan row above. **Done:** RED `6741e22cb`, GREEN `2b9ef241b` (scan filter, `import_row_skipped` kind and route bucket, runbook line) |
| pdpa H-1 + reliability L2 | `propagate`'s total time is not tied to the route deadline; a kill before the audit row leads to a false `ok` on re-drive | **Fix:** the plan row above. **Done:** RED `6741e22cb`, GREEN `47cdb9050` (port `deadlineAt`, adapter stop, `erase-member` threading, RoPA 8a, runbook) |
| CR#4 | P6 has about 100 ms of slack and can flake on CI | **Fix:** C = 3,000 ms with bounds relative to C. **Done:** `6741e22cb` (test only; sentinel 1.25 C, case (a) < 1.2 C, case (b) < 0.75 C) |
| CR#5 + pdpa L-1 | Stale `withRetry` / "safe to retry" / "six times" text | **Fix:** the text. **Done:** `0554c615e` |
| CR#6 | Two-layer factory | **Fix:** one factory. **Done:** `0554c615e` (refactor, no behaviour change) |
| reliability L1 | A create slower than 10 s can leave an orphan segment | **Accepted, with a mechanism already there:** `reclaim-orphan-audiences` (daily, `vercel.json:13`) reaps named `broadcast-<tenant>-<id>` segments; a 10 s create against a 0.48 s RTT is rare |
| security L1–L3 | The `addContactsToAudience` POST retry; propagate pair count; tick-1 rows without import columns | L1 accepted (it mints nothing sendable); L2 is covered by the propagate deadline; L3 is closed by s2b cell 23 (lease) |


**Round-1 fix notes.**
- Mutation proofs (from `043a72c9c`, each restored byte for byte): creates retrying every retryable → CR#1 5xx phase red; creates never retrying → CR#1 429 phase red; propagate ignoring the deadline, or not counting untried pairs → both deadline cases red; `deadlineAt` not threaded → "propagate receives the cascade deadline" red; the scan filter dropped → "flag OFF: the scan excludes import rows" red; the backstop returning the old kind → both DL7 cases red; the route bucketing it as `concurrent_skip` → the backstop contract case red.
- **Contradiction found (runbook):** "cancel the row" is not always available. `cancel-broadcast.ts` refuses an `approved` row once `audience_import_id` is set (`hasDispatchBegun` → `sending_started`), so for such a row re-enabling the flag is the only route; a row with only `audience_import_submitted_at` can be cancelled. `broadcast-audience-build.md` says so.
- The flag is now read once per tick, above the due scan (it was read after it); the filter fragment is hoisted out of the scan template.

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
