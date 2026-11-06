/**
 * `renderRenewalsPipelineView` (spec 122 US7a, maintainer review on the
 * parity page, 1 Oct): the work queue is one AURA card on a desktop (board
 * `Admin-renewals`); on a phone it has no frame and no padding, so the row
 * cards sit on the 16px page gutter as `Admin-renewals-mobile` and the
 * members list draw them, not 32px in.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  renderPipelineLens,
  renderRenewalsPipelineView,
} from '@/app/(staff)/admin/renewals/_components/renewals-pipeline-view';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));
// The lens's client islands (tabs, selects, the bulk table) have their own
// tests; here they are stand-ins so the footer can be read on its own.
vi.mock('@/app/(staff)/admin/renewals/_components/urgency-bucket-tabs', () => ({ UrgencyBucketTabs: () => null }));
vi.mock('@/app/(staff)/admin/renewals/_components/tier-filter-select', () => ({ TierFilterSelect: () => null }));
vi.mock('@/app/(staff)/admin/renewals/_components/pipeline-with-bulk', () => ({ PipelineWithBulk: () => null }));
vi.mock('@/components/renewals/result-count-announcer', () => ({ ResultCountAnnouncer: () => null }));
vi.mock('@/components/renewals/result-count-label', () => ({ ResultCountLabel: () => null }));

describe('renderRenewalsPipelineView — the work-queue card', () => {
  it('drops its frame and its padding below 640px (AURA flushBelow, no padding or border)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        {renderRenewalsPipelineView({
          moneyBand: null,
          sectionTabs: <p>SECTION TABS</p>,
          pipeline: <p>PIPELINE</p>,
          needsAction: <p>NEEDS ACTION</p>,
          byMonth: null,
          tray: null,
        })}
      </NextIntlClientProvider>,
    );
    const card = screen.getByText('SECTION TABS').closest('.aura-card');
    expect(card).toHaveClass('aura-card--flush-below-sm');
    expect(card).toHaveClass('max-sm:p-0', 'max-sm:border-0');
  });
});

const lensBase = {
  rows: [],
  summary: {
    totalInWindow: 60,
    byUrgency: { overdue: 0, due_soon: 0, upcoming: 60, suspended: 0 } as never,
    lapsedCount: 0,
    suspendedOutsideWindowCount: 0,
    suspendedInWindowGlobalCount: 0,
  } as never,
  urgency: 'upcoming' as never,
  tier: undefined,
  monthLensActive: false,
  monthKind: undefined,
  monthLabel: undefined,
  sort: 'expires' as never,
  sortHrefs: { expires: '/admin/renewals?sort=expires', tier: '/admin/renewals?sort=tier' },
  showEmptyState: false,
  canMutate: true,
  canManageSchedules: true,
} as const;

describe('renderPipelineLens — the keyset footer', () => {
  it('is AURA cursor Pagination with the same Next href and the "Showing first 50" status', async () => {
    const lens = (await renderPipelineLens({
      ...lensBase,
      nextHref: '/admin/renewals?urgency=upcoming&cursor=c2',
    })) as ReactElement;
    render(lens);
    // PR P review L6 — the nav is named for its list, not AURA's generic default.
    const nav = screen.getByRole('navigation', { name: 'Renewal pages' });
    // Forward-only keyset: no Previous step at all (AURA 5.84 #197).
    expect(nav).not.toHaveTextContent(/previous/i);
    expect(nav).toHaveClass('aura-pagination', 'aura-pagination--cursor');
    expect(nav).toHaveTextContent(en.admin.renewals.table.pagination.showingFirst);
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/admin/renewals?urgency=upcoming&cursor=c2',
    );
  });

  // PR #757 review — page 2+ of a forward-only keyset had no way back.
  it('on page 2+ links First page to the cursor-less view, filters kept', async () => {
    render(
      (await renderPipelineLens({
        ...lensBase,
        tier: 'corporate' as never,
        nextHref: '/admin/renewals?tier=corporate&urgency=upcoming&cursor=c3',
        firstHref: '/admin/renewals?tier=corporate&urgency=upcoming',
      })) as ReactElement,
    );
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/admin/renewals?tier=corporate&urgency=upcoming');
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', '/admin/renewals?tier=corporate&urgency=upcoming&cursor=c3');
  });

  it('keeps First page on the last page reached by a cursor; disables it on the first page', async () => {
    const { unmount } = render((await renderPipelineLens({ ...lensBase, nextHref: null, firstHref: '/admin/renewals?urgency=upcoming' })) as ReactElement);
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', '/admin/renewals?urgency=upcoming');
    unmount();
    render((await renderPipelineLens({ ...lensBase, nextHref: '/admin/renewals?urgency=upcoming&cursor=c2', firstHref: null })) as ReactElement);
    const first = screen.getByRole('link', { name: 'First page' });
    expect(first).toHaveAttribute('aria-disabled', 'true');
    expect(first).not.toHaveAttribute('href');
  });
});
