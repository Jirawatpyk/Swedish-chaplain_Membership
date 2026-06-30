/**
 * EventCreateInlineModal — field errors announced via role="alert" (audit XF-07).
 *
 * The four inline field errors used aria-live="polite" (announced unreliably
 * when inserted); they must use role="alert" (assertive) like every other form.
 * Rendered against real en.json with the dialog open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { EventCreateInlineModal } from '@/components/events/event-create-inline-modal';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

beforeEach(() => {
  vi.useRealTimers();
});

describe('EventCreateInlineModal', () => {
  it('renders field validation errors with role="alert" on an empty submit', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <EventCreateInlineModal open onOpenChange={vi.fn()} />
      </NextIntlClientProvider>,
    );

    const form = document.querySelector('form');
    if (!form) throw new Error('event modal form did not render');
    fireEvent.submit(form);

    // Empty submit fails externalId / name / startDate → role=alert messages.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    // The required-field messages are the assertive field errors (not a polite
    // live region that may be missed on insertion).
    expect(
      alerts.some((el) => el.className.includes('text-destructive')),
    ).toBe(true);
  });
});
