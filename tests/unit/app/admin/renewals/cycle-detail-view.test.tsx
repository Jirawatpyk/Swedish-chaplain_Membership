/**
 * `renderCycleDetailView` (spec 122 US7b-1, T721; boards `Admin-renewal-cycle`
 * + `-reminded`, `-pending`, `-mobile`): the cycle detail body on AURA, shared
 * by the page and the no-DB preview.
 *
 * - Four AURA cards, each a region named by its heading; "Member & plan" is
 *   one list, and on a phone "Linked invoice" comes first.
 * - The money labels read "Frozen price (excl. VAT)" and "Total (incl. VAT)"
 *   (spec Clarifications, Session 2026-10-01 US7b start).
 * - The state notices are AURA alerts, and activity rows carry status pills.
 * - The phone danger zone renders below 640px only.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  renderCycleDetailView,
  type CycleDetailViewProps,
} from '@/app/(staff)/admin/renewals/[cycleId]/_components/cycle-detail-view';

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const scope = ns.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en);
    const t = (key: string, values?: Record<string, string>) => {
      const raw = key
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], scope) as string;
      return raw.replace(/\{(\w+)\}/g, (_, k: string) => values?.[k] ?? `{${k}}`);
    };
    return t;
  },
}));

const cd = en.admin.renewals.cycleDetail;

const BASE: CycleDetailViewProps = {
  status: 'awaiting_payment',
  refundSettling: false,
  lookupFailedMessage: null,
  memberPlan: {
    company: 'Lindqvist & Chai Group Co., Ltd.',
    memberHref: '/admin/members/m-1',
    primaryContact: 'Mattias Lindqvist',
    tier: 'partnership',
    planName: 'Gold Partnership',
    frozenPrice: 'THB 100,000.00',
    term: '12',
    currency: 'THB',
    technicalIds: { cycleId: 'c-1', memberId: 'm-1', planId: 'gold-partnership' },
  },
  invoice: {
    number: 'SC-2026-000130',
    status: 'issued',
    statusLabel: 'Issued',
    total: 'THB 107,000.00',
    href: '/admin/invoices/i-1',
  },
  invoicePendingMessage: cd.noInvoiceYetUpcoming,
  period: [
    { label: cd.fields.periodFrom, value: '1 January 2027' },
    { label: cd.fields.periodTo, value: '31 December 2027' },
    { label: cd.fields.expiresAt, value: '31 December 2026' },
  ],
  auditTimestamps: { createdAt: '2 September 2026 at 09:00', updatedAt: '2 September 2026 at 09:05' },
  reminders: [
    { id: 'r-1', stepId: 't-120.task.quarterly_review', status: 'sent', statusLabel: 'Sent', date: '2 Sep 2026', channel: 'Task' },
  ],
  escalations: [
    { id: 'e-1', typeLabel: 'Quarterly review meeting', status: 'done', statusLabel: 'Done', date: '2 Sep 2026', role: 'Executive Director' },
  ],
};

async function renderView(overrides: Partial<CycleDetailViewProps> = {}) {
  const view = (await renderCycleDetailView({ ...BASE, ...overrides })) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      {view}
    </NextIntlClientProvider>,
  );
}

function card(name: string | RegExp): HTMLElement {
  const region = screen.getByRole('region', { name });
  expect(region.closest('.aura-card')).not.toBeNull();
  return region;
}

describe('renderCycleDetailView — cards', () => {
  it('renders the four cards as AURA cards, each a region named by its heading', async () => {
    await renderView();
    for (const name of [cd.sectionMemberPlan, cd.sectionInvoice, cd.sectionPeriod, cd.sectionActivity]) {
      card(name);
    }
  });

  it('puts "Linked invoice" first on a phone (board Admin-renewal-cycle-mobile)', async () => {
    await renderView();
    expect(card(cd.sectionInvoice).closest('.aura-card')).toHaveClass('max-sm:order-first');
    expect(card(cd.sectionMemberPlan).closest('.aura-card')).not.toHaveClass('max-sm:order-first');
  });

  it('lists Member & plan as one list with the frozen price excluding VAT', async () => {
    await renderView();
    const region = card(cd.sectionMemberPlan);
    const terms = within(region)
      .getAllByRole('term')
      .map((dt) => dt.textContent)
      .slice(0, 7);
    expect(terms).toEqual([
      cd.fields.companyName,
      cd.fields.primaryContact,
      cd.fields.tier,
      cd.fields.planName,
      'Frozen price (excl. VAT)',
      cd.fields.frozenTerm,
      cd.fields.frozenCurrency,
    ]);
    expect(within(region).queryByRole('heading', { name: cd.subsectionMember })).toBeNull();
    expect(within(region).getByRole('link', { name: BASE.memberPlan.company })).toHaveAttribute('href', '/admin/members/m-1');
    expect(within(region).getByText(en.admin.renewals.tierBadge.partnership).closest('.aura-badge')).not.toBeNull();
    expect(within(region).getByText(cd.fields.showTechnicalIds)).toBeInTheDocument();
  });

  it('shows the linked invoice with its status pill and the total including VAT', async () => {
    await renderView();
    const region = card(cd.sectionInvoice);
    expect(within(region).getByText('Total (incl. VAT)')).toBeInTheDocument();
    expect(within(region).getByText('THB 107,000.00')).toBeInTheDocument();
    expect(within(region).getByText('Issued').closest('.aura-pill')).toHaveClass('aura-pill--progress');
    expect(within(region).getByRole('link', { name: 'View invoice SC-2026-000130' })).toHaveAttribute('href', '/admin/invoices/i-1');
  });

  it('explains a missing invoice instead of hiding the card', async () => {
    await renderView({ invoice: null });
    expect(within(card(cd.sectionInvoice)).getByText(cd.noInvoiceYetUpcoming)).toBeInTheDocument();
  });

  it('lists reminders and escalation tasks with status pills', async () => {
    await renderView();
    const region = card(cd.sectionActivity);
    expect(within(region).getByText('Sent').closest('.aura-pill')).toHaveClass('aura-pill--ready');
    expect(within(region).getByText('Done').closest('.aura-pill')).toHaveClass('aura-pill--ready');
    expect(within(region).getByText('t-120.task.quarterly_review')).toBeInTheDocument();
    expect(within(region).getByText('Executive Director')).toBeInTheDocument();
  });

  it('shows the empty activity state when nothing has been sent yet', async () => {
    await renderView({ reminders: [], escalations: [] });
    expect(within(card(cd.sectionActivity)).getByText(cd.noActivityTitle)).toBeInTheDocument();
  });
});

describe('renderCycleDetailView — notices and danger zone', () => {
  it('asks for a decision on a pending cycle (warning alert, board Admin-renewal-cycle-pending)', async () => {
    await renderView({ status: 'pending_admin_reactivation' });
    const alert = screen.getByText(cd.pendingNoticeTitle).closest('.aura-alert');
    expect(alert).toHaveClass('aura-alert--warning');
    expect(alert).toHaveTextContent(cd.pendingNoticeBody);
  });

  it('shows the refund-settling notice instead of the decision once rejected', async () => {
    await renderView({ status: 'pending_admin_reactivation', refundSettling: true });
    expect(screen.queryByText(cd.pendingNoticeTitle)).toBeNull();
    expect(screen.getByText(cd.refundSettlingNoticeTitle).closest('.aura-alert')).toHaveAttribute('role', 'status');
  });

  it('explains how to take a payment on a terminated membership', async () => {
    await renderView({ status: 'lapsed' });
    expect(screen.getByText(cd.terminatedCallout.title).closest('.aura-alert')).toHaveAttribute('role', 'note');
  });

  it('says when related data could not be loaded', async () => {
    await renderView({ lookupFailedMessage: 'Member details could not be loaded (ref abc).' });
    expect(screen.getByText(cd.lookupFailedTitle).closest('.aura-alert')).toHaveTextContent('ref abc');
  });

  it('renders the danger zone below 640px only, when given', async () => {
    await renderView({ dangerZone: <button type="button">Cancel cycle</button> });
    const zone = screen.getByRole('region', { name: cd.dangerZone });
    expect(zone).toHaveClass('sm:hidden');
    expect(within(zone).getByRole('button', { name: 'Cancel cycle' })).toBeInTheDocument();
  });

  it('renders no danger zone without one', async () => {
    await renderView();
    expect(screen.queryByRole('region', { name: cd.dangerZone })).toBeNull();
  });
});
