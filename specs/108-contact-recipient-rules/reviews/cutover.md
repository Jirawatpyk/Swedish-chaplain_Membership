# 108 — Cutover record (T094)

**Feature**: `108-contact-recipient-rules` · **Flag**: `FEATURE_CONTACT_MARKETING_RECIPIENTS`
**Opened**: 2026-09-08 · **Owner**: maintainer (solo-maintainer substitute, Constitution § Governance)

This file is the artefact T094 names. It is written BEFORE the flip and updated at each step, so
that the state of every precondition is recorded at the moment it was true — not reconstructed
afterwards. **T094 does not complete when the flag is set. It completes when the five signals in
§ 4 have been observed on a real send.**

---

## 1. Flag state

| When (Asia/Bangkok) | Event | Evidence |
|---|---|---|
| 2026-09-07 | PR-C #346 (`91505b8f2`) merged; migrations `0294`–`0297` applied to prod on the deploy | CLAUDE.md § Recent Changes |
| 2026-09-08 09:36 | Last production deployment: `#351` (`d7003ea0c`, the `check:f8-error-id` CRLF fix) | Vercel deployment `dpl_BTvaqa62oyK1ypzRtBmEbvCcrwPV`, target `production`, state READY, created `2026-09-08T02:36:59Z` |
| 2026-09-08 ~09:44 | `FEATURE_CONTACT_MARKETING_RECIPIENTS=true` set in the Vercel project | maintainer, confirmed in session |
| 2026-09-08 ~10:41 | **Variable DELETED from the Vercel project** — the flip is disarmed | maintainer, confirmed in session |

**→ The flag is ABSENT, therefore `false`, and the flip is NOT armed.** `src/lib/env.ts:638`
declares `booleanFromString.default(false)`, so a missing variable is a valid boot and resolves to
off; the running production build resolves the `primary_only` leg with
`audienceCeiling(false) = 5_000`, and so will the next deployment.

**Consequence**: `main` is safe to merge again, and the preconditions in § 2 can be closed in the
order the plan intended. Setting the variable to `true` is now the deliberate first step of the
flip rather than a state the next unrelated merge would cash in.

### Why it was deleted — keep this if the variable is ever set early again

There was a window on 2026-09-08 between 09:44 and 10:41 in which the variable was `true` while
production had not yet been redeployed. That is not a harmless "staged" state. `vercel.json` has
**no `ignoreCommand`**, so every push to `main` produces a production deployment (`vercel-build`
= `run-migrations.ts && next build`): the next deployment would have performed the flip **whatever
it was for** — a docs-only PR, a typo fix, a CI-gate change. Nobody would have decided to flip it;
someone would merely have merged something. The docs PR that opened this very file would have
done it.

Deleting the variable restored the property the flag exists for: an operator gate between deploy
and the first E-Blast to newly eligible contacts (`plan.md` § Complexity Tracking #2, which
rejected flip-on-merge for exactly this reason).

The alternative — freezing `main` until the gates close — is worse: it blocks unrelated work and
it fails open, because a freeze is a convention while the deployment is automatic.

**Rule this leaves behind: on this project, setting a feature-flag env var IS the flip, scheduled
for whenever someone next merges anything. Set it when you are ready to redeploy, not before.**

---

## 2. Preconditions (quickstart § Cutover 1–3b)

