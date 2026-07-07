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
  MAX_SWEEP_ITERATIONS,
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
    list: vi.fn(async () => ({ registrations: [], truncated: false })),
    eraseOne: vi.fn(async () => ok({ alreadyErased: false })),
  };
}

describe('eraseAttendeeRegistrationsByEmail (F6 P3 best-effort bulk fan-out)', () => {
  it('continues past a throwing registration (best-effort, not silent abort)', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => ({
      registrations: [
        { registrationId: 'r1', eventId: 'e1' },
        { registrationId: 'r2', eventId: 'e1' },
        { registrationId: 'r3', eventId: 'e2' },
      ],
      truncated: false,
    }));
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
    deps.list = vi.fn(async () => ({
      registrations: [
        { registrationId: 'r1', eventId: 'e1' },
        { registrationId: 'r2', eventId: 'e2' },
      ],
      truncated: false,
    }));
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
    deps.list = vi.fn(async () => ({
      registrations: [
        { registrationId: 'r1', eventId: 'e1' },
        { registrationId: 'r2', eventId: 'e1' },
        { registrationId: 'r3', eventId: 'e2' },
      ],
      truncated: false,
    }));
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
        truncated: false,
      });
    }
    expect(deps.eraseOne).not.toHaveBeenCalled();
  });

  it('threads reasonText + occurredAt from input to each eraseOne', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => ({
      registrations: [{ registrationId: 'r1', eventId: 'e1' }],
      truncated: false,
    }));
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
      deps.list = vi.fn(async () => ({
        registrations: [{ registrationId: 'r1', eventId: 'e1' }],
        truncated: false,
      }));
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

  // -------------------------------------------------------------------------
  // PR 4.1 follow-up #1 — server-side auto-loop until the sweep is COMPLETE.
  //
  // Erased rows are hard-deleted, so each re-`list` returns the NEXT batch;
  // the fan-out loops until the sweep genuinely drains. The completeness
  // signal `truncated` is NO LONGER a straight passthrough of the enumeration
  // cap — it now reports whether the loop drained: `false` only when every
  // batch erased with zero failures and the guard never tripped.
  // -------------------------------------------------------------------------

  it('single sub-cap batch (not truncated) — one enumeration, no re-list, truncated:false', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => ({
      registrations: [
        { registrationId: 'r1', eventId: 'e1' },
        { registrationId: 'r2', eventId: 'e2' },
      ],
      truncated: false,
    }));
    deps.eraseOne = vi.fn(async () => ok({ alreadyErased: false }));

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        erasedCount: 2,
        alreadyErasedCount: 0,
        failedCount: 0,
        truncated: false,
      });
    }
    // Not truncated ⇒ the sweep drained in ONE pass — exactly one enumeration,
    // no wasteful confirming re-list (unchanged behaviour for the realistic
    // sub-cap case).
    expect(deps.list).toHaveBeenCalledTimes(1);
  });

  it('auto-loops across batches until the sweep drains — aggregates the tally, final truncated:false', async () => {
    const deps = buildDeps();
    // The loop keys on the `truncated` flag, NOT the row count — so small
    // batches faithfully simulate "a capped batch with more rows beyond".
    const batch1 = [
      { registrationId: 'a1', eventId: 'e1' },
      { registrationId: 'a2', eventId: 'e1' },
      { registrationId: 'a3', eventId: 'e2' },
    ];
    const batch2 = [
      { registrationId: 'b1', eventId: 'e3' },
      { registrationId: 'b2', eventId: 'e3' },
    ];
    let call = 0;
    deps.list = vi.fn(async () => {
      call += 1;
      if (call === 1) return { registrations: batch1, truncated: true };
      if (call === 2) return { registrations: batch2, truncated: false };
      return { registrations: [], truncated: false }; // defensive; not reached
    });
    deps.eraseOne = vi.fn(async () => ok({ alreadyErased: false }));

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        erasedCount: 5,
        alreadyErasedCount: 0,
        failedCount: 0,
        truncated: false,
      });
    }
    // Every row across BOTH batches was erased.
    expect(deps.eraseOne).toHaveBeenCalledTimes(5);
    // batch1 truncated → re-list; batch2 NOT truncated → drained. Exactly two
    // enumerations (no third confirming list).
    expect(deps.list).toHaveBeenCalledTimes(2);
  });

  it('STOPS the loop the moment a batch throws — does NOT re-list (guards the infinite-loop-on-failing-row bug)', async () => {
    const deps = buildDeps();
    // The batch claims MORE rows remain (truncated:true) so a NAIVE
    // re-list-until-empty loop WOULD re-enumerate. But a row that failed to
    // erase STAYS in the live table, so re-listing would return it forever —
    // the loop MUST break on the failure instead. This is the whole point.
    deps.list = vi.fn(async () => ({
      registrations: [
        { registrationId: 'r1', eventId: 'e1' },
        { registrationId: 'r2', eventId: 'e1' },
        { registrationId: 'r3', eventId: 'e2' },
      ],
      truncated: true,
    }));
    deps.eraseOne = vi.fn(async (registrationId: string) => {
      if (registrationId === 'r2') throw new Error('boom');
      return ok({ alreadyErased: false });
    });

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        erasedCount: 2,
        alreadyErasedCount: 0,
        failedCount: 1,
        // A failed row remains in the table → the sweep is INCOMPLETE even
        // though the enumeration was not itself cap-truncated.
        truncated: true,
      });
    }
    // THE POINT: after a failing batch the loop MUST NOT re-enumerate. (A naive
    // loop would call `list` up to MAX_SWEEP_ITERATIONS times and spin on the
    // failing row.)
    expect(deps.list).toHaveBeenCalledTimes(1);
    // The rest of the failing batch still ran (best-effort WITHIN the batch).
    expect(deps.eraseOne).toHaveBeenCalledTimes(3);
  });

  it('an err-Result batch (not a throw) also STOPS the loop — failedCount surfaced, no re-list', async () => {
    const deps = buildDeps();
    deps.list = vi.fn(async () => ({
      registrations: [
        { registrationId: 'r1', eventId: 'e1' },
        { registrationId: 'r2', eventId: 'e1' },
      ],
      truncated: true,
    }));
    deps.eraseOne = vi.fn(async (registrationId: string) => {
      if (registrationId === 'r2') {
        return {
          ok: false as const,
          error: { kind: 'registrations_repo_error' as const },
        };
      }
      return ok({ alreadyErased: false });
    });

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toMatchObject({
        erasedCount: 1,
        failedCount: 1,
        truncated: true,
      });
    }
    expect(deps.list).toHaveBeenCalledTimes(1);
  });

  it('bails at the MAX_SWEEP_ITERATIONS guard when batches never drain — truncated:true, no infinite loop', async () => {
    const deps = buildDeps();
    // Pathological: `list` ALWAYS reports a truncated batch and `eraseOne`
    // always succeeds, so the sweep would never drain (a contract-violating
    // state where an "erased" row keeps re-enumerating). The bounded guard
    // MUST stop it after exactly MAX_SWEEP_ITERATIONS enumerations.
    deps.list = vi.fn(async () => ({
      registrations: [{ registrationId: 'x', eventId: 'e1' }],
      truncated: true,
    }));
    deps.eraseOne = vi.fn(async () => ok({ alreadyErased: false }));

    const res = await eraseAttendeeRegistrationsByEmail(INPUT, deps);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.truncated).toBe(true);
      expect(res.value.failedCount).toBe(0);
      expect(res.value.erasedCount).toBe(MAX_SWEEP_ITERATIONS);
    }
    // The guard capped the enumerations — no unbounded spin.
    expect(deps.list).toHaveBeenCalledTimes(MAX_SWEEP_ITERATIONS);
    expect(deps.eraseOne).toHaveBeenCalledTimes(MAX_SWEEP_ITERATIONS);
  });
});
