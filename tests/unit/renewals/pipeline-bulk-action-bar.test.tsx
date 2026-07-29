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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// `notBulkPayableOverride` stands in for the dialog's OWN excluded-rows
// list (review round 1, SHOULD 4) — defaults to empty so existing tests
// are unaffected.
let markPaidBatchOverride: Array<{ cycleId: string; companyName: string; invoiceId: string }> = [];
let notBulkPayableOverride: Array<{ cycleId: string; companyName: string }> = [];
vi.mock('@/app/(staff)/admin/renewals/_components/bulk-mark-paid-confirm-dialog', () => ({
  BulkMarkPaidConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (
      batch: Array<{ cycleId: string; companyName: string; invoiceId: string }>,
      body: { paymentMethod: string; paymentReference: string; paymentDate: string },
      notBulkPayable: Array<{ cycleId: string; companyName: string }>,
    ) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onConfirm(
            markPaidBatchOverride,
            {
              paymentMethod: 'bank_transfer',
              paymentReference: 'REF-1',
              paymentDate: '2026-07-29',
            },
            notBulkPayableOverride,
          )
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
  notBulkPayableOverride = [];
});

describe('PipelineBulkActionBar — send reminder fan-out', () => {
  it('POSTs send-reminder-now once per selected cycle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ outcome: { kind: 'sent' } })));

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
          ]}
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
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
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
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
            { cycleId: 'c3', companyName: 'Gamma' },
          ]}
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

  // speckit-review #3 — pin the send-reminder classifier's two `skipped`
  // branches, which were un-pinned (asymmetric with the exhaustively-covered
  // mark-paid classifier): (1) a `200` whose body `outcome.kind === 'skipped'`
  // (the 200-trap's benign side), and (2) a bare `409 already_sent` (idempotent
  // replay). Each must land under `resultLabels.skipped` with NO error toast.
  it('buckets a 200 with outcome.kind=skipped as skipped, with no error toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ outcome: { kind: 'skipped' } })));

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));

    expect(await screen.findByText(B.resultLabels.skipped)).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('buckets a bare 409 already_sent as skipped (idempotent replay), with no error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'already_sent' } }, 409)),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));

    expect(await screen.findByText(B.resultLabels.skipped)).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('PipelineBulkActionBar — mark paid outcome bucketing (Decision 5)', () => {
  // C1 fix — the fan-out now POSTs the F4 record-payment route keyed on each
  // row's invoiceId, NOT the mint-and-pay `…/[cycleId]/mark-paid-offline`.
  it('POSTs /api/invoices/[invoiceId]/pay once per previewable row (not mark-paid-offline)', async () => {
    markPaidBatchOverride = [
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2' },
    ];
    const calls: string[] = [];
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(String(url));
        inits.push(init);
        return jsonResponse({ status: 'paid' });
      }),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
          ]}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/pay'))).toHaveLength(2);
    });
    expect(calls).toContain('/api/invoices/inv1/pay');
    expect(calls).toContain('/api/invoices/inv2/pay');
    // Never the old mint-and-pay route.
    expect(calls.some((u) => u.includes('mark-paid-offline'))).toBe(false);

    // Guards against a silent GET/casing/dropped-header regression that
    // would only surface as a prod 400 — every fanned-out request must be a
    // POST, carry the JSON content-type header, and serialise exactly the
    // shared payment body the confirm dialog handed to `onConfirm` (Decision
    // 4 — one payment_method/reference/date applies to the whole batch).
    for (const init of inits) {
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(init.body))).toStrictEqual({
        paymentMethod: 'bank_transfer',
        paymentReference: 'REF-1',
        paymentDate: '2026-07-29',
      });
    }
  });

  // 409 splits by code: invalid_status / concurrent_state_change are benign
  // "the invoice already moved on" skips (no action lost), while
  // membership_terminated is a needs-a-human bucket (payment still owed). Both
  // stay visible under their own bucket — a bare count is not enough on money.
  it('buckets a membership_terminated 409 as needs-action and an invalid_status 409 as skipped, keeping BOTH visible', async () => {
    markPaidBatchOverride = [
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('/inv1/pay')) {
          return jsonResponse({ error: { code: 'membership_terminated' } }, 409);
        }
        if (u.includes('/inv2/pay')) {
          return jsonResponse({ error: { code: 'invalid_status' } }, 409);
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
          ]}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(screen.getByText(B.resultLabels.needsAction)).toBeInTheDocument();
    });
    expect(screen.getByText(B.resultLabels.skipped)).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // needs-action is treated as needing attention — error-level toast.
    expect(toastError).toHaveBeenCalled();
  });

  // membership_terminated + the config/legacy codes are all 409s with no money
  // moved, but they are NOT "nothing to do": the same real bank transfer still
  // needs recording once a human reactivates / restores a flag / re-issues.
  // They must land in their OWN `needsAction` bucket, never folded into the
  // benign `skipped` bucket.
  it.each(['membership_terminated', 'settings_missing'])(
    'buckets a %s 409 as needs-action, not skipped',
    async (code) => {
      markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code } }, 409)));

      render(
        wrap(
          <PipelineBulkActionBar
            selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
            totalMatching={1}
            onClear={vi.fn()}
          />,
        ),
      );

      fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
      fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

      await waitFor(() => {
        expect(screen.getByText(B.resultLabels.needsAction)).toBeInTheDocument();
      });
      expect(screen.queryByText(B.resultLabels.skipped)).toBeNull();
      expect(screen.getByText('Acme')).toBeInTheDocument();
      expect(toastError).toHaveBeenCalled();
    },
  );

  // Review round 2 (L1) — the bulk confirm dialog collects ONE payment_date
  // for the WHOLE batch, but each invoice has its own issue date. A date
  // that predates one invoice's issue date fails ONLY that invoice's §87
  // server-side guard in recordPayment with `payment_date_out_of_range`,
  // which the /pay route has no explicit status-map case for — it falls
  // through to the route's generic 422. This is NOT a hard failure: the
  // payment is still owed, the admin just needs to pick a valid date and
  // retry, so it must land in needsAction, not failed.
  it('buckets a 422 payment_date_out_of_range as needs-action, not failed', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'payment_date_out_of_range',
              min: '2026-06-01',
              max: '2026-07-29',
            },
          },
          422,
        ),
      ),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(screen.getByText(B.resultLabels.needsAction)).toBeInTheDocument();
    });
    expect(screen.queryByText(B.resultLabels.failed)).toBeNull();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalled();
  });

  // The sibling of the above: every OTHER 422 code is a real data/
  // allocation error (not a bad date pick) and must stay FAILED — locks
  // the classifier's `code === 'payment_date_out_of_range'` narrowing so a
  // future refactor can't widen the whole 422 status back into needsAction.
  it('buckets a 422 no_snapshot_on_invoice as failed, not needs-action', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'no_snapshot_on_invoice' } }, 422)),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(screen.getByText(B.resultLabels.failed)).toBeInTheDocument();
    });
    expect(screen.queryByText(B.resultLabels.needsAction)).toBeNull();
  });

  // 429: record-payment rate-limits 20 pays / 5 min per (tenant, actor); a
  // large bulk hits it mid-batch. It lands in its own bucket, is never
  // retried (exactly one POST per row), and the affected row stays visible.
  it('buckets a 429 mid-batch as rate-limited, never retries it, and keeps the row visible', async () => {
    markPaidBatchOverride = [
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2' },
    ];
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/inv2/pay')) {
          return jsonResponse({ error: { code: 'rate_limited' } }, 429);
        }
        return jsonResponse({ status: 'paid' });
      }),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
          ]}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(screen.getByText(B.resultLabels.rateLimited)).toBeInTheDocument();
    });
    // No retry — exactly one POST per row.
    expect(calls.filter((u) => u.includes('/pay'))).toHaveLength(2);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  // Companion to the bad-STATUS (429) continue-on-error test above: this
  // pins the THROW path specifically (a rejected `fetch` — network drop,
  // AbortController, a bug upstream of `classify`), which the outer
  // `runFanOut` catch handles separately from a resolved-but-bad-status
  // response. One row throwing must not stop its siblings, must still land
  // in `failed` (visible, not silently dropped), and must now be logged
  // (the K1-E5-style forensic `console.error` this branch restores) instead
  // of the previous bare `catch {}`.
  it('a client-side fetch throw for one row lands in failed, logs it, and every sibling still POSTs', async () => {
    markPaidBatchOverride = [
      { cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' },
      { cycleId: 'c2', companyName: 'Beta', invoiceId: 'inv2' },
    ];
    const calls: string[] = [];
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/inv1/pay')) {
          throw new TypeError('network drop');
        }
        return jsonResponse({ status: 'paid' });
      }),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
          ]}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => {
      expect(screen.getByText(B.resultLabels.failed)).toBeInTheDocument();
    });
    // Continue-on-error (Decision 5) — the sibling row still fanned out
    // despite the thrown row, and there was no retry of the thrown one.
    expect(calls.filter((u) => u.includes('/pay'))).toHaveLength(2);
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[F8] bulk mark-paid: client handler failed',
      expect.any(TypeError),
    );

    consoleErrorSpy.mockRestore();
  });

  it('reports a fully successful mark-paid batch (200, incl. idempotent already-paid) with a plain success toast and no persisted panel', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
    // A 200 (fresh pay OR idempotent already-paid replay) → ok.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'paid' })));

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
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

  // speckit-review #1 — a SETTLED (2xx) mark-paid row whose `/pay` response
  // carried `email_dispatch: 'skipped_no_email'` (the payment settled but the
  // §86/4 receipt could not be emailed — no contact email on file) still
  // counts as settled (bucket `ok`), AND the additive "receipt not emailed"
  // note is surfaced in the success toast — mirroring the single-row
  // `mark-paid-offline-dialog` / `payment-form` `successNoEmailWarning`.
  it('surfaces a "receipt not emailed" note on a 2xx with email_dispatch=skipped_no_email, still counting it as settled', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'paid', email_dispatch: 'skipped_no_email' })),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    // Still settled — a success toast, never an error.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
    const message = toastSuccess.mock.calls[0]?.[0] as string;
    // Both the settled count AND the additive no-email note are surfaced.
    expect(message).toContain('marked paid');
    expect(message).toContain('could not be emailed');
  });

  // Review round 1 (SHOULD 4) — rows `BulkMarkPaidConfirmDialog` excludes
  // from the batch (upcoming / unpriced cycles) never even fan out, so
  // nothing in `runFanOut`'s bucketing sees them. Without carrying them
  // into the persisted panel separately, `onClear()` + `router.refresh()`
  // would drop them from view and the treasurer would forget the
  // still-unbilled members.
  it('carries not-bulk-payable rows into the results panel under "settle individually", even on an otherwise clean run', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
    notBulkPayableOverride = [{ cycleId: 'c2', companyName: 'Beta' }];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'paid' })));

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[
            { cycleId: 'c1', companyName: 'Acme' },
            { cycleId: 'c2', companyName: 'Beta' },
          ]}
          totalMatching={2}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(screen.getByText(B.resultLabels.notBulkPayable)).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});

