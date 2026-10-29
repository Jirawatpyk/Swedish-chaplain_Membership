# Plan: 138 — F7 import leg: hold abandon + pre-send persist + fenced audience delete

Spec: `specs/138-f7-import-hold-abandon/spec.md` · Size: L (first sized M in error, corrected on 29 Oct 2026) · Agreed by the user on: 29 Oct 2026, after the `chamber-os-architect` read and an advisor pass ("ถาม Advisor แล้วยืนยัน").

**Agreement history:**
- The first slice (the hold abandon) was approved in plan mode. That plan was saved outside the repo, which is a deviation.
- On 29 Oct 2026 the maintainer approved the residual fixes ("แก้ใน PR นี้เลย") and the move into feature-flow.
- The same day the maintainer answered three questions:
  - rename the branch to `138-f7-import-hold-abandon`;
  - staff may cancel or re-time a held E-Blast after the abandon;
  - de-duplicate the persist-before-send block in this PR.

## Approach

All changes are in the import leg (`build-audience-tick.ts`). It follows the legacy leg's proven pattern, and the row is the mutex.

1. **Pre-send persist (S8 closed).** After `createBroadcast`, call `attachBroadcastId` in its own transaction before `sendBroadcast`. The legacy leg and the import leg share one helper: the 23505 classification, the read-back, and the landed / absent / unknown branches. The legacy log names come in through a `logPrefix`.
2. **Inherited-id probe.** A row carrying `resend_broadcast_id` is probed with `retrieveBroadcast` before the standing gate. The answer can be:
   - handed (`queued` / `sending` / `sent`): catch up with the post-send writes;
   - reusable (`draft`);
   - dead (`cancelled` / `not_found`): re-minted (only a draft can be sent — 422 otherwise, measured); a `not_found` is re-probed once after 3 s in Step 1a, before the standing gate (round 3 choice; moved there in round 5 so a hold and a refusal see the second answer too); `failed` / `scheduled` read as `unknown` and are refused;
   - unknown, or the probe threw: refuse fail-closed.
3. **Fenced hold abandon.**
   - claim CAS: clear only the import columns, and keep the bid and the audience (architect B1, 29 Oct);
   - reclaim the draft broadcast (404 ok; a refusal stops and leaves the bid for the next probe — except for a `cancelled` id, which can never be sent, so its refusal continues);
   - `deleteAudience`;
   - narrow CAS: clear the bid and the audience together, with predicate `audience_import_id IS NULL`.

   On the sender side, `attachBroadcastId` takes an optional `expectedAudienceImportId` fence:
   - every import-leg attach BEFORE a send passes it, and the fresh-mint persist IS the fence (B2); the handed-path catch-up re-asserts unfenced, because the mail is already out;
   - the inherited path re-asserts once, right before `/send`;
   - the legacy calls do not pass it.

   A sender whose `/send` gets 404 re-reads the row, and returns non-terminal if the hold won.

   A dead inherited bid (`cancelled` / `not_found`) is replaced through a new CAS that swaps it only while it still equals the dead value (B3).
4. **Dead-audience self-heal.** On a `createBroadcast` 404 for a missing audience (always one an earlier tick created), run the same restart as the hold — claim, delete the audience at Resend (404 = gone), release — and return non-terminal. Tick 1 never reuses an audience (a row with an audience and no import is torn down first, round 5), so `createContactImport` always targets this tick's audience and its 404 keeps the permanent rule: no loop. **Built differently from B4, and accepted.** The gateway is unchanged. The import leg matches `permanent` with code `not_found` (or `http_404`) at its one call site (`isAudienceMissing`, `createBroadcast` in `confirmImport`), and two gateway pin tests keep the legacy classification (a 404 with no resource id stays `permanent`). The result is a new `audience_restarted` output, the counter `broadcasts_audience_import_restarted_missing_audience_total` and the phase `audience_restart`.
5. **A refused `/send` is probed** (`_probe-refused-send.ts`, both legs):
   - `queued` / `sending` / `sent` → advanced as sent;
   - `draft` / `cancelled` → the ordinary terminal path;
   - anything else, or a failed probe → a non-terminal refusal.

   When accepted, `broadcast_send_started` records the status the probe saw; a transition that then loses to a sibling already `sending` on the same resource logs info (`transition_already_sending`), not critical.
6. **`failed` and `scheduled` stay `unknown`,** so they are refused fail-closed. `normaliseStatus` is unchanged because the LIVE `reconcile-stuck-sending` reads the same union.

7. **The state table** (round 5; every cell names its handler and its test, so a review can check that nothing is missing). A row's Resend ids are `(import, bid, audience)`; ∅ means none.

