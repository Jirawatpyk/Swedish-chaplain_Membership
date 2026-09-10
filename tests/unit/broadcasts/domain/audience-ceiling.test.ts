/**
 * 108 — the ONE audience ceiling. `audienceCeiling(wideAudienceEnabled)` is the
 * single definition every caller reads (resolver, submit, count, dispatch):
 * 5,000 normally, 50,000 when BOTH the Contacts-Import build and the 1:N
 * audience are on — the latter equals the DB CHECK
 * `broadcasts_estimated_recipient_cap (0..50000)`, which does not change.
 *
 * The wide ceiling needs both flags for different reasons. The 1:N flag is
 * WHOSE addresses (review H-2: the ceiling was raised for that audience, so it
 * moves with it). The import flag is whether 50,000 can be DELIVERED at all —
 * the serial per-contact push manages ~2.08 req/s, so it could not finish that
 * audience in any number of ticks a member would wait through.
 */
import { describe, expect, it } from 'vitest';
import {
  audienceCeiling,
  DELIVERABLE_RECIPIENTS_PER_TICK,
} from '@/modules/broadcasts/domain/audience-ceiling';

describe('audienceCeiling (108)', () => {
  it('is 5,000 by default', () => {
    expect(audienceCeiling(false)).toBe(5_000);
  });

  it('is 50,000 for the wide audience (= the DB CHECK upper bound)', () => {
    expect(audienceCeiling(true)).toBe(50_000);
  });
});

/**
 * T095 (measured 2026-09-08) — the bound the LEGACY serial push can deliver in
 * one dispatch tick.
 *
 * `audienceCeiling` says what is ACCEPTED; this says what the per-contact loop
 * can push before `maxDuration = 300` kills it. Until this constant existed the
 * two were 5,000 and ~623, so a broadcast in between was accepted at submit and
 * then killed mid-push on every tick, sitting in `approved` until
 * `approved_overdue_count` noticed about ninety minutes later.
 *
 * It binds only while `FEATURE_F7_IMPORT_AUDIENCE` is OFF. With the import on,
 * the whole audience goes in one size-independent call and there is no per-tick
 * capacity to clamp against — which is the point: above this number the answer
 * becomes a Resend plan rather than a code change.
 *
 * Derivation lives in ONE place (`research.md` § R9, CORRECTED block) and is
 * not restated here: it was restated in five places once and they drifted, the
 * same figure reading ~830 or ~623 depending on which document you opened,
 * because the first sample measured `GET /audiences` (290 ms) while the loop
 * calls `POST /contacts` (481 ms). Short version: 2.08 req/s ⇒ ~623 per 300 s
 * ⇒ 500 with a 20 % margin. The Resend Free plan's ~987 usable contacts is a
 * second, independent bound that agrees.
 */
describe('DELIVERABLE_RECIPIENTS_PER_TICK (T095)', () => {
  it('is 500 — under both the ~623 wall-clock bound and the ~987 Free-plan contact bound', () => {
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBe(500);
    // Pinned as inequalities too, so a later edit has to confront the two
    // numbers it is supposed to sit under rather than just changing a literal
    // and a docblock.
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(623); // 300 s ÷ 481 ms measured POST /contacts
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(987); // Resend Free: 1,000 − what was stored that day
  });

  it('is below even the narrow accepted ceiling, so it binds whenever it applies', () => {
    // The finding that made this constant necessary: the undeliverable band
    // started BELOW the 5,000 ceiling that was already enforced, so the
    // exposure never depended on any flag being flipped.
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(audienceCeiling(false));
    expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBeLessThan(audienceCeiling(true));
  });
});
