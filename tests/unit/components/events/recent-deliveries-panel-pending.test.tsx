/**
 * Recent deliveries while the "Include test deliveries" toggle is
 * navigating: the switch stays in the Tab order (read-only, not
 * disabled), so keyboard focus does not drop to the page; a click while
 * pending changes nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useTransition: () => [true, (fn: () => void) => fn()] };
});

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
  usePathname: () => '/admin/settings/integrations/eventcreate',
  useSearchParams: () => new URLSearchParams(),
}));

const { RecentDeliveriesPanel } = await import('@/components/events/recent-deliveries-panel');

const r = en.admin.integrations.eventcreate.phaseC.recentDeliveries;

describe('<RecentDeliveriesPanel> while the toggle is pending', () => {
  it('keeps the switch focusable and read-only', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
        <RecentDeliveriesPanel deliveries={[]} includeTestDeliveries={false} />
      </NextIntlClientProvider>,
    );
    const toggle = screen.getByRole('switch', { name: r.includeTestDeliveriesLabel });
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute('aria-readonly', 'true');
    fireEvent.click(toggle);
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
