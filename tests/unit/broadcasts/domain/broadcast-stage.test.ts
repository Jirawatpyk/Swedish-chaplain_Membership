/**
 * F119 T052 (FR-019, FR-026) — `stageOf(status)` and `turnOf(status)`.
 *
 * data-model § 8.1 is the table these pin, row for row. Two properties matter
 * beyond the table itself:
 *   - every status maps to exactly one stage, and no two live statuses share
 *     one (the two retired statuses share `historical`, which no filter offers);
 *   - `turnOf` has NO `'system'` value: a stage nobody is waiting on is "—"
 *     (null), so the dashboard never invites staff to act on a row the
 *     dispatcher owns.
 */
import { describe, expect, it } from 'vitest';
import {
  BROADCAST_STAGES,
  stageOf,
  type BroadcastStage,
} from '@/modules/broadcasts/domain/stage/broadcast-stage';
import { turnOf, type WhoseTurn } from '@/modules/broadcasts/domain/stage/whose-turn';
import {
  BROADCAST_STATUSES,
  RETIRED_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

/** data-model § 8.1 — verbatim. */
const TABLE_8_1: ReadonlyArray<readonly [BroadcastStatus, BroadcastStage, WhoseTurn]> = [
  ['draft', 'draft', null],
  ['submitted', 'awaiting_marketing_review', 'marketing'],
  ['in_design', 'in_design', 'marketing'],
  ['awaiting_member_approval', 'awaiting_member_approval', 'member'],
  ['changes_requested', 'changes_requested', 'marketing'],
  ['member_approved', 'member_approved', 'marketing'],
  ['approved', 'scheduled', null],
  ['sending', 'sending', null],
  ['sent', 'sent', null],
  ['rejected', 'rejected', null],
  ['cancelled', 'cancelled', null],
  ['expired_no_member_response', 'expired', null],
  ['failed_to_dispatch', 'failed', null],
  ['partially_sent', 'historical', null],
  ['partial_delivery_accepted', 'historical', null],
];

describe('stageOf (data-model § 8.1)', () => {
  it('the table covers every status in the Domain tuple exactly once', () => {
    expect(TABLE_8_1.map(([s]) => s).sort()).toEqual([...BROADCAST_STATUSES].sort());
  });

  it.each(TABLE_8_1)('stageOf(%s) === %s', (status, stage) => {
    expect(stageOf(status)).toBe(stage);
  });

  it('every status maps to exactly one stage', () => {
    for (const status of BROADCAST_STATUSES) {
      expect(BROADCAST_STAGES).toContain(stageOf(status));
    }
  });

  it('no two live statuses share a stage — only the retired pair shares `historical`', () => {
    const retired: ReadonlyArray<BroadcastStatus> = RETIRED_BROADCAST_STATUSES;
    const live = BROADCAST_STATUSES.filter((s) => !retired.includes(s));
    const stages = live.map(stageOf);
    expect(new Set(stages).size).toBe(live.length);
    expect(stages).not.toContain('historical');
    for (const s of retired) expect(stageOf(s)).toBe('historical');
  });

  it('every declared stage is reachable from some status', () => {
    const reached = new Set(BROADCAST_STATUSES.map(stageOf));
    expect([...BROADCAST_STAGES].sort()).toEqual([...reached].sort());
  });
});

describe('turnOf (FR-026)', () => {
  it.each(TABLE_8_1)('turnOf(%s) — stage %s — is %s', (status, _stage, turn) => {
    expect(turnOf(status)).toBe(turn);
  });

  it('turnOf is null for draft, approved, sending and all five closed statuses', () => {
    const nobody: ReadonlyArray<BroadcastStatus> = [
      'draft',
      'approved',
      'sending',
      'sent',
      'rejected',
      'cancelled',
      'expired_no_member_response',
      'failed_to_dispatch',
    ];
    for (const s of nobody) expect(turnOf(s)).toBeNull();
  });

  it('only awaiting_member_approval is the member’s turn', () => {
    expect(BROADCAST_STATUSES.filter((s) => turnOf(s) === 'member')).toEqual([
      'awaiting_member_approval',
    ]);
  });

  it('never returns a `system` turn, and never undefined', () => {
    for (const s of BROADCAST_STATUSES) {
      expect(['marketing', 'member', null]).toContain(turnOf(s));
    }
  });
});
