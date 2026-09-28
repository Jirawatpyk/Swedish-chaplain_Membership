/**
 * The inline status toggle's accessible name + tooltip name the CURRENT status
 * with the same translated label the StatusBadge shows ("Active"), not the raw
 * status code ("active") — otherwise TH/SV screen readers hear an English enum.
 * Uses the real `src/i18n/messages/en.json`.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  MembersTable,
  type MembersTableRow,
} from '@/components/members/members-table';

// Base UI Checkbox uses PointerEvent internally; jsdom lacks it.
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

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
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

describe('inline status toggle label', () => {
  it('names the current status with the translated label, not the raw code', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MembersTable rows={[row()]} enableSelection onInlineEdit={vi.fn()} />
      </NextIntlClientProvider>,
    );

    const toggle = screen.getByRole('button', { name: /toggle status/i });
    expect(toggle).toHaveAccessibleName('Toggle status (currently Active)');
    expect(toggle).toHaveAttribute('title', 'Toggle status (currently Active)');
  });
});
