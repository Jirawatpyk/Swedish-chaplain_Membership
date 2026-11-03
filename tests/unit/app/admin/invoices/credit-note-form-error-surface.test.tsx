/**
 * 088 FR-032 — CreditNoteForm post-fetch `formError` surface.
 *
 * Issuing a credit note (§86/10 ใบลดหนี้) MINTS a NEW sequential §87 tax-document
 * number in-tx and moves the original invoice to credited; once committed it
 * cannot be rolled back client-side, so a credit FAILURE must render INLINE in
 * a focused role="alert" the admin cannot miss — never a transient toast.
 *
 * `credit-note-error-routing.ts` (the pure classifier) is unit-tested
 * separately; this file covers the RENDER half that nothing else exercised —
 * that the routed result actually reaches the DOM through the `InlineAlert`
 * migration:
 *   - concurrent (409 `invalid_status`) → neutral tone + "already credited/voided
 *     — refresh" copy + a working refresh button wired to `router.refresh()`;
 *   - failure (typed code)              → destructive tone + interpolated
 *     `errors.codeFallback` copy + focus moved onto the alert;
 *   - failure (no/unparseable code)     → the generic `errors.unknown` copy.
 *
 * Rendered against the REAL en.json so a missing/renamed key surfaces as
 * MISSING_MESSAGE rather than silently passing. Mirrors the harness in
 * `void-confirm-dialog.test.tsx` (next-intl provider + next/navigation mock +
 * `vi.stubGlobal('fetch', …)`). Assertions go through `data-testid` so they
 * stay primitive-agnostic across the Alert → InlineAlert migration.
 *
 * The form's submit gate is a typed-phrase confirmation ("CREDIT") on top of a
 * valid amount + reason; a PARTIAL credit is used throughout so the F-2
 * membership-effect fieldset never mounts (irrelevant to the error surface).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { CreditNoteForm } from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form';

/** An AURA field's label also holds its required asterisk, so match from the start. */
const labelled = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const cnMessages = enMessages.admin.creditNotes.new;

/** #728 review — the unknown-outcome copy names the attempt's amount. */
const UNCONFIRMED_500 =
  "We couldn't confirm whether the credit note for 500.00 THB was issued. Try again — if it was already issued, trying again issues nothing new. Or open the invoice to check.";

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock, replace: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// useTransition / async-transition interactions need real timers
// (tests/setup.ts installs fakes).
beforeEach(() => {
  vi.useRealTimers();
  window.sessionStorage.clear();
  refreshMock.mockClear();
  pushMock.mockClear();
});

const INVOICE_ID = 'inv-1';
const DOC_NUMBER = 'SC-2026-000001';
/** 1,070.00 THB remaining (107,000 satang). */
const REMAINING_SATANG = '107000';

function renderForm(
  overrides: Partial<{ remainingSatang: string; invoiceSubject: 'membership' | 'event' }> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreditNoteForm
        invoiceId={INVOICE_ID}
        documentNumber={DOC_NUMBER}
        remainingSatang={overrides.remainingSatang ?? REMAINING_SATANG}
        currencySymbol="THB"
        invoiceSubject={overrides.invoiceSubject ?? 'event'}
        paymentChannel="bank_transfer"
        onlineRefundState="none"
      />
    </NextIntlClientProvider>,
  );
}

/**
 * Drive the three submit gates: a valid PARTIAL amount, a non-empty reason, and
 * the typed confirmation phrase. Type the phrase lowercase to prove the
 * locale-case-INSENSITIVE compare stays intact alongside the error-surface work.
 */
function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(labelled(cnMessages.amountLabel)), {
    target: { value: '500.00' }, // 50,000 satang < 107,000 remaining → partial
  });
  fireEvent.change(screen.getByLabelText(labelled(cnMessages.reasonLabel)), {
    target: { value: 'duplicate charge' },
  });
  fireEvent.change(
    screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!)),
    { target: { value: cnMessages.confirmPhrase.toLowerCase() } },
  );
  const submit = screen.getByRole('button', { name: cnMessages.submit });
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
}

/** Reject `res` shape the component reads: `res.json().error.code`. */
function rejectingFetch(code: string | undefined) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: false,
    json: async () => (code ? { error: { code } } : {}),
  }));
}

