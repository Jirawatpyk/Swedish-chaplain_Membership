/**
 * Task 6a (054-event-fee-invoices) — Event details lookup port (F4).
 *
 * The invoicing module needs to read an F6 event's name + start date when
 * drafting an event-fee invoice (Task 6 `createEventInvoiceDraft`) so the
 * line description can name the event. This port is the Application-layer
 * seam: it exposes a primitive-typed view of the F6 event so no F6 branded
 * type (`EventId`, `TenantId`, …) leaks into the invoicing module
 * (Constitution Principle III — Clean Architecture).
 *
 * The implementing adapter
 * (`infrastructure/adapters/event-details-lookup-adapter.ts`) runs the read
 * on the caller-supplied `tx` so it executes under the same
 * `SET LOCAL app.current_tenant` (RLS) as the invoicing use-case's
 * `runInTenant` block — Principle I (two-layer tenant isolation). The
 * adapter never reaches for the global `db` singleton.
 *
 * No framework / ORM imports here — the only dependency is the shared
 * `Result` helper (Constitution Principle VIII).
 *
 * Sibling pattern: `event-registration-lookup-port.ts` (Task 5).
 */
import type { Result } from '@/lib/result';

/**
 * Invoicing-owned, primitive-typed view of an F6 event. The id brand is
 * flattened to plain `string` so the F6 Domain branded types stay inside the
 * events module.
 */
export interface EventDetailsView {
  readonly eventId: string;
  readonly name: string;
  /**
   * Event start as ISO-8601 UTC (Gregorian/CE). Caller derives the display
   * date; storage stays CE (BE is display-only).
   */
  readonly startDateIso: string;
}

/**
 * The adapter wraps the F6 repository's `err(...)` branch (DB / mapping
 * failure) into this single tagged error so the invoicing use-case never
 * sees F6's internal `EventsRepositoryError` shape.
 */
export type EventDetailsLookupError = { readonly kind: 'lookup_failed' };

export interface EventDetailsLookupPort {
  /**
   * Read one event's details by id within the caller's tenant.
   *
   * Returns `ok(null)` when the event does not exist IN THE CALLER'S TENANT —
   * RLS filters cross-tenant rows, so a `null` here may indicate a genuine
   * miss OR a cross-tenant probe. The use-case (Task 6) decides how to audit
   * the null outcome; this port only reports the data property.
   *
   * `tx` is typed `unknown` to keep the port free of any ORM type — the
   * adapter casts it back to the concrete `TenantTx` at the Infrastructure
   * boundary (same convention as `EventRegistrationLookupPort`).
   */
  findById(
    tx: unknown,
    tenantId: string,
    eventId: string,
  ): Promise<Result<EventDetailsView | null, EventDetailsLookupError>>;
}
