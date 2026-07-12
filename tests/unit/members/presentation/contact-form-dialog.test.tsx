/**
 * ContactFormDialog — inline email-taken (audit XF-01).
 *
 * Mirrors the sibling invite-colleague / portal-edit tests: a 409 conflict on
 * ADD must surface inline on #cf-email (aria-invalid + message) with focus, not
 * a toast. Rendered against real en.json with a mocked fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  ContactFormDialog,
  type ContactInitial,
} from '@/components/members/contact-form-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    info: vi.fn(),
  },
}));

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
  toastSuccess.mockClear();
  toastWarning.mockClear();
});

function openAddDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContactFormDialog memberId="m1" mode="add" trigger={<button>Open</button>} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByText('Open'));
}

function openEditDialog(overrides: Partial<ContactInitial> = {}) {
  const contact: ContactInitial = {
    contactId: 'c1',
    firstName: 'Alice',
    lastName: 'Anderson',
    email: 'alice@old.example',
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    linkedUserId: null,
    // Default PRIMARY — a linked PRIMARY contact keeps the read-only email
    // (sign-in identity changed on the member Edit page). Tests that need the
    // editable linked-SECONDARY path override `isPrimary: false`.
    isPrimary: true,
    ...overrides,
  };
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContactFormDialog memberId="m1" mode="edit" contact={contact} trigger={<button>Open</button>} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByText('Open'));
  return contact;
}

describe('ContactFormDialog — edit-mode email editability', () => {
  it('UNLINKED contact: email field is editable (focusable, not read-only), no note', () => {
    openEditDialog({ linkedUserId: null });
    const email = document.querySelector('#cf-email') as HTMLInputElement;
    expect(email.readOnly).toBe(false);
    expect(email.disabled).toBe(false);
    expect(document.querySelector('#cf-email-note')).toBeNull();
  });

  it('LINKED PRIMARY contact: email is read-only (focusable, not disabled) with a note', () => {
    openEditDialog({ linkedUserId: 'user-1', isPrimary: true });
    const email = document.querySelector('#cf-email') as HTMLInputElement;
    // read-only (not disabled) so screen readers still reach it + announce the note.
    expect(email.readOnly).toBe(true);
    expect(email.disabled).toBe(false);
    expect(document.querySelector('#cf-email-note')).not.toBeNull();
  });

  it('LINKED SECONDARY contact: email field is editable (no dead-end), no note', () => {
    // A linked SECONDARY contact has no path to change its email on the member
    // Edit page (that form only edits the PRIMARY). The PATCH route handles a
    // linked contact's email via changeContactEmail (FR-012a) for ANY linked
    // contact, so the dialog must let the admin edit it here.
    openEditDialog({ linkedUserId: 'user-1', isPrimary: false });
    const email = document.querySelector('#cf-email') as HTMLInputElement;
    expect(email.readOnly).toBe(false);
    expect(email.disabled).toBe(false);
    expect(document.querySelector('#cf-email-note')).toBeNull();
  });

  it('LINKED SECONDARY contact: a changed email PATCHes `email` AND `locale`', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    openEditDialog({
      linkedUserId: 'user-1',
      isPrimary: false,
      email: 'sec@old.example',
      preferredLanguage: 'th',
    });

    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'sec@new.example' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.email).toBe('sec@new.example');
    // `locale` steers changeContactEmail's verification email to the contact's
    // language (the route defaults to 'en' if absent).
    expect(body.locale).toBe('th');

    vi.unstubAllGlobals();
  });

  it('UNLINKED contact: submitting a changed email PATCHes the `email` field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    openEditDialog({ linkedUserId: null, email: 'alice@old.example' });

    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'alice@new.example' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.email).toBe('alice@new.example');
    expect(init.method).toBe('PATCH');

    vi.unstubAllGlobals();
  });

  it('UNLINKED contact: an UNCHANGED email is NOT included in the PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    openEditDialog({ linkedUserId: null, firstName: 'Alice', email: 'alice@old.example' });

    fireEvent.change(document.querySelector('#cf-first-name')!, {
      target: { value: 'Alicia' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.first_name).toBe('Alicia');
    expect('email' in body).toBe(false);

    vi.unstubAllGlobals();
  });

  it('LINKED contact: email is NEVER in the PATCH even when another field changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    openEditDialog({ linkedUserId: 'user-1', firstName: 'Bob', email: 'bob@corp.example' });

    fireEvent.change(document.querySelector('#cf-first-name')!, {
      target: { value: 'Bobby' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.first_name).toBe('Bobby');
    expect('email' in body).toBe(false);

    vi.unstubAllGlobals();
  });

  it('partial save: a `field_update_failed` marker on a 200 shows a warning, not success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ field_update_failed: 'server_error' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openEditDialog({ linkedUserId: null, email: 'alice@old.example' });

    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'alice@new.example' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    // The plain success toast must NOT also fire — the admin needs the retry cue.
    expect(toastSuccess).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('UNLINKED contact: a 400 validation_error on email surfaces inline (not a toast)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: { code: 'validation_error', details: { field: 'email' } },
        }),
      }),
    );
    openEditDialog({ linkedUserId: null, email: 'alice@old.example' });

    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'alice@new.example' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() =>
      expect(document.querySelector('#cf-email')?.getAttribute('aria-invalid')).toBe('true'),
    );
    expect(document.querySelector('#cf-email-error')).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('ContactFormDialog — inline email-taken', () => {
  it('surfaces a 409 conflict inline on #cf-email (not a toast)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'conflict' } }),
      }),
    );
    openAddDialog();

    fireEvent.change(document.querySelector('#cf-first-name')!, {
      target: { value: 'Jane' },
    });
    fireEvent.change(document.querySelector('#cf-last-name')!, {
      target: { value: 'Doe' },
    });
    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'dup@example.com' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() =>
      expect(document.querySelector('#cf-email')?.getAttribute('aria-invalid')).toBe(
        'true',
      ),
    );
    // Inline error rendered, no toast.
    expect(document.querySelector('#cf-email-error')).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('ContactFormDialog — retryable 503 (G24)', () => {
  it('maps a 503 idempotency-reservation outage to the retryable serverBusy toast, not the generic dead-end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: { code: 'idempotency_reservation_failed' } }),
      }),
    );
    openAddDialog();

    fireEvent.change(document.querySelector('#cf-first-name')!, {
      target: { value: 'Jane' },
    });
    fireEvent.change(document.querySelector('#cf-last-name')!, {
      target: { value: 'Doe' },
    });
    fireEvent.change(document.querySelector('#cf-email')!, {
      target: { value: 'new@example.com' },
    });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith(
      'The server is busy. Please try again in a moment.',
    );
    // Must NOT read as a permanent failure.
    expect(toastError).not.toHaveBeenCalledWith(
      'Something went wrong. Please try again.',
    );

    vi.unstubAllGlobals();
  });
});
