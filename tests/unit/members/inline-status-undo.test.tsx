/**
 * Inline status-toggle Undo (057 UX #1 / ux-patterns §2.3).
 *
 * Flipping a member's status inline shows a success toast whose Undo re-runs the
 * same inline-edit handler with the PREVIOUS value — a pure client re-call, no
 * new backend. Uses the real `src/i18n/messages/en.json`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  MembersTable,
  type MembersTableRow,
} from '@/components/members/members-table';

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  // A shared fake-timer setup elsewhere would freeze `waitFor` (30s hang) —
  // pin real timers, same guard as bulk-action-bar-error-map.test.tsx.
  vi.useRealTimers();
  toastSuccess.mockClear();
});

function row(): MembersTableRow {
  return {
    member_id: 'm1',
    member_number_display: 'SCCM-0001',
    company_name: 'Test Co',
    country: 'TH',
    plan_id: 'plan-a',
    plan_year: 2026,
    plan_display_name: 'Corporate Gold',
    status: 'active',
    membership_lapsed: false,
    membership_suspended: false,
    engagement: null,
    last_activity_at: null,
    portal_state: 'not_invited',
    primary_contact: {
      contact_id: 'c1',
      first_name: 'Anna',
      last_name: 'Berg',
      email: 'anna@example.com',
      invite_bounced: false,
    },
  };
}

describe('inline status Undo', () => {
  it('flips status then offers an Undo that re-applies the previous value', async () => {
    const onInlineEdit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable
          rows={[row()]}
          nextCursor={null}
          enableSelection
          onInlineEdit={onInlineEdit}
        />
      </NextIntlClientProvider>,
    );

    // The status cell renders an inline toggle (aria-label "Toggle status …").
    fireEvent.click(screen.getByRole('button', { name: /toggle status/i }));

    // Applied the flipped value (active → inactive).
    await waitFor(() => expect(onInlineEdit).toHaveBeenCalledWith('m1', 'status', 'inactive'));

    // Success toast carries an Undo action.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [, opts] = toastSuccess.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void | Promise<void> } },
    ];
    expect(opts?.action?.label).toBe('Undo');

    // Undo re-runs the handler with the PREVIOUS value (inactive → active).
    await opts!.action!.onClick();
    await waitFor(() => expect(onInlineEdit).toHaveBeenCalledWith('m1', 'status', 'active'));
  });
});
