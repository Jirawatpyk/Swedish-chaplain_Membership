/**
 * Task 5 (054-event-fee-invoices) — Event registration lookup port (F4).
 *
 * The invoicing module needs to read an F6 event registration when drafting
 * an event-fee invoice (Task 6 `createEventInvoiceDraft`). This port is the
 * Application-layer seam: it exposes a primitive-typed view of the F6
 * registration so no F6 branded type (`RegistrationId`, `EventId`,
 * `AttendeeEmail`, `MemberId`, …) leaks into the invoicing module
 * (Constitution Principle III — Clean Architecture).
 *
 * The implementing adapter
 * (`infrastructure/adapters/event-registration-lookup-adapter.ts`) runs the
 * read on the caller-supplied `tx` so it executes under the same
 * `SET LOCAL app.current_tenant` (RLS) as the invoicing use-case's
 * `runInTenant` block — Principle I (two-layer tenant isolation). The
 * adapter never reaches for the global `db` singleton.
 *
 * No framework / ORM imports here — the only dependency is the shared
 * `Result` helper (Constitution Principle VIII).
 */
import type { Result } from '@/lib/result';

/**
 * Invoicing-owned, primitive-typed view of an F6 event registration. Ids and
 * brands are flattened to plain `string` so the F6 Domain branded types stay
 * inside the events module.
 */
export interface EventRegistrationView {
  readonly registrationId: string;
  readonly eventId: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
  readonly attendeeCompany: string | null;
  /** Ticket face value in whole THB (F6 stores an integer, not satang). */
  readonly ticketPriceThb: number | null;
  readonly paymentStatus: string;
  readonly matchType: string;
  readonly matchedMemberId: string | null;
  /**
   * `true` when the attendee PII (name / email / company) has been
   * retention-purged to deterministic hashes (F6 FR-032). The use-case may
   * choose to refuse drafting a fee invoice against a pseudonymised row.
   */
  readonly pseudonymised: boolean;
}

/**
 * The adapter wraps the F6 repository's `err(...)` branch (DB / mapping
 * failure) into this single tagged error so the invoicing use-case never
 * sees F6's internal `RegistrationsRepositoryError` shape.
 */
export type EventRegistrationLookupError = { readonly kind: 'lookup_failed' };

export interface EventRegistrationLookupPort {
  /**
   * Read one event registration by id within the caller's tenant.
   *
   * Returns `ok(null)` when the registration does not exist IN THE CALLER'S
   * TENANT — RLS filters cross-tenant rows, so a `null` here may indicate a
   * genuine miss OR a cross-tenant probe. The use-case (Task 6) decides how
   * to audit the null outcome; this port only reports the data property.
   *
   * `tx` is typed `unknown` to keep the port free of any ORM type — the
   * adapter casts it back to the concrete `TenantTx` at the Infrastructure
   * boundary (same convention as `MemberIdentityPort`).
   */
  findById(
    tx: unknown,
    tenantId: string,
    registrationId: string,
  ): Promise<Result<EventRegistrationView | null, EventRegistrationLookupError>>;
}
