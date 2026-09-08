/**
 * 108 PR-C T085 (FR-041 / FR-042; research R9, contract broadcast-audience
 * § 3) — the ONE audience ceiling.
 *
 * Before 108 the number 5,000 lived in the resolver's `AUDIENCE_HARD_CAP`,
 * the F3 read's `.limit(5000)` and four i18n copy strings × 3 locales
 * (submit and dispatch had no number of their own — they relayed the
 * resolver's refusal), and the F7.1a batching path — built for 5,001–50,000 —
 * was unreachable because the resolver refused everything above 5,000 first
 * (R-C § 4). Now every caller reads this function through the composition
 * root (`currentAudienceCeiling()` in broadcasts-deps) and compares against
 * the same value at count, submit and dispatch, so the estimate a member
 * sees at compose is the number that decides the send.
 *
 *   - `false` → 5,000: the F7 MVP figure; a single Resend audience pushed by
 *     one dispatch tick.
 *   - `true`  → 50,000: the DB CHECK `broadcasts_estimated_recipient_cap
 *     (0..50000)` and `MAX_RECIPIENT_COUNT` — unchanged — are the hard bound.
 *
 * The composition root passes `isF71aUs1Enabled() && contactMarketingRecipients`
 * (review H-2, 2026-09-07): the wide ceiling was raised FOR the 1:N audience,
 * so it moves with the 1:N flag, not with batching alone — prod has batching
 * ON, and batching alone would have raised prod to 50,000 on a flag-OFF deploy.
 *
 * Pure Domain: the flag value is passed in; nothing here reads the env.
 */
export function audienceCeiling(batchingEnabled: boolean): number {
  return batchingEnabled ? 50_000 : 5_000;
}

/**
 * Above this many resolved recipients the `split-large-broadcasts` cron
 * routes a broadcast through per-batch audiences instead of one push. It
 * MUST stay strictly below `audienceCeiling(true)` — an accepted audience
 * the split never picks up would sit in `approved` forever — and it is
 * only ever reached with batching ON (`audienceCeiling(false)` is below
 * it). Pinned by `tests/unit/broadcasts/domain/audience-ceiling.test.ts`.
 *
 * **5,001–10,000 IS a gap — do not re-derive that it is not.** Round 2 of the
 * 2026-09-07 review called this band "the intended SINGLE-audience path under
 * `RESEND_PER_AUDIENCE_CAP`, not a gap": a correct statement about ROUTING
 * (Resend permits 10,000 contacts per audience) that never checked the WALL
 * CLOCK. Pass 4 of the staff review did. `split-large-broadcasts` skips
 * `resolvedCount <= SPLIT_THRESHOLD_RECIPIENTS`, so the band falls to
 * `dispatch-scheduled`, whose push is a SERIAL one-contact-at-a-time loop
 * inside `maxDuration = 300` — and `plan.md:268` states the serial push cannot
 * finish even 5,000 contacts in that budget. Such a broadcast is accepted at
 * submit and never delivered.
 *
 * **T095, measured 2026-09-08 — the band is WIDER than "5,001–10,000", and it
 * is NOT created by the 1:N flag.** The account limit is 10 req/s
 * (`ratelimit-policy: 10;w=1`, read from the API), but this loop is serial, so
 * its throughput is `min(limit, 1/RTT)` and the warm round trip is ~0.29 s —
 * about **3.4 req/s, latency-bound**. One 300 s tick therefore drains ~1,000
 * contacts, so anything above roughly **830** (with a 20 % margin) is
 * undeliverable **at the 5,000 ceiling that is enforced today, flag or no
 * flag**. The 1:N flip widens an existing exposure; it does not introduce one.
 * The earlier "~2 req/s" in this docblock was wrong about the account and
 * accidentally close about the effect. Detail + caveats:
 * `specs/108-contact-recipient-rules/research.md` § R9 (T095 block) and
 * `reviews/cutover.md` § 5a. Closing it is a precondition of the flag flip —
 * see the US5 AMENDMENT in `spec.md` and `reviews/pr-c.md` row 33.
 */
export const SPLIT_THRESHOLD_RECIPIENTS = 10_000;

