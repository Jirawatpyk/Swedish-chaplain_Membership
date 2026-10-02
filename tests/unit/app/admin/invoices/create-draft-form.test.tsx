/**
 * Spec 122 US8 (T807) — the membership draft form on AURA (`Admin-invoice-new`):
 * AURA's member combobox, the read-only plan block, the renewal note as an
 * info alert, Cancel + Create draft, and the duplicate warning as an AURA
 * alertdialog. The POST body is unchanged: `acknowledge_duplicate` only from
 * the dialog's "create anyway".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateDraftForm } from '@/app/(staff)/admin/invoices/_components/invoice-form';

const form = enMessages.admin.invoices.form;
const members = [{ memberId: 'm-1', label: 'Acme (Regular / 2026)', currentPlanId: 'regular', currentPlanYear: 2026 }];
const plans = [{ planId: 'regular', label: 'Regular Corporate', annualFeeMinorUnits: 3600000 }];

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreateDraftForm members={members} plans={plans} initialMemberId="m-1" />
    </NextIntlClientProvider>,
  );
}

const calls: Array<[string, RequestInit | undefined]> = [];
function stubFetch(postResponses: Array<{ status: number; body: unknown }>) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.startsWith('/api/invoices/member-renewal-context')) {
        return new Response(
          JSON.stringify({ classification: { kind: 'renewal' }, period_to: '2026-12-31', term_months: 12 }),
          { status: 200 },
        );
      }
      const next = postResponses.shift() ?? { status: 201, body: { invoice_id: 'inv-new' } };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
}

beforeEach(() => {
  vi.useRealTimers();
  pushMock.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

const posts = () => calls.filter(([u]) => u === '/api/invoices');

describe('CreateDraftForm on AURA (T807)', () => {
  it('an AURA combobox, the plan block and the renewal note as an info alert', async () => {
    stubFetch([]);
    renderForm();
    const combobox = screen.getByRole('combobox', { name: form.fields.memberId });
    expect(combobox.closest('.aura-combobox, .aura-field')).not.toBeNull();
    expect(screen.getByText('Regular Corporate')).toBeInTheDocument();
    const note = await screen.findByTestId('renewal-context-line');
    expect(note).toHaveClass('aura-alert--info');
  });

  it('Create draft carries the board\'s plus icon; Cancel has none', () => {
    stubFetch([]);
    renderForm();
    expect(screen.getByRole('button', { name: form.submit }).querySelector('svg.aura-icon')).not.toBeNull();
    expect(screen.getByRole('link', { name: form.cancel }).querySelector('svg')).toBeNull();
  });

  it('Create draft posts the same body, then opens the new draft', async () => {
    stubFetch([]);
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: form.submit }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/admin/invoices/inv-new'));
    const [, init] = posts()[0]!;
    expect(init?.body).toBe(
      JSON.stringify({ member_id: 'm-1', plan_id: 'regular', plan_year: 2026, auto_email_on_issue: null }),
    );
  });

  it('Cancel goes back to the list', () => {
    stubFetch([]);
    renderForm();
    expect(screen.getByRole('link', { name: form.cancel })).toHaveAttribute('href', '/admin/invoices');
  });

  it('a duplicate refusal opens an AURA alertdialog; "create anyway" alone adds acknowledge_duplicate', async () => {
    stubFetch([
      {
        status: 409,
        body: {
          error: {
            code: 'duplicate_membership_invoice',
            existing: { invoice_id: 'inv-old', status: 'issued', document_number: 'SC-2026-000100', total_satang: '3852000' },
          },
        },
      },
    ]);
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: form.submit }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveClass('aura-dialog');
    expect(dialog).toHaveTextContent('SC-2026-000100');
    expect(dialog).toHaveTextContent('38,520.00 THB');
    const existing = within(dialog).getByRole('link', { name: form.duplicateConfirm.viewExisting });
    expect(existing).toHaveAttribute('href', '/admin/invoices/inv-old');
    // Valid HTML: a <dl> holds only dt/dd groups, so the link sits after it.
    expect(existing.closest('dl')).toBeNull();
    fireEvent.click(await within(dialog).findByRole('button', { name: form.duplicateConfirm.createAnyway }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]![1]?.body).toBe(
      JSON.stringify({
        member_id: 'm-1',
        plan_id: 'regular',
        plan_year: 2026,
        auto_email_on_issue: null,
        acknowledge_duplicate: true,
      }),
    );
  });
});
