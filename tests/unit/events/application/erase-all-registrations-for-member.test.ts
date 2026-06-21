/**
 * COMP-1 US2c (Member Erasure — F6 Registration Fan-out) — unit tests for
 * the `eraseAllRegistrationsForMember` best-effort fan-out use-case
 * (design §10, throw-path-critical).
 *
 * The fan-out enumerates a member's F6 event registrations (via the
 * `list` dep) and calls the per-registration `eraseOne` dep once per row.
 * The contract these tests lock:
 *
 *   - BEST-EFFORT: a THROW on one registration must NOT abort the loop —
 *     the remaining registrations are still attempted (mirrors the
 *     `eraseMember` post-commit cascade philosophy). The throwing row is
 *     tallied as `failedCount`, not silently swallowed.
 *   - ERR-RESULT (not throw): an `eraseOne` returning `{ ok: false }` is
 *     also tallied as `failedCount` (not erased, not a throw) and logged.
 *   - IDEMPOTENT: an `eraseOne` returning `{ alreadyErased: true }` is
 *     tallied as `alreadyErasedCount`, distinct from `erasedCount` and
 *     `failedCount`.
 *   - The use-case NEVER returns `err` — failures are tallied. A caller
 *     (the eraseMember cascade) treats `failedCount > 0` as not-clean so
 *     the US2d reconciler re-drives.
 *   - NO PII in failure logs — only `registrationId` / `memberId` (uuids)
 *     + the error message; never the attendee email/name/company.
 *
 * Pure Application — the two collaborators are abstracted as plain deps so
 * the use-case is unit-testable without a real `runInTenant` tx. The Task 3
 * composition factory wires `list` → `listMemberRegistrationsInTx` and
 * `eraseOne` → a per-registration `runInTenant(eraseAttendeePii(...))`.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import {
  eraseAllRegistrationsForMember,
  type EraseAllRegistrationsForMemberDeps,
} from '@/modules/events/application/use-cases/erase-all-registrations-for-member';

const INPUT = {
  tenantId: 't',
  memberId: 'm',
  actorUserId: 'a',
  requestId: 'req',
  occurredAt: new Date('2026-06-19T00:00:00.000Z'),
};

/**
 * A baseline deps stub. Individual tests override `list` / `eraseOne`.
 * Defaults: empty list, `eraseOne` succeeds (never called when list empty).
 */
function buildDeps(): EraseAllRegistrationsForMemberDeps {
  return {
    list: vi.fn(async () => []),
    eraseOne: vi.fn(async () => ok({ alreadyErased: false })),
  };
}

describe('eraseAllRegistrationsForMember (COMP-1 US2c best-effort fan-out)', () => {
  it('continues past a throwing registration (best-effort, not silent abort)', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => [
      { registrationId: 'r1', eventId: 'e1' },
      { registrationId: 'r2', eventId: 'e1' },
      { registrationId: 'r3', eventId: 'e2' },
    ]);
    deps.eraseOne = vi.fn(async (registrationId: string) => {
      if (registrationId === 'r2') throw new Error('boom');
      return ok({ alreadyErased: false });
    });

    const res = await eraseAllRegistrationsForMember(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        erasedCount: 2,
        alreadyErasedCount: 0,
        failedCount: 1,
      });
    }
    // r2 threw, but r3 STILL ran — proves no silent abort.
    expect(deps.eraseOne).toHaveBeenCalledTimes(3);
  });

  it('idempotent — alreadyErased registrations count separately, not as failures', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => [{ registrationId: 'r1', eventId: 'e1' }]);
    deps.eraseOne = vi.fn(async () => ok({ alreadyErased: true }));

    const res = await eraseAllRegistrationsForMember(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        erasedCount: 0,
        alreadyErasedCount: 1,
        failedCount: 0,
      });
    }
  });

  it('err-result (not throw) counts as failedCount and is logged', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => [
      { registrationId: 'r1', eventId: 'e1' },
      { registrationId: 'r2', eventId: 'e1' },
      { registrationId: 'r3', eventId: 'e2' },
    ]);
    deps.eraseOne = vi.fn(async (registrationId: string) => {
      if (registrationId === 'r2') {
        return { ok: false as const, error: { kind: 'registrations_repo_error' as const } };
      }
      return ok({ alreadyErased: false });
    });

    const res = await eraseAllRegistrationsForMember(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        erasedCount: 2,
        alreadyErasedCount: 0,
        failedCount: 1,
      });
    }
    expect(deps.eraseOne).toHaveBeenCalledTimes(3);
  });

  it('empty registration list returns a clean zero tally', async () => {
    const deps = buildDeps();
    // `list` defaults to [] in buildDeps.

    const res = await eraseAllRegistrationsForMember(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        erasedCount: 0,
        alreadyErasedCount: 0,
        failedCount: 0,
      });
    }
    expect(deps.eraseOne).not.toHaveBeenCalled();
  });

  it('never logs attendee PII on a failure — only registrationId + memberId + err', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const deps = buildDeps();
      deps.list = vi.fn(async () => [{ registrationId: 'r1', eventId: 'e1' }]);
      deps.eraseOne = vi.fn(async () => {
        throw new Error('boom-with-secret');
      });

      await eraseAllRegistrationsForMember(INPUT, deps);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logObj] = errorSpy.mock.calls[0] ?? [];
      expect(logObj).toMatchObject({ registrationId: 'r1', memberId: 'm' });
      // The forbidden keys: no attendee PII may be logged.
      const keys = Object.keys(logObj as Record<string, unknown>);
      expect(keys).not.toContain('attendeeEmail');
      expect(keys).not.toContain('attendee_email');
      expect(keys).not.toContain('attendeeName');
      expect(keys).not.toContain('attendeeCompany');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
