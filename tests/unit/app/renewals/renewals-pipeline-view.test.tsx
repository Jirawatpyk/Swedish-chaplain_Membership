/**
 * `renderRenewalsPipelineView` (spec 122 US7a, maintainer review on the
 * parity page, 1 Oct): the work queue is one AURA card on a desktop (board
 * `Admin-renewals`); on a phone it has no frame and no padding, so the row
 * cards sit on the 16px page gutter as `Admin-renewals-mobile` and the
 * members list draw them, not 32px in.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { renderRenewalsPipelineView } from '@/app/(staff)/admin/renewals/_components/renewals-pipeline-view';

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
