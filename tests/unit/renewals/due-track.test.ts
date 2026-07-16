/**
 * 066 Round-2 §3.2 — pure due-track model.
 * - findDueTrackStepsDue: a step is due from (dueDate + offset) onward with
 *   NO staleness cutoff (spec: exempt from the 7-day catch-up lookback —
 *   fireable until sent; idempotency rows prevent re-sends).
 * - hasSatisfiedWarningRequirement: sent statutory email (due+30.email or a
 *   post-expiry t+N ≥ +7 email step) dispatched ≥ MIN_WARNING_NOTICE_DAYS ago.
 */
import { describe, it, expect } from 'vitest';
import {
  DUE_TRACK_STEPS,
  MIN_WARNING_NOTICE_DAYS,
  findDueTrackStepsDue,
  isStatutoryWarningStepId,
  hasSatisfiedWarningRequirement,
} from '@/modules/renewals/domain/due-track';

const NOW = '2026-08-15T09:00:00.000Z';

describe('findDueTrackStepsDue', () => {
  it('returns nothing before due+7', () => {
    expect(findDueTrackStepsDue('2026-08-10', NOW)).toEqual([]);
  });

  it('returns due+7 from day 7, due+30 joins from day 30', () => {
    expect(findDueTrackStepsDue('2026-08-08', NOW).map((s) => s.stepId)).toEqual(['due+7.email']);
    expect(findDueTrackStepsDue('2026-07-01', NOW).map((s) => s.stepId)).toEqual([
      'due+7.email',
      'due+30.email',
    ]);
  });

  it('boundary: exactly due+7 (same UTC instant) is due', () => {
    // due 2026-08-08 + 7d = 2026-08-15T00:00Z; NOW is 09:00Z the same day.
    expect(findDueTrackStepsDue('2026-08-08', '2026-08-15T00:00:00.000Z')).toHaveLength(1);
  });

  it('has NO staleness cutoff — a bill due 300 days ago still yields both steps', () => {
    expect(findDueTrackStepsDue('2025-10-01', NOW)).toHaveLength(2);
  });

  it('malformed due date yields no steps (fail-safe: no send, guard defers)', () => {
    expect(findDueTrackStepsDue('not-a-date', NOW)).toEqual([]);
  });
});

describe('isStatutoryWarningStepId', () => {
  it.each(['due+30.email', 't+7.email', 't+14.email', 't+30.email'])('accepts %s', (id) => {
    expect(isStatutoryWarningStepId(id)).toBe(true);
  });

  it.each(['due+7.email', 't+0.email', 't-30.email', 't+7.task.admin_notify', 'junk'])(
    'rejects %s',
    (id) => {
      expect(isStatutoryWarningStepId(id)).toBe(false);
    },
  );
});

describe('hasSatisfiedWarningRequirement', () => {
  const sent = (stepId: string, dispatchedAt: string, channel = 'email', status = 'sent') => ({
    stepId,
    status,
    channel,
    dispatchedAt,
  });

  it('satisfied by due+30.email sent 14+ days ago', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('due+30.email', '2026-08-01T00:00:00.000Z')], NOW),
    ).toBe(true);
  });

  it('satisfied by a ladder t+7.email sent 14+ days ago', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('t+7.email', '2026-07-01T00:00:00.000Z')], NOW),
    ).toBe(true);
  });

  it('NOT satisfied when sent < MIN_WARNING_NOTICE_DAYS ago (min-notice)', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('due+30.email', '2026-08-10T00:00:00.000Z')], NOW),
    ).toBe(false);
  });

  it('boundary: sent exactly MIN_WARNING_NOTICE_DAYS ago satisfies', () => {
    expect(
      hasSatisfiedWarningRequirement([sent('due+30.email', '2026-08-01T09:00:00.000Z')], NOW),
    ).toBe(true);
  });

  it('NOT satisfied by failed/pending status, task channel, or non-warning steps', () => {
    expect(
      hasSatisfiedWarningRequirement(
        [
          sent('due+30.email', '2026-07-01T00:00:00.000Z', 'email', 'failed'),
          sent('due+30.email', '2026-07-01T00:00:00.000Z', 'email', 'pending'),
          sent('t+30.task.board_escalation', '2026-07-01T00:00:00.000Z', 'task'),
          sent('due+7.email', '2026-07-01T00:00:00.000Z'),
        ],
        NOW,
      ),
    ).toBe(false);
  });

  it('NOT satisfied by a sent event with null dispatchedAt', () => {
    expect(
      hasSatisfiedWarningRequirement(
        [{ stepId: 'due+30.email', status: 'sent', channel: 'email', dispatchedAt: null }],
        NOW,
      ),
    ).toBe(false);
  });

  it('empty event list is not satisfied', () => {
    expect(hasSatisfiedWarningRequirement([], NOW)).toBe(false);
  });

  it('sanity: DUE_TRACK_STEPS is the exact spec pair', () => {
    expect(DUE_TRACK_STEPS.map((s) => s.stepId)).toEqual(['due+7.email', 'due+30.email']);
    expect(MIN_WARNING_NOTICE_DAYS).toBe(14);
  });
});
