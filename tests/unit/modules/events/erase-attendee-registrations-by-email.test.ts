/**
 * F6 remediation PR 2.1 / P3 (FR-032a by-email erasure BACKEND) — unit tests
 * for the `eraseAttendeeRegistrationsByEmail` best-effort bulk fan-out.
 *
 * A near-clone of `eraseAllRegistrationsForMember` (COMP-1 US2c) but enumerating
 * by attendee email instead of matched member. The fan-out enumerates every
 * registration sharing the email (via `list`) and calls the per-registration
 * `eraseOne` once per row — each in its OWN tx (own-tx-per-row is wired by the
 * composition factory; a shared tx would let one DB-poisoned row abort the whole
 * DSR). The contract these tests lock:
 *
 *   - BEST-EFFORT: a THROW on one registration must NOT abort the loop — the
 *     remaining rows are still attempted. The throwing row is tallied as
 *     `failedCount`, NOT silently swallowed. (Mock-only suites miss the throw
 *     path — an explicit throwing `eraseOne` stub is included.)
 *   - ERR-RESULT (not throw): `eraseOne` returning `{ ok: false }` is also
 *     tallied as `failedCount` and logged.
 *   - IDEMPOTENT: `eraseOne` returning `{ alreadyErased: true }` is tallied as
 *     `alreadyErasedCount`, distinct from erased + failed.
 *   - NEVER returns `err` (error channel is `never`) — failures are tallied.
 *   - reasonText is threaded straight from the input to each `eraseOne`.
 *   - NO PII in failure logs — only `registrationId` (uuid) + error class name;
 *     never the attendee email/name/company (the exact PII being erased).
 */
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import {
  eraseAttendeeRegistrationsByEmail,
  type EraseAttendeeRegistrationsByEmailDeps,
} from '@/modules/events/application/use-cases/erase-attendee-registrations-by-email';

const INPUT = {
  tenantId: 't',
  emailLower: 'secret-guest@example.com',
  actorUserId: 'a',
  reasonText: 'gdpr_art_17_dsr',
  occurredAt: new Date('2026-07-07T00:00:00.000Z'),
};

function buildDeps(): EraseAttendeeRegistrationsByEmailDeps {
  return {
    list: vi.fn(async () => []),
    eraseOne: vi.fn(async () => ok({ alreadyErased: false })),
  };
}

describe('eraseAttendeeRegistrationsByEmail (F6 P3 best-effort bulk fan-out)', () => {
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

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

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
    deps.list = vi.fn(async () => [
      { registrationId: 'r1', eventId: 'e1' },
      { registrationId: 'r2', eventId: 'e2' },
    ]);
    deps.eraseOne = vi.fn(async () => ok({ alreadyErased: true }));

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        erasedCount: 0,
        alreadyErasedCount: 2,
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

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

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

  it('empty registration list returns a clean zero tally without calling eraseOne', async () => {
    const deps = buildDeps();

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

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

  it('threads reasonText + occurredAt from input to each eraseOne', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => [{ registrationId: 'r1', eventId: 'e1' }]);
    const eraseOne = vi.fn(
      async (
        _registrationId: string,
        _eventId: string,
        _input: {
          tenantId: string;
          actorUserId: string;
          reasonText: string;
          occurredAt: Date;
        },
      ) => ok({ alreadyErased: false }),
    );
    deps.eraseOne = eraseOne;

    await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(eraseOne).toHaveBeenCalledTimes(1);
    const call = eraseOne.mock.calls[0];
    expect(call).toBeDefined();
    const [regId, eventId, callInput] = call!;
    expect(regId).toBe('r1');
    expect(eventId).toBe('e1');
    expect(callInput).toMatchObject({
      tenantId: 't',
      actorUserId: 'a',
      reasonText: 'gdpr_art_17_dsr',
      occurredAt: INPUT.occurredAt,
    });
  });

  it('never logs attendee email/PII on a failure — only registrationId + error class', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const deps = buildDeps();
      deps.list = vi.fn(async () => [{ registrationId: 'r1', eventId: 'e1' }]);
      deps.eraseOne = vi.fn(async () => {
        throw new Error('boom-with-secret');
      });

      await eraseAttendeeRegistrationsByEmail(INPUT, deps);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logObj] = errorSpy.mock.calls[0] ?? [];
      expect(logObj).toMatchObject({ registrationId: 'r1' });
      const keys = Object.keys(logObj as Record<string, unknown>);
      // The forbidden keys: no attendee PII, and no email may be logged.
      expect(keys).not.toContain('attendeeEmail');
      expect(keys).not.toContain('attendee_email');
      expect(keys).not.toContain('emailLower');
      expect(keys).not.toContain('email');
      expect(keys).not.toContain('attendeeName');
      expect(keys).not.toContain('attendeeCompany');
      // And the email VALUE must not leak into the log-line or object.
      const serialised = JSON.stringify(errorSpy.mock.calls[0]);
      expect(serialised).not.toContain('secret-guest@example.com');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
