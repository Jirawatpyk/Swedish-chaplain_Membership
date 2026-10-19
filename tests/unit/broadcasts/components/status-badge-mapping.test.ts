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
  getBroadcastStatusTone,
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
    // F119 (0308) — marketing's turn reads like `submitted`; the member's turn
    // is distinct and non-destructive; expiry is muted like `cancelled`.
    ['in_design', 'secondary'],
    ['awaiting_member_approval', 'outline'],
    ['changes_requested', 'secondary'],
    ['member_approved', 'secondary'],
    ['expired_no_member_response', 'outline'],
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
    expect(
      getBroadcastStatusBadgeProps('expired_no_member_response').className,
    ).toContain('text-muted-foreground');
  });

  it('does not mute the member’s turn — it is live work, unlike draft/cancelled', () => {
    expect(
      getBroadcastStatusBadgeProps('awaiting_member_approval').className,
    ).toBeUndefined();
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

// Spec 122 US12b — the review queue's AURA `StatusPill` tone per stage: work in
// flight is progress, done is ready, failed or refused is blocked, a partial
// send is a warning, and parked or closed stages stay neutral.
describe('getBroadcastStatusTone', () => {
  it.each<[BroadcastStatus, ReturnType<typeof getBroadcastStatusTone>]>([
    ['draft', 'neutral'],
    ['submitted', 'progress'],
    ['in_design', 'progress'],
    ['changes_requested', 'progress'],
    ['awaiting_member_approval', 'neutral'],
    ['member_approved', 'progress'],
    ['approved', 'ready'],
    ['sending', 'progress'],
    ['sent', 'ready'],
    ['partially_sent', 'warning'],
    ['partial_delivery_accepted', 'neutral'],
    ['rejected', 'blocked'],
    ['cancelled', 'neutral'],
    ['failed_to_dispatch', 'blocked'],
    ['expired_no_member_response', 'neutral'],
  ])('maps %s to tone=%s', (status, tone) => {
    expect(getBroadcastStatusTone(status)).toBe(tone);
  });

  it('covers every BroadcastStatus', () => {
    for (const status of BROADCAST_STATUSES) {
      expect(getBroadcastStatusTone(status)).toBeDefined();
    }
  });
});
