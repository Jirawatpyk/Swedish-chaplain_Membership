/**
 * Task 6a (054-event-fee-invoices) — Event details lookup adapter (F4).
 *
 * Implements `EventDetailsLookupPort` by bridging into the F6 events module
 * through its PUBLIC BARREL (`@/modules/events`) only — never a deep import
 * into `@/modules/events/{domain,application,infrastructure}/**`
 * (Constitution Principle III). The barrel exposes a minimal tenant-scoped
 * lookup factory (`makeEventDetailsLookupForTenant`) plus the validated brand
 * constructors (`asTenantId`, `asEventId`).
 *
 * Tenant isolation (Principle I): the caller (Task 6 `createEventInvoiceDraft`)
 * opens the tx via `runInTenant`, which sets `SET LOCAL app.current_tenant`.
 * We thread THAT tx straight into the F6 repository factory, so the F6 SELECT
 * runs under the same RLS context — a cross-tenant row is invisible (the F6
 * repo returns `ok(null)`), never leaked. This adapter never reaches for the
 * global `db` singleton.
 *
 * Mapping (F6 branded aggregate → invoicing primitive view):
 *   - eventId            → String(...)  (drop the brand)
 *   - name               → name
 *   - startDate (Date)   → startDateIso via .toISOString() (CE/UTC; BE is
 *                          display-only so storage + this view stay Gregorian)
 *
 * Sibling pattern: `event-registration-lookup-adapter.ts` (Task 5).
 */
import {
  asTenantId,
  asEventId,
  makeEventDetailsLookupForTenant,
  type EventAggregate,
} from '@/modules/events';
import type { TenantTx } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type {
  EventDetailsLookupPort,
  EventDetailsView,
  EventDetailsLookupError,
} from '../../application/ports/event-details-lookup-port';

function toView(event: EventAggregate): EventDetailsView {
  return {
    eventId: String(event.eventId),
    name: event.name,
    startDateIso: event.startDate.toISOString(),
  };
}

export const eventDetailsLookupAdapter: EventDetailsLookupPort = {
  async findById(
    txUnknown,
    tenantId: string,
    eventId: string,
  ): Promise<Result<EventDetailsView | null, EventDetailsLookupError>> {
    const tx = txUnknown as TenantTx;
    const lookup = makeEventDetailsLookupForTenant(tx);

    const result = await lookup.findById(asTenantId(tenantId), asEventId(eventId));

    if (!result.ok) {
      // F6 repo error (DB failure or read-time invariant collapse). Surface a
      // single opaque tagged error to the invoicing use-case; log a structured
      // breadcrumb with NO PII (ids only).
      logger.error(
        {
          event: 'f4_event_details_lookup_failed',
          tenantId,
          eventId,
        },
        '[F4] event-details lookup failed — F6 repository returned err',
      );
      return err({ kind: 'lookup_failed' });
    }

    if (result.value === null) return ok(null);
    return ok(toView(result.value));
  },
};
