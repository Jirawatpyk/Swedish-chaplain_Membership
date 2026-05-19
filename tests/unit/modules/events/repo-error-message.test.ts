/**
 * Phase 6 wave-6 — `repo-error-message.ts` helpers unit tests.
 *
 * Closes the TEST-GAP-5 cross-check finding: wave-5 batch-2 extracted
 * `eventsRepoErrorMessage` + `registrationsRepoErrorMessage` (REFACTOR
 * H1) using exhaustive `switch (e.kind)`. The compile-time
 * `never`-exhaustiveness check is good, but a future variant addition
 * could be silenced with `as any` casts. Direct unit tests anchor the
 * behaviour to runtime assertions so any drift is caught at
 * `pnpm test` time.
 */
import { describe, it, expect } from 'vitest';
import {
  eventsRepoErrorMessage,
  registrationsRepoErrorMessage,
} from '@/modules/events/application/use-cases/_helpers/repo-error-message';
import type { RegistrationId } from '@/modules/events';

describe('eventsRepoErrorMessage — exhaustive over EventsRepositoryError', () => {
  it('db_error returns the message', () => {
    expect(
      eventsRepoErrorMessage({ kind: 'db_error', message: 'conn lost' }),
    ).toBe('conn lost');
  });

  it('invariant_violation wraps with prefix', () => {
    expect(
      eventsRepoErrorMessage({
        kind: 'invariant_violation',
        invariant: 'events.upsert returned no row',
      }),
    ).toBe('events invariant: events.upsert returned no row');
  });

  it('not_implemented formats method + futureTask', () => {
    expect(
      eventsRepoErrorMessage({
        kind: 'not_implemented',
        method: 'setArchived',
        futureTask: 'Phase 10 T107',
      }),
    ).toBe('events.setArchived not_implemented (Phase 10 T107)');
  });
});

describe('registrationsRepoErrorMessage — exhaustive over RegistrationsRepositoryError', () => {
  it('db_error returns the message', () => {
    expect(
      registrationsRepoErrorMessage({ kind: 'db_error', message: 'lock contention' }),
    ).toBe('lock contention');
  });

  it('invariant_violation wraps with prefix', () => {
    expect(
      registrationsRepoErrorMessage({
        kind: 'invariant_violation',
        invariant: 'ON CONFLICT DO UPDATE returned no row',
      }),
    ).toBe('event_registrations invariant: ON CONFLICT DO UPDATE returned no row');
  });

  it('pseudonymised_row_rejected formats registrationId', () => {
    const regId =
      '00000000-0000-0000-0000-000000000abc' as RegistrationId;
    expect(
      registrationsRepoErrorMessage({
        kind: 'pseudonymised_row_rejected',
        registrationId: regId,
      }),
    ).toBe(`event_registrations pseudonymised row rejected: ${regId}`);
  });

  it('not_implemented formats method + futureTask', () => {
    expect(
      registrationsRepoErrorMessage({
        kind: 'not_implemented',
        method: 'updateMatchAndQuota',
        futureTask: 'Phase 9 T104',
      }),
    ).toBe('event_registrations.updateMatchAndQuota not_implemented (Phase 9 T104)');
  });
});
