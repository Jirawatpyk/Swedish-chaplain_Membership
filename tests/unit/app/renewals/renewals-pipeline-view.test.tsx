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

describe('renderPipelineLens — the keyset footer', () => {
  it('is AURA cursor Pagination with the same Next href and the "Showing first 50" status', async () => {
    const lens = (await renderPipelineLens({
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
      nextHref: '/admin/renewals?urgency=upcoming&cursor=c2',
      showEmptyState: false,
      canMutate: true,
      canManageSchedules: true,
    })) as ReactElement;
    render(lens);
    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(nav).toHaveClass('aura-pagination', 'aura-pagination--cursor');
    expect(nav).toHaveTextContent(en.admin.renewals.table.pagination.showingFirst);
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/admin/renewals?urgency=upcoming&cursor=c2',
    );
  });
});
