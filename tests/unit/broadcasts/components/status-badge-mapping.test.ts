/**
 * F7 UX hardening — H4: shared broadcast status → badge style mapping.
 *
 * Eliminates the 3-way drift between:
 *   - `src/components/broadcast/admin/status-badge.tsx`
 *   - `src/components/broadcast/admin/queue-table.tsx` (inline STATUS_STYLE)
 *   - `src/app/(member)/portal/broadcasts/[id]/page.tsx` (flat `variant="outline"`)
 *
 * Pure utility — no React / i18n / framework imports — so it is
 * consumable by server components, client components, and tests.
 *
 * Spec: BROADCAST_STATUSES (8 states) from
 * `src/modules/broadcasts/domain/value-objects/broadcast-status.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import {
  getBroadcastStatusBadgeProps,
  type BroadcastBadgeVariant,
} from '@/components/broadcast/status-badge-mapping';

describe('getBroadcastStatusBadgeProps', () => {
  it('returns a value for every BroadcastStatus (exhaustive)', () => {
    for (const status of BROADCAST_STATUSES) {
      const props = getBroadcastStatusBadgeProps(status);
      expect(props.variant).toBeDefined();
    }
  });

  it.each<[BroadcastStatus, BroadcastBadgeVariant]>([
    ['draft', 'outline'],
    ['submitted', 'secondary'],
    ['approved', 'default'],
    ['sending', 'default'],
    ['sent', 'default'],
    ['rejected', 'destructive'],
    ['cancelled', 'outline'],
    ['failed_to_dispatch', 'destructive'],
  ])('maps %s to variant=%s', (status, expectedVariant) => {
    const { variant } = getBroadcastStatusBadgeProps(status);
    expect(variant).toBe(expectedVariant);
  });

  it('gates sending pulse with motion-safe (prefers-reduced-motion friendly)', () => {
    const { className } = getBroadcastStatusBadgeProps('sending');
    expect(className).toContain('motion-safe:animate-pulse');
  });

  it('dims draft + cancelled with text-muted-foreground', () => {
    expect(getBroadcastStatusBadgeProps('draft').className).toContain(
      'text-muted-foreground',
    );
    expect(getBroadcastStatusBadgeProps('cancelled').className).toContain(
      'text-muted-foreground',
    );
  });

  it('returns no className for variants that need no overrides', () => {
    expect(getBroadcastStatusBadgeProps('submitted').className).toBeUndefined();
    expect(getBroadcastStatusBadgeProps('approved').className).toBeUndefined();
    expect(getBroadcastStatusBadgeProps('sent').className).toBeUndefined();
    expect(getBroadcastStatusBadgeProps('rejected').className).toBeUndefined();
    expect(
      getBroadcastStatusBadgeProps('failed_to_dispatch').className,
    ).toBeUndefined();
  });
});
