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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { CreditNoteForm } from '@/app/(staff)/admin/invoices/[invoiceId]/credit-notes/new/_components/credit-note-form';

/** An AURA field's label also holds its required asterisk, so match from the start. */
const labelled = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

const cnMessages = enMessages.admin.creditNotes.new;

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
  refreshMock.mockClear();
  pushMock.mockClear();
});

const INVOICE_ID = 'inv-1';
const DOC_NUMBER = 'SC-2026-000001';
/** 1,070.00 THB remaining (107,000 satang). */
const REMAINING_SATANG = '107000';

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreditNoteForm
        invoiceId={INVOICE_ID}
        documentNumber={DOC_NUMBER}
        remainingSatang={REMAINING_SATANG}
        currencySymbol="THB"
        invoiceSubject="event"
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
  const UNCONFIRMED =
    "We couldn't confirm whether the credit note was issued. Try again — if it was issued, trying again issues nothing new — or open the invoice to check.";

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
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<never>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { container } = renderForm();
      fillAndSubmit();
      fireEvent.submit(container.querySelector('form')!);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// #66 — the key outlives a reload (sessionStorage per invoice) until the server
// gives a definite answer, so a resubmit after a reload is deduplicated too; a
// replay says the note was already issued.
describe('CreditNoteForm — #66 the idempotency key', () => {
  const STORE_KEY = `cn-attempt:${INVOICE_ID}`;

  beforeEach(() => {
    window.sessionStorage.clear();
  });

  function okFetch(body: Record<string, unknown>) {
    return vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 201,
      json: async () => body,
    }));
  }

  it('after an unknown outcome a reload keeps the key: the next submit sends the same one', async () => {
    const dropped = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', dropped);
    try {
      const view = renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      const key = (JSON.parse(String(dropped.mock.calls[0]?.[1]?.body)) as { idempotencyKey: string })
        .idempotencyKey;
      expect(window.sessionStorage.getItem(STORE_KEY)).toBe(key);
      view.unmount();

      const ok = okFetch({ document_number: 'CN-2026-000009', replayed: true });
      vi.stubGlobal('fetch', ok);
      renderForm();
      fillAndSubmit();
      await waitFor(() => expect(ok).toHaveBeenCalledTimes(1));
      expect((JSON.parse(String(ok.mock.calls[0]?.[1]?.body)) as { idempotencyKey: string }).idempotencyKey).toBe(key);
      // A definite answer ends the attempt.
      await waitFor(() => expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a replay says the note was already issued and nothing new was created', async () => {
    const { toast } = await import('@/lib/toast');
    vi.mocked(toast.success).mockClear();
    vi.stubGlobal('fetch', okFetch({ document_number: 'CN-2026-000009', replayed: true }));
    try {
      renderForm();
      fillAndSubmit();
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
        'Credit note CN-2026-000009 was already issued — nothing new was created.',
      );
      expect(pushMock).toHaveBeenCalledWith(`/admin/invoices/${INVOICE_ID}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a definite refusal also ends the attempt (the next submit gets a new key)', async () => {
    const PENDING = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    window.sessionStorage.setItem(STORE_KEY, PENDING);
    const refused = rejectingFetch('invalid_status');
    vi.stubGlobal('fetch', refused);
    try {
      renderForm();
      fillAndSubmit();
      await screen.findByTestId('credit-note-error');
      // The pending attempt's key is reused, then dropped on the definite answer.
      expect((JSON.parse(String(refused.mock.calls[0]?.[1]?.body)) as { idempotencyKey: string }).idempotencyKey).toBe(PENDING);
      expect(window.sessionStorage.getItem(STORE_KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
