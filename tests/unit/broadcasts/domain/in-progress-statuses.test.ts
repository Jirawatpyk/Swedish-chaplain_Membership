/**
 * F119 T053 (FR-020, research R7) — `IN_PROGRESS_BROADCAST_STATUSES`, the ONE
 * Domain constant the allowance bucket and the cancel cascade derive from.
 *
 * The task names the property "disjoint from TERMINAL and together they cover
 * every non-historical status". Taken literally that is false: `draft` (not
 * reserved yet) and `sending` (past the withdrawal cut-off, FR-015) are in
 * neither set. The assertion below states the true partition and names both.
 */
import { describe, expect, it } from 'vitest';
import { IN_PROGRESS_BROADCAST_STATUSES } from '@/modules/broadcasts/domain/stage/in-progress-statuses';
import {
  BROADCAST_STATUSES,
  RETIRED_BROADCAST_STATUSES,
  TERMINAL_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

describe('IN_PROGRESS_BROADCAST_STATUSES (data-model § 9)', () => {
  it('is exactly the six reserving statuses', () => {
    expect(IN_PROGRESS_BROADCAST_STATUSES).toEqual([
      'submitted',
      'approved',
      'in_design',
      'awaiting_member_approval',
      'changes_requested',
      'member_approved',
    ]);
  });

  it('the constant and `TERMINAL_BROADCAST_STATUSES` are disjoint and together cover every non-historical status (with draft and sending, which are neither)', () => {
    const terminal: ReadonlyArray<BroadcastStatus> = TERMINAL_BROADCAST_STATUSES;
    const inProgress: ReadonlyArray<BroadcastStatus> = IN_PROGRESS_BROADCAST_STATUSES;
    expect(inProgress.filter((s) => terminal.includes(s))).toEqual([]);

    const retired: ReadonlyArray<BroadcastStatus> = RETIRED_BROADCAST_STATUSES;
    const neither = BROADCAST_STATUSES.filter(
      (s) => !retired.includes(s) && !terminal.includes(s) && !inProgress.includes(s),
    );
    expect(neither).toEqual(['draft', 'sending']);
  });

  it('holds no retired status and no duplicate', () => {
    const retired: ReadonlyArray<BroadcastStatus> = RETIRED_BROADCAST_STATUSES;
    expect(IN_PROGRESS_BROADCAST_STATUSES.filter((s) => retired.includes(s))).toEqual([]);
    expect(new Set(IN_PROGRESS_BROADCAST_STATUSES).size).toBe(
      IN_PROGRESS_BROADCAST_STATUSES.length,
    );
  });

  it('frees the allowance on expiry — `expired_no_member_response` is terminal, not in progress', () => {
    expect(IN_PROGRESS_BROADCAST_STATUSES).not.toContain('expired_no_member_response');
    expect(TERMINAL_BROADCAST_STATUSES).toContain('expired_no_member_response');
  });
});