| Row | Probe of the bid | Standing `send` | Standing `hold` | Standing `refuse` |
|---|---|---|---|---|
| (∅, ∅, ∅) — fresh tick 1 | — | `submitImport`: fresh audience, fenced import ("tick 1 attaches its import FENCED") | nothing to tear down | `failTerminally` |
| (∅, ∅, A) — tick 1 died, or a teardown stopped | — | `submitImport` → teardown `stale_audience`, never reused ("tick 1 on a row that still carries an audience…") | hold teardown, no claim ("a hold on a row with an audience … NO import") | `failTerminally`; `cleanup-audiences` reaps A |
| (∅, B, A) — legacy carry-over or stopped teardown | handed | `catchUpHanded` ("legacy-leg carry-over … SENT") | same | same |
| | draft | teardown deletes B; a refusal stops and keeps both ("DRAFT … REFUSED → it stops") | hold teardown, same rule | `failTerminally` |
| | cancelled | teardown carries on past a refused delete ("DEAD (cancelled) … carries on"); a retryable delete stops ("… fails RETRYABLY → it stops") | hold teardown, same rule | `failTerminally` |
| | not_found (re-probed first, Step 1a) | teardown: the delete 404s = success; a REFUSED delete stops and keeps both (contradictory evidence) | same ("NOT-FOUND twice, then the broadcast delete is REFUSED → STOP") | `failTerminally` only on the second answer ("a REFUSE … re-probe finds SENT → caught up") |
| (I, ∅, A) — tick 2 | — | `confirmImport`: fresh mint, fenced persist, send ("persists the minted id BEFORE the send"); `createBroadcast` 404 → self-heal ("createBroadcast answers 404") | claim → delete → release ("tick 2 hold … claims") | `failTerminally` |
| (I, B, A) — tick 2 re-entered | handed | `catchUpHanded` ("probe answers SENT / QUEUED") | same | same |
| | draft | reuse B through the fence ("REUSED") | claim → delete B (refusal stops) → delete A → release ("inherited DRAFT id → claims…", "delete FAILS … 403") | `failTerminally` |
| | cancelled | fresh mint replaces B ("probe answers CANCELLED") | claim → delete B (refusal carries on) → delete A → release ("inherited CANCELLED id whose delete is REFUSED") | `failTerminally` |
| | not_found | re-probed after 3 s in Step 1a, then mint and replace, or catch up ("NOT FOUND twice", "re-probe finds it SENT") | re-probed before the hold acts ("re-probed BEFORE the hold acts"); a refused delete after it stops ("… delete is REFUSED → STOP") | re-probed before the refusal ("a REFUSE … re-probe finds SENT → caught up") |
| | unknown / probe throws | refused fail-closed, no clock ("a status this build cannot read", "probe THROWS …") | same (the probe runs before standing) | same |

**Alternatives not taken:**
- **Detach first, delete later.** It orphans an audience that neither `reclaim-orphaned-audiences` nor erasure can see.
- **Retry the detach ×3 in the tick.** This was the first build. It treated the symptom, and the code review noted that the ordering is the cause.
- **A dispatch lease column.** It needs a migration, and the CAS fence already closes the overlap.
- **Treating the measured `failed`-on-audience-delete as theoretical.** It was measured.
- **Classifying the 422 in the gateway as "already sent".** It would key on provider text, change the LIVE leg's classification, and the 422 only says "not a draft" (a `failed` or `cancelled` resource answers it too); only `retrieveBroadcast` answers whether mail went out.

## Files and modules

- `src/modules/broadcasts/application/use-cases/`:
  - `build-audience-tick.ts`;
  - `dispatch-scheduled-broadcast.ts` (LIVE leg: helper extraction, the fail-closed probe throw, the refused-send probe);
  - new `_reclaim-minted-broadcast.ts`, `_persist-minted-broadcast-id.ts`, `_probe-refused-send.ts`; `_classify-thrown.ts` gains `retryableSubKind`;
  - `cancel-in-flight-broadcasts-for-member.ts` (docblock).
