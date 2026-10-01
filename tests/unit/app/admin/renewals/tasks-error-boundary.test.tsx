/**
 * The escalation tasks page's own error boundary — 122 US7b-2 (T735): a throw
 * stops at the page, inside its TableContainer, with the shared AURA
 * RouteErrorPanel (error id and Retry) instead of blanking the admin shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import TasksError from '@/app/(staff)/admin/renewals/tasks/error';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('escalation tasks error boundary', () => {
  it('shows the error id and a working Retry inside the table container', () => {
    const reset = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <TasksError error={Object.assign(new Error('boom'), { digest: 'def456' })} reset={reset} />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'table');
    expect(container.querySelector('[role="alert"] .aura-empty')).not.toBeNull();
    expect(screen.getByText(/def456/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