| # | Precondition | Status | Note |
|---|---|---|---|
| 1 | PR-A, PR-B, PR-D deployed; V1 = 0 violations before PR-B | **CLEARED** | All four PRs merged; `0292`–`0297` applied. V1 ran read-only against prod before PR-B merged. |
| 2 | PR-C deployed with the flag OFF | **CLEARED** | #346 deployed 2026-09-07; the nine unflagged changes have been live since (quickstart § Rollback matrix row C). |
| 3 | **T093** — FR-027a pre-flight review on `/admin/marketing/audience?kind=secondary&state=on&eligible=1`; switch off anyone who must not receive; record date + reviewer in `docs/go-live-readiness.md` | **CLEARED — VACUOUS at 0 eligible secondaries** (measured 2026-09-08 10:45, maintainer) | The tenant has no secondary contact rows, so the pre-flight page is empty and the 1:N audience equals the primary-only audience. § 3 carries the count. **Expires on SweCham's secondary import — re-run then.** |
| 3a | **GDPR Art. 14 first-contact attestation** (`docs/compliance/processing-records.md:128-135`) — either the system notices a new secondary on first marketing contact, or T093 attests per contact | **CLEARED — VACUOUS at 0 secondaries** (same measurement) | No secondary contact exists, therefore no data subject the chamber has not informed. **This is the row the import turns back on**: an imported marketing list is exactly a population that never gave the chamber its addresses directly. |
| 3b | **Push-capacity gate (staff review 🔴)** | **CLEARED 2026-09-08 — closed in code, option (c)** | `DELIVERABLE_RECIPIENTS_PER_TICK = 800` in the Domain; `currentAudienceCeiling()` = `min(configured, 800)`, so count, submit and dispatch all refuse above what one tick can push. Derived from the T095 measurement (§ 5a), not from a guess. The undeliverable band no longer exists in any flag state. |
| — | **T098** `/speckit.analyze` FR↔SC↔contract traceability, findings folded into `spec.md` | **IN PROGRESS** | Ordered before T094 by `tasks.md:305`. |
| — | **T095** — record the team's real Resend throughput in `research.md` § R9/R16 | **OPEN — operator, and it is now the ONLY thing between here and a decision** | Needed as the measured input to § 5. Every rate number in the codebase today is an unsourced comment (`~2 req/s` in `audience-ceiling.ts`, `10 req/s` in the F7 notes). **§ 5a below replaces "read Settings → Usage" with a measurement that answers the question the dashboard cannot.** |
| — | **T096** — record of processing + legitimate-interest assessment | **CLEARED** | Delivered with PR-D in `docs/compliance/processing-records.md` (recipient-side LIA `:113-135`, per-contact-preference activity `:136-152`). |

---

## 3. Production scale at cutover

The 1:N widening changes the audience **only** if the tenant actually has secondary contacts that
are marketing-eligible. At 0 eligible secondaries the flag-ON audience is byte-identical to the
flag-OFF audience, rows 3 and 3a of § 2 have nothing to review, and the flip is a no-op that can
be observed safely on the next real send.

Run read-only against prod and paste the output here **on the day of the flip** — a count from an
earlier day is not evidence, because SweCham's secondary-contact import is pending and would
change it in one step:

```
EXPORT_DOWNLOAD_TOKEN_SECRET='<any 32+ char dummy>' TENANT_SLUG=swecham \
TSX_TSCONFIG_PATH=tsconfig.scripts.json \
node --env-file=.env.production --import tsx scripts/inventory-primary-contact-invariant.ts
```

| Measure | Value | Measured (Asia/Bangkok) |
|---|---|---|
| members (active/inactive, non-erased) | **150** | 2026-09-08 10:45 |
| live contacts — primaries | **150** | 2026-09-08 10:45 |
| live contacts — secondaries | **0** | 2026-09-08 10:45 |
| of those, marketing-eligible (opt-out NULL, not suppressed) — the T093 preset set | **0** (necessarily — the tenant has no secondary contact rows at all) | 2026-09-08 10:45 |
| of those, with a portal login | **0** | 2026-09-08 10:45 |
| `marketing_unsubscribes` rows | **0** | 2026-09-08 10:45 |
| members with zero live primaries / more than one (`violations`) | **0 / 0** | 2026-09-08 10:45 |
| members with NO contact row at all | **0** | 2026-09-08 10:45 |
| broadcasts currently in `approved` / `scheduled` / `sending` | not covered by this script — check the outbox before the flip | — |

Run by the maintainer against prod, read-only, output pasted into the session. Exit: *"Invariant
holds — migration 0293 (PR-B) is safe to apply."*

### What these numbers settle, and what they do not