describe('CreditNoteForm — concurrent 409 inline recovery (FR-032)', () => {
  it('renders the "already credited/voided — refresh" prompt and refreshes on click', async () => {
    const fetchMock = rejectingFetch('invalid_status');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      // No error surface before the POST resolves.
      expect(screen.queryByTestId('credit-note-error')).toBeNull();

      fillAndSubmit();

      const alert = await screen.findByTestId('credit-note-error');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('/api/credit-notes');
      expect(init.method).toBe('POST');
      // A stale-write 409 is NOT the admin's error → neutral, not destructive.
      expect(alert).toHaveAttribute('data-tone', 'neutral');
      expect(alert).toHaveAttribute('role', 'alert');
      // #61 — no "in another session": a retry from this same form lands here too.
      expect(alert).toHaveTextContent(
        'This invoice has already been credited or voided. Open it to see its latest status.',
      );
      expect(alert).not.toHaveTextContent(/session/i);

      // #727 review (UX M2) — the form page answers notFound() for a fully
      // credited or voided invoice, so a refresh would land on a 404; the
      // recovery opens the invoice instead.
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
      expect(pushMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Open invoice' }));
      expect(pushMock).toHaveBeenCalledWith(`/admin/invoices/${INVOICE_ID}`);
      expect(refreshMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('CreditNoteForm — failure branch is focused + destructive (FR-032)', () => {
  it('renders the interpolated codeFallback copy and moves focus onto the alert', async () => {
    const fetchMock = rejectingFetch('overflow');
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();

      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent('Error code: overflow');
      // The irreversible §87-mint failure must not be missable: the component
      // parks focus on the alert (tabIndex={-1} + focus effect).
      expect(alert).toHaveAttribute('tabindex', '-1');
      await waitFor(() => expect(alert).toHaveFocus());
      // Failure keeps the form open so the admin can retry — no navigation.
      expect(pushMock).not.toHaveBeenCalled();
      // No refresh affordance on this branch (that is concurrent-only).
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the generic unknown copy when the body carries no error code', async () => {
    // A non-JSON error page (HTML 502) → `.json()` rejects → `catch(() => ({}))`
    // → undefined code → `errors.unknown`, NOT a raw "Error code: undefined".
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();

      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(alert).toHaveTextContent(
        'An unknown error occurred. Please try again.',
      );
      expect(alert).not.toHaveTextContent(/Error code/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// #61 — the credit note commits before `requestMembershipEnd` runs, so no
// answer, a timeout or a 5xx naming no refusal may come AFTER a §86/10 note was
// minted. An admin credit note is NOT idempotent (only a refund-origin one is,
// by source_refund_id): a partial retry passes the remainder check and mints a
// SECOND note. So the copy never invites a retry and the submit stays locked
// until the page reloads.
describe('CreditNoteForm — #61 an unknown outcome locks the submit', () => {
  const UNCONFIRMED = UNCONFIRMED_500;

  function respond(status: number, body: unknown) {
    return vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: false,
      status,
      json: async () => {
        if (body === undefined) throw new Error('Unexpected token < in JSON');
        return body;
      },
    }));
  }

  it('a rejected fetch shows the warning, focused; the submit stays locked, Try again resends the same request and Open invoice opens it', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();
      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(alert).toHaveTextContent(UNCONFIRMED);
      await waitFor(() => expect(alert).toHaveFocus());
      // The alert renders before the transition settles, so the button can
      // still read "Issuing…" for a moment: wait for it.
      const submit = await screen.findByRole('button', { name: cnMessages.submit });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // #66 — the attempt carries a uuid key the server dedupes on.
      const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
      expect(first.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      // The invoice detail lists its credit notes. No Refresh here: an
      // in-place refresh would keep the form.
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
      // #66 — Try again resends the SAME request, key included, so a note that
      // was already issued comes back instead of a second one.
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
      fireEvent.click(await screen.findByRole('button', { name: 'Open invoice' }));
      expect(pushMock).toHaveBeenCalledWith(`/admin/invoices/${INVOICE_ID}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // One case per test: two full form renders in one test ran close to the
  // default findBy budget on a loaded worker (seen once in a batch run).
  it.each([
    ['a 504 HTML page', 504, undefined],
    ['a 500 internal_error', 500, { error: { code: 'internal_error' } }],
  ] as const)('%s reads as unconfirmed and locks the submit', async (_label, status, body) => {
    vi.stubGlobal('fetch', respond(status, body));
    try {
      renderForm();
      fillAndSubmit();
      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(alert).toHaveTextContent(UNCONFIRMED);
      expect(await screen.findByRole('button', { name: cnMessages.submit })).toBeDisabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a named 5xx raised inside the rolled-back tx keeps its copy and does not lock', async () => {
    vi.stubGlobal('fetch', respond(500, { error: { code: 'pdf_render_failed' } }));
    try {
      renderForm();
      fillAndSubmit();
      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'destructive');
      expect(await screen.findByRole('button', { name: cnMessages.submit })).toBeEnabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the READ_ONLY_MODE 503 says nothing was changed, inline, with no Refresh, and does not lock', async () => {
    vi.stubGlobal('fetch', respond(503, { error: 'read-only-mode' }));
    try {
      renderForm();
      fillAndSubmit();
      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(alert).toHaveTextContent(
        'The system is currently in read-only mode for maintenance. Nothing was changed. Try again in a few minutes.',
      );
      expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
      expect(await screen.findByRole('button', { name: cnMessages.submit })).toBeEnabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the POST carries a timeout signal, and a double submit in one tick sends one POST', async () => {
    // Settled at the end: React entangles async transitions, so a POST left
    // hanging would keep every later test's form `pending`.
    let settle: (v: unknown) => void = () => {};
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise((r) => { settle = r; }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { container } = renderForm();
      fillAndSubmit();
      fireEvent.submit(container.querySelector('form')!);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      settle({ ok: false, status: 409, json: async () => ({ error: { code: 'invalid_status' } }) });
      vi.unstubAllGlobals();
    }
  });
});

// #66 — the key outlives a reload (sessionStorage per invoice) until the server
// gives a definite answer. #728 review: the stored attempt is the whole
// request, so a reload restores it LOCKED (no new amount under an old key) and
// "Try again" resends exactly what the first attempt sent.
describe('CreditNoteForm — #66 the idempotency key', () => {
  const STORE_KEY = `cn-attempt:${INVOICE_ID}`;
  const LOCKED_HINT = 'Finish this credit note with “Try again” in the message above, open the invoice, or choose “Start over”.';

  function okFetch(body: Record<string, unknown>) {
    return vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 201,
      json: async () => body,
    }));
  }
  function refusal(status: number, body: unknown) {
    return { ok: false, status, json: async () => body };
  }
  const dropped = () => {
    throw new TypeError('Failed to fetch');
  };
  /**
   * Try again is `aria-disabled` while a request runs; wait it out, then click.
   */
  async function untilTryAgainReady() {
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Try again' })).not.toHaveAttribute('aria-disabled', 'true'),
    );
  }
  async function clickTryAgain() {
    await untilTryAgainReady();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  }
  function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
    return JSON.parse(String((fetchMock.mock.calls[call] as [string, RequestInit])[1].body)) as Record<string, unknown>;
  }

  it('after an unknown outcome a reload restores the attempt locked, pre-filled, and Try again resends it exactly', async () => {
    const first = vi.fn(async (_url: string, _init: RequestInit) => dropped());
    vi.stubGlobal('fetch', first);
    try {
      const view = renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      const sent = String((first.mock.calls[0] as [string, RequestInit])[1].body);
      const stored = JSON.parse(window.sessionStorage.getItem(STORE_KEY) ?? 'null') as { key: string; body: string };
      expect(stored.body).toBe(sent);
      expect(stored.key).toBe((JSON.parse(sent) as { idempotencyKey: string }).idempotencyKey);
      view.unmount();

      const ok = okFetch({ document_number: 'CN-2026-000009', replayed: true });
      vi.stubGlobal('fetch', ok);
      renderForm();
      const alert = await screen.findByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(alert).toHaveTextContent(UNCONFIRMED_500);
      expect(screen.getByLabelText(labelled(cnMessages.amountLabel))).toHaveValue(500);
      expect(screen.getByLabelText(labelled(cnMessages.reasonLabel))).toHaveValue('duplicate charge');
      expect(screen.getByLabelText(labelled(cnMessages.amountLabel))).toHaveAttribute('readonly');
      expect(screen.getByRole('button', { name: cnMessages.submit })).toBeDisabled();
      expect(screen.getByTestId('cn-locked-hint')).toHaveTextContent(LOCKED_HINT);
      await clickTryAgain();
      await waitFor(() => expect(ok).toHaveBeenCalledTimes(1));
      expect(String((ok.mock.calls[0] as [string, RequestInit])[1].body)).toBe(sent);
      await waitFor(() => expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** A stored attempt, as the form writes it before a POST. */
  function storeAttempt(request: Record<string, unknown>) {
    const key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const body = JSON.stringify({ invoiceId: INVOICE_ID, reason: 'duplicate charge', ...request, idempotencyKey: key });
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ key, body }));
    return body;
  }

  // #728 round 2 (UX M-A) — after a reload the remainder may already reflect
  // the note the attempt issued; the locked amount is not an input error.
  it('a restored attempt above the new remainder shows no exceeds-remainder error', async () => {
    storeAttempt({ creditTotalSatang: '50000' });
    renderForm({ remainingSatang: '20000' });
    await screen.findByTestId('credit-note-error');
    const amount = screen.getByLabelText(labelled(cnMessages.amountLabel));
    expect(amount).toHaveValue(500);
    expect(amount).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(/exceeds/i)).toBeNull();
  });

  // #728 round 2 (UX M-B) — the membership choice the attempt carries stays
  // visible (locked) even when the new remainder no longer reads as a full
  // credit, so nobody resends a choice they cannot see.
  it('a restored full-credit attempt shows its membership choice, locked', async () => {
    storeAttempt({ creditTotalSatang: '107000', membershipEffect: 'cancel_membership' });
    renderForm({ remainingSatang: '0', invoiceSubject: 'membership' });
    await screen.findByTestId('credit-note-error');
    const fieldset = screen.getByTestId('cn-membership-effect-fieldset');
    const radios = fieldset.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(2);
    const checked = [...radios].find((r) => (r as HTMLInputElement).checked) as HTMLInputElement | undefined;
    expect(checked?.value).toBe('cancel_membership');
    for (const r of radios) expect(r).toBeDisabled();
  });

  // /code-review (FR-040) — a restored attempt must not carry the typed phrase:
  // once it ends on a definite refusal, a NEW note still needs the admin to
  // type it.
  it('a restored attempt that ends leaves the typed confirmation empty', async () => {
    storeAttempt({ creditTotalSatang: '50000' });
    vi.stubGlobal('fetch', vi.fn(async () => refusal(409, { error: { code: 'credit_exceeds_remainder' } })));
    try {
      renderForm();
      await screen.findByTestId('credit-note-error');
      await clickTryAgain();
      await waitFor(() =>
        expect(screen.getByTestId('credit-note-error')).toHaveAttribute('data-tone', 'neutral'),
      );
      expect(screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!))).toHaveValue('');
      expect(screen.getByRole('button', { name: cnMessages.submit })).toBeDisabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('while the outcome is unknown every field is read-only and the locked note says why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dropped()));
    try {
      renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      expect(screen.getByLabelText(labelled(cnMessages.amountLabel))).toHaveAttribute('readonly');
      expect(screen.getByLabelText(labelled(cnMessages.reasonLabel))).toHaveAttribute('readonly');
      expect(screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!))).toHaveAttribute('readonly');
      expect(screen.getByTestId('cn-locked-hint')).toHaveTextContent(LOCKED_HINT);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Thai-tax H-1 / UX H2 — these refusals come before the key is looked up, so
  // they say nothing about whether the first attempt issued a note. Dropping the
  // key would let the next submit mint a second one.
  it.each([
    ['a 429 rate limit', 429, { error: { code: 'rate_limited' } }],
    ['a read-only 503', 503, { error: 'read-only-mode' }],
    ['a 401 expired session', 401, { error: { code: 'unauthorized' } }],
    ['a 409 refund_in_progress', 409, { error: { code: 'refund_in_progress' } }],
  ] as const)('after an unknown outcome, Try again refused by %s keeps the key and the lock', async (_l, status, body) => {
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit) => refusal(status, body))
      .mockImplementationOnce(async () => dropped());
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      const stored = window.sessionStorage.getItem(STORE_KEY);
      await clickTryAgain();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await untilTryAgainReady();
      expect(window.sessionStorage.getItem(STORE_KEY)).toBe(stored);
      const alert = screen.getByTestId('credit-note-error');
      expect(alert).toHaveAttribute('data-tone', 'warning');
      expect(alert).toHaveTextContent(UNCONFIRMED_500);
      // #728 round 2 (UX L-4) — this try's refusal is named as such, so
      // "Nothing was changed" is not read as "no note was issued".
      expect(alert).toHaveTextContent(/This try was refused: /);
      expect(screen.getByRole('button', { name: cnMessages.submit })).toBeDisabled();
      await clickTryAgain();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(bodyOf(fetchMock, 2)).toEqual(bodyOf(fetchMock, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('after an unknown outcome, a refusal made after the key lookup ends the attempt', async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit) => refusal(409, { error: { code: 'invalid_status' } }))
      .mockImplementationOnce(async () => dropped());
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      await clickTryAgain();
      await waitFor(() =>
        expect(screen.getByTestId('credit-note-error')).toHaveAttribute('data-tone', 'neutral'),
      );
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a retry keeps the alert on screen while it runs, and offline it waits for the connection', async () => {
    let release: (v: unknown) => void = () => {};
    const fetchMock = vi
      .fn((_url: string, _init: RequestInit) => new Promise((r) => { release = r; }))
      .mockImplementationOnce(async () => dropped());
    vi.stubGlobal('fetch', fetchMock);
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderForm();
      onLine.mockReturnValue(true);
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      onLine.mockReturnValue(false);
      await clickTryAgain();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText('Waiting for the connection…').length).toBeGreaterThan(0);
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('credit-note-error')).toBeInTheDocument();
      release(refusal(504, undefined));
    } finally {
      onLine.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('a replay says the note had already been issued and no new one was', async () => {
    const { toast } = await import('@/lib/toast');
    vi.mocked(toast.success).mockClear();
    vi.stubGlobal('fetch', okFetch({ document_number: 'CN-2026-000009', replayed: true }));
    try {
      renderForm();
      fillAndSubmit();
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
        'Credit note CN-2026-000009 had already been issued — no new credit note was issued.',
      );
      expect(pushMock).toHaveBeenCalledWith(`/admin/invoices/${INVOICE_ID}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('before any unknown outcome, a refusal ends the attempt (the next submit gets a new key)', async () => {
    const refused = rejectingFetch('invalid_status');
    vi.stubGlobal('fetch', refused);
    try {
      renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      expect(bodyOf(refused, 0).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Task 68 — "Start over" closes a locked attempt on the server. The original
// request may still commit, so the form never unlocks on its own: it asks the
// server, which either closes the key for good or hands back the note the
// attempt had already issued.
describe('CreditNoteForm — task 68 Start over', () => {
  const STORE_KEY = `cn-attempt:${INVOICE_ID}`;
  const dropped = async () => {
    throw new TypeError('Failed to fetch');
  };

  async function lockedForm(abandon: (url: string, init: RequestInit) => Promise<unknown>) {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) =>
      url === '/api/credit-notes/attempts/abandon' ? abandon(url, init) : dropped(),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    fillAndSubmit();
    await screen.findByTestId('credit-note-error');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Start over' })).not.toHaveAttribute('aria-disabled', 'true'),
    );
    const key = (JSON.parse(window.sessionStorage.getItem(STORE_KEY) ?? '{}') as { key?: string }).key;
    return { fetchMock, key };
  }

  it('Start over asks first; Go back changes nothing', async () => {
    try {
      const { fetchMock } = await lockedForm(async () => ({ ok: true, status: 200, json: async () => ({ outcome: 'abandoned' }) }));
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('Start over without this credit note?');
      // "Go back", not "Cancel": in this dialog "Cancel" would read as
      // "cancel the credit note", the opposite of what the button does.
      fireEvent.click(within(dialog).getByRole('button', { name: 'Go back' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(STORE_KEY)).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('confirmed and abandoned: the key is closed, the form unlocks with the phrase empty, and a toast says so', async () => {
    const { toast } = await import('@/lib/toast');
    vi.mocked(toast.success).mockClear();
    try {
      const { fetchMock, key } = await lockedForm(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ outcome: 'abandoned' }),
      }));
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Start over' }));
      await waitFor(() => expect(screen.queryByTestId('credit-note-error')).toBeNull());
      const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/credit-notes/attempts/abandon') as [string, RequestInit];
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ invoiceId: INVOICE_ID, idempotencyKey: key });
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
      expect(screen.getByLabelText(labelled(cnMessages.amountLabel))).not.toHaveAttribute('readonly');
      expect(screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!))).toHaveValue('');
      expect(screen.queryByTestId('cn-locked-hint')).toBeNull();
      expect(toast.success).toHaveBeenCalledWith(
        'This credit note will not be issued. You can enter a new one.',
        expect.objectContaining({ duration: 10_000 }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the attempt had issued its note: the replay toast, then the invoice', async () => {
    const { toast } = await import('@/lib/toast');
    vi.mocked(toast.success).mockClear();
    try {
      await lockedForm(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ outcome: 'issued', document_number: 'CN-2026-000009' }),
      }));
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start over' }));
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith(`/admin/invoices/${INVOICE_ID}`));
      expect(toast.success).toHaveBeenCalledWith(
        'Credit note CN-2026-000009 had already been issued — no new credit note was issued.',
        expect.objectContaining({ duration: 10_000 }),
      );
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Start over fails: the attempt stays locked and the alert says so', async () => {
    try {
      await lockedForm(async () => ({ ok: false, status: 504, json: async () => { throw new Error('html'); } }));
      const stored = window.sessionStorage.getItem(STORE_KEY);
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start over' }));
      await waitFor(() =>
        expect(screen.getByTestId('credit-note-error')).toHaveTextContent(
          "We couldn't start over. The credit note stays locked — choose Start over again, or open the invoice to check.",
        ),
      );
      expect(window.sessionStorage.getItem(STORE_KEY)).toBe(stored);
      expect(screen.getByLabelText(labelled(cnMessages.amountLabel))).toHaveAttribute('readonly');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Start over refused by the write freeze: still locked, and the alert says nothing changed', async () => {
    try {
      await lockedForm(async () => ({ ok: false, status: 503, json: async () => ({ error: 'read-only-mode' }) }));
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start over' }));
      await waitFor(() =>
        expect(screen.getByTestId('credit-note-error')).toHaveTextContent(
          `${enMessages.errors.readOnlyMode} ${enMessages.errors.readOnlyNothingChanged}`,
        ),
      );
      expect(screen.getByTestId('credit-note-error')).not.toHaveTextContent("We couldn't start over");
      expect(window.sessionStorage.getItem(STORE_KEY)).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a Try again refused as attempt_abandoned (another tab started over) ends the attempt and says nothing was issued', async () => {
    const fetchMock = vi
      .fn(async (_u: string, _i: RequestInit) => ({ ok: false, status: 409, json: async () => ({ error: { code: 'attempt_abandoned' } }) }))
      .mockImplementationOnce(dropped);
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Try again' })).not.toHaveAttribute('aria-disabled', 'true'),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() =>
        expect(screen.getByTestId('credit-note-error')).toHaveTextContent(
          'This credit note was closed with “Start over” — nothing was issued.',
        ),
      );
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
      // The same unlock as Start over in this tab: a new note needs its own
      // typed confirmation, so the old phrase is not left armed.
      expect(screen.getByLabelText(new RegExp(cnMessages.confirmCopy.split('{phrase}')[0]!))).toHaveValue('');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a replay toast lasts 10 s, so it survives the move to the invoice', async () => {
    const { toast } = await import('@/lib/toast');
    vi.mocked(toast.success).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ document_number: 'CN-2026-000009', replayed: true }) })),
    );
    try {
      renderForm();
      fillAndSubmit();
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(vi.mocked(toast.success).mock.calls[0]?.[1]).toMatchObject({ duration: 10_000 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
