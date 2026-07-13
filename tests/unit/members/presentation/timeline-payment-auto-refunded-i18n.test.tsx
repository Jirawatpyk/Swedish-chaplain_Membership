/**
 * Task A.16 (M-h) — F5 `auto_refunded` payment-status label + refund-pending
 * copy i18n locks.
 *
 * The member activity timeline derives a payment row's event-kind from the
 * payment STATUS (`drizzle-timeline-repo.nonAuditEventKind` → `payment` case
 * returns `status`), which the consumer resolves via `timeline.payment.<status>`.
 * Adding the F5 terminal `auto_refunded` status without a label would silently
 * fall back to the generic "Payment" source label (the consumer's `.has` guard).
 * This pins that:
 *   - `timeline.payment.auto_refunded` exists in EN/TH/SV, so the timeline shows
 *     a specific label rather than the generic fallback; AND
 *   - the pre-existing refund-pending "awaiting confirmation" copy
 *     (`admin.refund.success.pendingToast`, added by A.9) + the auto-refund-failed
 *     forensic label (`audit.eventType.auto_refund_failed_needs_manual_reconcile`,
 *     added earlier / A.3) remain present in all three locales (guard against
 *     accidental removal — these are NOT re-added by A.16).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

import { TimelineEventItem } from '@/components/members/timeline-event-item';

type Msgs = Record<string, unknown>;
const locales: ReadonlyArray<readonly [string, Msgs]> = [
  ['en', en as Msgs],
  ['th', th as Msgs],
  ['sv', sv as Msgs],
];

function at(obj: Msgs, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Msgs)[key] : undefined),
    obj,
  );
}

describe('A.16 i18n — F5 refund-lifecycle labels present in every locale', () => {
  it.each(locales)('[%s] timeline.payment.auto_refunded is a non-empty string', (_, msgs) => {
    const label = at(msgs, 'timeline.payment.auto_refunded');
    expect(typeof label).toBe('string');
    expect((label as string).length).toBeGreaterThan(0);
  });

  it.each(locales)(
    '[%s] pre-existing audit.eventType.auto_refund_failed_needs_manual_reconcile is present (not duplicated by A.16)',
    (_, msgs) => {
      const label = at(msgs, 'audit.eventType.auto_refund_failed_needs_manual_reconcile');
      expect(typeof label).toBe('string');
      expect((label as string).length).toBeGreaterThan(0);
    },
  );

  it.each(locales)(
    '[%s] pre-existing refund-pending awaiting-confirmation copy admin.refund.success.pendingToast is present',
    (_, msgs) => {
      const copy = at(msgs, 'admin.refund.success.pendingToast');
      expect(typeof copy).toBe('string');
      expect((copy as string).length).toBeGreaterThan(0);
    },
  );
});

describe('A.16 i18n — auto_refunded renders through the timeline consumer (no generic fallback)', () => {
  it('source=payment eventType=auto_refunded resolves to the specific EN label', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <NextIntlClientProvider locale="en" messages={en as Msgs}>
        <TimelineEventItem
          id="pay-auto-refunded"
          timestamp="2026-05-15T10:00:00Z"
          source="payment"
          eventType="auto_refunded"
          actorKind="system"
          actorUserId="system"
          actorDisplayName={null}
          payload={null}
        />
      </NextIntlClientProvider>,
    );
    // The specific payment-status label — NOT the generic "Payment" source
    // fallback that would render if `timeline.payment.auto_refunded` were absent.
    expect(screen.getByText('Payment auto-refunded')).toBeTruthy();
    const missingMessageLogged = errSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('MISSING_MESSAGE')),
    );
    expect(missingMessageLogged).toBe(false);
    errSpy.mockRestore();
  });
});
