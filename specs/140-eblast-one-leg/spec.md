# 140 — E-Blast keeps one dispatch leg (Contacts-Import), behind a dispatch lease; erasure deletes the drafts it can reach

**Size**: L (`docs/workflow.md` § Sizes). It has a migration (slice 2), touches erasure and PII (RoPA 8d), and spans broadcasts, members (the erasure cascade) and the dispatch cron, in four slices.
**Status**: plan agreed by the maintainer on 31 Oct 2026. Slice 1 is in build.
**Source**:
- D-038: spec 140 owns import-leg tick concurrency.
- The maintainer's decision of 30 Oct 2026 to keep only the import leg (to be recorded as D-042).
- Issue #699 (RoPA 8d).
- Items deferred from specs 138, 139 and 141.

## Why

E-Blast has two dispatch legs, chosen per cron tick by `FEATURE_F7_IMPORT_AUDIENCE`:
- the legacy leg (`dispatch-scheduled-broadcast.ts`), which is live;
- the Contacts-Import leg (`build-audience-tick.ts`), which is dark.

Every fix in 138 and 139 was made twice, once per leg, and six review rounds of 138 kept reopening one class of bug. The dispatch cron holds no lease past its scan, so two ticks can work the same `approved` row.

The maintainer decided to keep only the import leg. Two things must hold before it becomes the only leg (D-038):
- it needs a lease;
- the Resend drafts that an erasure leaves behind (#699) must be deletable.

## Premises checked against the code (origin/main `efc6b664d`, 31 Oct 2026)

### Usage (D-041)
- **Rows:** prod `broadcasts` had 0 rows on 2026-10-30. This was a one-off read-only count the maintainer ordered. Rows can be hard-deleted, so it shows none now, not none ever.
- **Master flag:** `FEATURE_F7_BROADCASTS` is ON in prod (the maintainer, 2026-10-31). The legacy leg is therefore the live path, but it carries no row.
- **Import flag:** `FEATURE_F7_IMPORT_AUDIENCE` is OFF and absent from Vercel (`docs/operational-state.md`).

### The flag
- **It chooses the leg, nothing more.** `isF7ImportAudienceEnabled()` is `f7Broadcasts && f7ImportAudience` (`infrastructure/feature-flags.ts:91`).
- **The kill switches stay.** The cron's `cronReadOnlyGuard` and the `FEATURE_F7_BROADCASTS` early return run before any work (`dispatch-scheduled/route.ts:131,148`).
- **Retiring the legacy leg has the effect of turning the flag on.** So the retirement slice comes last.

### Concurrency
- **No lease past the scan.** The cron's scan lock ends when the scan commits, and `maxDuration` (300 s) equals the 5-minute cadence (`route.ts:109,178-187`). The import leg commits its step-1 lock transaction before any Resend call (`build-audience-tick.ts:429-436`).
- **Where ticks can interleave:**
  - a teardown of a row with no import, which no claim covers (`:912`);
  - two mints, where the loser's reclaim can leak;
  - two senders on one inherited draft;
  - a status-only `failTerminally` that lands after a sibling already sent (`sent_but_transition_lost`);
  - `attachResendIds`, which has no CAS at all (`drizzle-broadcasts-repo.ts:954-1006`).
- **Platform kill semantics are DOCUMENTED only.** Vercel Fluid Compute ends an *invocation* at `maxDuration`, and a process can outlive it. A lease therefore cannot rely on "TTL > maxDuration" alone.

### Erasure and drafts
- **The cascade sees only in-flight rows.** It lists `IN_PROGRESS_BROADCAST_STATUSES` only (`in-progress-statuses.ts:27-34`).
- **The scrub keeps the Resend id.** It rewrites our row, and its SET clause leaves `resend_broadcast_id` in place (repo 1927-1980). A terminal row's draft can therefore still be found by member id.
- **What actually produces a terminal row that holds a draft:**
  - the plain `refuse` arm, for a halted or ended membership (`build-audience-tick.ts:719-744`);
  - a `/send` probed `refused`;
  - retry-budget exhaustion, or a stuck import after the pre-send persist.
- **The RoPA producer is wrong.** RoPA 8d and #699 name "staff-cancelled with an id", but staff cancel refuses an `approved` row that carries an id (`cancel-broadcast.ts:248`).
- **Leaked mints exist only in logs.** A mint whose reclaim failed writes `minted_broadcast_leaked`. Nothing durable records it, and the port has no `listBroadcasts`.

### Ship-blockers for the retirement
- **The broadcast name is not capped.** The import leg sends the name `` `${tenantDisplayName} — ${subject}` `` with no cap (`build-audience-tick.ts:1803`). Resend caps names at 70 code points (fix #117, `resend-dashboard-name.ts:12`), and subjects can be up to 200 characters (`schema.ts:320`).
- **A remove without a segment id deletes everywhere.** In resend 6.35, `contacts.remove` with a falsy `audienceId` becomes `DELETE /contacts/{email}` (`dist/index.mjs:679-680`). That deletes the contact account-wide, on an account shared by every tenant and by dev and prod.
- **The audience ceiling jumps.** Today `currentAudienceCeiling()` is `min(configured, 500)` while the flag is off. Without the flag it becomes 5,000 (`broadcasts-deps.ts:244-248`).
  - Resend Free allows 1,000 contacts team-wide (DOCUMENTED; MEASURED on the billing page, 2026-09-08), and 22 are already used (Resend MCP read, 2026-10-30).
  - The cap behaviour cannot be measured without filling the prod account.

### Provider facts
`research.md` labels every fact MEASURED (with a date) or DOCUMENTED (with a URL). Measured on 2026-10-29/30:
- `/send` works only on a draft; anything else answers 422.
- DELETE works only on a draft or scheduled broadcast; queued, sent and canceled answer 403.
- Deleting an audience under a `queued` broadcast makes it `failed`, and no mail goes out.
- A cancelled queued broadcast reads `canceled`, with one L.
- `Idempotency-Key` is inert on broadcasts.
- No webhook reports a broadcast or import event (DOCUMENTED).

## Decisions (the maintainer, 31 Oct 2026)

1. **Slice order:** erasure → lease → table fixes → retirement.
2. **Audience ceiling:** configurable, **default 900**, bounded to 1–50,000, refused at submit.
3. **Slice 1:** deletes the drafts reachable from the DB and stops producing them at source. There is no Resend-side listing sweeper. Slice 2 adds a durable record of orphaned ids.
4. **Spec 141 carries:** the renewals items carried from 141 get their own issue.
5. **139 slice 2** (the Art. 30 audit events) comes after the retirement slice. A dated gate says it merges before the first prod E-Blast goes through the import leg.
6. **The Resend cleanup is all in this spec:**
   - timeouts and the lease in slice 2;
   - error classes in slice 3;
   - the Segments API names in slice 4.
7. **Plan review:** no `spec-review-panel`. `chamber-os-architect`, `security-engineer` and `pdpa-gdpr-compliance-officer` read the plan before it was agreed, and their findings are folded in.
8. **Rollback:** from slice 2, the legacy leg skips any row that carries import columns. Reverting the retirement is then safe with no env change.

## User stories

### US1 — An erased member leaves no reachable draft at Resend (slice 1, #699)

As the chamber, when a member is erased, every Resend draft that our DB still points to for that member's E-Blasts is deleted. Every copy Resend will not delete is recorded as retained.

**Done when:**
- **ED1.** An erased member with a `failed_to_dispatch` row that holds a draft id:
  - the draft answers 404 at Resend afterwards;
  - `member_erased` carries `resend_drafts_cleared: 1`.
- **ED2.** On a terminal row, the DELETE answers 403 and the GET answers `canceled`:
  - `member_erased` is written with `resend_copies_retained: 1`;
  - `broadcasts_already_sent_count` is unchanged.
- **ED3.** A retryable answer from Resend:
  - `member_erased` is withheld;
  - the `reconcile-erasures` re-drive then succeeds.
- **ED4.** On both legs, a refusal for a halted or ended membership deletes the row's draft at Resend. An undecided delete is recorded as `undeleted` (with a closed `resendDraftErrClass`). Erasure reaches that draft, and from slice 2 so does the orphan sweep. A 403 whose one GET reads handed means a sibling tick sent the draft: that is a concurrent skip, so no `failed_to_dispatch` is written and the member is not emailed. A 403 whose GET reads `cancelled` or `failed` is an unsendable copy: it clears (`resendDraftOutcome: 'cancelled'` / `'failed'`). Any other GET reading is `undeleted`, with `resendDraftErrClass` one of `probe_draft`, `probe_not_found`, `probe_retryable`, `probe_other` or `threw`. (Amended at review rounds 1–3, 31 Oct 2026.)
- **ED5.** A stale `attachResendIds` on a row that is no longer `approved` writes nothing.

### US2 — One cron tick at a time works a row (slice 2)

As the chamber, an E-Blast is built and sent by one cron invocation at a time. An invocation that loses its lease makes no Resend call and writes nothing after that.

**Done when:**
- **DL1.** Two concurrent ticks on one `approved` row (both orders) produce exactly:
  - one audience;
  - one import;
  - one broadcast;
  - one `/send`.
- **DL2.** A holder whose lease expired mid-run makes no Resend call after the expiry and writes no column. Every CAS and every pre-call check refuses a stale token.
- **DL3.** The claim waits behind an erasure's row lock, then skips the cancelled row.
- **DL4.** With two tenants holding the same broadcast uuid, claim and release each touch only their own row (run as `chamber_app`).
- **DL5.** A timed-out `createBroadcast`:
  - is not retried;
  - writes an orphan-id row.
- **DL6.** A failed reclaim writes an orphan-id row, and the cleanup cron deletes it at Resend.
- **DL7.** The legacy leg skips a row that holds import columns.
- **DL8.** Every broadcasts gateway call aborts at its timeout.

### US3 — The import leg reads Resend correctly (slice 3)

**Done when:**
- **DT1.** A 75-character subject is sent with a broadcast name of no more than 70 code points.
- **DT2.** A `canceled` inherited broadcast is refused terminally, never re-minted.
- **DT3.** Error classes:
  - a 409 `resource_locked` is retried;
  - a 429 `daily_quota_exceeded` or `monthly_quota_exceeded` is permanent;
  - a 409 followed by a 422 ends sent, with no failure write.
- **DT4.** A `+` address and an uppercase address:
  - are each detached from their segment;
  - still exist as contacts afterwards.

### US4 — One dispatch leg (slice 4, D-042)

**Done when:**
- **DR1.** `rg FEATURE_F7_IMPORT_AUDIENCE src scripts tests .env.example` prints nothing.
- **DR2.** On the branch's :3400 server, with the flag absent and the sink address only, an approved E-Blast goes `approved → sending → sent` over two cron ticks.
- **DR3.** A segment of 901 recipients is refused at submit, with the ceiling message in EN, TH and SV.
- **DR4.** The broadcasts contract suite passes. It fails on any `DELETE /contacts/{email}`, so an account-wide contact delete cannot ship.

## Out of scope

- **The spec 141 carries:** the renewals items carried from spec 141 go to their own issue:
  - persisting the rendered body;
  - folding the two send loops;
  - the scan-gate gaps.
- **139 slice 2:** the Art. 30 audit events (decision 5).
- **#362 / #364:** the 108 `primary_only` / `all_contacts` cutover. It does not depend on the dispatch leg: both legs use one resolver.
- **A Resend-side listing sweeper** for drafts.
- **A Resend plan upgrade**, and measuring the Free-plan cap.

## Open questions

None blocking. Two items need a measurement in slice 3, on the sink address only:
- the email encoding of `contacts.remove`;
- whether 409 `resource_locked` occurs at all.

Both are listed in `research.md`.
