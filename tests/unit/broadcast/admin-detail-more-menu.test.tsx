/**
 * Spec 122 US12c-1 (parity comment "จัดปุ่มใหม่", 20 Oct; board
 * `Admin-broadcast-review-mobile`) — below 640px the staff detail's pinned
 * bar keeps Reject and the next step as buttons and folds the secondary
 * actions (Cancel broadcast; Start formatted version when it is not the next
 * step) into one ⋯ menu. The same dialog opens from either control, and a
 * dialog opened from the menu hands focus back to ⋯ (the item is gone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { DetailActionBar } from '@/components/broadcast/admin/detail-action-bar';
import { CancelBroadcastAction } from '@/components/broadcast/cancel-broadcast-action';
import {
  StartFormattedVersionAction,
  type StartConfirm,
} from '@/components/broadcast/approval/start-formatted-version-action';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

const ID = '11111111-1111-4111-8111-111111111111';
const more = en.admin.broadcasts.review.moreActions;
const cancelLabel = en.admin.broadcasts.cancelDialog.confirm;
const startLabel = en.admin.broadcasts.approval.start.button;

function renderBar(confirm: StartConfirm = 'leaves_submitted') {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <main id="main-content" tabIndex={-1}>
        <DetailActionBar
          moreLabel={more}
          start={
            <>
              <CancelBroadcastAction broadcastId={ID} surface="admin" subject="Autumn" />
              <button type="button">Reject</button>
            </>
          }
        >
          <StartFormattedVersionAction broadcastId={ID} confirm={confirm} round={0} />
          <button type="button">Approve</button>
        </DetailActionBar>
      </main>
    </NextIntlClientProvider>,
  );
}

const moreTrigger = () => screen.getByRole('button', { name: more });

describe('the staff detail bar on a phone', () => {
  it('folds Cancel and a secondary Start into ⋯, hiding their inline buttons below 640px', async () => {
    renderBar();
    const inlineCancel = screen.getByRole('button', { name: cancelLabel });
    expect(inlineCancel.className).toContain('max-sm:hidden');
    expect(screen.getByTestId('eblast-start-version').className).toContain('max-sm:hidden');
    expect(moreTrigger().closest('[data-more-actions]')?.className).toContain('sm:hidden');

    fireEvent.click(moreTrigger());
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim());
    expect(items).toEqual([startLabel, cancelLabel]);
  });

  it('opens the same cancel dialog from the menu and returns focus to ⋯ when it closes', async () => {
    renderBar();
    fireEvent.click(moreTrigger());
    fireEvent.click(await screen.findByRole('menuitem', { name: cancelLabel }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.admin.broadcasts.cancelDialog.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(moreTrigger()));
  });

  it('keeps Start as a button when it is the next step (it runs on the click)', () => {
    renderBar('none');
    expect(screen.getByTestId('eblast-start-version').className).not.toContain('max-sm:hidden');
    fireEvent.click(moreTrigger());
    return screen.findByRole('menu').then((menu) => {
      expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim())).toEqual([cancelLabel]);
    });
  });

  it('outside the bar, Cancel keeps its own button at every width', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
        <CancelBroadcastAction broadcastId={ID} surface="admin" subject="Autumn" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('button', { name: cancelLabel }).className).not.toContain('max-sm:hidden');
    expect(screen.queryByRole('button', { name: more })).toBeNull();
  });
});
