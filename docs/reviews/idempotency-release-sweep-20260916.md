# Idempotency reservation-release sweep — 2026-09-16

**Branch**: `117-idempotency-release-sweep` (cut from `origin/main` `d491800a1`)
**Class**: a reserved idempotency record left behind on an arm that does not
remember a response burns the key for 24 h.
**Scope**: 20 route files + the shared plans guard. Closed everywhere.

**Why this file lives in `docs/reviews/` and not
`specs/114-member-change-approval/reviews/`**: the *reference* fix (T121,
PR #371) is F114's, but the class spans `plans`, `members`, `invoicing`,
`payments`-adjacent settings and the portal — five modules, none of which is
F114. Filing a cross-cutting sweep under one feature's spec directory hides it
from the next person who greps for it. `docs/reviews/` is new; this is its
first entry.

---

## 1. The class

`reserveIdempotencyRecord` (`src/lib/idempotency.ts:210`) writes
`{ bodyHash, response: null }` under a 24 h TTL, and
`classifyIdempotencyRequest` (`:172-182`) reads a reserved-but-unwritten record
as a **conflict** — the "another worker is still working" case. That is correct
while the handler runs.

The moment the handler finishes with an outcome it must not remember, it is
wrong. The record stays for the rest of the TTL, so the client's retry — same
key, same body, the retry `Retry-After` and every HTTP client's retry policy
tell it to make — is answered with the route's conflict status (422
`idempotency-key-reused` on the portal route, 409 `idempotency_conflict`
everywhere else) and **can never succeed**.

PR #371 / T121 fixed it by hand on `portal/change-requests` (the `rate_limited`
and `server_error` arms). Sixteen files had no release call at all, which is
what this sweep closes.

## 2. Discovery

`grep -rln "withIdempotency\|reserveIdempotencyRecord\|runIdempotencyGuard" src/`
found **20 route files + the shared guard**, not the sixteen the brief listed.
The four extra callers all reserve through
`src/app/api/plans/_idempotency-guard.ts`:
`plans/[year]/[planId]/{activate,deactivate,undelete}` and
`admin/scheduled-plan-changes/[id]/cancel`. They were exposed by the same
defect, through a file that itself had no release path.

`withIdempotency` (the convenience wrapper at `idempotency.ts:312`) has **no
caller in `src/` today**. It reserves, so the gate's regex covers it the day one
appears.

### Table — arms live after the reservation

"Remembered" = the arms whose behaviour is unchanged by this sweep.
"Burnt" = the arms that exited without remembering, i.e. the class.
Every burnt arm below now RELEASES. **No arm changed from burnt to
remembered** — see § 5.

