/**
 * #731 (task 53) — `buildUseCaseErrorTelemetry` feeds `processorErrorReason`
 * into the payments initiate / cancel route logs. The use cases pass closed
 * snake_case codes today, but the logger redacts by key name only, so a
 * free-text processor message reaching `reason` would be logged verbatim.
 * The helper therefore emits the reason only when it is a code.
 */
import { describe, expect, it } from 'vitest';
import { buildUseCaseErrorTelemetry } from '@/lib/payments-route-helpers';

describe('buildUseCaseErrorTelemetry — processorErrorReason', () => {
  it('passes a closed snake_case code through', () => {
    const t = buildUseCaseErrorTelemetry({
      code: 'processor_unavailable',
      kind: 'permanent',
      reason: 'cross_method_cancel_refused',
    });
    expect(t.processorErrorReason).toBe('cross_method_cancel_refused');
    expect(t.processorErrorKind).toBe('permanent');
  });

  it.each([
    'Your card was declined: 4242 4242 4242 4242',
    'No such payment_intent: pi_123',
    'Keys for idempotent requests can only be used with the same parameters',
    'x'.repeat(65),
  ])('drops a free-text or over-long reason (%#)', (reason) => {
    const t = buildUseCaseErrorTelemetry({
      code: 'processor_unavailable',
      kind: 'permanent',
      reason,
    });
    expect(t.processorErrorReason).toBeUndefined();
    expect(t.processorErrorKind).toBe('permanent');
  });
});
