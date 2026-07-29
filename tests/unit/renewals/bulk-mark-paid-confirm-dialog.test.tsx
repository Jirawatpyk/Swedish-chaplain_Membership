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
  selectNotBulkPayableBatch,
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
  it('keeps only previewable rows, carrying {cycleId, companyName, invoiceId} for the /pay fan-out', () => {
    const batch = selectPreviewableBatch([
      {
        cycleId: 'c1',
        companyName: 'Acme',
        invoiceId: 'inv1',
        amountThbMinor: 5000,
        currency: 'THB',
        previewable: true,
      },
      {
        cycleId: 'c2',
        companyName: 'Beta',
        invoiceId: null,
        amountThbMinor: null,
        currency: null,
        previewable: false,
      },
    ]);
    expect(batch).toEqual([{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }]);
  });

  it('returns an empty batch when nothing is previewable', () => {
    expect(
      selectPreviewableBatch([
        { cycleId: 'c1', companyName: 'Acme', invoiceId: null, amountThbMinor: null, currency: null, previewable: false },
      ]),
    ).toEqual([]);
  });

  // Review round 1 (SHOULD 3) — a row can be `previewable: true` and STILL
  // carry a null amount (the wire contract allows it even though Task 9
  // rows always populate one today). Such a row must never be bulk-payable
  // — no money-mutating action may be shown/settled without a legible figure.
  it('excludes a previewable row with no legible amount (defensive money-safety line)', () => {
    const batch = selectPreviewableBatch([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 5000, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2', amountThbMinor: null, currency: null, previewable: true },
    ]);
    expect(batch).toEqual([{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }]);
  });

  // C1 fix — the /pay fan-out keys on `invoiceId`; a row with no invoice id
  // could not be settled at all, so it must never enter the batch (defensive:
  // a previewable row always has one today, since previewable ⇔ issued invoice).
  it('excludes a previewable, priced row that somehow carries no invoiceId', () => {
    const batch = selectPreviewableBatch([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 5000, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: null, amountThbMinor: 6000, currency: 'THB', previewable: true },
    ]);
    expect(batch).toEqual([{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }]);
  });

  // Code-review fix — a previewable, priced, invoiced row that is NOT THB
  // must never be bulk-settled: the server's own `totalThbMinor` gate
  // (`load-settlement-preview.ts`) excludes non-THB rows from the total, so
  // including one here would let the confirmed grand total understate the
  // money actually settled. It falls to `selectNotBulkPayableBatch` instead.
  it('excludes a previewable, priced, invoiced row that is not THB', () => {
    const batch = selectPreviewableBatch([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 5000, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2', amountThbMinor: 3000, currency: 'USD', previewable: true },
    ]);
    expect(batch).toEqual([{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }]);
  });
});

describe('selectNotBulkPayableBatch (review round 1 SHOULD 4 — pure, no rendering)', () => {
  it('captures both non-previewable rows AND previewable rows with no legible amount', () => {
    const batch = selectNotBulkPayableBatch([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 5000, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: null, amountThbMinor: null, currency: null, previewable: false },
      { cycleId: 'c3', companyName: 'Gamma', invoiceId: 'inv3', amountThbMinor: null, currency: null, previewable: true },
    ]);
    expect(batch).toEqual([
      { cycleId: 'c2', companyName: 'Beta' },
      { cycleId: 'c3', companyName: 'Gamma' },
    ]);
  });

  // Code-review fix — the complement side of the new currency gate: a
  // previewable, priced, invoiced but non-THB row is excluded from the batch
  // (see the sibling test in the `selectPreviewableBatch` block above) and
  // must show up here instead.
  it('captures a previewable, priced, invoiced row that is not THB', () => {
    const batch = selectNotBulkPayableBatch([
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 5000, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2', amountThbMinor: 3000, currency: 'USD', previewable: true },
    ]);
    expect(batch).toEqual([{ cycleId: 'c2', companyName: 'Beta' }]);
  });

  it('is the exact complement of selectPreviewableBatch over the same input', () => {
    const items = [
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1', amountThbMinor: 5000, currency: 'THB', previewable: true },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: null, amountThbMinor: null, currency: null, previewable: false },
    ];
    const payable = selectPreviewableBatch(items);
    const notPayable = selectNotBulkPayableBatch(items);
    expect(payable.length + notPayable.length).toBe(items.length);
    expect(new Set([...payable, ...notPayable].map((i) => i.cycleId))).toEqual(
      new Set(items.map((i) => i.cycleId)),
    );
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

  // Review round 1 (SHOULD 3) — a previewable row with a null amount must
  // render on the SAME side of the line as the batch it feeds: the
  // not-bulk-payable list, never the priced list with an em-dash stand-in.
  it('treats a previewable row with no legible amount as not-bulk-payable in the rendered lists too', async () => {
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
            {
              cycle_id: 'c2',
              company_name: 'Beta',
              invoice_id: 'inv2',
              amount_thb_minor: null,
              currency: null,
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
          cycleIds={['c1', 'c2']}
          onConfirm={vi.fn(async () => {})}
        />,
      ),
    );

    await screen.findByText('Acme');
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText(en.admin.renewals.bulk.previewRowUnpriced)).toBeInTheDocument();
  });

  // Code-review fix (#1) — a non-THB previewable row must be excluded from
  // the priced list/batch, AND the grand total must be the CLIENT-SIDE sum
  // of the rows actually shown/settled, never the server-supplied
  // `total_thb_minor` (deliberately set to a bogus value here to prove the
  // dialog never reads it for display).
  it('excludes a non-THB previewable row from the batch and renders the client-computed total, ignoring the server total_thb_minor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        settlementPreviewResponse({
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
              invoice_id: 'inv2',
              amount_thb_minor: 300000,
              currency: 'USD',
              previewable: true,
            },
          ],
          // Deliberately wrong — the dialog must NEVER display this figure.
          total_thb_minor: 999999,
        }),
      ),
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
    // The USD row lands under "not included in this batch", not the priced
    // list — it never contributes to the batch or the displayed total.
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText(en.admin.renewals.bulk.previewRowUnpriced)).toBeInTheDocument();
    // Grand total = the client-side sum of ONLY the THB previewable row
    // (appears twice: the row's own amount + the grand total, since there is
    // only one previewable row) — never the bogus server total.
    expect(screen.getAllByText('฿1,070.00')).toHaveLength(2);
    expect(screen.queryByText('฿9,999.99')).toBeNull();
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