describe('PipelineBulkActionBar — accessibility + selection wiring', () => {
  it('renders nothing when there is no selection and no prior run result', () => {
    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[]}
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
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
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
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
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

  // Review round 1 (SHOULD 2) — locks the Decision-5 invariant: the results
  // panel is sourced from THIS component's own `lastRunResult` state, never
  // from the live `selectedCycles` prop. Every OTHER test in this file
  // keeps a fixed, populated selection throughout — a refactor that
  // (re-)derived the panel from the selection instead would blank the
  // do-not-retry list while every one of THOSE tests stayed green. This
  // test re-renders with the REAL post-run shape: `onClear()` + `router.
  // refresh()` emptying the parent's live selection on the next server
  // render.
  it('keeps the results panel visible after the parent empties selectedCycles post-run (Decision 5)', async () => {
    markPaidBatchOverride = [{ cycleId: 'c1', companyName: 'Acme', invoiceId: 'inv1' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'membership_terminated' } }, 409)),
    );

    const { rerender } = render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.markPaid }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmMarkPaidAction }));

    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    rerender(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[]}
          totalMatching={0}
          onClear={vi.fn()}
        />,
      ),
    );

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText(B.resultLabels.needsAction)).toBeInTheDocument();
  });
});

describe('PipelineBulkActionBar — results panel focus (a11y, review round 1 MUST-FIX)', () => {
  let main: HTMLElement;

  beforeEach(() => {
    // Deterministic double-RAF: jsdom's native `requestAnimationFrame` is
    // real (unlike `setTimeout`, it is not part of the shared fake-timer
    // config in tests/setup.ts), so without this the assertion would have
    // to wait on real animation frames. Same precedent as
    // `month-filter-chip.test.tsx`'s focus-restore fallback test.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      },
    );

    // The staff layout's `#main-content` landmark — present so the test can
    // positively assert focus did NOT land there (the pre-fix behaviour).
    main = document.createElement('main');
    main.id = 'main-content';
    main.tabIndex = -1;
    document.body.appendChild(main);
  });

  afterEach(() => {
    main.remove();
    vi.unstubAllGlobals();
  });

  it('moves focus onto the results panel (not #main-content) after a run with issues', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ outcome: { kind: 'failed_permanent' } })),
    );

    render(
      wrap(
        <PipelineBulkActionBar
          selectedCycles={[{ cycleId: 'c1', companyName: 'Acme' }]}
          totalMatching={1}
          onClear={vi.fn()}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: B.actions.sendReminder }));
    fireEvent.click(screen.getByRole('button', { name: B.confirmReminderAction }));

    const heading = await screen.findByText(B.resultsHeadingReminder);
    const panel = heading.closest('[role="region"]');
    expect(panel).not.toBeNull();

    // The regression this MUST-FIX closes: a screen-reader user must land
    // ON the panel that lists WHICH company failed, not at the top of the
    // page — the transient (~4s) toast alone is not sufficient (WCAG 2.1
    // AA SC 4.1.3).
    await waitFor(() => expect(document.activeElement).toBe(panel));
    expect(document.activeElement).not.toBe(main);
  });
});
