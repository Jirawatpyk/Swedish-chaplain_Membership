/**
 * 122 US5b-1 (T555) — the member detail page's Archive and Erase actions on
 * AURA. Neither had a unit test before (e2e only), so these pin the behaviour
 * the swap must keep, plus the field help that AURA links to its field:
 *
 * - Archive: an alert dialog named for the company, an optional reason whose
 *   limit note is the field's description, and POST /archive with the reason.
 *   A refusal keeps the dialog open with the mapped message.
 * - Erase: the confirm stays `aria-disabled` and names the missing conditions
 *   (legal basis, attestation, method, the typed member number) until all are
 *   met, then POSTs /erase with them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));

const { ArchiveMemberButton } = await import('@/components/members/archive-member-button');
const { EraseMemberButton } = await import('@/components/members/erase-member-button');

const AR = enMessages.admin.members.archive;
const ER = enMessages.admin.members.erase;

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {ui}
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
  toast.success.mockReset();
  toast.error.mockReset();
  vi.useFakeTimers();
});

describe('ArchiveMemberButton (T555)', () => {
  it('opens an alert dialog named for the company; the reason field says its limit', () => {
    wrap(<ArchiveMemberButton memberId="m-1" companyName="Siam Nordic" />);
    fireEvent.click(screen.getByRole('button', { name: AR.archiveCta }));
    const dialog = screen.getByRole('alertdialog', { name: AR.confirmTitle.replace('{companyName}', 'Siam Nordic') });
    const reason = within(dialog).getByRole('textbox', { name: AR.reasonLabel });
    expect(reason).toHaveAttribute('id', 'archive-reason');
    expect(reason).toHaveAccessibleDescription(AR.reasonHelper);
  });

  it('POSTs the trimmed reason, toasts and refreshes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    wrap(<ArchiveMemberButton memberId="m-1" companyName="Siam Nordic" />);
    fireEvent.click(screen.getByRole('button', { name: AR.archiveCta }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  company closed ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: AR.confirmCta }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/members/m-1/archive');
    expect(JSON.parse(String(init!.body))).toEqual({ reason: 'company closed' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(AR.archiveSuccess.replace('{companyName}', 'Siam Nordic')));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a refusal maps the code to its message and keeps the dialog open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'state_error' } }), { status: 409 }),
    );
    wrap(<ArchiveMemberButton memberId="m-1" companyName="Siam Nordic" />);
    fireEvent.click(screen.getByRole('button', { name: AR.archiveCta }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: AR.confirmCta }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(AR.archiveAlreadyArchived));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

// 122 US5b-1 (maintainer, 29 Sep): the phone header opens these from its ⋯
// menu, so each can be opened by its caller with no trigger of its own.
describe('Archive / Erase opened by a caller', () => {
  it('ArchiveMemberButton: open without a trigger, Cancel reports the close', () => {
    const onOpenChange = vi.fn();
    wrap(<ArchiveMemberButton memberId="m-1" companyName="Siam Nordic" showTrigger={false} open onOpenChange={onOpenChange} />);
    expect(screen.queryByRole('button', { name: AR.archiveCta })).toBeNull();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: AR.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('EraseMemberButton: open without a trigger, Cancel reports the close', () => {
    const onOpenChange = vi.fn();
    wrap(<EraseMemberButton memberId="m-1" companyName="Siam Nordic" memberNumberDisplay="TSCC-0003" showTrigger={false} open onOpenChange={onOpenChange} />);
    expect(screen.queryByRole('button', { name: ER.eraseCta })).toBeNull();
    const dialog = screen.getByRole('alertdialog', { name: ER.dialogTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: ER.cancel }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('EraseMemberButton (T555)', () => {
  function openErase() {
    wrap(<EraseMemberButton memberId="m-1" companyName="Siam Nordic" memberNumberDisplay="TSCC-0003" />);
    fireEvent.click(screen.getByRole('button', { name: ER.eraseCta }));
    return screen.getByRole('alertdialog', { name: ER.dialogTitle });
  }

  it('keeps Erase aria-disabled and says what is missing until every condition is met', () => {
    const dialog = openErase();
    const confirm = within(dialog).getByRole('button', { name: ER.confirmCta });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    const checklist = within(dialog).getByRole('status');
    for (const item of [ER.gateReason, ER.gateAttestation, ER.gateMethod, ER.gateTyped]) {
      expect(checklist).toHaveTextContent(item);
    }
    expect(confirm).toHaveAccessibleDescription(expect.stringContaining(ER.gateHeading));
  });

  it('the note field says its limit', () => {
    const dialog = openErase();
    expect(within(dialog).getByRole('textbox', { name: ER.noteLabel })).toHaveAccessibleDescription(ER.noteHelper);
  });

  it('once complete, POSTs the legal basis, the attestation, the method and the note', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ cascadesComplete: true }), { status: 200 }));
    const dialog = openErase();
    fireEvent.click(within(dialog).getByRole('radio', { name: ER.reasonPdpa }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: ER.attestationLabel }));
    // The repo's convention for an AURA Select: change its native <select>.
    expect(within(dialog).getByRole('combobox', { name: ER.methodLabel })).toBeInTheDocument();
    fireEvent.change(dialog.querySelector('select')!, { target: { value: 'in_person' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: ER.noteLabel }), { target: { value: 'DPO-7' } });
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: ER.confirmLabel.replace('{memberNumber}', 'TSCC-0003') }),
      { target: { value: 'TSCC-0003' } },
    );
    const confirm = within(dialog).getByRole('button', { name: ER.confirmCta });
    expect(confirm).not.toHaveAttribute('aria-disabled');
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/members/m-1/erase');
    expect(JSON.parse(String(init!.body))).toEqual({
      reason: 'pdpa_deletion_request',
      identityVerified: true,
      verificationMethod: 'in_person',
      note: 'DPO-7',
    });
  });

  // UX review M5 (ux-standards § 6.4): a refusal is said inside the dialog,
  // where the modal keeps the screen reader, and focus moves to it — a toast
  // outside an aria-modal dialog goes unheard.
  it('a refusal is an inline alert that takes focus, and the dialog stays open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }),
    );
    const dialog = openErase();
    fireEvent.click(within(dialog).getByRole('radio', { name: ER.reasonPdpa }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: ER.attestationLabel }));
    fireEvent.change(dialog.querySelector('select')!, { target: { value: 'in_person' } });
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: ER.confirmLabel.replace('{memberNumber}', 'TSCC-0003') }),
      { target: { value: 'TSCC-0003' } },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: ER.confirmCta }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(ER.eraseNotFound);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
