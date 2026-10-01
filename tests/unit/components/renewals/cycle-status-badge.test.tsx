/**
 * F8 Phase 6 review-round 2 A3 — CycleStatusBadge parametric coverage.
 *
 * Pins the 7-status tone table + the optional `srSuffix` surfacing for
 * severity-bearing statuses (`lapsed`, `pending_admin_reactivation` per
 * Phase 6 review-round 2 C1).
 *
 * 122 US7b-1 (T721): the badge is an AURA `StatusPill` whose tone comes
 * from the map it shares with the member-detail Renewal health card (spec
 * Clarifications, Session 2026-10-01 US7b start), so a cycle status reads
 * the same in both places.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { CycleStatus } from '@/modules/renewals';
import { CycleStatusBadge } from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-status-badge';
import { CYCLE_STATUS_TONE } from '@/components/renewals/cycle-status-tone';

describe('CycleStatusBadge (Phase 6 review-round 2 A3)', () => {
  const statuses: ReadonlyArray<CycleStatus> = [
    'upcoming',
    'reminded',
    'awaiting_payment',
    'completed',
    'lapsed',
    'cancelled',
    'pending_admin_reactivation',
  ];

  it('shares one tone per status: neutral before the bill, progress while it is open, ready when paid', () => {
    expect(CYCLE_STATUS_TONE).toEqual({
      upcoming: 'neutral',
      reminded: 'neutral',
      awaiting_payment: 'progress',
      pending_admin_reactivation: 'warning',
      completed: 'ready',
      lapsed: 'blocked',
      cancelled: 'blocked',
    });
  });

  it.each(statuses)(
    'renders the label as an AURA StatusPill in its shared tone for status %s',
    (status) => {
      const { getByText } = render(
        <CycleStatusBadge status={status} label={`Label for ${status}`} />,
      );
      const pill = getByText(`Label for ${status}`).closest('.aura-pill');
      expect(pill).not.toBeNull();
      expect(pill).toHaveClass(`aura-pill--${CYCLE_STATUS_TONE[status]}`);
    },
  );

  it('renders srSuffix in sr-only span when provided', () => {
    const { container } = render(
      <CycleStatusBadge
        status="lapsed"
        label="Lapsed"
        srSuffix=" — needs reactivation"
      />,
    );
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe(' — needs reactivation');
  });

  it('omits sr-only span when srSuffix is null', () => {
    const { container } = render(
      <CycleStatusBadge status="upcoming" label="Upcoming" srSuffix={null} />,
    );
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly).toBeNull();
  });

  it('omits sr-only span when srSuffix is undefined', () => {
    const { container } = render(
      <CycleStatusBadge status="upcoming" label="Upcoming" />,
    );
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly).toBeNull();
  });

  it('omits sr-only span when srSuffix is empty string', () => {
    const { container } = render(
      <CycleStatusBadge status="upcoming" label="Upcoming" srSuffix="" />,
    );
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly).toBeNull();
  });
});
