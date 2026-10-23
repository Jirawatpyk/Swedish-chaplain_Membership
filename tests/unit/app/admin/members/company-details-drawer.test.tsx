/**
 * Layout B — "All company details" opens the full record in a Drawer; when it
 * closes, focus returns to the trigger even where a click does not focus the
 * button (Safari), so the next Tab continues from there (2.4.3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompanyDetailsDrawer } from '@/app/(staff)/admin/members/[memberId]/_components/company-details-drawer';

describe('CompanyDetailsDrawer', () => {
  // AURA's close animation runs on real timers (setup.ts fakes them).
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));

  it('returns focus to the trigger after a mouse open and an Escape close', async () => {
    render(
      <CompanyDetailsDrawer triggerLabel="All company details" title="Siam Nordic" closeLabel="Close company details">
        <p>record</p>
      </CompanyDetailsDrawer>,
    );
    const trigger = screen.getByRole('button', { name: 'All company details' });
    // a mouse click in Safari leaves focus on <body>
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Siam Nordic' });
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  // R73c: on a member with no Tax ID or website the record's first focusable is
  // a copy button inside the closed Technical disclosure, which Chromium will not
  // focus, so focus stayed on the trigger and Esc did nothing. The Close button
  // is always shown, so the Drawer opens with focus there.
  it('moves focus to its Close button when it opens', async () => {
    render(
      <CompanyDetailsDrawer triggerLabel="All company details" title="Siam Nordic" closeLabel="Close company details">
        <details>
          <summary>Technical details</summary>
          <button type="button">Copy member number</button>
        </details>
      </CompanyDetailsDrawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'All company details' }));
    await screen.findByRole('dialog', { name: 'Siam Nordic' });
    expect(screen.getByRole('button', { name: 'Close company details' })).toHaveFocus();
  });
});
