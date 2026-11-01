/**
 * Event options for the /admin/invoices/new event-fee tab.
 *
 * The page loads only the newest 200 events, and the form preselects a
 * deep-linked event (`?eventRegistrationId=…`) only when that event is among
 * the options. Without `withDeepLinkedEvent`, a registration on an older event
 * opened an empty Event tab with no message (#54).
 */
import { bangkokLocalDate } from '@/lib/fiscal-year';
import type { EventOption } from '../_components/event-fee-form';

/** Label: name + CE start date in Asia/Bangkok (BE is display-only, later). */
export function toEventOption(
  e: { readonly eventId: string; readonly name: string; readonly startDateIso: string },
  description?: string,
): EventOption {
  return {
    eventId: e.eventId,
    label: `${e.name} (${bangkokLocalDate(e.startDateIso)})`,
    ...(description ? { description } : {}),
  };
}

/**
 * The options with the deep-linked event added at the end when the loaded
 * list does not hold it. Unchanged (same reference) otherwise.
 */
export function withDeepLinkedEvent(
  events: readonly EventOption[],
  deepLinked: EventOption | null,
): readonly EventOption[] {
  if (deepLinked === null) return events;
  if (events.some((e) => e.eventId === deepLinked.eventId)) return events;
  return [...events, deepLinked];
}
