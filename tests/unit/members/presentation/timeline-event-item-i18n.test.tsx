/**
 * F8 Round-5 review-finding L5 — TimelineEventItem i18n consumer test.
 *
 * Pins that the 10 round-3 + round-4 audit event types added to
 * `audit.eventType.*` (en/th/sv) actually render through the
 * `<TimelineEventItem>` consumer. Without this, a future refactor
 * that renames the i18n namespace (e.g. `audit.eventType.*` →
 * `renewals.audit.events.*`) would silently fall through the
 * component's `try/catch` to the raw enum key — `pnpm check:i18n`
 * still passes, but the UI displays "tier_upgrade_suggested" raw
 * instead of "Tier upgrade suggested".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

import { TimelineEventItem } from '@/components/members/timeline-event-item';

// Subset of round-3 + round-4 audit event types verified to have
// EN translations (see `src/i18n/messages/en.json` audit.eventType
// block). The ICU `pnpm check:i18n` gate guarantees TH + SV parity.
const ROUND_345_AUDIT_KEYS = [
  ['at_risk_score_recomputed', 'Risk score recomputed'],
  ['at_risk_score_threshold_crossed', 'Risk band changed'],
  ['at_risk_snoozed', 'At-risk snoozed'],
  ['at_risk_outreach_recorded', 'Outreach recorded'],
  ['at_risk_compute_partial_failure', 'At-risk score partial failure'],
  ['tier_upgrade_suggested', 'Tier upgrade suggested'],
  ['tier_upgrade_accepted', 'Tier upgrade accepted'],
  ['cron_bearer_auth_rejected', 'Cron auth rejected'],
  ['lapsed_member_action_blocked', 'Action blocked — lapsed member'],
  ['renewal_kill_switch_blocked', 'Action blocked — kill switch active'],
] as const;

// Minimal messages tree mirroring the production en.json shape that
// the consumer reads from. We only include the keys this test needs;
// `useTranslations('audit.eventType')` tolerates missing siblings.
const messages = {
  admin: {
    members: {
      timeline: {
        actorSystem: 'System',
        payload: {},
      },
    },
  },
  audit: {
    eventType: Object.fromEntries(ROUND_345_AUDIT_KEYS) as Record<
      string,
      string
    >,
  },
  // F9 US3 — the consumer now reads the unified `timeline.*` namespace for
  // the source badge + actor attribution line.
  timeline: {
    actorBy: 'by {actor}',
    source: {
      audit: 'Profile / Audit',
      invoice: 'Invoice',
      payment: 'Payment',
      event: 'Event',
      broadcast: 'E-Blast',
      renewal: 'Renewal',
    },
    actorKind: { staff: 'Staff', member: 'Member', system: 'System' },
  },
};

describe('TimelineEventItem — round-3+4+5 audit event-type i18n (L5)', () => {
  it.each(ROUND_345_AUDIT_KEYS)(
    'renders translated label "%s" → "%s" via audit.eventType.* namespace',
    (eventType, expectedLabel) => {
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <TimelineEventItem
            id={`audit-${eventType}`}
            timestamp="2026-04-10T10:00:00Z"
            source="audit"
            eventType={eventType}
            actorKind="staff"
            actorUserId="actor-1"
            actorDisplayName="Test User"
            payload={null}
          />
        </NextIntlClientProvider>,
      );
      // `getByText` throws if absent → test fails on namespace drift.
      expect(screen.getByText(expectedLabel)).toBeTruthy();
    },
  );

  // F9-QA-01 regression: the `audit.eventType` catalogue does NOT cover every
  // `audit_event_type` enum value (~140 uncatalogued, e.g. invoice_pdf_downloaded).
  // The `.has` guard must fall back to the row summary WITHOUT querying the missing
  // key — otherwise next-intl's onError reporter spams MISSING_MESSAGE to the console.
  it('uncatalogued audit event falls back to its summary without a MISSING_MESSAGE log', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TimelineEventItem
          id="audit-uncatalogued"
          timestamp="2026-04-10T10:00:00Z"
          source="audit"
          eventType="invoice_pdf_downloaded"
          actorKind="staff"
          actorUserId="actor-1"
          actorDisplayName="Test User"
          payload={{ summary: 'Downloaded INV-2026-0001.pdf' }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Downloaded INV-2026-0001.pdf')).toBeTruthy();
    // The `.has` guard means the missing key was never queried → no onError log.
    const missingMessageLogged = errSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('MISSING_MESSAGE')),
    );
    expect(missingMessageLogged).toBe(false);
    errSpy.mockRestore();
  });

  it('uncatalogued audit event with no summary falls back to the source label', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <TimelineEventItem
          id="audit-uncatalogued-nosummary"
          timestamp="2026-04-10T10:00:00Z"
          source="audit"
          eventType="some_brand_new_event"
          actorKind="staff"
          actorUserId="actor-1"
          actorDisplayName="Test User"
          payload={null}
        />
      </NextIntlClientProvider>,
    );
    // Both the event label (fallback) and the source badge read 'Profile / Audit'.
    expect(screen.getAllByText('Profile / Audit').length).toBeGreaterThanOrEqual(1);
  });
});
