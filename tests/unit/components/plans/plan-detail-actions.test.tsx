/**
 * <PlanDetailActions> — the plan detail page's "⋯" menu (Activate /
 * Deactivate, Delete, Restore). Same endpoints, confirmation dialogs and
 * toasts as the plans list row menu (both use `usePlanActions`).
 *
 * Base UI Menu only renders its popup while open, via pointer interactions
 * jsdom does not model, so the dropdown primitives are swapped for inline
 * stand-ins (same pattern as invoice-more-menu.test.tsx).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

vi.mock('@/components/ui/dropdown-menu', () => {
  function DropdownMenu({ children }: { children?: React.ReactNode }) {
    return <div>{children}</div>;
  }
  function DropdownMenuTrigger({
    render: renderProp,
  }: {
    render?: (props: Record<string, unknown>) => React.ReactNode;
  }) {
    return <>{renderProp ? renderProp({}) : null}</>;
  }
  function DropdownMenuContent({ children }: { children?: React.ReactNode }) {
    return <div role="menu">{children}</div>;
  }
  function DropdownMenuItem({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) {
    return (
      <button type="button" role="menuitem" onClick={onClick}>
        {children}
      </button>
    );
  }
  function DropdownMenuSeparator() {
    return <hr />;
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  };
});

import { PlanDetailActions } from '@/components/plans/plan-detail-actions';

const fetchMock = vi.fn();

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

  it('labels the menu trigger with the plan name', () => {
    renderActions({ is_active: true, deleted: false });
    expect(screen.getByRole('button', { name: 'Actions for Diamond' })).toBeInTheDocument();
  });

  it('deactivates an active plan after confirmation', async () => {
    renderActions({ is_active: true, deleted: false });
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
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        '3 active members are on this plan. Move them to another plan before deleting.',
      ),
    );
  });
});
