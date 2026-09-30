/**
 * `<LapsedTab>` on AURA (spec 122 US7a, T707): the Terminated tab of the
 * pipeline — an AURA info alert explaining the tab, an AURA table that
 * stacks on a phone, each close reason as an AURA badge (tone by meaning),
 * and the row's ⋯ as an AURA menu: "Open cycle" (a link) and "Mark
 * contacted" (the shared outreach dialog).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { PipelineRow } from '@/modules/renewals/client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { LapsedTab } from '@/app/(staff)/admin/renewals/_components/lapsed-tab';

function row(cycleId: string, companyName: string, closedReason: string | null): PipelineRow {
  return {
    cycleId: cycleId as PipelineRow['cycleId'],
    memberId: `m-${cycleId}`,
    companyName,
    tierBucket: 'regular' as PipelineRow['tierBucket'],
    expiresAt: '2026-01-01T00:00:00.000Z',
    urgency: 'terminated',
    status: 'lapsed' as PipelineRow['status'],
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    anchored: false,
    closedReason: closedReason as PipelineRow['closedReason'],
    emailUnverified: false,
  };
}

function renderTab(rows: ReadonlyArray<PipelineRow>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LapsedTab rows={rows} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.useRealTimers());

describe('<LapsedTab> on AURA', () => {
  it('explains the tab in an AURA info alert', () => {
    renderTab([]);
    const alert = screen.getByText(en.admin.renewals.lapsed.banner.description).closest('.aura-alert');
    expect(alert).not.toBeNull();
    expect(alert).toHaveClass('aura-alert--info');
  });

  it('lists the rows in an AURA table with each reason as a toned AURA badge', () => {
    renderTab([
      row('c1', 'Grace Co', 'grace_expired'),
      row('c2', 'Paid Co', 'paid'),
      row('c3', 'Refund Co', 'admin_rejected_with_refund'),
      row('c4', 'Cancel Co', 'cancelled'),
    ]);
    expect(screen.getByRole('table').closest('.aura-tbl')).not.toBeNull();
    const badge = (label: string) => screen.getByText(label).closest('.aura-badge');
    expect(badge('Grace expired')).toHaveClass('aura-badge--danger');
    expect(badge('Paid')).toHaveClass('aura-badge--success');
    expect(badge('Refunded')).toHaveClass('aura-badge--warning');
    expect(badge('Cancelled')).toHaveClass('aura-badge--neutral');
  });

  it('shows the empty-bucket copy when there are no rows', () => {
    renderTab([]);
    expect(screen.getByText(en.admin.renewals.table.noRows)).toBeInTheDocument();
  });

  it('the row menu is an AURA menu: Open cycle links to the cycle, Mark contacted opens the outreach dialog', () => {
    renderTab([row('c1', 'Grace Co', 'grace_expired')]);
    const trigger = screen.getByRole('button', { name: 'Actions for Grace Co' });
    expect(trigger).toHaveClass('aura-icon-btn');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Actions for Grace Co' });
    expect(within(menu).getByRole('menuitem', { name: 'Open cycle' })).toHaveAttribute('href', '/admin/renewals/c1');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark contacted' }));
    expect(screen.getByRole('alertdialog', { name: 'Record outreach' })).toBeInTheDocument();
  });
});
