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
  newestStatutoryWarningDispatch,
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

  it.each([
    'due+7.email',
    't+0.email',
    't+6.email', // just below the ≥7 threshold
    't-30.email',
    't+7.task.admin_notify',
    'junk',
  ])('rejects %s', (id) => {
    expect(isStatutoryWarningStepId(id)).toBe(false);
  });
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

  it('NOT satisfied by a VALID warning step id on the wrong channel (pins the channel guard)', () => {
    // T1-review nit #1: 'due+30.email' passes the step-id predicate, so this
    // case fails ONLY if the channel !== 'email' guard is present.
    expect(
      hasSatisfiedWarningRequirement([sent('due+30.email', '2026-07-01T00:00:00.000Z', 'task')], NOW),
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

// renewals-suspended-visibility-audit — feeds the dormancy-guard deferral
// audit (`renewal_lapse_deferred_warning_pending`): same qualifying predicate
// as hasSatisfiedWarningRequirement, minus the maturity cutoff.
describe('newestStatutoryWarningDispatch', () => {
  const sent = (
    stepId: string,
    dispatchedAt: string | null,
    channel = 'email',
    status = 'sent',
  ) => ({ stepId, status, channel, dispatchedAt });

  it('returns null when no qualifying warning exists (empty, non-warning steps, wrong channel/status, null dispatchedAt)', () => {
    expect(newestStatutoryWarningDispatch([])).toBeNull();
    expect(
      newestStatutoryWarningDispatch([
        sent('due+7.email', '2026-07-01T00:00:00.000Z'), // not a statutory warning
        sent('due+30.email', '2026-07-01T00:00:00.000Z', 'task'), // wrong channel
        sent('due+30.email', '2026-07-01T00:00:00.000Z', 'email', 'failed'), // not sent
        sent('due+30.email', null), // never dispatched
      ]),
    ).toBeNull();
  });

  it('picks the NEWEST qualifying dispatch and returns maturity = sent + MIN_WARNING_NOTICE_DAYS', () => {
    const result = newestStatutoryWarningDispatch([
      sent('due+30.email', '2026-07-01T06:00:00.000Z'),
      sent('t+7.email', '2026-07-20T06:00:00.000Z'), // newest qualifying
      sent('due+30.email', '2026-06-01T06:00:00.000Z'),
    ]);
    expect(result).toEqual({
      sentAtIso: '2026-07-20T06:00:00.000Z',
      // +14 days exactly (MIN_WARNING_NOTICE_DAYS) — the first instant the
      // dormancy guard can pass for this cycle.
      maturesAtIso: '2026-08-03T06:00:00.000Z',
    });
  });

  it('agrees with hasSatisfiedWarningRequirement at the maturity boundary', () => {
    const events = [sent('due+30.email', '2026-07-01T00:00:00.000Z')];
    const maturity = newestStatutoryWarningDispatch(events)!.maturesAtIso;
    // One ms before maturity the guard still defers; at maturity it passes.
    expect(
      hasSatisfiedWarningRequirement(events, new Date(Date.parse(maturity) - 1).toISOString()),
    ).toBe(false);
    expect(hasSatisfiedWarningRequirement(events, maturity)).toBe(true);
  });
});
