/**
 * COMP-1 US2c — `eventRegistrationErasureAdapter` outcome translation.
 *
 * The adapter is the F3↔F6 boundary for the GDPR Art. 17 / PDPA §33 event
 * registration fan-out cascade. It calls the events barrel's never-erring
 * best-effort fan-out `eraseAllRegistrationsForMember`, which returns
 * `Result<{ erasedCount, alreadyErasedCount, failedCount }, never>` — a
 * `failedCount > 0` is success-WITH-failures, NOT an `err`.
 *
 * These tests pin the discriminated-union contract:
 *   (a) ok({ erasedCount: 3, failedCount: 0 }) → { outcome: 'ok', erasedCount: 3 } + input mapped
 *   (b) ok({ erasedCount: 2, failedCount: 1 }) → { outcome: 'partial', erasedCount: 2, failedCount: 1 } + logged
 *   (c) the call THROWS                        → { outcome: 'failed' } + logged, no throw escapes (best-effort)
 *   (d) noop                                   → { outcome: 'ok' } without invoking F6
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { eraseAllRegistrationsForMember, makeEraseAllRegistrationsForMemberDeps } =
  vi.hoisted(() => ({
    eraseAllRegistrationsForMember: vi.fn(),
    makeEraseAllRegistrationsForMemberDeps: vi.fn(() => ({})),
  }));
// Partial mock — spread the real events barrel (so transitive imports through
// `@/modules/members` → renewals-deps, which pull other real events exports
// like `drizzleEventAttendeesAdapter`, still resolve) and override ONLY the two
// fan-out functions under test.
vi.mock('@/modules/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/events')>();
  return {
    ...actual,
    eraseAllRegistrationsForMember,
    makeEraseAllRegistrationsForMemberDeps,
  };
});

import {
  eventRegistrationErasureAdapter,
  noopEventRegistrationErasureAdapter,
} from '@/modules/members/infrastructure/adapters/event-registration-erasure-adapter';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('33333333-3333-4333-8333-333333333333');

describe('eventRegistrationErasureAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates fan-out ok with failedCount=0 → outcome="ok" + input mapped', async () => {
    eraseAllRegistrationsForMember.mockResolvedValueOnce(
      ok({ erasedCount: 3, alreadyErasedCount: 0, failedCount: 0 }),
    );

    const result = await eventRegistrationErasureAdapter.eraseAllForMember(
      tenant,
      memberId,
      { actorUserId: 'admin-9', requestId: 'req-9' },
    );

    expect(result.outcome).toBe('ok');
    if (result.outcome !== 'ok') return;
    expect(result.erasedCount).toBe(3);

    // Deps built from the tenant context.
    expect(makeEraseAllRegistrationsForMemberDeps).toHaveBeenCalledWith(tenant);

    // Input mapped: tenant.slug → tenantId, memberId, actorUserId, requestId.
    const passedInput = eraseAllRegistrationsForMember.mock.calls[0]![0];
    expect(passedInput.tenantId).toBe(tenant.slug);
    expect(passedInput.memberId).toBe(memberId);
    expect(passedInput.actorUserId).toBe('admin-9');
    expect(passedInput.requestId).toBe('req-9');
    expect(passedInput.occurredAt).toBeInstanceOf(Date);

    expect(loggerError).not.toHaveBeenCalled();
  });

  it('translates fan-out ok with failedCount>0 → outcome="partial" with counts (+ logger.error)', async () => {
    eraseAllRegistrationsForMember.mockResolvedValueOnce(
      ok({ erasedCount: 2, alreadyErasedCount: 0, failedCount: 1 }),
    );

    const result = await eventRegistrationErasureAdapter.eraseAllForMember(
      tenant,
      memberId,
      { actorUserId: 'admin-9', requestId: 'req-9' },
    );

    expect(result.outcome).toBe('partial');
    if (result.outcome !== 'partial') return;
    expect(result.erasedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it('catches a fan-out throw → outcome="failed" (best-effort, + logger.error, no throw)', async () => {
    eraseAllRegistrationsForMember.mockRejectedValueOnce(
      new Error('neon connection refused'),
    );

    const result = await eventRegistrationErasureAdapter.eraseAllForMember(
      tenant,
      memberId,
      { actorUserId: null as unknown as string, requestId: null },
    );

    expect(result.outcome).toBe('failed');
    // failed branch carries no counts.
    expect((result as { erasedCount?: number }).erasedCount).toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});

describe('noopEventRegistrationErasureAdapter', () => {
  it('returns outcome="ok" without invoking F6', async () => {
    const result = await noopEventRegistrationErasureAdapter.eraseAllForMember(
      tenant,
      memberId,
      { actorUserId: null as unknown as string, requestId: null },
    );
    expect(result.outcome).toBe('ok');
    expect(eraseAllRegistrationsForMember).not.toHaveBeenCalled();
  });
});