/**
 * T095 (2026-09-08) — how many contacts ONE dispatch tick can actually push.
 *
 * `audienceCeiling` above says what the system is willing to ACCEPT. This says
 * what it can DELIVER, and until this constant existed the two were 5,000 and
 * ~1,000. A broadcast in between was accepted at submit and then killed
 * mid-push on every tick, sitting in `approved` until
 * `broadcasts_approved_overdue_count` noticed roughly ninety minutes later.
 * The composition root now enforces `min(audienceCeiling(flags), this)`, so
 * the number a member sees at compose is a number the push can honour.
 *
 * **Measured, not assumed** (`specs/108-contact-recipient-rules/research.md`
 * § R9, T095 block; five `GET /audiences` calls on one keep-alive connection
 * with the production key):
 *
 *   - the Resend account limit is **10 req/s** — `ratelimit-policy: 10;w=1`,
 *     read from the API's own headers. The "~2 req/s" that this file and three
 *     others claimed for a year was wrong;
 *   - but `addContactsToAudience` is a **serial `await` loop**, so it reaches
 *     only `min(limit, 1/RTT)`, and the warm round trip is **~0.29 s** —
 *     about **3.4 req/s**. Latency binds, not the plan. Using the documented
 *     10 as a capacity input overestimates by ~3×;
 *   - **the number comes from `POST /contacts`, the verb the loop actually
 *     calls** — 15 serial samples through a real dev audience, 2026-09-08:
 *     mean **481 ms** (median 420, p95 894, zero 429s). Mean is the right
 *     statistic here: a serial loop of N requests takes N × mean, not N × p95.
 *     `1 / 0.481 = 2.08 req/s`; `300 s × 2.08 ⇒ ~623` contacts; with a 20 %
 *     margin, **~499**. Read it the other way: **500 contacts take ~240 s,
 *     i.e. 80 % of the 300 s budget**, and the remaining 20 % absorbs
 *     dispatch's own work — the audience resolve (which grows with the
 *     audience) plus `createAudience` + `createBroadcast` + `sendBroadcast`.
 *
 *     **This corrects T095's own first answer.** That sample used
 *     `GET /audiences` (290 ms → 3.45 req/s → a bound near 830) because it was
 *     the only read-only probe available before anything had been dispatched.
 *     Writes are ~1.7× slower, and the caveat recorded with that measurement —
 *     "`GET` latency, not `POST /contacts`; all caveats push the number DOWN" —
 *     turned out to be worth 300 recipients. It also means the `~2 req/s` that
 *     four source comments carried for a year was **right about the effect**
 *     and wrong only about the cause (it read as an account cap; the account
 *     allows 10);
 *   - the account is on Resend's **Free** plan, whose 1,000-contact cap bites
 *     around ~987 (1,000 minus the 13 stored when this was checked — that
 *     subtrahend is a snapshot, not a constant, and R16's Global Contacts
 *     survive an audience delete). **What Resend actually returns at the cap
 *     is UNVERIFIED**: T095 measured `GET /audiences` and never touched the
 *     limit. IF it is a plain 4xx, `classifyResendError` makes it `permanent`
 *     and the broadcast fails terminally in one tick with an audit row — the
 *     better of the two failures. If it is a 429 or a 5xx instead, `withRetry`
 *     backs off and rethrows `retryable`, and the row sits in `approved` being
 *     re-pushed every tick — the silent failure this constant exists to
 *     prevent. Confirm on the first real send (contact count in Resend before
 *     and after, against the `resend.broadcasts.contacts_added` log) before
 *     relying on the benign reading.
 *
 * **500 sits under both bounds — for ONE broadcast in flight.** Say that part
 * out loud, because neither bound is per-broadcast:
 *
 *   - the 300 s is per INVOCATION. `dispatch-scheduled` runs up to
 *     `MAX_PER_TICK = 50` broadcasts in one `await` loop with no wall-clock
 *     check between rows, so two 500-recipient broadcasts due in the same tick
 *     need ~480 s and the second is killed mid-push — the very failure this
 *     constant closes, one layer up;
 *   - the 1,000 contacts is per ACCOUNT. Ephemeral audiences live until
 *     `cleanup-audiences` reaps them (grace 1 h, cron every 15 min), so two live
 *     500-contact audiences are 1,000 against a 1,000 cap — exactly at it.
 *
 * Both are unreachable at SweCham's cadence (a handful of sends a month, 150
 * recipients each), and both are follow-ups rather than blockers: a per-tick
 * wall-clock budget in that loop, or `MAX_PER_TICK` derived from this constant
 * and the expected concurrency.
 *
 * The value is round rather than computed on purpose: two independent limits
 * that agree to within 20 % do not justify false precision, and the inputs
 * carry caveats that all push the true figure down (measured from Bangkok, not
 * `sin1`; `GET` latency, not `POST /contacts`; four warm samples).
 *
 * **Raise it only with a new measurement**, or when the push stops being
 * serial — batched multi-tick dispatch, or Resend's Contacts Import API
 * (T086 / T087 / T106, deferred). Upgrading the Resend plan is not enough:
 * Pro raises the contact cap to 5,000 but changes no latency, so the ~830
 * wall-clock bound survives the upgrade. Money buys the cap, not the clock.
 *
 * **Principle III note**: this is an Infrastructure fact (Resend latency,
 * Vercel `maxDuration`, a Resend plan tier) sitting in `domain/`. It is not an
 * import violation — it is a bare number — but the contract it stands for
 * belongs next to the gateway that was measured. It lives here because
 * `audienceCeiling()` and `SPLIT_THRESHOLD_RECIPIENTS` already do the same
 * thing in this file and the clamp has to compare against them; moving all
 * three is the honest fix and is recorded as a follow-up, not smuggled in
 * with a bugfix.
 */
export const DELIVERABLE_RECIPIENTS_PER_TICK = 500;
