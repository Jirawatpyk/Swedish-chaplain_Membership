/**
 * F8 Phase 6 review-round 2 A3 — CycleStatusBadge parametric coverage.
 *
 * Pins the 7-status × variant-class table + the optional `srSuffix`
 * surfacing for severity-bearing statuses (`lapsed`,
 * `pending_admin_reactivation` per Phase 6 review-round 2 C1).
 *
 * The TS compile-time `Record<CycleStatus, string>` already enforces
 * exhaustiveness on `STATUS_VARIANT_CLASSES`; this test verifies the
 * runtime DOM output (label rendering + sr-only suffix presence) so a
 * silent regression — e.g. someone deleting an arm or accidentally
 * dropping the `srSuffix` prop wiring — fails CI.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { CycleStatus } from '@/modules/renewals';
import { CycleStatusBadge } from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-status-badge';

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

  it.each(statuses)('renders label + non-empty class for status %s', (status) => {
    const { container, getByText } = render(
      <CycleStatusBadge status={status} label={`Label for ${status}`} />,
    );
    expect(getByText(`Label for ${status}`)).toBeTruthy();
    const badge = container.querySelector('span');
    expect(badge?.className.length ?? 0).toBeGreaterThan(50);
  });

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
