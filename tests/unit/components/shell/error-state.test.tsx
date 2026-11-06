/**
 * PR O — `ErrorState` is AURA's EmptyState in the danger tone: a live alert
 * with the generic or given title, the description, and the retry button.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ErrorState } from '@/components/shell/error-state';
import enMessages from '@/i18n/messages/en.json';

afterEach(() => cleanup());

function renderState(props: React.ComponentProps<typeof ErrorState>) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErrorState {...props} />
    </NextIntlClientProvider>,
  );
}

describe('ErrorState', () => {
  it('is an AURA danger EmptyState announced as an alert, with the title and description', () => {
    renderState({ title: 'Could not load members', description: 'Try again in a moment.' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('aura-empty', 'is-danger');
    expect(alert).toHaveTextContent('Could not load members');
    expect(alert).toHaveTextContent('Try again in a moment.');
  });

  it('falls back to the generic title, and offers retry only when given', () => {
    const onRetry = vi.fn();
    const { rerender } = renderState({});
    expect(screen.getByRole('alert')).toHaveTextContent(enMessages.errors.generic);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ErrorState onRetry={onRetry} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: enMessages.buttons.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
