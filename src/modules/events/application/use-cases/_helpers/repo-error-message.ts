/**
 * Phase 6 wave-5 REFACTOR H1 — shared helpers for collapsing the
 * `EventsRepositoryError` and `RegistrationsRepositoryError`
 * discriminated unions into a single string for use-case error
 * messages.
 *
 * Before: `toggle-event-category.ts` and `archive-event.ts` each
 * contained 8+ sites of the same nested-ternary cascade unwrapping
 * `db_error.message` / `invariant_violation.invariant` /
 * `pseudonymised_row_rejected` / fallback `.kind`. The duplication
 * was both verbose AND error-prone (a new variant in the underlying
 * Result.err type would require touching every cascade — exhaustiveness
 * check absent because nested ternaries don't trigger TypeScript's
 * `never` check).
 *
 * This helper uses a `switch` on `.kind` to keep `never`-exhaustiveness
 * working — adding a new variant to either repo's error union becomes
 * a compile-time error here, not a silent fallthrough.
 *
 * Pure functions, no framework imports (Constitution Principle III).
 */
import type { EventsRepositoryError } from '../../ports/events-repository';
import type { RegistrationsRepositoryError } from '../../ports/registrations-repository';

export function eventsRepoErrorMessage(e: EventsRepositoryError): string {
  switch (e.kind) {
    case 'db_error':
      return e.message;
    case 'invariant_violation':
      return `events invariant: ${e.invariant}`;
    case 'not_implemented':
      return `events.${e.method} not_implemented (${e.futureTask})`;
  }
}

export function registrationsRepoErrorMessage(
  e: RegistrationsRepositoryError,
): string {
  switch (e.kind) {
    case 'db_error':
      return e.message;
    case 'invariant_violation':
      return `event_registrations invariant: ${e.invariant}`;
    case 'pseudonymised_row_rejected':
      return `event_registrations pseudonymised row rejected: ${e.registrationId}`;
    case 'not_implemented':
      return `event_registrations.${e.method} not_implemented (${e.futureTask})`;
  }
}