| # | route (handler) | remembered (unchanged) | burnt → now released | throw reachable after reservation? |
|---|---|---|---|---|
| 1 | `admin/contacts/[contactId]/marketing` POST | 200 changed / unchanged | 404 ×2, 409 self_opted_out, 409 suppressed, **503** suppression_unavailable, **500** | yes — use case + `deps.audit.record` |
| 2 | `members/[memberId]/archive` POST | 200 | 400, 404, 409 state_error, **500** | yes — session/invitation cascade |
| 3 | `members/[memberId]/contacts/[contactId]` PATCH | 200 ×2 | 404, **500** (email-change path), 400/404/409/**500** (inner switch ×2), 400 ×2, 404, **500** (outer switch) | yes — atomic email-change tx |
| 4 | `members/[memberId]/contacts` POST | 201 | 400 ×2, 409 conflict, 404, **500** | yes |
| 5 | `members/[memberId]/erase` POST | 200 | 400, 404, **500** | yes — the erasure cascade is the fattest throw surface here |
| 6 | `members/[memberId]/inline-edit` PATCH | 200 (key optional) | 400 ×2, 404, 409 state_error, **500** | yes |
| 7 | `members/[memberId]` PATCH | 200 ×2 (changePlan + updateMember) | changePlan: 400 ×2, 404 ×2, 409, 422 ×2, **500**; updateMember: 400 ×2, 404, **500** | yes — incl. `await import('@/modules/renewals')` |
| 8 | `members/[memberId]/undelete` POST | 200, **409 no_primary_contact** | 404, 403 archive_window_expired, 409 state_error (other codes), **500** | yes |
| 9 | `members/bulk` POST | 200 ×5, deterministic 4xx ×4 | **429 bulk_rate_limit_exceeded**, the **500** arms the route deliberately skips, final switch 400 ×2 / 404 ×2 / 409 / **500** | yes |
| 10 | `members` POST | 201 | 400 ×2, 404 plan_not_found, 422 ×3, 409 ×2, **500 audit_failed**, **500** | yes — incl. the dynamic renewals import |
| 11 | `plans/[year]/[planId]` PATCH | 200 | 400, 422 ×2, 404, 409, **500** ×2 | yes |
| 12 | `plans/[year]/[planId]` DELETE | 200 | 404, 409 ×2, **500** ×2 | yes |
| 13 | `plans/_idempotency-guard.ts` | — (reserves for #14–#17) | **every** arm of its four callers | — |
| 14 | `plans/[year]/[planId]/activate` POST | 200 | 404, **500 audit_failed**, **500** | yes |
| 15 | `plans/[year]/[planId]/deactivate` POST | 200 | 404, **500 audit_failed**, **500** | yes |
| 16 | `plans/[year]/[planId]/undelete` POST | 200 | 404, 409 idempotency_conflict, **500** ×2 | yes |
| 17 | `admin/scheduled-plan-changes/[id]/cancel` POST | 200, 200 + audit-backfill headers | 400, 404, 409 already_terminal, **500** | **yes, by construction** — the `default:` arm calls `assertNever`, and no `catch` encloses the switch |
| 18 | `plans/clone` POST | 201 | 400, 409 ×3, **500 audit_failed**, **500** | yes |
| 19 | `plans` POST | 201 | 400, 422, 409 ×2, **500 audit_failed**, **500** | yes |
| 20 | `portal/profile/marketing` PATCH | 200 | 404 ×2, 409 ×2, **503** suppression_unavailable, **500** | yes |
| 21 | `tenant-invoice-settings/logo` POST | 201 **and** 415 / 413 / 409 / 400 | **nothing but a throw** | yes — sharp re-encode, Blob put, DB write |

Two entries deserve reading twice:

- **#9 `members/bulk`** is the sharpest case in the repo. The rate limit is
  consumed *after* the reservation, so a 429 both tells the client to retry and
  guarantees the retry cannot work. The route's own comment already said "5xx
  is deliberately NOT cached: an infra fault must stay retryable with the same
  key" — the reasoning was right and the reservation was left behind anyway.
- **#21 logo** was the only route already remembering every status it returns.
  Its sole exposure was a throw — which is exactly the arm a hand-written
  release sweep would have skipped.

## 3. Mechanism

`src/lib/idempotency-run.ts` — `runIdempotent(tenant, reservation, work)`:

```ts
let answered = false;
try {
  return await work({ remember: async (r) => { await rememberIdempotentResponse(...); answered = true; } });
} finally {
  if (!answered) await releaseIdempotencyRecord(tenant, reservation.key);
}
```

Design notes:

- **A closure, not a `release()` the caller remembers to call.** The class
  recurs because a hand-written release must be repeated at every exit and a
  new arm added later gets none. `finally` covers every exit there is,
  including the ones nobody wrote down.
- **`remember` refuses a 429 or a 5xx** and releases instead. No caller asks
  for one today; the guard exists so a future arm cannot make one stick for
  24 h.
- **`answered` is set AFTER the write**, so a remember that itself throws still
  releases rather than leaving the key burnt.
- **A `null` reservation is a no-op** — that is the optional-`Idempotency-Key`
  path (`inline-edit`, `logo`), where nothing was reserved.
- **It lives outside `@/lib/idempotency` on purpose.** Twenty-three contract
  suites `vi.mock('@/lib/idempotency')` with an explicit factory (the module
  builds an Upstash client at load). A `runIdempotent` exported from there
  would be replaced by a stub in every one of them, and the release path would
  never be exercised by the tests written to prove it. From its own module it
  calls through to whatever `@/lib/idempotency` resolves to — the real module
  in production, the suite's spies under test.
- **The plans family** keeps its shared guard: `_idempotency-guard.ts` gained
  `idempotentRun(guard, work)`, the same helper bound to the guard's
  reservation, so its four callers read `idempotentRun(guard, async ({ remember }) => …)`.

**Behaviour preservation is measured, not asserted.** `git diff -w` across all
20 route files + the guard is 116 insertions / 82 deletions: the import swap,
one wrapper line per handler, the `rememberIdempotentResponse(t, k, h, x)` →
`remember(x)` collapse, and the guard's new export. Everything else in the diff
is indentation.

## 4. Tests

- `tests/unit/lib/idempotency-run.test.ts` — 6 cases on the helper: remembers
  and does not release; releases on a plain return; releases and rethrows on a
  throw; refuses 429/500/503; releases when remembering throws; no-ops on a
  null reservation.
- **One focused class test per route handler**, in that route's existing
  contract suite, asserting `rememberIdempotentResponse` was NOT called and
  `releaseIdempotencyRecord(tenant, <key>)` WAS — 27 tests across 18 suites.
  `members/bulk` gets the 429 arm as well as the 500; `cancel` and `logo` get
  the throw path; `logo` also gets the negative (no key ⇒ no release);
  `portal/profile/marketing` gets the 503 arm.
- `tests/unit/architecture/idempotency-release-coverage.test.ts` — the gate.
  Scans `src/app/**/route.ts` + the plans guard (comments stripped, `\r?\n`
  safe): every file that reserves must call `runIdempotent` or
  `releaseIdempotencyRecord`; no remember call may be handed a literal 5xx
  status. Four positive controls, because a scan that cannot tell "nothing to
  find" from "not looking" is not a check: the scan must find ≥ 17 reserving
  files and must contain the plans guard; a reservation-without-release fixture
  must fail rule 1; both release shapes must pass it; a remembered 500 must
  fail rule 2.

**RED was measured, not assumed.** With `src/` reverted to `origin/main` and
the tests in place, all 27 class tests and the gate failed — one distinct line
per route (`expected "spy" to be called with arguments: [ Anything, '<key>' ]`)
and `expected [ …(16) ] to deeply equal []` for the gate. `src/` was then
restored and verified byte-identical against the saved `--numstat`.

## 5. Deliberately left

1. **No arm was promoted from burnt to remembered.** Several deterministic 4xx
   arms (404 `not_found` on every plans and members route, 409 `conflict`, 422
   validation) would arguably be better *remembered*, so a retry replays the
   same refusal instead of re-running the use case. That is a behaviour change
   on live-stakes money routes and is out of this sweep's scope. Release is
   behaviour-neutral for them: the retry re-evaluates and returns the same
   deterministic answer, and the key is no longer burnt either way. Listed
   here rather than changed silently.
2. **`plans` POST / `plans/clone` `audit_failed` (500).** These fire *after*
   the row(s) have committed. Before: the retry got 409
   `idempotency_conflict`. After: the retry re-runs and gets 409
   `duplicate_plan` / `target_year_populated` — same status, more truthful
   body, and the operator-backfill log line is unchanged. Not silent, but
   worth knowing before reading a support ticket.
3. **`members/bulk` keeps its nine explicit remember sites** (the brief
   guessed 19; it is 9). They are unchanged inside the wrapper, including the
   `if (errorResponse.status === 500)` guard that skips remembering an infra
   fault — that guard is now correct rather than half-correct, because the
   skipped arm also drops the reservation.
4. **Rule 2 of the gate is grep-level.** A status carried in a variable
   (`bulk`'s `errorResponse`, `logo`'s `status`) is out of reach of a source
   scan. `runIdempotent`'s runtime refusal of 429/5xx is the backstop for
   those, and it has a unit test.
5. **`releaseIdempotencyRecord` stays best-effort** (`redis.del` in a
   try/catch). A Redis outage during the release leaves the reservation to
   expire on its TTL — the pre-existing behaviour, and it must never turn a 429
   into a 500.
6. **No integration test was added.** Every one of these routes has a contract
   suite that drives the real handler with the idempotency primitives mocked,
   which is where the release is observable; a live-Neon test would exercise
   Postgres, not Upstash.

## 6. Files

| | |
|---|---|
| mechanism | `src/lib/idempotency-run.ts` (new), `src/app/api/plans/_idempotency-guard.ts` (+`idempotentRun`) |
| routes | the 20 files in the table above |
| gate | `tests/unit/architecture/idempotency-release-coverage.test.ts` (new) |
| helper tests | `tests/unit/lib/idempotency-run.test.ts` (new) |
| class tests | 18 existing contract suites, insertion-only |
| convention | `docs/code-conventions.md` § 9 |
