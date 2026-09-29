/**
 * 122 US5b-1 (T554) — a contact's actions on the member detail page, as the
 * `Admin-member-detail` board draws them: a visible Edit, and for another
 * (non-primary) contact a visible "Make primary" plus a "⋯" menu holding
 * Remove. The primary contact cannot be removed or promoted, so it has
 * neither. Promote and Remove each confirm in an AURA alert dialog with the
 * same copy and the same requests as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

const { ContactActions } = await import('@/components/members/contact-actions');

const A = enMessages.admin.members.detail.contactActions;

const contact = {
  contactId: 'c-2',
  firstName: 'Ploy',
  lastName: 'Srisuk',
  email: 'ploy@siamnordic.example',
  phone: null,
  roleTitle: null,
  preferredLanguage: 'th' as const,
  linkedUserId: null,
  isPrimary: false,
};

function renderActions(isPrimary: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      <ContactActions memberId="m-1" contact={{ ...contact, isPrimary }} isPrimary={isPrimary} />
    </NextIntlClientProvider>,
  );
}

// Real timers: the global setup fakes them, and findBy / waitFor poll on timers.
beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('ContactActions (T554)', () => {
  it('the primary contact: Edit only — no Make primary, no menu', () => {
    renderActions(true);
    expect(screen.getByRole('button', { name: new RegExp(A.edit) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(A.promote) })).toBeNull();
    expect(screen.queryByRole('button', { name: /more actions/i })).toBeNull();
  });

  it('another contact: Edit, Make primary, and a ⋯ menu named for the contact that holds Remove', () => {
    renderActions(false);
    expect(screen.getByRole('button', { name: new RegExp(A.edit) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(A.promote) })).toBeInTheDocument();
    const more = screen.getByRole('button', { name: A.moreActions.replace('{name}', 'Ploy Srisuk') });
    fireEvent.click(more);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: new RegExp(A.remove) })).toBeInTheDocument();
  });

  it('Remove confirms in an alert dialog, then DELETEs the contact and refreshes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    renderActions(false);
    fireEvent.click(screen.getByRole('button', { name: A.moreActions.replace('{name}', 'Ploy Srisuk') }));
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(A.remove) }));
    const dialog = await screen.findByRole('alertdialog', { name: A.removeTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: A.removeConfirm }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/members/m-1/contacts/c-2', { method: 'DELETE' }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Make primary confirms in an alert dialog, then POSTs promote-primary', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    renderActions(false);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(A.promote) }));
    const dialog = await screen.findByRole('alertdialog', {
      name: A.promoteTitle.replace('{name}', 'Ploy Srisuk'),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: A.promoteConfirm }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/members/m-1/contacts/c-2/promote-primary', { method: 'POST' }),
    );
  });

  // UX review M7: several contacts each have an Edit and a Make primary, so
  // each button carries the contact's name after its visible text (2.5.3).
  it('Edit and Make primary are named for their contact', () => {
    renderActions(false);
    expect(screen.getByRole('button', { name: `${A.edit}, Ploy Srisuk` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${A.promote}, Ploy Srisuk` })).toBeInTheDocument();
  });
});
