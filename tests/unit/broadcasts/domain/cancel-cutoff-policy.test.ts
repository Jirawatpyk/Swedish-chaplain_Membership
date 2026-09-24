/**
 * F119 T081 — the withdrawal cut-off is entry into `sending` (FR-015,
 * data-model § 8.2): cancellable from every in-progress stage, refused as
 * `sending_started` from `sending` onward, and as the pre-existing
 * `broadcast_cancel_too_late` for a closed E-Blast that never started
 * sending. The F7.1a `sending`-with-batches operator arm is kept as it was.
 */
import { describe, expect, it } from 'vitest';
import { authorizeCancel, canCancel } from '@/modules/broadcasts/domain/policies/cancel-cutoff-policy';
import {
  IN_PROGRESS_BROADCAST_STATUSES,
  SENDING_STARTED_BROADCAST_STATUSES,
  hasDispatchBegun,
  hasSendingStarted,
} from '@/modules/broadcasts/domain/stage/in-progress-statuses';
import { BROADCAST_STATUSES } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

describe('canCancel / authorizeCancel — widened to IN_PROGRESS_BROADCAST_STATUSES', () => {
  it.each(IN_PROGRESS_BROADCAST_STATUSES)('%s is cancellable', (status) => {
    expect(canCancel(status)).toBe(true);
    expect(authorizeCancel(status)).toEqual({ ok: true, value: true });
  });

  it.each(SENDING_STARTED_BROADCAST_STATUSES)('%s → sending_started', (status) => {
    expect(canCancel(status)).toBe(false);
    expect(authorizeCancel(status)).toEqual({ ok: false, error: { code: 'sending_started', status } });
  });

  it.each(['draft', 'rejected', 'cancelled', 'failed_to_dispatch', 'expired_no_member_response'] as const)(
    '%s → broadcast_cancel_too_late (never started sending, already closed or never submitted)',
    (status) => {
      expect(canCancel(status)).toBe(false);
      expect(authorizeCancel(status)).toEqual({ ok: false, error: { code: 'broadcast_cancel_too_late', status } });
    },
  );

  it('the F7.1a operator arm is unchanged: sending WITH batches is cancellable, without is not', () => {
    expect(canCancel('sending', true)).toBe(true);
    expect(authorizeCancel('sending', true).ok).toBe(true);
    expect(canCancel('sending', false)).toBe(false);
  });

  it('every status is in exactly one of: in progress, sending started, or neither — and the two sets never overlap', () => {
    const inProgress = new Set<string>(IN_PROGRESS_BROADCAST_STATUSES);
    for (const status of SENDING_STARTED_BROADCAST_STATUSES) expect(inProgress.has(status)).toBe(false);
    for (const status of BROADCAST_STATUSES) {
      expect(hasSendingStarted(status)).toBe((SENDING_STARTED_BROADCAST_STATUSES as readonly string[]).includes(status));
    }
  });

  it('T166 R-H1: dispatch has begun once a Resend broadcast id OR an audience import is on the row — an audience alone is not a send', () => {
    expect(hasDispatchBegun({ resendBroadcastId: null, audienceImportId: null })).toBe(false);
    expect(hasDispatchBegun({ resendBroadcastId: 'rb-1', audienceImportId: null })).toBe(true);
    expect(hasDispatchBegun({ resendBroadcastId: null, audienceImportId: 'imp-1' })).toBe(true);
  });
});
