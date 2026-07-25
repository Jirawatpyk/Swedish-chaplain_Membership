/**
 * #5 — MemberRowActionsMenu behaviour. The Base UI DropdownMenu + AlertDialog
 * are replaced with lightweight stand-ins (Base UI's menu/alert-dialog are
 * jsdom-hostile — PointerEvent + a startTransition deadlock), so the items are
 * always rendered and clickable and we can drive the handlers directly. Rendered
 * against real en.json so a missing key fails the test. Focus-return wiring is
 * covered by resolveDialogFinalFocus's own unit test; here we assert the
 * ACTIONS (endpoints, bodies, toast buckets, undo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { cloneElement, isValidElement, type ReactElement } from 'react';
import enMessages from '@/i18n/messages/en.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    loading: () => 'loading-id',
    dismiss: vi.fn(),
  },
}));

// Stand-ins: render items/content inline so the menu is "always open".
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({
    render,
  }: {
    render: (props: Record<string, unknown>) => React.ReactNode;
  }) => <>{render({})}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    render,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    render?: ReactElement;
  }) =>
    render && isValidElement(render) ? (
      cloneElement(render, {}, children)
    ) : (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: (e: { preventDefault: () => void }) => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick?.({ preventDefault: () => {} })}
    >
      {children}
    </button>
  ),
}));

import { MemberRowActionsMenu } from '@/components/members/member-row-actions-menu';

const CONTACT = { contactId: 'c-1', email: 'a@b.co' };

function renderMenu(
  props: Partial<React.ComponentProps<typeof MemberRowActionsMenu>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberRowActionsMenu
        memberId="m-1"
        companyName="Acme Co"
        status="active"
        portalState="not_invited"
        primaryContact={CONTACT}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  // A shared setup enables fake timers, which freezes `waitFor` (30s hang, not a
  // fast assertion failure) — see the same fix in inline-status-undo.test.tsx.
  vi.useRealTimers();
  refresh.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  toastInfo.mockClear();
});

describe('MemberRowActionsMenu — item visibility', () => {
  it('shows Invite only when the member needs an invite (has contact + not_invited/expired)', () => {
    renderMenu({ portalState: 'not_invited' });
    expect(screen.getByText('Invite to portal')).toBeInTheDocument();
  });

  it('hides Invite when the portal account is already active', () => {
    renderMenu({ portalState: 'active' });
    expect(screen.queryByText('Invite to portal')).toBeNull();
  });

  it('shows Archive (not Restore) for an active member', () => {
    renderMenu({ status: 'active' });
    expect(screen.getByText('Archive')).toBeInTheDocument();
    expect(screen.queryByText('Restore')).toBeNull();
  });

  it('shows Restore (not Archive/Reminder/Invite) for an archived member', () => {
    renderMenu({ status: 'archived' });
    expect(screen.getByText('Restore')).toBeInTheDocument();
    expect(screen.queryByText('Archive')).toBeNull();
    expect(screen.queryByText('Send renewal reminder')).toBeNull();
    expect(screen.queryByText('Invite to portal')).toBeNull();
  });

  it('renders nav items as deep-links to the detail invoices + benefits', () => {
    renderMenu();
    expect(screen.getByText('View invoices').closest('a')).toHaveAttribute(
      'href',
      '/admin/members/m-1#invoices',
    );
    expect(screen.getByText('Benefits').closest('a')).toHaveAttribute(
      'href',
      '/admin/members/m-1/benefits',
    );
  });
});

describe('MemberRowActionsMenu — actions', () => {
  it('Invite POSTs the contact invite-portal endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({ portalState: 'not_invited' });
    fireEvent.click(screen.getByText('Invite to portal'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/members/m-1/contacts/c-1/invite-portal',
    );
    vi.unstubAllGlobals();
  });

  it('Invite maps a snake_case server code to the SPECIFIC localized copy (regression guard)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ error: { code: 'already_linked' } }, 409));
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({ portalState: 'not_invited' });
    fireEvent.click(screen.getByText('Invite to portal'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The camelCase key (errors.alreadyLinked) must be resolved from the
    // snake_case server code — not degraded to the generic serverError.
    expect(toastError.mock.calls[0]?.[0]).toBe(
      enMessages.admin.members.invitePortal.errors.alreadyLinked,
    );
    expect(toastError.mock.calls[0]?.[0]).not.toBe(
      enMessages.admin.members.invitePortal.errors.serverError,
    );
    vi.unstubAllGlobals();
  });

  it('Send reminder surfaces the rate-limit toast on 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}, 429));
    vi.stubGlobal('fetch', fetchMock);

    renderMenu();
    fireEvent.click(screen.getByText('Send renewal reminder'));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toBe(
      enMessages.admin.members.rowActions.rateLimited,
    );
    vi.unstubAllGlobals();
  });

  it('Send reminder POSTs the bulk endpoint with the single id and shows success on sent≥1', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ counts: { sent: 1, skipped: 0, failed: 0 } }));
    vi.stubGlobal('fetch', fetchMock);

    renderMenu();
    fireEvent.click(screen.getByText('Send renewal reminder'));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/members/bulk');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toEqual({ action: 'send_renewal_reminder', member_ids: ['m-1'] });
    vi.unstubAllGlobals();
  });

  it('Send reminder shows a neutral "none due" info toast when nothing was sent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okJson({ counts: { sent: 0, skipped: 1, failed: 0 } }));
    vi.stubGlobal('fetch', fetchMock);

    renderMenu();
    fireEvent.click(screen.getByText('Send renewal reminder'));

    await waitFor(() => expect(toastInfo).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Restore POSTs /undelete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}));
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({ status: 'archived' });
    fireEvent.click(screen.getByText('Restore'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/members/m-1/undelete');
    expect(toastSuccess).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Archive → confirm POSTs /archive and the success toast exposes an Undo that POSTs /undelete', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({})) // archive
      .mockResolvedValueOnce(okJson({})); // undo → undelete
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({ status: 'active' });
    // Open the confirm dialog (menu item — unique while the dialog is closed),
    // then confirm within the dialog (the CTA text can also appear in the menu).
    fireEvent.click(screen.getByText('Archive'));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(
      within(dialog).getByText(enMessages.admin.members.archive.confirmCta as string),
    );

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/members/m-1/archive');

    // Invoke the Undo action from the toast options.
    const [, opts] = toastSuccess.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void } },
    ];
    expect(opts?.action?.label).toBe(enMessages.admin.members.rowActions.undo);
    opts!.action!.onClick();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/members/m-1/undelete');
    vi.unstubAllGlobals();
  });
});
