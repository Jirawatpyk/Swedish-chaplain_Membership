/**
 * <PlanDetailActions> — the plan detail page's "⋯" menu (Activate /
 * Deactivate, Delete, Restore). Same endpoints, confirmation dialogs and
 * toasts as the plans list row menu (both use `usePlanActions`).
 *
 * 122 US6 (T603): AURA's DropdownMenu behind an IconButton named "More
 * actions for {plan}" (board `Admin-plan-detail`); each test opens it first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

import { PlanDetailActions } from '@/components/plans/plan-detail-actions';

const fetchMock = vi.fn();

/** Opens the AURA menu from its trigger. */
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Diamond' }));
}

function renderActions(state: { is_active: boolean; deleted: boolean }) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanDetailActions
        plan={{
          plan_id: 'diamond',
          plan_year: 2026,
          plan_name: { en: 'Diamond' },
          is_active: state.is_active,
          deleted_at: state.deleted ? '2026-03-01T00:00:00.000Z' : null,
        }}
      />
    </NextIntlClientProvider>,
  );
}

describe('PlanDetailActions', () => {
  beforeEach(() => {
    // tests/setup.ts fakes setTimeout for the whole run; findBy*/waitFor
    // poll on it, so this suite runs on real timers.
    vi.useRealTimers();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('labels the menu trigger with the plan name, an AURA icon button', () => {
    renderActions({ is_active: true, deleted: false });
    const trigger = screen.getByRole('button', { name: 'More actions for Diamond' });
    expect(trigger).toHaveClass('aura-icon-btn');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('deactivates an active plan after confirmation', async () => {
    renderActions({ is_active: true, deleted: false });
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Activate' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plans/2026/diamond/deactivate',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Plan “Diamond” deactivated.'),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('activates an inactive plan straight away', async () => {
    renderActions({ is_active: false, deleted: false });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Activate' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plans/2026/diamond/activate',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('deletes after confirmation', async () => {
    renderActions({ is_active: true, deleted: false });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plans/2026/diamond',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });

  it('offers only Restore on a deleted plan', async () => {
    renderActions({ is_active: false, deleted: true });
    openMenu();
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Restore']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/plans/2026/diamond/undelete',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('shows the member-attached error when delete is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        error: { code: 'plan_has_active_members', details: { affected_member_count: 3 } },
      }),
    });
    renderActions({ is_active: true, deleted: false });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '3 active members are on this plan. Move them to another plan before deleting.',
      ),
    );
  });
});
