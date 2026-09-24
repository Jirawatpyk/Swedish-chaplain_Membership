/**
 * F119 dashboard UX review M2 — the queue's loading skeleton reserves the chips
 * the strip will actually render: 8 with the approval round off (the five
 * round-only stages are withheld when no row sits in them — R18), 13 with it
 * on; plus the Upcoming sends button's h-9 slot, which it did not reserve.
 *
 * `loading.tsx` reads the flag through the module barrel; the barrel is
 * replaced by the REAL value-object exports plus a flag double, so the counts
 * below come from the same tuples the strip derives from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const flag = vi.hoisted(() => ({ on: false }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('@/modules/broadcasts', async () => ({
  ...(await import('@/modules/broadcasts/domain/value-objects/broadcast-status')),
  isEblastMemberApprovalEnabled: () => flag.on,
}));

import AdminBroadcastsLoading from '@/app/(staff)/admin/broadcasts/loading';
import {
  APPROVAL_ROUND_ONLY_STATUSES,
  OFFERED_BROADCAST_STATUSES,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

async function renderSkeleton() {
  return render((await AdminBroadcastsLoading()) as React.ReactElement);
}

beforeEach(() => {
  flag.on = false;
});

describe('the queue loading skeleton (UX review M2)', () => {
  it('reserves the 8 always-offered chips while the approval round is off', async () => {
    const { container } = await renderSkeleton();
    const chips = container.querySelectorAll('[data-skeleton="stage-chip"]');
    expect(chips).toHaveLength(8);
    expect(chips).toHaveLength(OFFERED_BROADCAST_STATUSES.length - APPROVAL_ROUND_ONLY_STATUSES.size);
  });

  it('reserves all 13 offered chips while it is on', async () => {
    flag.on = true;
    const { container } = await renderSkeleton();
    expect(container.querySelectorAll('[data-skeleton="stage-chip"]')).toHaveLength(13);
    expect(OFFERED_BROADCAST_STATUSES).toHaveLength(13);
  });

  it('reserves an h-9 slot for the Upcoming sends button', async () => {
    const { container } = await renderSkeleton();
    const slot = container.querySelector('[data-skeleton="upcoming-sends"]');
    expect(slot).not.toBeNull();
    expect(slot!.className).toContain('h-9');
  });
});