- `src/modules/broadcasts/application/ports/`: `broadcasts-repo.ts` (claim + narrow-clear methods, the `attachBroadcastId` fence) and `broadcasts-gateway-port.ts` (docblocks).
- `src/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo.ts` (claim, release, fences, the `''` arm) and `infrastructure/resend/resend-broadcasts-gateway.ts` (comments only; classification and `normaliseStatus` unchanged).
- `src/app/api/cron/broadcasts/dispatch-scheduled/route.ts` (the `audience_restarted` bucket and span).
- `src/modules/broadcasts/domain/stage/in-progress-statuses.ts` (docblock) and `src/lib/metrics.ts` (`audienceImportAbandonedOnHold`, `audienceImportRestartedOnMissingAudience`, `audienceImportRestartFailed`).
- The `check:red-first` gate (retro): `scripts/check-red-first.ts`, `scripts/lib/red-first.ts`, `package.json` (`pnpm check`), `.github/workflows/quality-gates.yml` (the PR-only step).
- Rule: `.claude/rules/modules/broadcasts.md`.
- Docs:
  - `docs/runbooks/{eblast-approval,broadcast-audience-build,cron-jobs}.md`;
  - `docs/observability.md`;
  - `docs/go-live-readiness.md` § 6.10 and `docs/operational-state.md` (the spec-139 flip gate);
  - `docs/compliance/processing-records.md` (residual 8b, the measured DELETE facts, the hold's audience delete) and `docs/runbooks/member-erasure.md` step 3b (legacy leg only) (interim, until 139);
  - `docs/changelog.md`, `docs/decisions.md`, `docs/retro.md`;
  - `.claude/rules/modules/broadcasts.md`;
  - `.claude/skills/review-and-ship/SKILL.md` § 2;
  - `.claude/skills/run-chamber-os/SKILL.md` § 1.
- Cross-module: none. Every caller and fake of the touched ports is in `tests/` (grep `detachPendingAudienceImport`, `attachBroadcastId`, `retrieveBroadcast`).

## Data model and migration

n/a. No migration.
- The claim CAS satisfies 0299's `broadcasts_audience_import_coherent` CHECK: the import id and `submitted_at` are nulled together.
- It also satisfies the immutability trigger's normal arm.

## Slices (L — sharing one branch, see Complexity Tracking)

| # | Slice | Done-when lines it covers | Surface reviewers | Branch | PR · status |
|---|---|---|---|---|---|
| 1 | A hold abandons the pending import | 1, 2, 9 | reliability-guardian, pdpa-gdpr-compliance-officer | `138-f7-import-hold-abandon` | #695 · done (c5bc2f9c6; reworked in slice 3) |
| 2 | Pre-send persist + inherited-id probe | 5, 7, 12 | reliability-guardian | `138-f7-import-hold-abandon` | #695 · done (37f7067e1, dbc8bc0a9) |
| 3 | Fenced abandon, dead-audience self-heal, shared legacy helpers, fail-closed probe | 3, 4, 6, 8, 10, 11, 13 | reliability-guardian, pdpa-gdpr-compliance-officer, security-engineer, senior-tester | `138-f7-import-hold-abandon` | #695 · done (0a93148ff … 8f07e2a41) |

## Test plan

| Done-when line | Test that goes red first | Level |
|---|---|---|
| 1 hold abandons (claim → reclaim → delete → clear), gauge stops matching, counter | `build-audience-tick-failure-paths.test.ts` hold block; `eblast-send-time-standing.test.ts` "tick-2 hold abandons…" with the real gauge predicate | unit + integration |
| 2 lost claim touches nothing | failure-paths "claim lost → no gateway delete" | unit |
| 3 sender fence: every attach fenced, both orders, double-race re-read | `audience-import-repo.test.ts` fence pair against Neon; failure-paths "fence lost → no send, own mint reclaimed, no bid left"; "send 404 after a claim → re-read → non-terminal", covering bid=X + import NULL and bid≠own + import ours | integration + unit |
| 4 partial abandon self-heals; 403 stops and leaves the bid | failure-paths "redo on an import-NULL row with bid/audience still set (no re-claim)"; "broadcast delete 403 → audience untouched, bid kept → next probe catches up" | unit |
| 5 no double send: pre-send persist order; probe arms; dead bid replaced; fail-closed throws | failure-paths persist/probe blocks; "not_found bid → replace-dead-bid CAS → fresh mint"; "probe answers CANCELLED → a FRESH resource is minted" (RED `8b9037505`); `audience-import-two-tick.test.ts` re-entry after send | unit + integration |
| 6 dead audience self-heals (deletes, bounded); legacy classification pinned | failure-paths "createBroadcast 404 audience → …released" (now also asserts the audience delete), "createContactImport 404 for the audience THIS tick created → no restart loop" (RED `8b9037505`); "tick 1 on a row that still carries an audience but no import → the teardown is FINISHED" (RED `c8c5169b0`); gateway unit "legacy createBroadcast 404 stays permanent" | unit |
| 7 no `''` sentinels | failure-paths "'' broadcast id does not loop"; "handed path keeps null audience" | unit |
| 8 legacy unchanged except stated | the legacy `dispatch-scheduled*` unit suites; `dispatch-persist-before-send`, `eblast-approved-exit-vs-dispatch` integration; new legacy tests for the probe-throw and `failed` arms | unit + integration |
| 9 staff cancel after abandon | `hasDispatchBegun` false after detach (domain unit) | unit |
| 10 docs | `spec-compliance-auditor` reads them against the code | review |
| 11 cross-tenant layer 1 for each new or changed repo method | `audience-import-repo.test.ts` `it.each` next to `:622` | integration |
| 12 refused second `/send` → probe → accepted, not failed (both legs) | failure-paths + legacy dispatch suite: "send 422 + probe sent → sending, no member email"; "422 + probe draft / cancelled → terminal as today" (RED `284a80be9`); "422 + probe throws → non-terminal refusal"; "422 + queued → audit records queued", "422 + accepted, transition LOSES → no critical" (RED `8b9037505`) | unit |
| 13 DELETE on sending/sent labelled (sent MEASURED 403 on 2026-10-29; sending inferred) | `spec-compliance-auditor` greps the comments and docs | review |

- **Cross-tenant test (Principle I, both layers):**
  - Layer 2: the existing broadcasts RLS suite.
  - Layer 1: an `it.each` in `audience-import-repo.test.ts`, next to `:622`, over every new or changed method: the claim, the narrow clear, the fenced attach and the replace-dead-bid.
- **e2e:** no spec touches this path (cron-only, dark behind the flag).
- **Verify (step 6):**
  - **Setup:** serve the branch on :3400 from a worktree, against dev Neon, with `FEATURE_F7_IMPORT_AUDIENCE=true` set only in that worktree's `.env.local`.
    - The Resend key is the production Broadcasts key, so the probe E-Blast is a **custom-recipients** broadcast whose only recipient is `delivered@resend.dev`. A tier or segment broadcast could import real member emails from the prod-derived dev data.
    - Its member is set `suspended` on dev. This is a dev-DB write, stated here and in the session.
    - Before the first tick, `pnpm db:query` the due `approved` rows. If any exist besides the probe row, drive only the probe row (a tsx script calling `buildAudienceTick` for that id), not the global cron route.
  - **Abandon:** run tick 1 and tick 2 through `GET /api/cron/broadcasts/dispatch-scheduled` with `CRON_SECRET`. Observe that the row's import, audience and broadcast columns are cleared (`pnpm db:query`), that `/api/internal/metrics/broadcasts-gauges` no longer counts the row, and the abandon log line.
  - **Resume:** set the member to active and tick again. Expect a fresh tick 1, then tick 2 sends to the sink only. Record the Resend broadcast status and the single sink email.
  - **Wrong-input probe:** the cron without `CRON_SECRET` answers 401.
  - **Recipients:** only Resend's sink address (`delivered@resend.dev`) is ever a recipient.

## Constitution Check

1. **Data Privacy & Security.** Pass.
   - Audiences are deleted only after the row is claimed and still points at them, so erasure visibility is kept.
   - No PII in logs (`errKind`).
2. **Test-First.** Pass, with a deviation: the first commit, c5bc2f9c6, shared RED and GREEN. See Complexity Tracking. Later commits are RED, then GREEN.
3. **Clean Architecture.** Pass. Application uses ports only, and the new helpers are application-layer.
4. **PCI DSS.** n/a.
5. **i18n.** n/a, no user-facing text.
6. **Inclusive UX.** n/a.
7. **Perf & Observability.** Pass.
   - One extra GET (the probe) only on rows with an inherited id.
   - New counter catalogued in `observability.md`.
8. **Reliability.** Pass, with these residuals stated:
   - every crash point has been walked;
   - the CAS fences close the audience-delete race;
   - the fence double race ends non-terminal;
   - a second `/send` on any non-draft broadcast is refused by Resend (422, MEASURED 2026-10-29), so there is no double send, and DW12 stops that refusal being recorded as a failure.
9. **Code Quality.** Pass. Duplication removed through the shared helpers.
10. **Simplicity.** Pass. No migration, no new dependency, no flag.

## Complexity Tracking

| Deviation | Why it is needed | Simpler alternative rejected, and why |
|---|---|---|
| Solo-maintainer review (PII + audit log). The five checks: (1) ≥ 2 rounds of `/code-review high` + surface reviewers (`reliability-guardian`, `pdpa-gdpr-compliance-officer`); (2) staff review: `security-engineer` + `senior-tester`, without `whole-branch-reviewer`. The maintainer decided this on 29 Oct 2026: one branch and an unsplit review, so `/code-review high` with its target already reads the whole diff (D-022); (3) pinned coverage + Neon integration for the fence and the abandon; (4) defence in depth: the CAS predicates and 0299 CHECK at the DB; (5) the raising reviewer re-runs on each fix. Counts per round are recorded in the PR | No second human reviewer | — |
| Started outside feature-flow: branch `fix/…` on the main checkout (renamed to `138-…` before push); plan held outside the repo until 29 Oct; an L built in one pass, not one slice at a time; the review-fix round was delegated to a `software-engineer` subagent instead of the main session; c5bc2f9c6 shared RED and GREEN | The maintainer brought it into the flow mid-build on 29 Oct 2026. Restarting would discard reviewed work | Restart from a worktree, slice by slice: rejected, because it redoes reviewed work. The deviations are disclosed in the PR, with retro lines and guards in `docs/retro.md`. The next fix round runs in the main session |
| Three slices share one branch and one PR | (1) hold abandon, (2) pre-send persist + probe, (3) fence + self-heal + the shared legacy helpers all interlock. (2) changes what "handed" means for (1), and (3) re-orders (1). They were built and reviewed together, and the maintainer chose the de-duplication in this PR | One PR per slice: rejected, because (1) alone ships the measured audience-delete race and (2) alone leaves the abandon unfenced |
| Without `whole-branch-reviewer` for the seam pass, which `docs/workflow.md` § Slices asks for when slices share a branch | The maintainer ruled it out on 29 Oct 2026 (one branch, one PR; `/code-review high` reads the whole diff). Round 1 had already run it once (MERGEABLE, 1 MEDIUM, now in the fix set) | — (the user's instruction is precedence #1; recorded in `docs/decisions.md`) |

## Evidence

Filled in at Verify, one line per Done-when line.

**Slice 3 builder report, 29 Oct 2026** (re-run at Check):
- RED `0a93148ff` (23 unit + 2 integration tests failing on assertions) and `e1366f025` (41 unit + 7 integration). GREEN is the next four commits.
- **Unit** (`tests/unit/broadcasts` + `tests/unit/broadcast`): 3113/3114. The one failure is `admin-eblast-detail-actions` "a manager sees no action control", a 30 s timeout. It passes alone (80/80) and is still to be re-run at Check.
- **Contract** (`tests/contract/broadcasts`): 961/961.
- **Integration, one file at a time:**
  - `audience-import-repo` 26/26 (fence pair both orders, cross-tenant layer 1);
  - `eblast-send-time-standing` 11/11, `audience-import-two-tick` 4/4, `halt-flag-precondition` 7/7;
  - `dispatch-persist-before-send` 2/2, `eblast-approved-exit-vs-dispatch` 6/6.
- **Coverage:** `build-audience-tick.ts` 99.54 / 95.15 (pin 95 / 88); `dispatch-scheduled-broadcast.ts` 92.03 / 85.57.
- **Main session:** RED `284a80be9`, GREEN `b5afd499d` (`cancelled` → refused, both legs; 264/264). Guard RED `c1770d714`, GREEN `6d0e36b7b` (9/9; with the allowlist removed it flags exactly `c5bc2f9c6`).

**Recorded so far:**
- The Resend measurements of 2026-10-29 (spec § Premises).
- First build, before the fence rework:
  - unit 251 files / 3,074 tests;
  - contract 79 / 961;
  - integration `audience-import-two-tick` 4/4, `eblast-send-time-standing` 11/11, `audience-import-repo` 16/16, `dispatch-persist-before-send` 2/2, `eblast-approved-exit-vs-dispatch` 6/6;
  - `build-audience-tick.ts` coverage 99.6 / 95.19 / 100 / 99.6 against a pin of 95 / 88 / 100 / 95.
- Review round 1:
  - `reliability-guardian`: 0 BLOCKER, 0 HIGH, 3 MEDIUM, 4 LOW;
  - `whole-branch-reviewer`: MERGEABLE, 1 MEDIUM, 3 LOW. It ran once, before the maintainer ruled it out for this unsplit branch;
  - `/code-review high`: 10 findings.

  All are being closed in the fence commit set.

**Check, 29 Oct 2026 (main checkout, after `/simplify` commits `28255613f`, `1a3f82b97`):**
- **`pnpm check`:** exit 0, including `check:red-first` ("allowed c5bc2f9c6 …").
- **`pnpm vitest run tests/contract/`:** 253 of 256 files passed, 2,740 tests.
  - The 3 failing files are outside this change (`events/admin-events-api`, `events/csv-import-api`, `invoices/issue-as-paid`).
  - Re-run alone: 3/3 files, 96/96 tests. They timed out under load: 2.3 GB free RAM, 79 node processes on the machine.
- **`pnpm test:coverage`:** not run locally. The machine's memory reaper killed it, and the maintainer chose to let CI's required coverage check run it ("3", 29 Oct 2026). Disclosed in the PR.
- **`/simplify` gates:**
  - unit 3124/3126: 1 obsolete case removed; `broadcasts-deps-audience` timed out at 30 s under load and passes alone;
  - contract `broadcasts` 961/961;
  - integration `audience-import-repo` 26, `audience-import-two-tick` 4, `eblast-send-time-standing` 11, `dispatch-persist-before-send` 2, `eblast-approved-exit-vs-dispatch` 6.
- **Speed:** `check:red-first` dropped from 6.6–7.0 s to 1.9–2.3 s.
- **Legacy-leg diff:** 422 lines down to 386.

**Verify, 29 Oct 2026 (step 6). Driven live: Done-when 1 (abandon + gauge + audience gone) and 5 (fresh tick 1 after a resume, one send, no second send). Done-when 2 / 3 / 4 / 6 / 7 / 8 / 9 / 11 / 12 rest on the tests named in § Test plan and the suites in § Check — the live run cannot stage their races or provider faults. Done-when 10 and 13 are checked by `spec-compliance-auditor` against the docs; 13's `sent` answer was measured live (below):**
- **Setup:**
  - The branch ran on **:3401** from a detached worktree with `FEATURE_F7_IMPORT_AUDIENCE=true` set only there. :3400 was taken by another session's worktree (`Temp/f49`), which was left alone.
  - Database: the dev Neon branch (`ep-gentle-king`).
  - Data: test tenant `test-swecham-b0394791` with one approved, due, `custom` E-Blast `583cdab4-…`, whose only recipient is `delivered@resend.dev`.
  - Before the first tick, `pnpm db:query` showed 0 other approved rows on dev.
- **Route under test:** the real cron route, `GET /api/cron/broadcasts/dispatch-scheduled`, called with `x-tenant` and the bearer token.
- **Results:**
  - **Wrong-input probe:** without the bearer token the route answered **401**.
  - **Suspended at tick 1:** `held: 1`; the row was untouched (no audience, no import).
  - **Member set to full** (dev write: `awaiting_entered_at = now()`). Tick 1 returned `import_submitted: 1`; the row carries audience `194065b2-…` and import `39584250-…`.
  - **Member suspended again, tick 2:** `held: 1`. The row's audience, import, submitted_at and broadcast id are all NULL. The stuck-gauge predicate matches **0** rows. Log line `broadcasts.audience_import.abandoned_on_hold`. **GET of the tick-1 audience at Resend returned 404** (deleted).
  - **Member back to full:**
    - resume tick 1: `import_submitted: 1`, a fresh audience and import;
    - resume tick 2: `succeeded: 1`, row `sending`, `resend_broadcast_id ba647ded-…`;
    - tick 3: `processed: 0`, so no second send.
  - **At Resend:** broadcast `ba647ded-…` is `sent` (11:56:05 UTC), and **exactly one email for this subject, to `delivered@resend.dev`, `delivered`**.
  - **Measured afterwards, for Done-when 13:** `DELETE /broadcasts/{id}` on a `sent` sink broadcast → **403** "Only draft or scheduled broadcasts can be deleted"; status still `sent`.
- **Cleanup:**
  - the probe audience was deleted at Resend (200);
  - the :3401 server was stopped;
  - the worktree, including its `.env.local` copy, was removed;
  - the test tenant is left for the 6 h stale-tenant sweep.

**Review round 2, 29 Oct 2026** (on `dc7be41d6`; all reviewers ran in fresh subagents, read-only):

| Reviewer | Verdict | BLOCKER / HIGH / MEDIUM / LOW |
|---|---|---|
| `/code-review high origin/main...HEAD` | 10 findings | — / — / 6 correctness + 1 gate / 3 |
| `reliability-guardian` | PASS; every round-1 finding confirmed closed in the code | 0 / 0 / 0 / 4 |
| `pdpa-gdpr-compliance-officer` | APPROVE WITH CONDITIONS | 0 / 2 / 2 / 1 |
| `security-engineer` (staff review, security sign-off) | **SIGN WITH CONDITIONS**: the condition is the erasure gap, tracked as a flip precondition (spec 139) | 0 / 0 / 1 / 2 + 2 info |
| `senior-tester` (staff review) | SHIP-READY | 0 / 0 / 2 / 8 |
| `spec-compliance-auditor` | PARTIALLY COMPLIANT: the code meets every line; the evidence and docs did not | 0 / 3 / 8 / 2 |

**Closed in the round-2 fix set:**
- **Code:**
  - RED `8b9037505`, GREEN `068b5f0e2`: cancelled re-minted; the self-heal deletes the audience and is bounded; the accepted-send audit status is recorded; the sibling-won transition is info; an empty audience counts as none; `viaGateway` uses the shared narrowing; no provider text in the Result; new counter `restart_failed_total`.
  - RED `284a80be9` / `c1770d714` / the perf-revert case, GREEN `b5afd499d` / `6d0e36b7b` / `d2a28b07f`: the `cancelled` refusal, and `check:red-first` hardening (empty / non-SHA range refused, `--end-of-options`, a parse-to-nothing control, `perf:` / `revert:` checked).
- **Tests:** `sendLostToHold` bid≠own, the cross-tenant `it.each` asserting `tx tenant mismatch` and covering `markAudienceImportCompleted`.
- **Docs:**
  - the spec-139 flip gate (go-live § 6.10, operational-state);
  - RoPA residual 8b plus the measured DELETE facts and the hold delete;
  - erasure runbook step 2b (now 3b, round 4);
  - the stale "unmeasured `/send`" comments (3);
  - changelog counts and `cancelled`;
  - runbook § C (cancelled, the unbounded fail-closed recovery, three-invocation residual, the 403 completion-stamp noise, the new counter);
  - observability rows;
  - the plan's Approach, Files, Test plan, Rollout and Risks;
  - the spec wording (DW3, DW5, DW6, DW13), the Verify header above.
- **Measured:** DELETE on a `sent` broadcast → 403.

**Moved to spec 139:**
- the erasure gap (code-review #1, security M1, pdpa H-2 code half);
- the Art. 30 record for a hold's audience delete (reliability L4).

**Left as residuals, listed in the PR:**
- **Unbounded fail-closed refusal on a permanent probe error.** It is the reliability round-1 M2 request; the recovery is in runbook § C.
- **One earlier `test:` commit covers later logic commits** (the `check:red-first` limit).
- **Old weak cross-tenant case at `audience-import-repo.test.ts:648`.** It predates this branch.
- **Two status-split copies (import leg and refused-send) plus legacy Step 1b.** Code-review #9; the legacy copy is not touched on a live leg.

**Gates after the fix set:**
- unit `tests/unit/broadcasts` + `tests/unit/broadcast` + red-first: 3129/3130. The one failure is `admin-eblast-detail-actions` "a manager sees no action control", a 30 s timeout. It passes alone (80/80, 22 s), its file is outside the diff, and the branch touches no UI.
- contract `broadcasts` 961/961.
- integration `audience-import-repo` 27/27, `audience-import-two-tick` 4/4, `eblast-send-time-standing` 11/11.
- `red-first` 11/11.

**Review round 3, 29 Oct 2026** (on `7136bd51e`; the raising reviewers re-ran on their fixes):

| Reviewer | Verdict | Remaining |
|---|---|---|
| `pdpa-gdpr-compliance-officer` | APPROVE WITH CONDITIONS | H-1, M-1, M-2, L-1 CLOSED; H-2 PARTIAL. New MEDIUM: step 2b was correct only for the legacy leg, and on the import leg it would send a `[redacted]` E-Blast. 3 LOW |
| `senior-tester` | SHIP-READY | both MEDIUM CLOSED; new MEDIUM: nothing asserted that the critical `sent_but_transition_lost` still fires when a cancel won; 2 LOW |
| `spec-compliance-auditor` | PARTIALLY COMPLIANT (code meets every line) | 3 MEDIUM: the live-surface count, a runbook line contradicting the self-heal delete, four stale "unmeasured DELETE on sent" texts. 4 LOW |
| `/code-review high` | 10 findings | the `cancelled` restart loop; a transient `not_found` re-mint (double send); the `check:red-first` prefix / scope / `Revert "…"` gaps; the misplaced metric docblock; the refused-send phase |

**RED honesty for `8b9037505`.** Its message says all seven cases failed on their assertion. Two did not:
- **The `queued` audit case** failed on a `ReferenceError`: `sendStarted` lived in another `describe`.
- **The transition-lost case** failed on the fake's plain `40001` throw: `transitionThrowKind` was unset.
- **GREEN `068b5f0e2` fixed both setups.** Each case discriminates now (senior-tester round 3 traced each to its production line).
- **The `message: shape.kind` expectation was changed in the GREEN commit**, not in a RED of its own.

**Closed in round 4:**
- **RED `2ff6a9dcb` → GREEN `f23e9d87f`:**
  - a `not_found` id is re-probed after 3 s before it is minted over (the maintainer's choice);
  - a re-probe that finds the id sent catches the row up;
  - a dead id's refused delete no longer stops the restart.
  - Guards added: the critical log still fires when a cancel won; the `restart_failed` counter names its step.
- **RED `b26efed16` → GREEN `ff5fdb430`:** `check:red-first` counts a scoped or prefix-named RED and `Revert "…"` commits; the dead `allowShas` parameter is removed; the errors name `git fetch origin main`.
- **Docs:**
  - erasure step moved after step 3 as **3b**, marked **legacy leg only**, with a log or query fallback;
  - RoPA 8b states the interim is legacy-only, and the hold delete also covers the self-heal;
  - go-live sign-off gains 8b;
  - the stale "unmeasured DELETE on sent" text in the port docblock, `cron-jobs.md`, `observability.md` and the RoPA is corrected;
  - the runbook's "the audience is not deleted" line;
  - the metric docblock is moved onto its own method;
  - the cancel-in-flight docblock names spec 139;
  - spec line references, DW4, DW5, DW8 (the fourth bullet), and the Verify header.

**Left as residuals:**
- **The refused-send probe still reports phase `inherited_status`.** The runbook already routes `send_refused_unverifiable` there, and a new label value on the live metric is not worth adding now.
- **Detecting the transient `not_found` rests on the GET-consistency assumption.** See Risks.

**Review round 4, 29 Oct 2026** (on `02a6ed2bd`):
- **`pdpa-gdpr`:** APPROVE WITH CONDITIONS. Every round-3 item is closed. New LOW: a `cancelled` copy left at Resend uncounted (now RoPA text), plus a `tenant_id` nit for the step-3b SQL.
- **`senior-tester`:** SHIP-READY. New MEDIUM F1: `bidIsDead` was not pinned either way. LOWs F2–F6.
- **`spec-compliance-auditor`:** PARTIALLY COMPLIANT. One MEDIUM: a fifth stale "NOT MEASURED" in `sweep-expired-broadcasts.ts`. LOWs.
- **`/code-review high`:**
  - two real bugs, both from the same half-finished-teardown state: a stopped teardown's audience reused by the next tick 1, and the `bidIsDead=false` hardcode in `submitImport`;
  - a cancelled copy dropped with no record;
  - the 3 s pause on hold ticks;
  - the `check:red-first` limit;
  - the silent re-read catch;
  - the legacy inline handed test;
  - the loop readability.
- **Approach changed on the advisor's call:** one rule plus the state table above, instead of patching each transition.

**Closed in round 5:**
- **RED `c8c5169b0` → GREEN `2bbe708d7`:**
  - the stale-audience teardown;
  - the re-probe moved to `confirmImport` (single-shot probe, `catchUpHanded` shared);
  - warn lines for dead copies;
  - the re-read failure logged.
- **Docs:**
  - `sweep-expired-broadcasts.ts` measured text;
  - `observability.md` rows;
  - runbook § C;
  - RoPA cancelled-copy sentence;
  - step-3b `tenant_id`;
  - changelog list;
  - CI step renamed to "A module's logic commits follow a test commit for that module".
- **RED honesty:**
  - `f23e9d87f` also corrected an expectation in the GREEN commit (`afterGatewayCalls` 3 → 4).
  - RED `c8c5169b0` missed `build-audience-tick.test.ts` "tick 1 REUSES an audience", which pinned the old behaviour. GREEN `2bbe708d7` rewrote it to the new rule.

**Gates after round 5:**
- `pnpm typecheck` clean.
- unit `tests/unit/broadcasts` + `tests/unit/broadcast` + contract `tests/contract/broadcasts` + red-first: 329/331 files. The two failures were:
  - the known `admin-eblast-detail-actions` 30 s load timeout (outside the diff, passes alone);
  - `build-audience-tick.test.ts`, the reuse test, then rewritten: 12/12.
- failure-paths 165/165.
- integration `audience-import-two-tick` 4/4, `eblast-send-time-standing` 11/11, `audience-import-repo` 27/27.

**Left as residuals:**
- **The legacy Step 1b keeps its inline handed test (code-review #7).** It is the live leg, behaviour-identical.
- **`check:red-first` accepts one earlier test commit for a module's later logic commits.** The CI step name now says that.

**Review round 5, 29 Oct 2026** (on `68de0d271`), and the maintainer's decision:
- **The HIGH (senior-tester F3 and the auditor, also code-review #1/#2).** A single `not_found` GET drove a destructive teardown (carry on past a refused delete) and a terminal refusal, and only `confirmImport` re-probed. Closed: RED `b2c5fefda` → GREEN `ff06a0b24`. The re-probe moved to Step 1a before the standing gate; `isDeadProbe` counts only `cancelled`.
- **Code-review #3 and #4.** A hold or stale teardown can delete a no-import row's audience under an overlapping tick 1 (the claim is skipped). A legacy tick running across the flip can have its audience torn out.
- **The decision.** Five rounds each found a real bug of one class: overlapping ticks with no lease, which the row fence does not cover for rows with no import id. The maintainer chose to **split** ("แยกงาน: 138 merge + เปิด spec 140"):
  - 138 merges dark and not flip-ready;
  - spec 140 owns the import leg's tick concurrency with a dispatch lease;
  - 140 joins 139 as a flip precondition.
- **Docs.** Auditor M-1 is closed: the nine stale references to the removed `createContactImport` self-heal. So is code-review #9 (stale reuse comments). The state table splits `cancelled` from `not_found`.
- **Re-raised and kept.** Code-review #5 is the live fail-closed refusal with no bound; it is reliability round-1 M2, with recovery in runbook § C.
- **LOW, listed:**
  - #7: a false error log on the completion stamp after a 403 stop (runbook § C.4 names it);
  - #8: the `check:red-first` prefix leniency;
  - #10: repo doubles hand-stubbed in 16 files;
  - tester F4 / F5: the pause size, re-probe second answers.

**Verification of the round-5 fix, 29 Oct 2026** (the raisers re-ran):
- **`senior-tester`: SHIP-READY.** F3 is CLOSED. Its zero-edit mutation run checked the new tests against the pre-fix source: the three new tests failed, and the other 164 passed. Raised one MEDIUM: the stale-audience teardown with a `not_found` id had no test. Closed by a guard test in `853ecd56a`. Its LOWs were also fixed in that commit and `8f07e2a41`: the third site, a stale comment, an orphaned docblock, and an assertion on the pause.
- **`spec-compliance-auditor`: PARTIALLY COMPLIANT.** HIGH-1 is CLOSED. Three findings remained, and each is now closed:
  - **MEDIUM-A**, the `createBroadcast` self-heal treating `not_found` as dead: RED `853ecd56a` → GREEN `8f07e2a41`.
  - **MEDIUM-B**, five stale texts: code docblocks, `metrics.ts`, `plan.md`, the runbook.
  - **MEDIUM-C**, the go-live § 6.10 dangling paragraph.
- **Gates on the final tree:**
  - `pnpm check` exit 0 (`check:red-first`: 39 commits);
  - `pnpm vitest run tests/contract/` 256/256 files;
  - failure-paths + `build-audience-tick` 181/181;
  - integration `audience-import-two-tick` 4/4, `eblast-send-time-standing` 11/11 (after `ff06a0b24`);
  - `pnpm test:coverage` → CI (the maintainer's choice).

## Rollout

- **Dark behind `FEATURE_F7_IMPORT_AUDIENCE`** (absent from Vercel): the whole import leg.
- **Unflagged on merge — the five LIVE legacy-leg surfaces (spec Done-when 8):**
  1. the shared persist-before-send and reclaim helpers (refactor, no behaviour change; log names byte-identical);
  2. a non-retryable inherited-id probe throw is refused fail-closed (`inherited_probe_refused`, phase `inherited_status`) instead of `failed_to_dispatch` + member email;
  3. a non-retryable `/send` failure is probed (`_probe-refused-send.ts`): `queued` / `sending` / `sent` → advanced as sent; `draft` → terminal as before; anything else → a non-terminal refusal;
  4. in that probe, `cancelled` is a genuine refusal (terminal), as Step 1b reads it;
  5. `attachBroadcastId`'s CAS treats `''` as no id (it looped mint → CAS-fail → reclaim).
  Also unflagged but inert until the flag: the import-leg code, the new metrics, the cron bucket. Plus the `check:red-first` gate in `pnpm check` and CI.
- **Before the flag may be set:** spec 139 (erasure) AND spec 140 (import-leg tick concurrency, a dispatch lease) merged, and no legacy-leg row in flight (`docs/go-live-readiness.md` § 6.10). **This PR leaves the import leg dark and NOT flip-ready.**
- **Rollback:** revert the PR. There is no data migration.

## Risks

- **A live-leg regression from the helper extraction.** Noticed by the legacy unit and integration suites, the log names pinned in their tests, and `broadcasts_approved_overdue_count` in production.
- **The fence double race.** A re-asserts its id, then B claims and deletes it in the milliseconds before A's `/send`. A gets 404, re-reads the row (`sendLostToHold`) and returns a concurrent skip; no mail, nothing terminal, B's restart proceeds. No double send.
- **A transient `not_found` from Resend's GET.** Acting on a stale 404 for an accepted send — a fresh mint, a teardown, a refusal — would mail twice, kill a queued send, or record delivered mail as failed. Mitigated by one re-probe after 3 s (`REPROBE_PAUSE_MS`) in Step 1a, before every decision; GET answered consistently in every measurement on 2026-10-29 (immediately after `/send`, after a delete), but staleness cannot be induced, so this rests on that assumption. Noticed by two `send_already_accepted`-free sends for one broadcast in the Resend dashboard and by `broadcast_send_started` appearing twice for one `broadcast_id`.
- **Three overlapping invocations** (a cron fired twice by hand) can let a re-submitted import be sent into an audience the hold is deleting: a lost E-Blast, not a double send. Closing it needs a lease column: spec 140. Documented in `broadcast-audience-build.md` § C.4.
- **A fail-closed refusal can stall a row** (for example after a key rotation) until a human acts. Noticed by the `inherited_status` phase counter and `broadcasts_approved_overdue_count`. Recovery is in `broadcast-audience-build.md` § C.
