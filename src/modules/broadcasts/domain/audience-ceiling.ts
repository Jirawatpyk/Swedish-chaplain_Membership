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
 * T095 (2026-09-08), re-purposed by Phase 9b — how many contacts ONE dispatch
 * tick can push, and therefore **how big one batch is**.
 *
 * `audienceCeiling` above says what the system is willing to ACCEPT. This says
 * what one invocation can DELIVER, and the two used to be 5,000 and ~623: a
 * broadcast in between was accepted at submit and then killed mid-push on every
 * tick, sitting in `approved` until `broadcasts_approved_overdue_count` noticed
 * roughly ninety minutes later.
 *
 * **T095 closed that by clamping the accepted ceiling to this number. Phase 9b
 * replaced the clamp with batching, and the difference matters:** a clamp
 * refuses what it cannot deliver in one tick, so a chamber that grows past 500
 * members hits an engineering wall that needs a code change. Batching cuts the
 * audience at this number instead and delivers one batch per tick, so headcount
 * binds on the Resend plan — a billing decision — rather than on a constant.
 * `SPLIT_THRESHOLD_RECIPIENTS` below is therefore derived from this, and
 * `currentAudienceCeiling()` clamps to it ONLY on the single-tick path (with
 * batching off, nothing splits, so the old bound is still the real one).
 *
 * **Measured, not assumed. The derivation lives in ONE place —
 * `specs/108-contact-recipient-rules/research.md` § R9, the block marked
 * CORRECTED — and is deliberately not restated here.** It was restated in five
 * places once, and they drifted: the same figure appeared as ~830 and as ~623
 * depending on which document you opened, because the first sample measured
 * `GET /audiences` (290 ms) and the loop calls `POST /contacts` (481 ms, 15
 * serial samples). Writes are ~1.7× slower and mean, not p95, is the statistic
 * — a serial loop of N requests takes N × mean. The short version: **2.08
 * req/s ⇒ ~623 per 300 s tick ⇒ 500 with a 20 % margin**, i.e. 500 contacts
 * take ~240 s and the remaining 20 % absorbs the resolve plus `createAudience`
 * + `createBroadcast` + `sendBroadcast`.
 *
 * **What Resend returns at the Free plan's 1,000-contact cap is still
 * UNVERIFIED**, and the two possibilities differ in kind. A plain 4xx is
 * classified `permanent`, and since Phase 9b that is no longer auto-retried —
 * the batch fails once, with its reason on the manifest, for a human. A 429 or
 * 5xx is `retryable` and will be re-attempted within budget. Confirm on the
 * first real send (contact count in Resend before and after, against the
 * `resend.broadcasts.contacts_added` log).
 *
 * **Neither bound is per-broadcast**, which is the caveat most likely to be
 * forgotten:
 *
 *   - the 300 s is per INVOCATION. `dispatch-scheduled` runs up to
 *     `MAX_PER_TICK = 50` broadcasts in one `await` loop with no wall-clock
 *     check between rows, so two full-size broadcasts due in the same tick
 *     need ~480 s and the second is killed mid-push — the same failure, one
 *     layer up. `dispatch-batches` is bounded by its own concurrency cap;
 *   - the 1,000 contacts is per ACCOUNT. Ephemeral audiences live until
 *     `cleanup-audiences` reaps them (grace 1 h, cron every 15 min), so two
 *     live full-size audiences already sit at the Free cap.
 *
 * Both are unreachable at SweCham's cadence (a handful of sends a month, 150
 * recipients each) and both are follow-ups: a per-tick wall-clock budget in
 * that loop, or `MAX_PER_TICK` derived from this constant and the expected
 * concurrency.
 *
 * The value is round rather than computed on purpose: two independent limits
 * that agree to within ~40 % do not justify false precision, and the inputs
 * carry caveats that all push the true figure down (measured from Bangkok, not
 * `sin1`; a warm connection; one account).
 *
 * **Raise it only with a new measurement from `sin1`.** Upgrading the Resend
 * plan is not enough: Pro raises the contact cap to 5,000 but changes no
 * latency, so ~623 survives the upgrade. Money buys the cap, not the clock.
 * The push stopping being serial WOULD change it — Resend's Contacts Import
 * API is size-independent (research § R9 V4, open).
 *
 * **Principle III note**: this is an Infrastructure fact (Resend latency,
 * Vercel `maxDuration`, a Resend plan tier) sitting in `domain/`. It is not an
 * import violation — it is a bare number — but the contract it stands for
 * belongs next to the gateway that was measured. Phase 9b re-examined the
 * question and kept it here: `audienceCeiling()` and
 * `SPLIT_THRESHOLD_RECIPIENTS` do the same thing in this file, the threshold
 * is now DERIVED from this constant so the two cannot be separated, and moving
 * all three during a behaviour change would mix a refactor into a fix. The
 * deviation is recorded in `plan.md` § Complexity Tracking #5.
 */
export const DELIVERABLE_RECIPIENTS_PER_TICK = 500;

/**
 * Above this many resolved recipients the `split-large-broadcasts` cron routes
 * a broadcast through per-batch audiences instead of one push.
 *
 * **It is DERIVED from the constant above, not a second literal, and that
 * equality is the whole of Phase 9b.** Before 9b it was 10,000 — Resend's
 * per-audience capacity — while one dispatch tick could push about 623. Every
 * audience between the two was refused by `split-large-broadcasts` (too small)
 * and killed at `maxDuration` by `dispatch-scheduled` (too large): accepted at
 * submit, never delivered, noticed roughly ninety minutes later by
 * `broadcasts_approved_overdue_count`. Deriving one from the other closes that
 * band permanently — there is no arithmetic left in which a broadcast can be
 * too big for one tick and too small to split.
 *
 * Two invariants, both pinned in `tests/unit/broadcasts/domain/audience-ceiling.test.ts`:
 *
 *   - it MUST stay `<= RESEND_PER_AUDIENCE_CAP` (10,000). That is the
 *     provider's hard limit on one audience, and a batch is one audience. It is
 *     nowhere near binding today, which is exactly why it needs a test: a
 *     future latency win that raises the tick bound would otherwise sail past
 *     it and turn every split into a 4xx;
 *   - it MUST stay `< audienceCeiling(true)`, or an accepted audience the split
 *     never picks up would sit in `approved` forever.
 *
 * The old pin `SPLIT_THRESHOLD_RECIPIENTS > audienceCeiling(false)` is gone
 * rather than adjusted. It encoded "with batching OFF nothing is ever split,
 * because nothing above 5,000 is accepted" — still true, but now stated where
 * it can be observed: with batching OFF the ENFORCED ceiling equals this
 * threshold (`currentAudienceCeiling()` in `broadcasts-deps.ts`), so nothing
 * above it is accepted in the first place.
 *
 * **The two crons must partition the `approved` set, and neither may release a
 * row it has claimed.** They claim on `estimated_recipient_count`, frozen at
 * submit; delivery is bounded by the RESOLVED count, read days later. Where
 * those disagree, `dispatch-scheduled` hands off by writing the resolved count
 * back as the estimate (it never dies mid-push), and `split-large-broadcasts`
 * splits whatever it resolved even when that has fallen below this threshold
 * (it never skips). Removing either half strands broadcasts in `approved` with
 * no owner — see `specs/108-contact-recipient-rules/tasks.md` Phase 9b, T147
 * and T148, for the two directions and how each was found.
 */
export const SPLIT_THRESHOLD_RECIPIENTS = DELIVERABLE_RECIPIENTS_PER_TICK;