**Settled — § 2 rows 3 and 3a are VACUOUS.** With zero secondary contact rows in the tenant, the
`all_contacts` audience is **identical** to the `primary_only` audience: same 150 addresses, in
the same order. The FR-027a pre-flight page renders an empty list — there is nobody to switch off
— and GDPR Art. 14 has no uninformed data subject to notify, because no secondary contact exists.
Recorded with the count rather than as "n/a", per FR-027a.

**Not settled — the flip is still not a no-op.** It also moves the enforced ceiling from 5,000 to
50,000 (`audienceCeiling(isF71aUs1Enabled() && contactMarketingRecipients)`; prod has batching ON),
which is what arms the undeliverable 5,001–10,000 band in § 5. That band does not depend on the
member count at all — a **custom list** reaches it directly, and a custom list of thousands is
precisely what SweCham's pending marketing import is for. **Zero secondaries closes rows 3 and 3a;
it does not close row 3b.**

**These numbers expire on the import.** They are the state at 10:45 on 2026-09-08, before the
secondary-contact import. Re-run the command above immediately after that import lands: it flips
every row in this table at once, and it turns rows 3 and 3a from vacuous into real work.

Last known figures (2026-09-05, PR-B post-deploy inventory): 150 members / 150 primaries /
**0 secondaries** / 0 violations. If that still holds, rows 3 and 3a of § 2 are **VACUOUS** — record
that verdict in `docs/go-live-readiness.md` with the date and the number, not as "n/a".

---

## 4. First send — the five signals (T094 completion criteria)

The `audience_import_status` gauge went with the deferred T086 and **does not exist** — do not
wait for it. The five signals PR-C actually ships:

- [ ] `broadcasts_audience_resolved_total{mode}` flips from `primary_only` to `all_contacts` on the first resolve (phase `dispatch`)
- [ ] `broadcasts_recipient_count_ms{outcome="ok"}` p95 inside SLO-F7-013 (400 ms @ 5,000) — note FR-043 requires this measured from `sin1`, never from CI (which scales budgets ×6) and never from a workstation
- [ ] `broadcasts_dispatch_resolve_failed_total` stays 0 **and** `broadcasts_approved_overdue_count` stays 0 through the send
- [ ] `broadcasts_marketing_opt_out_filter_count{phase="dispatch"}` is a LIVE series — present even at 0; its **absence** means the filter stopped running
- [ ] the outbox: `estimated_recipient_count` = delivered

Any of the first four wrong → § Rollback (flag OFF + redeploy) before the next dispatch tick.

**Observed on**: _pending first send_

---

## 5. The push-capacity gate (§ 2 row 3b) — CLOSED 2026-09-08

> **RESOLVED in code.** `DELIVERABLE_RECIPIENTS_PER_TICK = 800`
> (`src/modules/broadcasts/domain/audience-ceiling.ts`) and
> `currentAudienceCeiling()` = `min(configuredAudienceCeiling(), 800)` in the composition root.
> Every call site — compose count, submit, dispatch — already read that one function, and every
> i18n string interpolates `{ceiling, number}`, so the refusal, the copy and all three locales
> moved together with no message edits.
>
> This is option **(c)** from `reviews/pr-c.md` row 33, and it is only writable now because
> § 5a measured the number. 800 sits under the wall-clock bound (~830) and under the Free-plan
> contact bound (~987) — two independent limits agreeing to within 20 %.
>
> Two consequences, both pinned by tests rather than left to be discovered later:
> - **The bound binds with the 108 flag OFF too** (800 < 5,000). The undeliverable band always
>   started below today's ceiling; the flip widened an existing exposure rather than creating
>   one — so this fix was worth making whether or not 108 ever flips.
> - **The split path is now unreachable**, since nothing can reach `SPLIT_THRESHOLD_RECIPIENTS`.
>   No working capability is lost: `dispatch-batches` runs the same serial push under the same
>   `maxDuration = 300` with batches of up to `RESEND_PER_AUDIENCE_CAP = 10,000`, so it could not
>   have delivered those audiences either.
>
> The analysis below is kept because it is the reasoning the fix rests on, and because the
> "5,001–10,000 band" framing it corrects is still quoted in older review rows.

