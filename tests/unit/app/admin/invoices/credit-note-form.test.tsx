/**
 * Component tests for `CreditNoteForm` — F-2 (2026-07-08) membership-effect
 * intent capture (Task 13, renewal-rolling-anchor design).
 *
 * Covers:
 *  - The membership-effect fieldset renders ONLY for a `'membership'`
 *    invoice whose entered amount fully credits it (event invoices and
 *    partial credits never show it).
 *  - Default selection is 'keep'; the group is marked `required`
 *    (aria-required) even though a default is always pre-selected.
 *  - The POST body includes `membershipEffect` ONLY when the fieldset is
 *    shown — omitted entirely for a partial credit / event invoice, even
 *    though internal state still defaults to 'keep'.
 *  - Selecting "cancel_membership" (via its label — Base UI Radio gotcha:
 *    the radio toggles via a click on its associated <label> text) changes
 *    what is submitted.
 *  - A `membership_cancellation_failed: true` response field surfaces as a
 *    toast description alongside the success toast.
 *
 * Base UI Radio gotcha (same as invoice-create-switcher.test /
 * event-fee-form.test): the radio toggles via a click on its associated
 * <label> text, not on the role=radio element itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const { pushMock, toastSuccess } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import { CreditNoteForm } from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form';
import enMessages from '@/i18n/messages/en.json';

const cnMessages = enMessages.admin.creditNotes.new;

/** 1,070.00 THB remaining (107,000 satang) — matches the FULL-credit fixture. */
const REMAINING_SATANG = '107000';

function renderForm(overrides: Partial<{ invoiceSubject: 'membership' | 'event' }> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreditNoteForm
        invoiceId="inv-1"
        documentNumber="SC-2026-000001"
        remainingSatang={REMAINING_SATANG}
        currencySymbol="THB"
        invoiceSubject={overrides.invoiceSubject ?? 'membership'}
      />
    </NextIntlClientProvider>,
  );
}

function fillAmount(value: string) {
  fireEvent.change(screen.getByLabelText(cnMessages.amountLabel), {
    target: { value },
  });
}

function fillFullFormFields() {
  fillAmount('1070.00'); // 107,000 satang === REMAINING_SATANG → full credit
  fireEvent.change(screen.getByLabelText(cnMessages.reasonLabel), {
    target: { value: 'membership refund' },
  });
  fireEvent.change(
    screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!)),
    { target: { value: cnMessages.confirmPhrase } },
  );
}

function fillPartialFormFields() {
  fillAmount('500.00'); // 50,000 satang < 107,000 remaining → partial credit
  fireEvent.change(screen.getByLabelText(cnMessages.reasonLabel), {
    target: { value: 'partial refund' },
  });
  fireEvent.change(
    screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!)),
    { target: { value: cnMessages.confirmPhrase } },
  );
}

function mockFetchOk(body: Record<string, unknown> = {}) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 201 }),
  );
}

describe('<CreditNoteForm> — F-2 membership-effect fieldset visibility', () => {
  beforeEach(() => {
    pushMock.mockClear();
    toastSuccess.mockClear();
  });

  it('does NOT render the fieldset for an EVENT invoice, even on a full-credit amount', () => {
    renderForm({ invoiceSubject: 'event' });
    fillAmount('1070.00'); // full credit
    expect(screen.queryByTestId('cn-membership-effect-fieldset')).toBeNull();
  });

  it('does NOT render the fieldset for a MEMBERSHIP invoice on a PARTIAL-credit amount', () => {
    renderForm({ invoiceSubject: 'membership' });
    fillAmount('500.00'); // partial
    expect(screen.queryByTestId('cn-membership-effect-fieldset')).toBeNull();
  });

  it('renders the fieldset for a MEMBERSHIP invoice on a FULL-credit amount, default-checked "keep"', () => {
    renderForm({ invoiceSubject: 'membership' });
    fillAmount('1070.00'); // full credit
    expect(screen.getByTestId('cn-membership-effect-fieldset')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: new RegExp(cnMessages.membershipEffect.keep.label) }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', {
        name: new RegExp(cnMessages.membershipEffect.cancelMembership.label),
      }),
    ).not.toBeChecked();
  });

  it('the fieldset has an accessible legend naming the group (WCAG) and both options rendered', () => {
    renderForm({ invoiceSubject: 'membership' });
    fillAmount('1070.00');
    // F-2 review finding — `required`/`aria-required` is deliberately NOT set
    // (Base UI's unnamed hidden radio inputs would block native form submit
    // on the unchecked sibling); the fieldset+legend pairing alone satisfies
    // WCAG grouping semantics, and a valid selection ('keep') always exists.
    expect(
      screen.getByRole('group', { name: cnMessages.membershipEffect.legend }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: new RegExp(cnMessages.membershipEffect.keep.label) }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', {
        name: new RegExp(cnMessages.membershipEffect.cancelMembership.label),
      }),
    ).toBeInTheDocument();
  });

  it('the fieldset disappears again if the amount is edited down to a partial credit', () => {
    renderForm({ invoiceSubject: 'membership' });
    fillAmount('1070.00');
    expect(screen.getByTestId('cn-membership-effect-fieldset')).toBeInTheDocument();
    fillAmount('500.00');
    expect(screen.queryByTestId('cn-membership-effect-fieldset')).toBeNull();
  });
});

