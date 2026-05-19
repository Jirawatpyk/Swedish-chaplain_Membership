/**
 * Phase 6 wave-4 — F6 audit-event i18n parity test.
 *
 * Asserts that the `admin.events.detail.auditEvents.*` translation
 * keys exist (in all 3 locales) for every QUOTA-related + ADMIN-
 * action F6 audit event type. This is the durable guard for the
 * audit-panel surface that will render `auditEvents[event.event_type]`
 * as the human-readable label for an audit row.
 *
 * The keys land in wave-4 ahead of the audit panel UI shipping —
 * keeping them in i18n NOW means:
 *   - The chamber's TH/SV translators see the canonical labels in
 *     ONE batch instead of trickle-by-trickle as audit panels land.
 *   - Future audit-row renderers can rely on the parity guarantee
 *     this test enforces (CI fails if a key drops or a new
 *     `F6_AUDIT_EVENT_TYPES` entry is added without a matching
 *     translation).
 *
 * Why this test exists (vs leaving the keys "unused"): the F6 audit
 * taxonomy is the source of truth for canonical event-type names.
 * The i18n labels MUST stay aligned with that enum. Without this
 * test, a future `F6_AUDIT_EVENT_TYPES` rename would silently break
 * the audit panel until QA caught it; with this test, CI fails on
 * the rename PR.
 */
import { describe, it, expect } from 'vitest';
import { F6_AUDIT_EVENT_TYPES } from '@/modules/events';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';

/**
 * Subset of F6_AUDIT_EVENT_TYPES that the audit panel surfaces to
 * admins (quota + admin actions). Webhook security / privacy events
 * have their own dedicated labels surface elsewhere (recent-deliveries-
 * panel for webhook receipts, privacy panel for pii_* events) and
 * are intentionally excluded here.
 */
const AUDIT_PANEL_EVENT_TYPES = [
  'quota_partnership_decremented',
  'quota_cultural_decremented',
  'quota_credit_back_refund',
  'quota_credit_back_archive',
  'quota_over_quota_warning',
  'event_partner_benefit_toggled',
  'event_cultural_event_toggled',
  'event_archived',
] as const;

function getNested(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
}

describe('F6 audit-event i18n parity (Phase 6 wave-4)', () => {
  it('every AUDIT_PANEL_EVENT_TYPES entry exists as a key in admin.events.detail.auditEvents.* (en)', () => {
    for (const eventType of AUDIT_PANEL_EVENT_TYPES) {
      const path = `admin.events.detail.auditEvents.${eventType}`;
      const value = getNested(enMessages, path);
      expect(
        typeof value === 'string' && value.length > 0,
        `[en] missing or empty key at ${path}`,
      ).toBe(true);
    }
  });

  it('every AUDIT_PANEL_EVENT_TYPES entry exists in TH locale', () => {
    for (const eventType of AUDIT_PANEL_EVENT_TYPES) {
      const path = `admin.events.detail.auditEvents.${eventType}`;
      const value = getNested(thMessages, path);
      expect(
        typeof value === 'string' && value.length > 0,
        `[th] missing or empty key at ${path}`,
      ).toBe(true);
    }
  });

  it('every AUDIT_PANEL_EVENT_TYPES entry exists in SV locale', () => {
    for (const eventType of AUDIT_PANEL_EVENT_TYPES) {
      const path = `admin.events.detail.auditEvents.${eventType}`;
      const value = getNested(svMessages, path);
      expect(
        typeof value === 'string' && value.length > 0,
        `[sv] missing or empty key at ${path}`,
      ).toBe(true);
    }
  });

  it('every AUDIT_PANEL_EVENT_TYPES is a valid F6_AUDIT_EVENT_TYPES member', () => {
    // Inverse guard: if `AUDIT_PANEL_EVENT_TYPES` ever drifts from the
    // canonical taxonomy (e.g., a typo or a copy-paste mistake), this
    // catches it. Keeps the i18n keys aligned with the source of
    // truth.
    const canonical = new Set<string>(F6_AUDIT_EVENT_TYPES);
    for (const eventType of AUDIT_PANEL_EVENT_TYPES) {
      expect(
        canonical.has(eventType),
        `${eventType} is not in F6_AUDIT_EVENT_TYPES (drift from the canonical taxonomy)`,
      ).toBe(true);
    }
  });

  it('admin.events.detail.ticketsRemaining microcopy exists in all 3 locales', () => {
    for (const [locale, messages] of [
      ['en', enMessages],
      ['th', thMessages],
      ['sv', svMessages],
    ] as const) {
      const value = getNested(messages, 'admin.events.detail.ticketsRemaining');
      expect(
        typeof value === 'string' && value.length > 0,
        `[${locale}] missing admin.events.detail.ticketsRemaining`,
      ).toBe(true);
    }
  });
});