### The original analysis — why it stayed open

With the flag ON, `audienceCeiling(true) = 50_000`. `split-large-broadcasts` routes to per-batch
audiences only above `SPLIT_THRESHOLD_RECIPIENTS = 10_000`, so a broadcast resolving to
**5,001–10,000** recipients falls to `dispatch-scheduled`, whose push is a serial
one-contact-per-request loop inside `maxDuration = 300`. Such a broadcast is **accepted at submit
and never delivered** — it sits in `approved`.

Three facts that are easy to get wrong here:

1. **This is not created by the flip, it is widened by it.** `plan.md:268` states the serial push
   cannot finish even 5,000 contacts inside the 300 s budget, so the hazard already exists at the
   flag-OFF ceiling. The flip raises the accepted band, it does not invent the gap.
2. **Round 2 of the review "cleared" this and was wrong.** It reasoned about ROUTING (Resend permits
   10,000 contacts per audience) and never checked the WALL CLOCK. The docblock in
   `src/modules/broadcasts/domain/audience-ceiling.ts` says so explicitly: *"5,001–10,000 IS a gap —
   do not re-derive that it is not."*
3. **Every rate number in the repo is an unsourced comment.** `~2 req/s` in the docblock,
   `10 req/s` in the F7 notes; T095 exists precisely because nobody has measured it. At 2 req/s the
   safe bound is ≈ 600 recipients; at 10 req/s ≈ 3,000. Both are **below** the flag-OFF ceiling of
   5,000 — so the bound must be derived from a measured rate, not chosen to match a ceiling.

**Closure requires ONE of** (quickstart § Cutover 3b):

- the import build (T086/T087/T106 — deferred, not authored); or
- a lowered `SPLIT_THRESHOLD_RECIPIENTS` **plus** a wall-clock budget with resume in `addContactsToAudience`; or
- an explicit **submit-time refusal** above `300 s × measured req/s − margin`.

The third is the cheapest and is the recommended closure: a Domain change with a named constant
whose comment points at T095 as the thing that replaces the guessed rate. It is a code change and
therefore takes its own TDD cycle, review stack and PR — it is not part of this cutover record.

Two different numbers get conflated here — keep them apart:

- **Today** (measured 2026-09-08: 150 primaries, 0 secondaries — § 3): 150 addresses ≈ **75 s** at 2 req/s. Comfortable — for a *member-based* send. A **custom list** is not bounded by the member count and reaches the band directly.
- **After SweCham's secondary import** (the quickstart's projection, ~150 members × 3 contacts
  ≈ 450 addresses): ≈ **225 s against a 300 s budget** — no margin, and that is before anyone
  writes a broadcast to a custom list.

So the 5,001–10,000 band is unreachable today, but the budget stops being comfortable at the very
step SweCham is already preparing. Record the measured rate in `reviews/pr-c.md` row 33 when T095
lands, and re-derive both numbers from it rather than from the 2 req/s guess above.

---

## 5a. T095 — MEASURED 2026-09-08 12:41

**Decision, 2026-09-08 (maintainer): the flip WAITS for T095.** Not because the risk was large at
today's scale — § 3 measured 150 primaries and 0 secondaries — but because no correct bound can be
written without the number, and a guessed bound is the exact defect this feature spent seven
review rounds removing. **T095 is now done. T094 remains open pending the decision it enables.**

### The result

Five `GET /audiences` calls with the production `RESEND_BROADCASTS_API_KEY`, keep-alive on one
connection, from the maintainer's Bangkok workstation:

```
ratelimit-policy: 10;w=1    ratelimit-limit: 10    200 OK on every call
req0 (cold)   dns=4ms  tcp=8.5ms  tls=37ms   total=333ms
req1..req4    (connection reused)            total=285 / 281 / 300 / 291 ms
```

