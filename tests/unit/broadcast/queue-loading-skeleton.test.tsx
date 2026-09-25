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
import { cleanup as cleanupRender, render } from '@testing-library/react';

const flag = vi.hoisted(() => ({ on: false, templates: true }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('@/modules/broadcasts', async () => ({
  ...(await import('@/modules/broadcasts/domain/value-objects/broadcast-status')),
  isEblastMemberApprovalEnabled: () => flag.on,
  isF71aUs7Enabled: () => flag.templates,
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
  flag.templates = true;
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

  it('#400 item 8: reserves an h-9 slot for the Waiting on marketing button too', async () => {
    const { container } = await renderSkeleton();
    const slot = container.querySelector('[data-skeleton="waiting-on-marketing"]');
    expect(slot).not.toBeNull();
    expect(slot!.className).toContain('h-9');
  });
});

/**
 * T086a V3 (PR-1's U12) — the rest of the page's regions. The skeleton drew
 * seven full-width bars at every width: no eight-column table from `md`, no
 * card list below it, no header actions (the real Templates + New E-Blast
 * links share the header's action row, a full-width row below `sm` — ~80 px
 * of shift on every phone load), no order hint, and no `aria-busy`.
 */
describe('the queue loading skeleton mirrors the page (T086a V3)', () => {
  it('announces itself as busy', async () => {
    const { container } = await renderSkeleton();
    expect(container.querySelector('[data-slot="layout-container"]')).toHaveAttribute('aria-busy', 'true');
  });

  it('reserves the header actions the page renders — Templates only while its flag is on', async () => {
    const { container } = await renderSkeleton();
    const actions = container.querySelector('[data-slot="page-header-actions"]');
    expect(actions?.querySelectorAll('[data-skeleton="header-action"]')).toHaveLength(2);

    cleanupRender();
    flag.templates = false;
    const off = await renderSkeleton();
    expect(off.container.querySelectorAll('[data-skeleton="header-action"]')).toHaveLength(1);
  });

  it('reserves the order hint, the eight-column table from md and the card list below it', async () => {
    const { container } = await renderSkeleton();
    expect(container.querySelector('[data-skeleton="order-hint"]')).not.toBeNull();

    const table = container.querySelector('[data-skeleton="queue-table"]');
    expect(table?.className).toMatch(/(?:^|\s)hidden(?:\s|$)/);
    expect(table?.className).toContain('md:block');
    expect(table?.querySelectorAll('[data-skeleton="queue-column"]')).toHaveLength(8);
    // Real rows are two-line (a value over its secondary line) in every column.
    const firstRow = table?.querySelector('[data-skeleton="queue-row"]');
    expect(firstRow?.querySelectorAll('[data-skeleton="queue-cell"]')).toHaveLength(8);

    const cards = container.querySelector('[data-skeleton="queue-card-list"]');
    expect(cards?.className).toContain('md:hidden');
    expect(cards?.querySelectorAll('[data-slot="card"]').length).toBeGreaterThan(0);
  });
});
