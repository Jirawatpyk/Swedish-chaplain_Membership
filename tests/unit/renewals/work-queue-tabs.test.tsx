/**
 * `<WorkQueueTabs>` — the All renewals / Needs action toggle (spec 122 US7a,
 * T703; board `Admin-renewals`): AURA segmented `Tabs` whose panels are the
 * pipeline and the at-risk lens, the needs-action count on its tab, and the
 * pipeline help button at the end of the row. The active panel keeps the
 * `#work-queue-panel` hook the e2e specs scope to.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  WorkQueueTabs,
  type WorkQueueTabsProps,
} from '@/app/(staff)/admin/renewals/_components/work-queue-tabs';

beforeEach(() => vi.useRealTimers());

function setup(extraProps: Partial<WorkQueueTabsProps> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <WorkQueueTabs
        pipeline={<div data-testid="pipeline-panel">PIPELINE</div>}
        needsAction={<div data-testid="needs-action-panel">NEEDS ACTION</div>}
        {...extraProps}
      />
    </NextIntlClientProvider>,
  );
}

describe('WorkQueueTabs on AURA', () => {
  it('is an AURA segmented tablist named "Work queue"', () => {
    setup();
    const list = screen.getByRole('tablist', { name: 'Work queue' });
    expect(list).toHaveClass('aura-segmented');
    expect(screen.getByRole('tab', { name: 'All renewals' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the pipeline by default, inside #work-queue-panel, and not the needs-action lens', () => {
    setup();
    expect(screen.getByTestId('pipeline-panel')).toBeVisible();
    expect(screen.getByTestId('pipeline-panel').closest('#work-queue-panel')).not.toBeNull();
    expect(screen.queryByTestId('needs-action-panel')).toBeNull();
  });

  it('ArrowRight moves selection to Needs action and shows its lens', async () => {
    setup();
    screen.getByRole('tab', { name: 'All renewals' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /^Needs action/ })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('needs-action-panel')).toBeVisible();
    expect(screen.getByTestId('needs-action-panel').closest('#work-queue-panel')).not.toBeNull();
  });

  it('shows the needs-action count on its tab and names it', () => {
    setup({ needsActionCount: 3 });
    const tab = screen.getByRole('tab', { name: 'Needs action, 3 members need action' });
    expect(tab.textContent).toBe('Needs action3');
  });

  it('shows no count when there is none (0 or absent)', () => {
    setup({ needsActionCount: 0 });
    expect(screen.getByRole('tab', { name: 'Needs action' }).textContent).toBe('Needs action');
  });

  it('renders the pipeline help button at the end of the toggle row', () => {
    setup();
    expect(screen.getByRole('button', { name: 'About the renewal pipeline' })).toBeInTheDocument();
  });
});