| | |
|---|---|
| Account rate limit | **10 req/s** — confirmed from the API's own headers, not from a docs page |
| Warm round trip | **~0.29 s** (tight: 281–300 ms; the TLS handshake is only 37 ms, so connection reuse is not the lever) |
| **Serial-loop throughput** | **≈ 3.4 req/s** = `min(10, 1 / 0.29)` — **latency-bound, not plan-bound** |
| `per_tick_max` = `300 × 3.4 × 0.8` | **≈ 830 contacts** |

### What it changes

- **The "~2 req/s" in `resend-broadcasts-gateway.ts` and in `reviews/pr-c.md` row 33 was wrong**
  about the account: the limit is 10. It was accidentally close about the *effect*, for the wrong
  reason.
- **The documented 10 req/s overestimates capacity by ~3×** if used as a throughput input, which
  is what `plan.md:268` and `research.md` R9 both did.
- **The undeliverable band starts near ~830–1,000 recipients — below the 5,000 ceiling enforced
  today.** So this is not a hazard the flip introduces; the flip widens an exposure that already
  exists on the `primary_only` leg, exactly as `plan.md:268` claimed and as the 5,001–10,000
  framing obscured.
- **`withRetry`'s 429 backoff never fires.** At 3.4 req/s the loop never approaches a 10 req/s
  policy, so row 33's "one 429 backoff burst eats the margin" cannot happen in normal operation.

### Against SweCham's real numbers

| Population | Push time at 3.4 req/s | Share of the 300 s budget |
|---|---|---|
| Today — 150 primaries, 0 secondaries (§ 3) | ≈ **44 s** | 15 % |
| After the secondary import (~150 × 3 ≈ 450) | ≈ **132 s** | 44 % |
| The bound | ~830 | 80 % (the margin) |

Both real populations fit comfortably. **The gap is entirely between ~830 and whatever ceiling is
enforced** — 5,000 today, 50,000 after the flip. Nothing SweCham can currently compose reaches it;
a pasted custom list could.

### And the account is on Resend's FREE plan — which binds before any of this

Confirmed 2026-09-08 from the Resend billing + usage pages: **1,000 contacts** (13 in use),
**3 segments/audiences** (1 in use — `General`), 3 domains, unlimited broadcast sending.

| Bound | Where it bites | Failure mode |
|---|---|---|
| **Free plan: 1,000 contacts** | a broadcast above ~**987** recipients (1,000 − 13 stored) | 4xx → `permanent` → **`failed_to_dispatch`** in one tick, audited. **Loud and terminal — the good failure.** |
| Wall clock: ~830/tick | above ~830 | killed mid-push every tick, sits in `approved`, alarmed ~90 min later by `approved_overdue_count`. **Silent — the bad one.** |
| **Free plan: 3 segments** | **2** concurrent in-flight broadcasts (`General` holds one slot) | third fails until the `cleanup-audiences` cron frees room — the "plan-segment-limit overflow" already in `go-live-readiness.md` § 6.6 |

Two bounds, 20 % apart, arrived at independently — they agree on where the safe ceiling is.

**Upgrading does not fix the push.** Pro marketing ($40/mo) takes contacts to 5,000 and segments to
unlimited, but latency is latency: ~3.4 req/s and ~830-per-tick survive the upgrade. Money buys the
contact cap, not the wall clock.

**The mismatch worth naming**: the app accepts up to 5,000 today (50,000 after the flip) while the
provider account can hold 1,000. SweCham reaches neither — 150 now, ~450 post-import — but a
configured ceiling 5× to 50× above what the account can physically accept is invisible until a
send fails.

### Caveats — all of which push the true number DOWN, not up

1. Measured from a Bangkok workstation, not from Vercel `sin1`. Re-check against
   `resend.broadcasts.contacts_added` on the first real send.
2. `GET /audiences` is a read; the loop calls `POST /contacts`, a write. This is a lower bound on
   latency and therefore an **upper** bound on throughput.
3. Four warm samples. Variance was low (281–300 ms), but four is four.

### The method, kept because it is the part that was wrong

### The measurement the task originally asked for is insufficient

"Resend → Settings → Usage" gives the **account's rate limit**. The push cannot necessarily reach
it. `addContactsToAudience` is a *serial* `await` loop — one request, wait for the response, next
request (`resend-broadcasts-gateway.ts:246-267`) — so its throughput is

