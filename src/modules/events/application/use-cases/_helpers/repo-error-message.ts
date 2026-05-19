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
import type { QuotaAccountingError } from '../../ports/quota-accounting-port';

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

/**
 * R7 TYPE-FR-04 closure — `QuotaAccountingError` discriminated-union
 * unwrapper for the 5 sites that emit `quota_lookup_failed`. The 3
 * sibling repo-error helpers above use the same `switch on .kind`
 * pattern; this completes the symmetry across the 4 F6 Result.err
 * types that flow through use-case error variants. Adding a new
 * `QuotaAccountingError` variant becomes a compile-time error here
 * (the `switch` is exhaustive — `never` check at the bottom).
 */
export function quotaAccountingErrorMessage(e: QuotaAccountingError): string {
  switch (e.kind) {
    case 'db_error':
      return `quota lookup: ${e.message}`;
    case 'member_not_found':
      return `quota lookup: member ${e.memberId} not found`;
    case 'plan_not_found':
      return `quota lookup: plan not found for member ${e.memberId}`;
  }
}
