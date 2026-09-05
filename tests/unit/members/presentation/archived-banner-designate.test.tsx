/**
 * 108 T039 (US2 / FR-014) — `ArchivedBanner` drives the designate flow.
 *
 * Restore → 409 `no_primary_contact` (with `details.designatable`) → the
 * dialog opens with those contacts → the admin picks one → a SECOND request
 * carries `designate_primary_contact_id` under a FRESH Idempotency-Key (the
 * first key belongs to a request the server refused and did not remember; a
 * reused key with a different body would be an idempotency conflict).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ArchivedBanner } from '@/components/members/archived-banner';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: vi.fn(),
  },
}));
// Stub the nested add-contact form: expose its `onSaved` as a button.
vi.mock('@/components/members/contact-form-dialog', () => ({
  ContactFormDialog: (props: { trigger: React.ReactElement; onSaved?: () => void }) => (
    <div data-testid="cfd-stub">
      {props.trigger}
      <button type="button" data-testid="cfd-saved" onClick={() => props.onSaved?.()}>
        saved
      </button>
    </div>
  ),
}));
const D = enMessages.admin.members.undelete.designate;
const A = enMessages.admin.members.archive;

const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const CONTACT_B = '77777777-7777-4777-8777-777777777777';

/**
 * Plain object, not `new Response` — the same shape the sibling
 * contact-form-dialog test uses; a real Response under jsdom + the shared
 * setup's timers has hung `res.json()` before (memory: 30 s timeout = harness).
 */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ArchivedBanner
        memberId={MEMBER_ID}
        archivedAtIso="2026-08-01T00:00:00.000Z"
        windowStatus={{ state: 'within_window', daysRemaining: 60 }}
      />
    </NextIntlClientProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The shared setup can leave fake timers installed; `waitFor`/`findBy*`
  // then never advance and the test dies at the 30 s cap (sibling
  // plan-change-confirm-dialog.test.tsx does the same reset).
  vi.useRealTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ArchivedBanner — designate a primary on restore (108 FR-014)', () => {
  it('opens the dialog with the server-supplied contacts on 409 no_primary_contact', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: 'no_primary_contact',
          message: 'x',
          details: {
            designatable: [
              { contact_id: 'c-ann', first_name: 'Ann', last_name: 'Alpha' },
              { contact_id: CONTACT_B, first_name: 'Bo', last_name: 'Beta' },
            ],
          },
        },
      }),
    );
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Ann Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeInTheDocument();
    // No error toast — this is a question, not a failure.
    expect(toastError).not.toHaveBeenCalled();
  });

  it('second request carries the designation under a NEW Idempotency-Key, then refreshes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'no_primary_contact',
            details: {
              designatable: [
                { contact_id: CONTACT_B, first_name: 'Bo', last_name: 'Beta' },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          member_id: MEMBER_ID,
          status: 'active',
          designated_primary_contact_id: CONTACT_B,
        }),
      );
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Bo Beta'));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeChecked(),
    );
    fireEvent.click(screen.getByTestId('restore-primary-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toBe(`/api/members/${MEMBER_ID}/undelete`);
    expect(secondUrl).toBe(`/api/members/${MEMBER_ID}/undelete`);
    expect(JSON.parse(String(secondInit.body))).toEqual({
      designate_primary_contact_id: CONTACT_B,
    });
    const key1 = new Headers(firstInit.headers).get('Idempotency-Key');
    const key2 = new Headers(secondInit.headers).get('Idempotency-Key');
    expect(key1).toBeTruthy();
    expect(key2).toBeTruthy();
    expect(key2).not.toBe(key1);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(D.successDesignated));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('says only "restored" (not "primary contact set") when the server designated nobody (L4c)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'no_primary_contact',
            details: {
              designatable: [
                { contact_id: CONTACT_B, first_name: 'Bo', last_name: 'Beta', email: 'bo@x.example' },
              ],
            },
          },
        }),
      )
      // A primary appeared between the 409 and the retry: nothing designated.
      .mockResolvedValueOnce(
        jsonResponse(200, { member_id: MEMBER_ID, status: 'active', designated_primary_contact_id: null }),
      );
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Bo Beta'));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeChecked(),
    );
    fireEvent.click(screen.getByTestId('restore-primary-confirm'));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(A.undeleteSuccess));
    expect(toastSuccess).not.toHaveBeenCalledWith(D.successDesignated);
  });

  it('after "Add a contact" saves, restores again in place — the new contact is now the primary (H2)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, { error: { code: 'no_primary_contact', details: { designatable: [] } } }),
      )
      // addContact made the first contact primary, so the retry succeeds.
      .mockResolvedValueOnce(
        jsonResponse(200, { member_id: MEMBER_ID, status: 'active', designated_primary_contact_id: null }),
      );
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await screen.findByRole('alertdialog');
    expect(screen.getByTestId('restore-primary-add-contact')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cfd-saved'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(secondInit.body).toBeUndefined();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(A.undeleteSuccess));
  });

  it('a second 409 (the chosen contact vanished) re-opens the dialog with the fresh list, no crash', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'no_primary_contact',
            details: {
              designatable: [
                { contact_id: CONTACT_B, first_name: 'Bo', last_name: 'Beta' },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'no_primary_contact',
            details: {
              designatable: [
                { contact_id: 'c-ann', first_name: 'Ann', last_name: 'Alpha' },
              ],
            },
          },
        }),
      );
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Bo Beta'));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeChecked(),
    );
    fireEvent.click(screen.getByTestId('restore-primary-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The stale choice is gone; the dialog now offers what the server has,
    // and says so INSIDE the dialog — a toast is aria-hidden behind the modal
    // (T041 UX review, H1).
    await screen.findByRole('radio', { name: /Ann Alpha/ });
    expect(screen.queryByRole('radio', { name: /Bo Beta/ })).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toContainElement(screen.getByRole('alert'));
    expect(screen.getByRole('alert')).toHaveTextContent(D.retry);
  });

  // ── T041 UX review round 2 ─────────────────────────────────────────────────

  it('a non-409 failure from INSIDE the dialog closes it first, then toasts and refreshes — the page becomes the source of truth (N1)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, { error: { code: 'no_primary_contact', details: { designatable: [] } } }),
      )
      // The retry after "Add a contact" hits a server error.
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'server_error' } }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await screen.findByRole('alertdialog');

    fireEvent.click(screen.getByTestId('cfd-saved'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The dialog must not sit there still saying "no contacts left" with the
    // add door open while a toast is hidden behind the modal.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(A.undeleteError));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('clears the lost-race notice the moment a new request starts, so a repeat is re-announced (N6a)', async () => {
    let resolveSecond!: (v: unknown) => void;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'no_primary_contact',
            details: {
              designatable: [
                { contact_id: CONTACT_B, first_name: 'Bo', last_name: 'Beta', email: 'bo@x.example' },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(409, {
          error: {
            code: 'no_primary_contact',
            details: {
              designatable: [
                { contact_id: 'c-ann', first_name: 'Ann', last_name: 'Alpha', email: 'ann@x.example' },
              ],
            },
          },
        }),
      )
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByText('Bo Beta'));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeChecked());
    fireEvent.click(screen.getByTestId('restore-primary-confirm'));
    // Second 409 → the notice is up.
    await screen.findByRole('alert');
    fireEvent.click(screen.getByText('Ann Alpha'));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Ann Alpha/ })).toBeChecked());
    fireEvent.click(screen.getByTestId('restore-primary-confirm'));
    // Third request in flight: the old notice is gone, so the next one mounts fresh.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('alert')).toBeNull();
    resolveSecond(jsonResponse(200, { member_id: MEMBER_ID, designated_primary_contact_id: 'c-ann' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it('an erased member gets its own copy, not "not archived" (reliability N4)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: { code: 'state_error', details: { code: 'undelete_erased' } } }),
    );
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(A.undeleteErased));
  });

  it('a plain restore (member already has a primary) still works without any dialog', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { member_id: MEMBER_ID }));
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