```
observed_req_per_sec  =  min( account_rate_limit , 1 / round_trip_time )
```

A 50 req/s account still pushes ~5 req/s if each round trip from `sin1` takes 200 ms. **The
binding constraint may be latency, not the plan.** Recording only the plan's limit would put a
second unsourced number in the repo next to the two already there.

### One command, both numbers

Run from the repo root (reads the key out of `.env.production` without printing it; `GET
/audiences` is read-only and changes nothing):

```bash
KEY=$(grep -m1 '^RESEND_BROADCASTS_API_KEY=' .env.production | cut -d= -f2- | tr -d '"\r')
curl -sS -D - -o /dev/null -w '\nround_trip_seconds: %{time_total}\n' \
  -H "Authorization: Bearer $KEY" https://api.resend.com/audiences \
  | grep -iE '^HTTP|ratelimit|retry-after|round_trip'
```

Record all of it in `research.md` § R9/R16 and in `reviews/pr-c.md` row 33:

- `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset` — the account's limit, from the
  API itself rather than from a docs page;
- `round_trip_seconds` — one sample of the RTT that bounds the serial loop. Take three or four
  samples; use the slowest.

### Then the arithmetic, done once

```
throughput      = min( ratelimit-limit , 1 / round_trip_seconds )
per_tick_max    = 300 s × throughput × 0.8      (20 % margin for retries and the rest of the tick)
```

| If throughput is | one tick drains about | the undeliverable band starts near |
|---|---|---|
| 2 req/s | 600 | 480 |
| **3.4 req/s ← measured** | **1,035** | **830** |
| 5 req/s | 1,500 | 1,200 |
| 10 req/s (the documented limit — *not* the achievable throughput) | 3,000 | 2,400 |

Every row **starts below the 5,000 ceiling that is enforced today**, which is the finding that
matters: the wall-clock hazard is not the 5,001–10,000 slice the flip adds, it is everything above
`throughput × 300` in *any* path. `dispatch-batches` also runs `maxDuration = 300`
(`route.ts:90`) and `RESEND_PER_AUDIENCE_CAP = 10_000` per batch, so splitting does not escape it
— a batch is just a smaller version of the same serial push.

### What the number decides — now that it is known

The measured 3.4 req/s puts us squarely in the second case below, so **the fix is worth doing
whether or not 108 ever flips**:

- **The exposure already exists at today's ceiling.** A broadcast between ~830 and 5,000
  recipients is accepted at submit today, on the `primary_only` leg, with the 108 flag off, and
  cannot finish its push. Nothing about the flip created that.
- **The cheapest correct closure is now writable with a measured number**: an explicit
  submit-time refusal above `per_tick_max` with its own error code, the constant carrying the
  measurement, its date and its method — option (c) of `reviews/pr-c.md` row 33. A round **800**
  sits just under the computed 830 and three orders of magnitude above anything SweCham can
  compose, so its blast radius today is zero while it closes the band completely.
- **It is still a behaviour change on a live path**: audiences of 801–5,000 are accepted today and
  would start being refused. They are exactly the ones that silently fail now, so the refusal
  replaces a silent failure with a legible one — but it must ship as a stated change, with a
  Domain test, an error code, i18n copy in three locales and its own review stack, not as a
  quiet constant.
- **The ceiling raise then stops mattering.** With a refusal at ~800 binding first, whether the
  ceiling reads 5,000 or 50,000 is cosmetic, and gate 3b is closed by construction rather than by
  argument.

## 6. After the flip

- One clean week → **T099**: delete the flag from `src/lib/env.ts`, `.env.example` and Vercel, and delete the `primary_only` leg in `resolve-segment-recipients.ts` and `findMembersBySegmentForBroadcast`; re-pin the tests.
- Separate, unrelated to the flag: the live-mode switch item — Stripe Dashboard → Customer emails → **"Successful payments" = OFF** (quickstart § Cutover 7, gap G1's operator residual).
