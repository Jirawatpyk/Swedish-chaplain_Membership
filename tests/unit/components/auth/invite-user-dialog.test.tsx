/**
 * Spec 122 US10a (T1004; board `Admin-user-invite`) — the invite dialog on
 * AURA: Dialog, a required email field, the role as a Select whose hint
 * names the chosen role and what it grants (the summary moved off the
 * options, same words), and the member link enabled only for Member. The
 * request body and the toasts are today's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: nav.refresh }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin/users',
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { InviteUserDialog } from '@/components/auth/invite-user-dialog';

const i = en.admin.users.invite;
const roles = en.admin.users.filters.role;
const summary = en.admin.users.roleSummary;

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) =>
    url.startsWith('/api/members')
      ? json({ items: [{ member_id: 'm-1', company_name: 'Siam Nordic Trading Co., Ltd.', country: 'TH', status: 'active' }] })
      : json({ ok: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function flush() {
  for (let n = 0; n < 5; n += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function open() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <InviteUserDialog />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: en.admin.users.actions.invite }));
  return screen.getByRole('dialog', { name: i.title });
}

/** AURA's Select drives a native <select> under its face. */
const roleSelect = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('combobox', { name: new RegExp(`^${i.roleLabel}`) })
    .at(-1)!
    .closest('.aura-select')!
    .querySelector('select')!;
/** The field a person meets: AURA's combobox face, which carries the hint. */
const roleFace = (dialog: HTMLElement) =>
  within(dialog).getAllByRole('combobox', { name: new RegExp(`^${i.roleLabel}`) })[0]!;
const memberBox = (dialog: HTMLElement) =>
  within(dialog).getByRole('combobox', { name: i.linkMember.label });
const posts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/invite');

describe('InviteUserDialog on AURA', () => {
  it('opens an AURA dialog with a required email field and the role Select', () => {
    const dialog = open();
    expect(dialog.closest('.aura-dialog') ?? dialog).toHaveClass('aura-dialog');
    expect(within(dialog).getByRole('textbox', { name: i.emailLabel })).toBeRequired();
    expect(roleSelect(dialog).value).toBe('member');
  });

  it('says what the chosen role grants in the hint under the Select (the summary, no second dash)', () => {
    const dialog = open();
    expect(roleFace(dialog)).toHaveAccessibleDescription(summary.member);
    fireEvent.change(roleSelect(dialog), { target: { value: 'manager' } });
    expect(roleFace(dialog)).toHaveAccessibleDescription(summary.manager);
    // The options carry the role names alone.
    expect(within(roleSelect(dialog)).getByRole('option', { name: roles.super_admin, hidden: true })).toBeInTheDocument();
  });

  it('enables the member link only for the Member role', () => {
    const dialog = open();
    expect(memberBox(dialog)).toBeEnabled();
    fireEvent.change(roleSelect(dialog), { target: { value: 'admin' } });
    expect(memberBox(dialog)).toBeDisabled();
  });

  it('posts the same body: trimmed lower-case email, role, locale', async () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: i.emailLabel }), {
      target: { value: '  Sofia.Lind@Example.com ' },
    });
    fireEvent.change(roleSelect(dialog), { target: { value: 'manager' } });
    fireEvent.click(within(dialog).getByRole('button', { name: i.submit }));
    await flush();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0]![1].body as string)).toEqual({
      email: 'sofia.lind@example.com',
      role: 'manager',
      locale: 'en',
    });
    expect(toastMock.success).toHaveBeenCalledWith(i.toast.success.replace('{email}', 'Sofia.Lind@Example.com'));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('adds the linked member for a Member invite', async () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: i.emailLabel }), {
      target: { value: 'a@b.co' },
    });
    fireEvent.focus(memberBox(dialog));
    fireEvent.change(memberBox(dialog), { target: { value: 'siam' } });
    act(() => vi.advanceTimersByTime(250));
    await flush();
    fireEvent.click(screen.getByRole('option', { name: /Siam Nordic/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: i.submit }));
    await flush();
    expect(JSON.parse(posts()[0]![1].body as string)).toEqual({
      email: 'a@b.co',
      role: 'member',
      locale: 'en',
      memberId: 'm-1',
    });
  });

  it('shows a refusal inline as an alert, in words', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/invite' ? json({ error: 'email-taken' }, 409) : json({ items: [] }),
    );
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: i.emailLabel }), {
      target: { value: 'a@b.co' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: i.submit }));
    await flush();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(i.errors['email-taken']);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('gives its fields 44px boxes on phones (UX review)', () => {
    const dialog = open();
    expect(within(dialog).getByRole('textbox', { name: i.emailLabel }).closest('.aura-field')).toHaveClass('is-touch');
    expect(roleSelect(dialog).closest('.aura-field')).toHaveClass('is-touch');
  });
});
