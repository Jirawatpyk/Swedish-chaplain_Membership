/**
 * COMP-1 US2b — `f7BroadcastsContentScrubAdapter` outcome translation.
 *
 * The adapter is the F3↔F7 boundary for the GDPR Art. 17 / PDPA §33
 * broadcast CONTENT redaction cascade (the delivery tombstone moved into the
 * caller's atomic scrub tx). It mirrors `f7BroadcastsCascadeAdapter`
 * (the in-flight cancel cascade) but is BEST-EFFORT defensive: the underlying
 * `scrubBroadcastContentForMember` use-case never-throws (returns a typed
 * `Result`), yet the adapter still wraps the call in try/catch so a throw at
 * the calling convention is translated to `{ outcome: 'failed' }` + a logged
 * error — the erasure proof records the cascade as incomplete, never a
 * silent swallow-to-no-op.
 *
 * These tests pin the three-case contract:
 *   (a) use-case ok  → { outcome: 'ok', scrubbedCount, tombstonedCount } + input mapped
 *   (b) use-case err → { outcome: 'failed' } + logger.error, no throw
 *   (c) use-case throws → caught → { outcome: 'failed' } + logger.error, no throw
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { scrubBroadcastContentForMember, makeScrubBroadcastContentForMemberDeps } =
  vi.hoisted(() => ({
    scrubBroadcastContentForMember: vi.fn(),
    makeScrubBroadcastContentForMemberDeps: vi.fn(() => ({})),
  }));
vi.mock('@/modules/broadcasts', () => ({
  scrubBroadcastContentForMember,
  makeScrubBroadcastContentForMemberDeps,
}));

import {
  f7BroadcastsContentScrubAdapter,
  noopBroadcastsContentScrubAdapter,
} from '@/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('22222222-2222-4222-8222-222222222222');
// The delivery-tombstone count (produced in the caller's atomic scrub tx)
// threaded through the adapter to the F7 use-case so the single audit records
// both axes. The delivery tombstone itself no longer runs in this cascade.
const TOMBSTONED_COUNT = 3;

describe('f7BroadcastsContentScrubAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates use-case ok → outcome="ok" with counts forwarded + input mapped', async () => {
    scrubBroadcastContentForMember.mockResolvedValueOnce(
      ok({ scrubbedCount: 2, tombstonedCount: 3 }),
    );

    const result = await f7BroadcastsContentScrubAdapter.scrubContentForMember(
      tenant,
      memberId,
      {
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
        reason: 'gdpr_erasure_request',
        tombstonedCount: TOMBSTONED_COUNT,
      },
    );

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.scrubbedCount).toBe(2);
    expect(result.tombstonedCount).toBe(3);

    // Deps built from the tenant slug.
    expect(makeScrubBroadcastContentForMemberDeps).toHaveBeenCalledWith(
      tenant.slug,
    );

    // Input mapped: tenant, memberId, reason, initiatedByUserId, requestId,
    // tombstonedCount threaded. `reason` MUST forward so the F7 audit records
    // the real legal basis (Art. 17 / PDPA §33); `tombstonedCount` MUST forward
    // so the single audit records the caller's atomic delivery-tombstone count.
    const passedInput = scrubBroadcastContentForMember.mock.calls[0]![1];
    expect(passedInput.tenant).toBe(tenant);
    expect(passedInput.memberId).toBe(memberId);
    expect(passedInput.reason).toBe('gdpr_erasure_request');
    expect(passedInput.initiatedByUserId).toBe('admin-7');
    expect(passedInput.requestId).toBe('req-7');
    expect(passedInput.tombstonedCount).toBe(TOMBSTONED_COUNT);

    expect(loggerError).not.toHaveBeenCalled();
  });

  it('translates use-case err → outcome="failed" (+ logger.error, no throw)', async () => {
    scrubBroadcastContentForMember.mockResolvedValueOnce(
      err({ kind: 'scrub.server_error', message: 'neon down' }),
    );

    const result = await f7BroadcastsContentScrubAdapter.scrubContentForMember(
      tenant,
      memberId,
      {
        initiatedByUserId: 'admin-7',
        requestId: 'req-7',
        reason: 'pdpa_deletion_request',
        tombstonedCount: TOMBSTONED_COUNT,
      },
    );

    expect(result.outcome).toBe('failed');
    // failed branch carries no counts.
    expect((result as { scrubbedCount?: number }).scrubbedCount).toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it('catches a use-case throw → outcome="failed" (best-effort, + logger.error, no throw)', async () => {
    scrubBroadcastContentForMember.mockRejectedValueOnce(
      new Error('neon connection refused'),
    );

    const result = await f7BroadcastsContentScrubAdapter.scrubContentForMember(
      tenant,
      memberId,
      {
        initiatedByUserId: null,
        requestId: null,
        reason: 'gdpr_erasure_request',
        tombstonedCount: TOMBSTONED_COUNT,
      },
    );

    expect(result.outcome).toBe('failed');
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});

describe('noopBroadcastsContentScrubAdapter', () => {
  it('returns outcome="ok" without invoking F7', async () => {
    const result =
      await noopBroadcastsContentScrubAdapter.scrubContentForMember(
        tenant,
        memberId,
        {
          initiatedByUserId: null,
          requestId: null,
          reason: 'gdpr_erasure_request',
          tombstonedCount: TOMBSTONED_COUNT,
        },
      );
    expect(result.outcome).toBe('ok');
    expect(scrubBroadcastContentForMember).not.toHaveBeenCalled();
  });
});
