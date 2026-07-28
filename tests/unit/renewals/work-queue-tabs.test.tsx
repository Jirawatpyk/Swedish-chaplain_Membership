/**
 * Wave 2 Task 7 — `WorkQueueTabs` unit test (roving tabindex + panel switch).
 *
 * `WorkQueueTabs` is the 2-lens client tablist that folds the pipeline body
 * and the `AtRiskWidget` into ONE work-queue control on `/admin/renewals`
 * (below the section tabs, no URL param). Only the active lens's panel is
 * mounted — `pipeline` is server-streamed content passed as a `ReactNode`
 * prop, so mounting/unmounting it is cheap.
 *
 * Review round 1 Fix I-1 — `needsActionBadge` is an optional `ReactNode`
 * slot rendered inside the "Needs action" tab, right after its label. The
 * page passes a server-streamed count badge; these tests only verify the
 * slot itself (present vs absent), not the page's data-fetch (that half is
 * a server component, covered by typecheck/lint per the review — see
 * `page.tsx`'s `NeedsActionCountBadge`).
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that would
 * hang React rendering / `userEvent` (memory: component test harness fake
 * timers).
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

describe('WorkQueueTabs', () => {
  it('shows pipeline by default and hides needs-action', () => {
    setup();
    expect(screen.getByTestId('pipeline-panel')).toBeVisible();
    expect(screen.queryByTestId('needs-action-panel')).toBeNull();
  });

  it('ArrowRight moves roving focus + selection to needs-action', async () => {
    setup();
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '0');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
    expect(await screen.findByTestId('needs-action-panel')).toBeVisible();
  });

  it('renders needsActionBadge inside the Needs action tab when provided', () => {
    setup({
      needsActionBadge: <span data-testid="needs-action-badge">3</span>,
    });
    const needsActionTab = screen.getByRole('tab', { name: /needs action/i });
    const badge = screen.getByTestId('needs-action-badge');
    expect(badge).toBeVisible();
    // Slotted INSIDE the tab button, not floated elsewhere on the page.
    expect(needsActionTab).toContainElement(badge);
  });

  it('renders no badge in either tab when needsActionBadge is absent', () => {
    setup();
    expect(screen.queryByTestId('needs-action-badge')).toBeNull();
    const pipelineTab = screen.getByRole('tab', { name: /pipeline|all renewals/i });
    // The pipeline tab never gets a badge slot at all, present or absent.
    expect(pipelineTab.querySelector('[data-testid]')).toBeNull();
  });
});
