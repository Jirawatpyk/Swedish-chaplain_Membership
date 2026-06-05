/**
 * Task 5 (054-event-fee-invoices) — Event registration lookup adapter (F4).
 *
 * Implements `EventRegistrationLookupPort` by bridging into the F6 events
 * module through its PUBLIC BARREL (`@/modules/events`) only — never a deep
 * import into `@/modules/events/{domain,application,infrastructure}/**`
 * (Constitution Principle III). The barrel exposes a minimal tenant-scoped
 * lookup factory (`makeEventRegistrationLookupForTenant`) plus the validated
 * brand constructors (`asTenantId`, `asRegistrationId`).
 *
 * Tenant isolation (Principle I): the caller (Task 6
 * `createEventInvoiceDraft`) opens the tx via `runInTenant`, which sets
 * `SET LOCAL app.current_tenant`. We thread THAT tx straight into the F6
 * repository factory, so the F6 SELECT runs under the same RLS context — a
 * cross-tenant row is invisible (the F6 repo returns `ok(null)`), never
 * leaked. This adapter never reaches for the global `db` singleton.
 *
 * Mapping (F6 branded aggregate → invoicing primitive view):
 *   - registrationId / eventId          → String(...)  (drop the brand)
 *   - attendee.{name,email,company}     → attendeeName / attendeeEmail /
 *                                         attendeeCompany (email un-branded)
 *   - ticket.priceThb / paymentStatus   → ticketPriceThb / paymentStatus
 *   - match.type / match.matchedMemberId→ matchType / matchedMemberId
 *   - piiPseudonymisedAt !== null       → pseudonymised
 */
import {
  asTenantId,
  asRegistrationId,
  makeEventRegistrationLookupForTenant,
  type EventRegistrationAggregate,
} from '@/modules/events';
import type { TenantTx } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type {
  EventRegistrationLookupPort,
  EventRegistrationView,
  EventRegistrationLookupError,
} from '../../application/ports/event-registration-lookup-port';

function toView(reg: EventRegistrationAggregate): EventRegistrationView {
  return {
    registrationId: String(reg.registrationId),
    eventId: String(reg.eventId),
    attendeeName: reg.attendee.name,
    attendeeEmail: String(reg.attendee.email),
    attendeeCompany: reg.attendee.company,
    ticketPriceThb: reg.ticket.priceThb, // integer THB, NOT satang — caller must ×100 when converting to satang
    paymentStatus: String(reg.ticket.paymentStatus),
    matchType: String(reg.match.type),
    matchedMemberId:
      reg.match.matchedMemberId === null ? null : String(reg.match.matchedMemberId),
    pseudonymised: reg.piiPseudonymisedAt !== null,
  };
}

export const eventRegistrationLookupAdapter: EventRegistrationLookupPort = {
  async findById(
    txUnknown,
    tenantId: string,
    registrationId: string,
  ): Promise<Result<EventRegistrationView | null, EventRegistrationLookupError>> {
    const tx = txUnknown as TenantTx;
    const lookup = makeEventRegistrationLookupForTenant(tx);

    const result = await lookup.findById(
      asTenantId(tenantId),
      asRegistrationId(registrationId),
    );

    if (!result.ok) {
      // F6 repo error (DB failure or read-time invariant collapse). Surface a
      // single opaque tagged error to the invoicing use-case; log a structured
      // breadcrumb with NO PII (ids only — no attendee name/email).
      logger.error(
        {
          event: 'f4_event_registration_lookup_failed',
          tenantId,
          registrationId,
        },
        '[F4] event-registration lookup failed — F6 repository returned err',
      );
      return err({ kind: 'lookup_failed' });
    }

    if (result.value === null) return ok(null);
    return ok(toView(result.value));
  },
};
