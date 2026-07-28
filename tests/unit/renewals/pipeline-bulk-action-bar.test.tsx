/**
 * 059-membership-suspension Task 11 — `PipelineBulkActionBar`.
 *
 * `ConfirmationDialog` (reminder confirm) and `BulkMarkPaidConfirmDialog`
 * (mark-paid confirm) are BOTH mocked out as simple stand-in trigger
 * buttons — same established convention as
 * `bulk-action-bar-enrol-toast.test.tsx` ("so the test drives
 * `executeBulk()` without jsdom Base UI transition flakiness"). This
 * exercises the REAL fan-out + outcome-bucketing + toast + results-panel
 * logic (the actual point of this task) against a mocked `fetch`, without
 * ever clicking through a live Base UI Dialog/AlertDialog.
 *
 * `BulkMarkPaidConfirmDialog`'s OWN settlement-preview fetch + previewable
 * filtering (Decision 3) is covered separately, and safely, by
 * `bulk-mark-paid-confirm-dialog.test.tsx` (render-only + a pure-function
 * suite) — this file's stand-in supplies a FIXED batch directly, standing
 * in for "the dialog already fetched the preview and the admin confirmed".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineBulkActionBar } from '@/app/(staff)/admin/renewals/_components/pipeline-bulk-action-bar';

const B = en.admin.renewals.bulk;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

// Reminder confirm — stand-in mirrors bulk-action-bar-enrol-toast.test.tsx's
// approach: key off `confirmLabel` so the test can fire it directly.
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: ({
    open,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    confirmLabel: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onConfirm()}>
        {confirmLabel}
      </button>
    ) : null,
}));

// Mark-paid confirm — the stand-in supplies a FIXED batch (standing in for
// "the real dialog already fetched settlement-preview and filtered to
// previewable rows"); each test controls the batch via a module-level ref
// so different tests can exercise different previewable subsets.
let markPaidBatchOverride: Array<{ cycleId: string; companyName: string }> = [];
vi.mock('@/app/(staff)/admin/renewals/_components/bulk-mark-paid-confirm-dialog', () => ({
  BulkMarkPaidConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (
      batch: Array<{ cycleId: string; companyName: string }>,
      body: { payment_method: string; payment_reference: string; payment_date: string },
    ) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onConfirm(markPaidBatchOverride, {
            payment_method: 'bank_transfer',
            payment_reference: 'REF-1',
            payment_date: '2026-07-29',
          })
        }
      >
        {en.admin.renewals.bulk.confirmMarkPaidAction}
      </button>
    ) : null,
}));

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.useRealTimers();
  toastSuccess.mockClear();
  toastError.mockClear();
  toastInfo.mockClear();
  markPaidBatchOverride = [];
});

describe('PipelineBulkActionBar — send reminder fan-out', () => {
  it('POSTs send-reminder-now once per selected cycle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ outcome: { kind: 'sent' } })));

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1', 'c2']}
          selectedCompanyNames={['Acme', 'Beta']}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));

    await waitFor(() => {
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) =>
        String(u).includes('send-reminder-now'),
      );
      expect(calls).toHaveLength(2);
    });
  });

  it('buckets a 200 with outcome.kind=failed_transient as FAILED, not ok (the 200-trap)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ outcome: { kind: 'failed_transient' } })),
    );
    const onClear = vi.fn();

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1']}
          selectedCompanyNames={['Acme']}
          totalMatching={1}
          onClear={onClear}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    const message = toastError.mock.calls[0]?.[0] as string;
    expect(message).toContain('1 failed');
  });

  it('a 429 mid-batch lands in the rate-limited bucket, is never retried, and the affected company stays visible', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('/c2/')) {
          return jsonResponse({ error: { code: 'rate_limited' } }, 429);
        }
        return jsonResponse({ outcome: { kind: 'sent' } });
      }),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1', 'c2', 'c3']}
          selectedCompanyNames={['Acme', 'Beta', 'Gamma']}
          totalMatching={3}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));

    await waitFor(() => {
      expect(calls.filter((u) => u.includes('send-reminder-now'))).toHaveLength(3);
    });
    // No retry — exactly one POST per cycle, never more.
    expect(calls).toHaveLength(3);

    // The rate-limited row's company name is kept visible in the persisted
    // results panel, under its own bucket — a bare count is not enough.
    expect(await screen.findByText(B.resultLabels.rateLimited)).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});

describe('PipelineBulkActionBar — mark paid outcome bucketing (Decision 5)', () => {
  it('buckets f4_orphan_invoice separately from a benign cycle_not_payable, keeping BOTH company names visible', async () => {
    markPaidBatchOverride = [
      { cycleId: 'c1', companyName: 'Acme' },
      { cycleId: 'c2', companyName: 'Beta' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/c1/mark-paid-offline')) {
          return jsonResponse(
            { error: { code: 'f4_orphan_invoice', orphan_invoice_id: 'inv-orphan' } },
            409,
          );
        }
        if (u.includes('/c2/mark-paid-offline')) {
          return jsonResponse({ error: { code: 'cycle_not_payable' } }, 409);
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1', 'c2']}
          selectedCompanyNames={['Acme', 'Beta']}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(screen.getByText(B.resultLabels.orphan)).toBeInTheDocument();
    });
    expect(screen.getByText(B.resultLabels.skipped)).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // Orphan is treated as needing attention — error-level toast, not a
    // green tick, even though nothing here is a hard "failed".
    expect(toastError).toHaveBeenCalled();
  });

  it('reports a fully successful mark-paid batch with a plain success toast and no persisted panel', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ outcome: 'completed', cycle_status: 'completed' })),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1']}
          selectedCompanyNames={['Acme']}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByText(B.resultsHeadingMarkPaid)).toBeNull();
  });
});

describe('PipelineBulkActionBar — accessibility + selection wiring', () => {
  it('renders nothing when there is no selection and no prior run result', () => {
    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={[]}
          selectedCompanyNames={[]}
          totalMatching={0}
          onClear={vi.fn()}
        />,
      ),
    );
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('exposes an accessible name on the sticky toolbar', () => {
    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1']}
          selectedCompanyNames={['Acme']}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );
    expect(screen.getByRole('toolbar', { name: B.toolbarLabel })).toBeInTheDocument();
  });

  it('"Clear selection" dismisses a persisted results panel too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ outcome: { kind: 'failed_permanent' } })),
    );
    const onClear = vi.fn();

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycleIds={['c1']}
          selectedCompanyNames={['Acme']}
          totalMatching={1}
          onClear={onClear}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: B.resultsDismiss }));
    expect(screen.queryByText('Acme')).toBeNull();
  });
});
