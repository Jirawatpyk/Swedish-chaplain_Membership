/**
 * The reminder schedules page's own error boundary — 122 US7b-2 (T738): a
 * throw stops at the page, inside its FormContainer, with the shared AURA
 * RouteErrorPanel (error id and Retry), instead of blanking the admin shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import SchedulesError from '@/app/(staff)/admin/settings/renewals/schedules/error';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('reminder schedules error boundary', () => {
  it('shows the error id and a working Retry inside the form container', () => {
    const reset = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SchedulesError error={Object.assign(new Error('boom'), { digest: 'sch789' })} reset={reset} />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'form');
    expect(container.querySelector('[role="alert"] .aura-empty')).not.toBeNull();
    expect(screen.getByText(/sch789/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
