/**
 * The cycle detail page's own error boundary (spec 122 US7b-1, UX review L10):
 * a throw stops at the page, inside its DetailContainer, with the shared AURA
 * RouteErrorPanel (error id and Retry), as every migrated route shows one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import CycleDetailError from '@/app/(staff)/admin/renewals/[cycleId]/error';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('cycle detail error boundary', () => {
  it('shows the error id and a working Retry inside the detail container', () => {
    const reset = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <CycleDetailError error={Object.assign(new Error('boom'), { digest: 'abc123' })} reset={reset} />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector('[data-slot="layout-container"]')).toHaveAttribute('data-variant', 'detail');
    expect(container.querySelector('[role="alert"] .aura-empty')).not.toBeNull();
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
