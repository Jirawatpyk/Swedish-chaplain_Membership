/**
 * Spec 122 US8b (T825) — Delete draft on AURA: "Delete draft…" opens an
 * alertdialog (focus on Cancel, ux-standards § 6); confirming sends the same
 * DELETE, then goes back to the list with a toast; a failure keeps the dialog
 * open with the error toast, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));

const { DeleteDraftDialog } = await import('@/app/(staff)/admin/invoices/_components/delete-draft-dialog');
const L = enMessages.admin.invoices.deleteDraft;

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

function renderDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DeleteDraftDialog invoiceId="inv-1" />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: L.trigger }));
  return screen.getByRole('alertdialog', { name: L.title });
}

describe('DeleteDraftDialog', () => {
  it('opens an alertdialog that says what is removed, with focus on Cancel', () => {
    const dialog = renderDialog();
    expect(dialog).toHaveAccessibleDescription(L.description);
    expect(screen.getByRole('button', { name: L.cancel })).toHaveFocus();
  });

  it('sends the DELETE, then returns to the list with a toast', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: L.deleteButton }));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/invoices/inv-1', { method: 'DELETE' });
    expect(toast.success).toHaveBeenCalledWith(L.success);
    expect(router.push).toHaveBeenCalledWith('/admin/invoices');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('a failure shows the error toast with the code and keeps the dialog open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_draft' } }), { status: 409 })));
    renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: L.deleteButton }));
    });
    expect(toast.error).toHaveBeenCalledWith(L.errors.failed, { description: 'Error code: not_draft' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
