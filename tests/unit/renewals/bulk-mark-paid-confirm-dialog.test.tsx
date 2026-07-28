/**
 * 059-membership-suspension Task 11 — `BulkMarkPaidConfirmDialog`.
 *
 * Render-only (the dialog is mounted with `open` TRUE from the start, no
 * click-to-open transition, and no click-through submit) — mirrors the
 * "render-only is safe under jsdom" precedent documented in
 * `mark-paid-offline-dialog.test.tsx` (a click-to-open + fill + confirm flow
 * on a Base UI Dialog/AlertDialog under jsdom + React 19 deadlocks; a
 * static/typed-into render does not). `selectPreviewableBatch` (Decision 3
 * — bulk mark-paid acts ONLY on previewable cycles) is additionally pinned
 * as a pure-function test with NO rendering at all, so that guarantee never
 * depends on Base UI interaction being safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  BulkMarkPaidConfirmDialog,
  selectPreviewableBatch,
} from '@/app/(staff)/admin/renewals/_components/bulk-mark-paid-confirm-dialog';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

function settlementPreviewResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('selectPreviewableBatch (Decision 3 — pure, no rendering)', () => {
  it('keeps only previewable rows, dropping their money fields down to {cycleId, companyName}', () => {
    const batch = selectPreviewableBatch([
      {
        cycleId: 'c1',
        companyName: 'Acme',
        amountThbMinor: 5000,
        currency: 'THB',
        previewable: true,
      },
      {
        cycleId: 'c2',
        companyName: 'Beta',
        amountThbMinor: null,
        currency: null,
        previewable: false,
      },
    ]);
    expect(batch).toEqual([{ cycleId: 'c1', companyName: 'Acme' }]);
  });

  it('returns an empty batch when nothing is previewable', () => {
    expect(
      selectPreviewableBatch([
        { cycleId: 'c1', companyName: 'Acme', amountThbMinor: null, currency: null, previewable: false },
      ]),
    ).toEqual([]);
  });
});

describe('BulkMarkPaidConfirmDialog — settlement preview rendering', () => {
  it('fetches the preview and renders the THB grand total for previewable rows + the not-bulk-payable note for the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(String(url)).toContain('/api/admin/renewals/settlement-preview?cycle_ids=c1,c2');
        return settlementPreviewResponse({
          items: [
            {
              cycle_id: 'c1',
              company_name: 'Acme',
              invoice_id: 'inv1',
              amount_thb_minor: 107000,
              currency: 'THB',
              previewable: true,
            },
            {
              cycle_id: 'c2',
              company_name: 'Beta',
              invoice_id: null,
              amount_thb_minor: null,
              currency: null,
              previewable: false,
            },
          ],
          total_thb_minor: 107000,
        });
      }),
    );

    render(
      wrap(
        <BulkMarkPaidConfirmDialog
          open
          onOpenChange={vi.fn()}
          cycleIds={['c1', 'c2']}
          onConfirm={vi.fn(async () => {})}
        />,
      ),
    );

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    // Appears twice: the single previewable row's own amount AND the grand
    // total happen to be the same figure in this fixture (one row).
    expect(screen.getAllByText('฿1,070.00')).toHaveLength(2);
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText(en.admin.renewals.bulk.previewRowUnpriced)).toBeInTheDocument();
  });

  it('shows previewError when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => settlementPreviewResponse(null, 500)));

    render(
      wrap(
        <BulkMarkPaidConfirmDialog
          open
          onOpenChange={vi.fn()}
          cycleIds={['c1']}
          onConfirm={vi.fn(async () => {})}
        />,
      ),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      en.admin.renewals.bulk.previewError,
    );
  });

  it('keeps the confirm button disabled while the shared payment reference/date are empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        settlementPreviewResponse({
          items: [
            {
              cycle_id: 'c1',
              company_name: 'Acme',
              invoice_id: 'inv1',
              amount_thb_minor: 5000,
              currency: 'THB',
              previewable: true,
            },
          ],
          total_thb_minor: 5000,
        }),
      ),
    );

    render(
      wrap(
        <BulkMarkPaidConfirmDialog
          open
          onOpenChange={vi.fn()}
          cycleIds={['c1']}
          onConfirm={vi.fn(async () => {})}
        />,
      ),
    );

    await screen.findByText('Acme');
    const confirmButton = screen.getByRole('button', {
      name: en.admin.renewals.bulk.confirmMarkPaidAction,
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText(en.admin.renewals.bulk.paymentReferenceLabel),
      { target: { value: 'REF-123' } },
    );
    // Reference alone is not enough — date is still empty.
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(en.admin.renewals.bulk.paymentDateLabel), {
      target: { value: '2026-07-29' },
    });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
  });

  it('stays disabled when nothing in the selection is previewable, even with fields filled in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        settlementPreviewResponse({
          items: [
            {
              cycle_id: 'c1',
              company_name: 'Acme',
              invoice_id: null,
              amount_thb_minor: null,
              currency: null,
              previewable: false,
            },
          ],
          total_thb_minor: 0,
        }),
      ),
    );

    render(
      wrap(
        <BulkMarkPaidConfirmDialog
          open
          onOpenChange={vi.fn()}
          cycleIds={['c1']}
          onConfirm={vi.fn(async () => {})}
        />,
      ),
    );

    await screen.findByText('Acme');
    fireEvent.change(
      screen.getByLabelText(en.admin.renewals.bulk.paymentReferenceLabel),
      { target: { value: 'REF-123' } },
    );
    fireEvent.change(screen.getByLabelText(en.admin.renewals.bulk.paymentDateLabel), {
      target: { value: '2026-07-29' },
    });
    expect(
      screen.getByRole('button', { name: en.admin.renewals.bulk.confirmMarkPaidAction }),
    ).toBeDisabled();
  });
});
