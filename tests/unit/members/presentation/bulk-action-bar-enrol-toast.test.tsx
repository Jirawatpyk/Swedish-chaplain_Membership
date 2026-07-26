/**
 * BulkActionBar — the enrol_auto_invoice confirmation toast.
 *
 * Pairs with `tests/contract/members/bulk-enrol-auto-invoice.test.ts`, which
 * pins the wire shape (`skipped_erased`) on the route side. This suite pins
 * what the admin is actually TOLD, above the use-case boundary.
 *
 * Why the erased bucket needs its own coverage: the client defaults
 * `skipped_erased: 0` before spreading the response body (so an ICU
 * FORMATTING_ERROR can't eat the whole toast), which means a dropped field
 * degrades QUIETLY — the admin is simply never told that a compliance skip
 * happened, with no error anywhere. Only an assertion on the rendered copy
 * catches that.
 *
 * Rendered against real en.json with a mocked fetch. The Base UI dialogs are
 * replaced with lightweight stand-ins so the test drives `executeBulk()`
 * without jsdom Base UI transition flakiness — same approach as the sibling
 * bulk-action-bar suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const toastSuccess = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

vi.mock('@/app/(staff)/admin/members/_components/archive-confirm-dialog', () => ({
  ArchiveConfirmDialog: () => null,
}));
vi.mock('@/app/(staff)/admin/members/_components/bulk-progress-indicator', () => ({
  BulkProgressIndicator: () => null,
}));
// Three ConfirmationDialogs share this component (invite / enrol / unenrol);
// key the stand-in off `confirmLabel` so the test can fire the ENROL one only.
vi.mock('@/components/shell/confirmation-dialog', () => ({
  ConfirmationDialog: ({
    confirmLabel,
    onConfirm,
  }: {
    confirmLabel: string;
    onConfirm: () => void;
  }) => (
    <button
      type="button"
      data-testid={`confirm-${confirmLabel}`}
      onClick={() => onConfirm()}
    >
      {confirmLabel}
    </button>
  ),
}));

import { BulkActionBar } from '@/app/(staff)/admin/members/_components/bulk-action-bar';

const ENROL_CONFIRM_LABEL =
  enMessages.admin.members.bulk.confirmEnrolAction as unknown as string;

beforeEach(() => {
  // The shared setup installs fake timers; `waitFor` would otherwise spin to a
  // 30s test timeout that looks like a hung render.
  vi.useRealTimers();
  toastSuccess.mockClear();
  toastInfo.mockClear();
  toastError.mockClear();
});

function renderBarAndEnrol(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);

  const { getByTestId } = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BulkActionBar
        selectedIds={['11111111-2222-3333-4444-555555555555']}
        selectedCompanyNames={['Acme Co']}
        totalMatching={1}
        onClear={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
  fireEvent.click(getByTestId(`confirm-${ENROL_CONFIRM_LABEL}`));
}

describe('BulkActionBar — enrol_auto_invoice toast', () => {
  it('reports a non-zero erased skip bucket to the admin', async () => {
    renderBarAndEnrol({
      enrolled: 1,
      skipped_already: 0,
      skipped_terminated: 0,
      skipped_erased: 2,
    });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const message = toastSuccess.mock.calls[0]?.[0] as string;
    expect(message).toContain('1 member enrolled');
    // The compliance skip must be VISIBLE — this is the assertion that fails
    // if `skipped_erased` stops arriving and the client defaults it to 0.
    expect(message).toContain('2 skipped (personal data erased)');
  });

  it('reports erased separately from terminated, never folded together', async () => {
    // Folding the two would tell the admin to retry later on a member for whom
    // that is not a legal option — an erased member can never be enrolled,
    // whereas a terminated one can after renewing.
    renderBarAndEnrol({
      enrolled: 0,
      skipped_already: 0,
      skipped_terminated: 3,
      skipped_erased: 1,
    });

    // Zero writes gets a neutral info toast, not a green tick.
    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    const message = toastInfo.mock.calls[0]?.[0] as string;
    expect(message).toContain('3 skipped (membership ended)');
    expect(message).toContain('1 skipped (personal data erased)');
  });

  it('omits the erased clause entirely when the bucket is zero', async () => {
    renderBarAndEnrol({
      enrolled: 2,
      skipped_already: 1,
      skipped_terminated: 0,
      skipped_erased: 0,
    });

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const message = toastSuccess.mock.calls[0]?.[0] as string;
    expect(message).toContain('2 members enrolled');
    expect(message).toContain('1 already enrolled');
    expect(message).not.toContain('erased');
  });
});