describe('<CreditNoteForm> — F-2 submit body wiring', () => {
  // `useTransition` + `fetch` require real timers (same gotcha as
  // event-fee-form.test.tsx) — the global setup enables fake timers by
  // default, which stalls the async `startTransition` callback forever.
  beforeEach(() => {
    vi.useRealTimers();
    pushMock.mockClear();
    toastSuccess.mockClear();
  });
  afterEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  it('a PARTIAL credit never sends membershipEffect, even though internal state defaults to "keep"', async () => {
    const fetchMock = mockFetchOk({ document_number: 'CN-2026-000001' });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ invoiceSubject: 'membership' });
    fillPartialFormFields();

    fireEvent.click(screen.getByRole('button', { name: cnMessages.submit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.membershipEffect).toBeUndefined();
  });

  it('a FULL membership credit sends membershipEffect="keep" by default (no radio interaction)', async () => {
    const fetchMock = mockFetchOk({ document_number: 'CN-2026-000002' });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ invoiceSubject: 'membership' });
    fillFullFormFields();

    fireEvent.click(screen.getByRole('button', { name: cnMessages.submit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.membershipEffect).toBe('keep');
  });

  it('selecting "cancel_membership" (via its label) sends membershipEffect="cancel_membership"', async () => {
    const fetchMock = mockFetchOk({ document_number: 'CN-2026-000003' });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ invoiceSubject: 'membership' });
    fillFullFormFields();

    // Base UI Radio gotcha — click the label text, not the role=radio node.
    fireEvent.click(screen.getByText(cnMessages.membershipEffect.cancelMembership.label));
    await waitFor(() =>
      expect(
        screen.getByRole('radio', {
          name: new RegExp(cnMessages.membershipEffect.cancelMembership.label),
        }),
      ).toBeChecked(),
    );

    fireEvent.click(screen.getByRole('button', { name: cnMessages.submit }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(sentBody.membershipEffect).toBe('cancel_membership');
  });

  it('a membership_cancellation_failed:true response shows a toast description prompting a manual renewals retry', async () => {
    const fetchMock = mockFetchOk({
      document_number: 'CN-2026-000004',
      membership_cancellation_failed: true,
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ invoiceSubject: 'membership' });
    fillFullFormFields();

    fireEvent.click(screen.getByRole('button', { name: cnMessages.submit }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));

    const [, opts] = toastSuccess.mock.calls[0]!;
    expect((opts as { description?: string }).description).toContain(
      cnMessages.membershipCancellationFailedNotice,
    );
  });

  it('a normal success (no cascade warning) shows a toast with no description', async () => {
    const fetchMock = mockFetchOk({ document_number: 'CN-2026-000005' });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ invoiceSubject: 'membership' });
    fillFullFormFields();

    fireEvent.click(screen.getByRole('button', { name: cnMessages.submit }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));

    expect(toastSuccess.mock.calls[0]!.length).toBe(1);
  });
});
