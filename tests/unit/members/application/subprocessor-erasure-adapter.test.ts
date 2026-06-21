/**
 * COMP-1 US3-C — `subprocessorErasureAdapter` best-effort sub-processor
 * propagation (GDPR Art. 17 / PDPA §33 sub-processor erasure).
 *
 * The adapter is the post-commit cascade step (T5 calls it) that removes the
 * erased member's email from every Resend AUDIENCE the member received
 * broadcasts in. The `(audienceId, email)` pairs were captured in the atomic
 * scrub tx BEFORE redaction (Task 3 `BroadcastsAudienceDerivationPort`).
 *
 * Two arms:
 *   - Stripe: a PURE no-op TODAY (no member↔Stripe-customer model). Always
 *     reports `stripeOutcome: 'ok'`.
 *   - Resend: best-effort remove each captured pair. The underlying gateway
 *     resolves on a 404 (already absent) and throws a retryable
 *     `GatewayThrowable` on 5xx; the adapter's per-pair try/catch keeps the
 *     loop alive so a single failure never aborts the cascade.
 *
 * These tests pin the outcome contract:
 *   1. no pairs            → ok / 0 / 0 + gateway NOT called
 *   2. all resolve         → ok, removed = N
 *   3. mixed (1 of 2 fail) → partial, removed:1 failed:1
 *   4. all reject          → failed, removed:0
 *   5. NEVER throws (the loop catches every gateway throw)
 *   6. forbidden-fields hygiene — the failure-path log carries `audienceId`
 *      but NEVER the email.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loggerWarn } = vi.hoisted(() => ({ loggerWarn: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: loggerWarn, info: vi.fn(), debug: vi.fn() },
}));

const { removeContactFromAudience } = vi.hoisted(() => ({
  removeContactFromAudience: vi.fn(),
}));
// Partial mock — the adapter only reads `resendBroadcastsGateway` from the F7
// barrel; exposing just that export avoids pulling the whole broadcasts graph.
vi.mock('@/modules/broadcasts', () => ({
  resendBroadcastsGateway: { removeContactFromAudience },
}));

import {
  subprocessorErasureAdapter,
  noopSubprocessorErasureAdapter,
} from '@/modules/members/infrastructure/adapters/subprocessor-erasure-adapter';
import type { SubprocessorErasureInput } from '@/modules/members/application/ports/subprocessor-erasure-port';

function inputWith(
  audienceContacts: ReadonlyArray<{ audienceId: string; email: string }>,
): SubprocessorErasureInput {
  return {
    memberId: '22222222-2222-4222-8222-222222222222',
    reason: 'gdpr_erasure_request',
    audienceContacts,
    tenantSlug: 'test-tenant',
    requestId: 'req-99',
  };
}

describe('subprocessorErasureAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no pairs → ok/0/0 + Stripe ok + gateway NOT called', async () => {
    const result = await subprocessorErasureAdapter.propagate(inputWith([]));

    expect(result).toEqual({
      resendOutcome: 'ok',
      resendContactsRemoved: 0,
      resendContactsFailed: 0,
      stripeOutcome: 'ok',
    });
    expect(removeContactFromAudience).not.toHaveBeenCalled();
  });

  it('all pairs resolve → ok, removed = N (404 counts as removed — gateway resolves)', async () => {
    removeContactFromAudience.mockResolvedValue(undefined);

    const result = await subprocessorErasureAdapter.propagate(
      inputWith([
        { audienceId: 'aud-1', email: 'a@example.com' },
        { audienceId: 'aud-2', email: 'b@example.com' },
      ]),
    );

    expect(result.resendOutcome).toBe('ok');
    expect(result.resendContactsRemoved).toBe(2);
    expect(result.resendContactsFailed).toBe(0);
    expect(result.stripeOutcome).toBe('ok');
    expect(removeContactFromAudience).toHaveBeenCalledTimes(2);
    expect(removeContactFromAudience).toHaveBeenCalledWith('aud-1', 'a@example.com');
    expect(removeContactFromAudience).toHaveBeenCalledWith('aud-2', 'b@example.com');
  });

  it('1 of 2 rejects → partial, removed:1 failed:1', async () => {
    removeContactFromAudience
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('resend 503'));

    const result = await subprocessorErasureAdapter.propagate(
      inputWith([
        { audienceId: 'aud-1', email: 'a@example.com' },
        { audienceId: 'aud-2', email: 'b@example.com' },
      ]),
    );

    expect(result.resendOutcome).toBe('partial');
    expect(result.resendContactsRemoved).toBe(1);
    expect(result.resendContactsFailed).toBe(1);
    expect(result.stripeOutcome).toBe('ok');
  });

  it('all reject → failed, removed:0', async () => {
    removeContactFromAudience.mockRejectedValue(new Error('resend 503'));

    const result = await subprocessorErasureAdapter.propagate(
      inputWith([
        { audienceId: 'aud-1', email: 'a@example.com' },
        { audienceId: 'aud-2', email: 'b@example.com' },
      ]),
    );

    expect(result.resendOutcome).toBe('failed');
    expect(result.resendContactsRemoved).toBe(0);
    expect(result.resendContactsFailed).toBe(2);
    expect(result.stripeOutcome).toBe('ok');
  });

  it('NEVER throws even when the gateway throws (the loop catches)', async () => {
    removeContactFromAudience.mockRejectedValue(new Error('resend 503'));

    await expect(
      subprocessorErasureAdapter.propagate(
        inputWith([{ audienceId: 'aud-1', email: 'a@example.com' }]),
      ),
    ).resolves.toMatchObject({ resendOutcome: 'failed' });
  });

  it('forbidden-fields hygiene — failure log carries audienceId but NOT the email', async () => {
    removeContactFromAudience.mockRejectedValue(new Error('resend 503'));

    await subprocessorErasureAdapter.propagate(
      inputWith([{ audienceId: 'aud-1', email: 'secret@example.com' }]),
    );

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const logPayload = loggerWarn.mock.calls[0]![0] as Record<string, unknown>;
    expect(logPayload.audienceId).toBe('aud-1');
    // The email is a forbidden log field — must never appear in any value.
    const serialised = JSON.stringify(logPayload);
    expect(serialised).not.toContain('secret@example.com');
  });

  it('a non-Error throwable → errKind "unknown", counted failed, never dropped', async () => {
    // The production gateway only ever throws a GatewayThrowable (an Error
    // subclass), so this arm is unreachable in prod — but pin the defensive
    // `e instanceof Error ? e.constructor.name : 'unknown'` fallback so a future
    // gateway that rejects with a non-Error still counts + logs (never silent).
    removeContactFromAudience.mockRejectedValue('a raw string rejection');

    const result = await subprocessorErasureAdapter.propagate(
      inputWith([{ audienceId: 'aud-1', email: 'a@example.com' }]),
    );

    expect(result.resendOutcome).toBe('failed');
    expect(result.resendContactsFailed).toBe(1);
    const logPayload = loggerWarn.mock.calls[0]![0] as Record<string, unknown>;
    expect(logPayload.errKind).toBe('unknown');
  });
});

describe('noopSubprocessorErasureAdapter', () => {
  it('returns all-ok/0 without invoking the gateway', async () => {
    const result = await noopSubprocessorErasureAdapter.propagate(
      inputWith([{ audienceId: 'aud-1', email: 'a@example.com' }]),
    );

    expect(result).toEqual({
      resendOutcome: 'ok',
      resendContactsRemoved: 0,
      resendContactsFailed: 0,
      stripeOutcome: 'ok',
    });
    expect(removeContactFromAudience).not.toHaveBeenCalled();
  });
});
