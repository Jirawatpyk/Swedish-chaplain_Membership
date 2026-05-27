/**
 * Shared audit-event label helpers (F9 — activity feed FR-003 + audit viewer
 * FR-009/011). A single source of truth for turning a raw `audit_event_type`
 * code into a localised, human-readable label, with a deterministic humanised
 * fallback for codes not yet in the i18n catalogue.
 *
 * The translator is the next-intl `t` scoped to `admin.dashboard.activity.events`
 * — both the server `getTranslations(...)` and the client `useTranslations(...)`
 * return this shape (a callable with a `.has` guard), so the same helper serves
 * the server-rendered table and the client filter dropdown.
 */

/** next-intl translator scoped to a namespace (callable + `.has` guard). */
export type EventLabelTranslator = ((key: string) => string) & {
  has: (key: string) => boolean;
};

/** Deterministic fallback: `member_created` → `Member created`. */
export function humanizeEventType(eventType: string): string {
  const words = eventType.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Localised label for an event code, falling back to the humanised form. */
export function resolveEventLabel(t: EventLabelTranslator, eventType: string): string {
  return t.has(eventType) ? t(eventType) : humanizeEventType(eventType);
}
