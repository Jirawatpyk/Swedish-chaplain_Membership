// @vitest-environment node
/**
 * Spec 140 s2a, carry R3 — `subprocessorErasure.propagate` has a time bound.
 *
 * It detaches each captured (audience, email) pair with
 * `removeContactFromAudience`, a DELETE that keeps its retry (plan.md P2). The
 * bound comes from the gateway: every call, retries included, gives up at
 * `callTimeoutMs`, so `propagate` returns within pairs × C (+ 1 s of slack)
 * even when Resend never answers. The REAL gateway runs here, built at 50 ms,
 * against a `fetch` that answers only when its signal aborts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  delete process.env['RESEND_BASE_URL'];
  delete process.env['RESEND_USER_AGENT'];
});

const { C } = vi.hoisted(() => ({ C: 50 }));
vi.mock('@/modules/broadcasts', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway')
  >('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway');
  return { resendBroadcastsGateway: actual.createResendBroadcastsGateway({ callTimeoutMs: C }) };
});

import { subprocessorErasureAdapter } from '@/modules/members/infrastructure/adapters/subprocessor-erasure-adapter';

// Installed for the whole file and never removed, so nothing here reaches the
// network: a hung request settles only when its signal aborts.
vi.stubGlobal(
  'fetch',
  vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  ),
);

beforeEach(() => {
  vi.useRealTimers();
});

describe('subprocessorErasureAdapter.propagate — bounded by the gateway (R3)', () => {
  it('propagate with a hung gateway returns within pairs × C + 1 s', async () => {
    const pairs = [
      { audienceId: 'aud_1', email: 'a@example.com' },
      { audienceId: 'aud_2', email: 'a@example.com' },
      { audienceId: 'aud_3', email: 'a@example.com' },
    ];
    const bound = pairs.length * C + 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sentinel = new Promise<'still running'>((resolve) => {
      timer = setTimeout(() => resolve('still running'), bound);
    });
    const result = await Promise.race([
      subprocessorErasureAdapter.propagate({
        memberId: '22222222-2222-4222-8222-222222222222',
        reason: 'gdpr_erasure_request',
        audienceContacts: pairs,
        tenantSlug: 'test-tenant',
        requestId: 'req-r3',
      }),
      sentinel,
    ]);
    clearTimeout(timer);

    // Every pair timed out: nothing detached, nothing confirmed absent.
    expect(result).toEqual({
      resendOutcome: 'failed',
      resendContactsRemoved: 0,
      resendContactsAlreadyAbsent: 0,
      resendContactsFailed: 3,
      stripeOutcome: 'ok',
    });
  });
});
