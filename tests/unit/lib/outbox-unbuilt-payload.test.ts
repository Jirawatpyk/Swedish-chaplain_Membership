/**
 * #400 item 4 — how the outbox dispatcher closes a row it could not render.
 *
 * `buildEblastNotificationPayload` used to answer `null` both when a read
 * threw and when a row's context was malformed, so a row whose read kept
 * failing exhausted the retry ladder and was permanently failed as
 * `no_template_handler` — "there is no template for this" — although the
 * template exists and it was the read that failed. A failed read is now its
 * own transient reason, `read_failed`, carried to `last_error`, the audit row
 * and the failure metric; `null` (a missing arm, a malformed row) keeps
 * `no_template_handler`.
 */
import { describe, expect, it } from 'vitest';
import { isPayloadMiss, isPayloadTransient, unbuiltPayloadOutcome } from '@/lib/outbox-unbuilt-payload';

const MAX = 5;

describe('unbuiltPayloadOutcome — the reason an unrendered outbox row is closed or retried under', () => {
  it('an exhausted read failure ends permanently as read_failed, not no_template_handler', () => {
    expect(unbuiltPayloadOutcome({ transient: 'read_failed' }, MAX, MAX)).toEqual({
      permanent: true,
      reason: 'read_failed',
      metricReason: 'read_failed',
    });
  });

  it('a read failure below the ceiling stays on the retry ladder under its own reason', () => {
    expect(unbuiltPayloadOutcome({ transient: 'read_failed' }, 2, MAX)).toEqual({
      permanent: false,
      reason: 'read_failed',
      metricReason: 'read_failed',
    });
  });

  it('a missing arm (null) still retries, and ends as no_template_handler', () => {
    expect(unbuiltPayloadOutcome(null, 2, MAX)).toEqual({
      permanent: false,
      reason: 'no_template_handler',
      metricReason: 'no_template_handler',
    });
    expect(unbuiltPayloadOutcome(null, MAX, MAX)).toEqual({
      permanent: true,
      reason: 'no_template_handler',
      metricReason: 'no_template_handler',
    });
  });

  it.each(['request_gone', 'recipient_gone', 'request_not_decided'] as const)(
    'a deterministic miss (%s) is permanent on the FIRST tick, under its own reason',
    (miss) => {
      expect(unbuiltPayloadOutcome({ miss }, 1, MAX)).toEqual({ permanent: true, reason: miss, metricReason: miss });
    },
  );

  it('request_superseded is permanent but no failure: it has no failure-metric reason', () => {
    expect(unbuiltPayloadOutcome({ miss: 'request_superseded' }, 1, MAX)).toEqual({
      permanent: true,
      reason: 'request_superseded',
      metricReason: null,
    });
  });

  it('the guards the dispatcher narrows with tell the three shapes apart', () => {
    expect([isPayloadTransient({ transient: 'read_failed' }), isPayloadTransient({ miss: 'request_gone' }), isPayloadTransient(null)]).toEqual([true, false, false]);
    expect([isPayloadMiss({ miss: 'request_gone' }), isPayloadMiss({ transient: 'read_failed' }), isPayloadMiss(null)]).toEqual([true, false, false]);
  });
});
