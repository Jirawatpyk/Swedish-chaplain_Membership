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
import {
  CLOSED_NEVER_SENT_BROADCAST_STATUSES,
  holdsImageReferences,
  IN_PROGRESS_BROADCAST_STATUSES,
} from '@/modules/broadcasts/domain/stage/in-progress-statuses';
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

/**
 * T081 follow-up — the image sweep's last-reference rule. A rejected /
 * withdrawn E-Blast's images are stamped, but its body keeps the URL (the
 * immutability trigger forbids redacting it), so while its own content still
 * counted as a reference the sweep put every such image back in the live set
 * and the `broadcast_image_removed` audit row was false.
 */
describe('holdsImageReferences — which E-Blasts keep their embedded images alive', () => {
  const NO_HAND_OVER = { sendingStartedAt: null, resendBroadcastId: null, audienceImportId: null };

  it('is exactly the three closed-never-sent statuses that let go', () => {
    expect(CLOSED_NEVER_SENT_BROADCAST_STATUSES).toEqual(['rejected', 'cancelled', 'expired_no_member_response']);
  });

  // Decided for EVERY status: a new status is a reference until someone says
  // otherwise (fail-safe — a delivered email still loads its images).
  it.each(BROADCAST_STATUSES.map((status) => ({ status })))(
    '$status with nothing handed over',
    ({ status }) => {
      const closed: ReadonlyArray<BroadcastStatus> = CLOSED_NEVER_SENT_BROADCAST_STATUSES;
      expect(holdsImageReferences({ status, ...NO_HAND_OVER })).toBe(!closed.includes(status));
    },
  );

  it.each([
    { evidence: { sendingStartedAt: new Date('2026-09-20T08:00:00Z') } },
    { evidence: { resendBroadcastId: 'rb-1' } },
    { evidence: { audienceImportId: 'imp-1' } },
  ])('a closed row the dispatcher had already handed over ($evidence) still holds them', ({ evidence }) => {
    expect(holdsImageReferences({ status: 'cancelled', ...NO_HAND_OVER, ...evidence })).toBe(true);
  });
});

// PR #392 review C4 — the two approval-round sets had near-identical names and
// nothing tying them together. The 4-tuple is defined once (beside the chip
// set, which a client component imports) and the 5-value chip set derives
// from it; the stage module re-exports the same tuple.
describe('APPROVAL_ROUND_STATUSES and APPROVAL_ROUND_ONLY_STATUSES', () => {
  it('are one definition: the stage module re-exports the tuple, and the chip set is it plus expired_no_member_response', async () => {
    const statusModule = await import('@/modules/broadcasts/domain/value-objects/broadcast-status');
    const stageModule = await import('@/modules/broadcasts/domain/stage/in-progress-statuses');
    expect(stageModule.APPROVAL_ROUND_STATUSES).toBe(statusModule.APPROVAL_ROUND_STATUSES);
    expect(statusModule.APPROVAL_ROUND_ONLY_STATUSES).toEqual(
      new Set([...statusModule.APPROVAL_ROUND_STATUSES, 'expired_no_member_response']),
    );
  });
});
