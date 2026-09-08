/**
 * 108 (FR-041 / FR-042; research R9, contract broadcast-audience § 3) — the ONE
 * audience ceiling.
 *
 * Before 108 the number 5,000 lived in the resolver's `AUDIENCE_HARD_CAP`, the
 * F3 read's `.limit(5000)` and four i18n copy strings × 3 locales. Now every
 * caller reads this through the composition root (`currentAudienceCeiling()` in
 * `broadcasts-deps`) and compares against the same value at count, submit and
 * dispatch, so the estimate a member sees at compose is the number that decides
 * the send.
 *
 *   - `false` → 5,000: one Resend audience built by the serial per-contact
 *     push.
 *   - `true`  → 50,000: the DB CHECK `broadcasts_estimated_recipient_cap
 *     (0..50000)` and `MAX_RECIPIENT_COUNT` — unchanged — are the hard bound.
 *
 * The composition root passes `isF7ImportAudienceEnabled() &&
 * contactMarketingRecipients`. The wide ceiling was raised FOR the 1:N audience
 * (review H-2), so it moves with that flag — and it also requires the import
 * build, because the serial push cannot deliver 50,000 in any number of ticks
 * that a member would wait for. Both conditions, or 5,000.
 *
 * Pure Domain: the flag value is passed in; nothing here reads the env.
 */
export function audienceCeiling(wideAudienceEnabled: boolean): number {
  return wideAudienceEnabled ? 50_000 : 5_000;
}

/**
 * T095 (2026-09-08) — how many contacts ONE dispatch tick can push through the
 * SERIAL per-contact loop.
 *
 * `audienceCeiling` above says what the system is willing to ACCEPT; this says
 * what the legacy push can DELIVER, and the two used to be 5,000 and ~623. A
 * broadcast in between was accepted at submit and then killed mid-push on every
 * tick, sitting in `approved` until `broadcasts_approved_overdue_count` noticed
 * roughly ninety minutes later. `currentAudienceCeiling()` clamps to this
 * number so nothing is accepted that the push cannot finish.
 *
 * **It applies ONLY when `FEATURE_F7_IMPORT_AUDIENCE` is off.** With the import
 * on, the whole audience goes to Resend in one size-independent call, so there
 * is no per-tick capacity to clamp against and the accepted ceiling is what the
 * flags configure. That is what stops a growing chamber's headcount from being
 * an engineering problem: above this number the answer is a Resend plan, not a
 * code change.
 *
 * **Measured, not assumed. The derivation lives in ONE place —
 * `specs/108-contact-recipient-rules/research.md` § R9, the block marked
 * CORRECTED — and is deliberately not restated here.** It was restated in five
 * places once and they drifted: the same figure appeared as ~830 and as ~623
 * depending on which document you opened, because the first sample measured
 * `GET /audiences` (290 ms) while the loop calls `POST /contacts` (481 ms, 15
 * serial samples). Writes are ~1.7× slower, and mean — not p95 — is the
 * statistic, because a serial loop of N requests takes N × mean. Short version:
 * **2.08 req/s ⇒ ~623 per 300 s tick ⇒ 500 with a 20 % margin.**
 *
 * **What Resend returns at the Free plan's 1,000-contact cap is UNVERIFIED.** A
 * plain 4xx is classified `permanent` and fails the broadcast once, with its
 * reason recorded, which is the better of the two outcomes. A 429 or 5xx is
 * `retryable` and re-attempted within budget. Confirm on the first real
 * large send.
 *
 * **The 300 s is per INVOCATION, not per broadcast** — the caveat most likely
 * to be forgotten. `dispatch-scheduled` runs up to `MAX_PER_TICK = 50`
 * broadcasts in one `await` loop with no wall-clock check between rows, so two
 * full-size legacy pushes due in the same tick need ~480 s and the second is
 * killed mid-push: the same failure, one layer up. Unreachable at SweCham's
 * cadence (a handful of sends a month, 150 recipients each), and moot entirely
 * once the import flag is on, but it is a real bound on the legacy path.
 *
 * The value is round rather than computed on purpose: the inputs carry caveats
 * that all push the true figure down (measured from Bangkok, not `sin1`; a warm
 * connection; one account), and false precision would invite trusting it.
 *
 * **Raise it only with a new measurement from `sin1`.** Upgrading the Resend
 * plan is not enough: Pro raises the contact cap but changes no latency, so
 * ~623 survives the upgrade. Money buys the cap, not the clock.
 *
 * **Principle III note**: this is an Infrastructure fact (Resend latency,
 * Vercel `maxDuration`) sitting in `domain/`. It is not an import violation —
 * it is a bare number — but the contract it stands for belongs next to the
 * gateway that was measured. It stays here because `audienceCeiling()` does the
 * same thing in this file and the clamp compares against it. Recorded in
 * `plan.md` § Complexity Tracking #5.
 */
export const DELIVERABLE_RECIPIENTS_PER_TICK = 500;
