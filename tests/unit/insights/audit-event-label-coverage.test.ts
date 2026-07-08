/**
 * Audit event-label i18n coverage guard (QA 2026-07-09 — "audit log shows
 * English in TH/SV").
 *
 * The audit viewer + activity feed + filter dropdown resolve an event code via
 * `resolveEventLabel`: `admin.dashboard.activity.events` → `audit.eventType` →
 * humanised ENGLISH fallback. The fallback fires in EVERY locale, so any
 * `audit_event_type` enum value missing from BOTH catalogues renders English
 * to TH/SV admins. Nothing gated this before (check:i18n only verifies
 * cross-locale KEY parity, not enum→catalogue coverage) — 86 of 168 enum
 * values had drifted out of the catalogues by the time QA caught it.
 *
 * Invariants pinned here:
 *  1. Every enum value resolves through the catalogue union in EN, TH and SV.
 *  2. Every TH label in either catalogue contains Thai script — a key whose TH
 *     value is copy-pasted English passes parity but is exactly the reported
 *     bug, so it must fail here.
 *
 * When this fails after adding an enum value: add the label to
 * `audit.eventType` in en.json + th.json + sv.json (the broad catalogue;
 * `activity.events` is only for viewer-specific phrasing overrides).
 */
import { describe, expect, it } from 'vitest';
import { ALL_AUDIT_EVENT_TYPES } from '@/modules/auth';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';

type LabelMap = Readonly<Record<string, string>>;

const LOCALES = [
  ['en', enMessages],
  ['th', thMessages],
  ['sv', svMessages],
] as const;

function catalogues(messages: (typeof LOCALES)[number][1]): {
  activityEvents: LabelMap;
  eventType: LabelMap;
} {
  return {
    activityEvents: messages.admin.dashboard.activity.events as LabelMap,
    eventType: messages.audit.eventType as LabelMap,
  };
}

describe('audit event-label i18n coverage', () => {
  it.each(LOCALES.map(([locale]) => [locale] as const))(
    'every audit_event_type enum value has a %s label in activity.events ∪ audit.eventType',
    (locale) => {
      const messages = LOCALES.find(([l]) => l === locale)![1];
      const { activityEvents, eventType } = catalogues(messages);
      const missing = ALL_AUDIT_EVENT_TYPES.filter(
        (code) => !(code in activityEvents) && !(code in eventType),
      );
      expect(
        missing,
        `${missing.length} audit event type(s) fall back to humanised English in "${locale}" — add them to audit.eventType in all 3 locale files`,
      ).toEqual([]);
    },
  );

  it('every TH label in both catalogues contains Thai script (no English copy-paste)', () => {
    const { activityEvents, eventType } = catalogues(thMessages);
    const thai = /[฀-๿]/;
    const englishOnly = [
      ...Object.entries(activityEvents).map(([k, v]) => ['activity.events', k, v] as const),
      ...Object.entries(eventType).map(([k, v]) => ['audit.eventType', k, v] as const),
    ].filter(([, , value]) => !thai.test(value));
    expect(
      englishOnly.map(([ns, k, v]) => `${ns}.${k} = "${v}"`),
      'TH label values must be translated, not copied from EN',
    ).toEqual([]);
  });

  it('labels are non-empty in every locale', () => {
    for (const [locale, messages] of LOCALES) {
      const { activityEvents, eventType } = catalogues(messages);
      for (const [key, value] of [
        ...Object.entries(activityEvents),
        ...Object.entries(eventType),
      ]) {
        expect(value.trim(), `${locale}: empty label for ${key}`).not.toBe('');
      }
    }
  });
});