/**
 * Review round 1 (SHOULD 5) — the ONE place a non-bulk-payable cycle could
 * enter the batch and mint a §86/4 is `handleConfirm` calling
 * `selectPreviewableBatch(preview.items)` → `onConfirm`. Both this file's
 * OTHER tests (render-only, never click Confirm) and
 * `pipeline-bulk-action-bar.test.tsx` (mocks this whole component out) skip
 * that wiring entirely. This is a REAL click-through — `handleConfirm` has
 * NO `useTransition`/`startTransition` (plain `useState` submitting flag,
 * per the module docstring), so unlike the AlertDialog-based confirm
 * dialogs elsewhere in this repo, a plain click here is expected to be safe
 * under jsdom + React 19.
 */
describe('BulkMarkPaidConfirmDialog — handleConfirm wiring (Decision 3, real click path)', () => {
  it('passes onConfirm ONLY the bulk-payable cycleIds, plus the shared body and the excluded rows', async () => {
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
            {
              cycle_id: 'c2',
              company_name: 'Beta',
              invoice_id: null,
              amount_thb_minor: null,
              currency: null,
              previewable: false,
            },
            {
              cycle_id: 'c3',
              company_name: 'Gamma',
              invoice_id: 'inv3',
              amount_thb_minor: null,
              currency: null,
              previewable: true,
            },
          ],
          total_thb_minor: 5000,
        }),
      ),
    );
    const onConfirm = vi.fn(
      async (
        _batch: readonly { cycleId: string; companyName: string; invoiceId: string }[],
        _body: { paymentMethod: string; paymentReference: string; paymentDate: string },
        _notBulkPayable: readonly { cycleId: string; companyName: string }[],
      ): Promise<void> => {},
    );

    render(
      wrap(
        <BulkMarkPaidConfirmDialog
          open
          onOpenChange={vi.fn()}
          cycleIds={['c1', 'c2', 'c3']}
          onConfirm={onConfirm}
        />,
      ),
    );

    await screen.findByText('Acme');
    fireEvent.change(screen.getByLabelText(en.admin.renewals.bulk.paymentReferenceLabel), {
      target: { value: 'REF-1' },
    });
    fireEvent.change(screen.getByLabelText(en.admin.renewals.bulk.paymentDateLabel), {
      target: { value: '2026-07-29' },
    });

    const confirmButton = screen.getByRole('button', {
      name: en.admin.renewals.bulk.confirmMarkPaidAction,
    });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    fireEvent.click(confirmButton);

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [batch, body, notBulkPayable] = onConfirm.mock.calls[0]!;
    // Only the previewable+priced+invoiced row reaches the batch, carrying its
    // invoiceId for the /pay fan-out. c2 (non-previewable) + c3 (previewable but
    // unpriced) are excluded.
    expect(batch).toEqual([{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }]);
    // Body maps to recordPaymentSchema (camelCase) — the shape /pay expects.
    expect(body).toEqual({
      paymentMethod: 'bank_transfer',
      paymentReference: 'REF-1',
      paymentDate: '2026-07-29',
    });
    expect(notBulkPayable).toEqual([
      { cycleId: 'c2', companyName: 'Beta' },
      { cycleId: 'c3', companyName: 'Gamma' },
    ]);
  });
});
