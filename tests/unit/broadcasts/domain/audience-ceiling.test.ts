/**
 * 108 PR-C T083/T085 (FR-041, FR-042; research R9, contract § 3) — the ONE
 * audience ceiling. `audienceCeiling(batchingEnabled)` is the single
 * definition every caller reads (resolver, submit, count, dispatch); 5,000
 * when the F7.1a US1 batching path is OFF, 50,000 when ON — the latter equals
 * the DB CHECK `broadcasts_estimated_recipient_cap (0..50000)` and
 * `MAX_RECIPIENT_COUNT`, which do not change.
 *
 * The split threshold (10,000) must sit BELOW the 50,000 ceiling, or an
 * accepted audience above the threshold would never be picked up by
 * `split-large-broadcasts` and would sit in `approved` forever. The 50,000
 * argument is `batching AND the 1:N flag` at the composition root (H-2).
 */
import { describe, expect, it } from 'vitest';
import {
  audienceCeiling,
  DELIVERABLE_RECIPIENTS_PER_TICK,
  SPLIT_THRESHOLD_RECIPIENTS,
} from '@/modules/broadcasts/domain/audience-ceiling';

describe('audienceCeiling (108 PR-C)', () => {
  it('is 5,000 when the batching path is OFF (the F7 MVP figure)', () => {
    expect(audienceCeiling(false)).toBe(5_000);
  });

  it('is 50,000 when the batching path is ON (= the DB CHECK upper bound)', () => {
    expect(audienceCeiling(true)).toBe(50_000);
  });

  it('the split threshold sits strictly below the batching-ON ceiling, so every accepted large audience can reach the batch path', () => {
    expect(SPLIT_THRESHOLD_RECIPIENTS).toBe(10_000);
    expect(SPLIT_THRESHOLD_RECIPIENTS).toBeLessThan(audienceCeiling(true));
    // …and above the OFF ceiling: with batching OFF nothing is ever split,
    // because nothing above 5,000 is ever accepted.
    expect(SPLIT_THRESHOLD_RECIPIENTS).toBeGreaterThan(audienceCeiling(false));
  });
});

/**
 * T095 follow-up (2026-09-08) — the bound the PUSH can actually deliver.
 *
 * `audienceCeiling` says what the system is willing to ACCEPT. It says nothing
 * about what one dispatch tick can DELIVER, and until this constant existed
 * the two were 5,000 and ~1,000 — so a broadcast could be accepted at submit
 * and then be killed mid-push on every tick, sitting in `approved` until
 * `approved_overdue_count` noticed roughly ninety minutes later.
 *
 * Measured, not assumed (`research.md` § R9 T095 block): the Resend account
 * limit is 10 req/s (`ratelimit-policy: 10;w=1`, read from the API), but
 * `addContactsToAudience` is a serial `await` loop, so it reaches only
 * `min(limit, 1/RTT)` and the warm round trip is ~0.29 s — about 3.4 req/s.
 * Across `maxDuration = 300` that is ~1,020 contacts; with a 20 % margin,
 * **~830** — before subtracting dispatch's own per-broadcast work, so 800
 * carries ~4 % headroom, not 20 %. The account is also on Resend's FREE plan,
 * whose 1,000-contact cap bites at ~987. **800 sits under both bounds, for one
 * broadcast in flight** — neither bound is per-broadcast (the 300 s is per
 * invocation across `MAX_PER_TICK = 50` rows; the 1,000 contacts is per
 * account across un-reaped ephemeral audiences). The constant's own docblock
 * carries that caveat and the follow-ups. Round rather than computed on
 * purpose: two independent limits agreeing to within 20 % do not justify false
 * precision.
 */
describe('DELIVERABLE_RECIPIENTS_PER_TICK (T095, 2026-09-08)', () => {
  it('is 800 — under both the ~830 wall-clock bound and the ~987 Free-plan contact bound', () => {
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBe(800);
    // Pinned as inequalities too, so a later edit to the constant has to
    // confront the two numbers it is supposed to sit under rather than just
    // changing a literal and a docblock.
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(830); // 300 s × 3.4 req/s × 0.8
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(987); // Resend Free: 1,000 − 13 stored
  });

  it('binds in BOTH flag states: it is strictly below even the batching-OFF ceiling', () => {
    // This is the finding that matters and the reason the constant is not
    // "the 5,001–10,000 band". The undeliverable band starts BELOW the 5,000
    // ceiling enforced today, so the exposure predates the 108 flag entirely
    // — flipping `FEATURE_CONTACT_MARKETING_RECIPIENTS` widens it, it does
    // not create it.
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(audienceCeiling(false));
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(audienceCeiling(true));
  });

  it('sits below the split threshold, so nothing reachable ever needs splitting', () => {
    // A consequence worth stating out loud rather than discovering later: with
    // the enforced ceiling capped here, no audience can reach
    // SPLIT_THRESHOLD_RECIPIENTS, so `split-large-broadcasts` has nothing to
    // pick up. That path could not deliver anyway — `dispatch-batches` runs
    // the same serial push under the same `maxDuration = 300`, with batches of
    // up to RESEND_PER_AUDIENCE_CAP = 10,000 — so this makes an unusable path
    // unreachable rather than removing a working one.
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(SPLIT_THRESHOLD_RECIPIENTS);
  });
});
