/**
 * WP8 (BP5 item 7) — segment error boundaries.
 *
 * The tier-upgrade queue boundary stays inside the page's TableContainer; the
 * new member-edit boundary uses a FormContainer so a throw no longer bubbles
 * to the 72rem member-detail boundary (the 42→72rem width jump).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';
import TierUpgradesError from '@/app/(staff)/admin/renewals/tier-upgrades/error';
import EditMemberError from '@/app/(staff)/admin/members/[memberId]/edit/error';

type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

function renderErr(
  Comp: (props: ErrorBoundaryProps) => ReactElement,
  props: ErrorBoundaryProps,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Comp {...props} />
    </NextIntlClientProvider>,
  );
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe('tier-upgrades error boundary', () => {
  it('shows the generic copy, the error id, and a working retry', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });
    renderErr(TierUpgradesError, { error, reset });
    expect(screen.getAllByText(en.errors.generic).length).toBeGreaterThan(0);
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('renders inside the table layout container', () => {
    const { container } = renderErr(TierUpgradesError, {
      error: new Error('x'),
      reset: vi.fn(),
    });
    expect(
      container.querySelector('[data-slot="layout-container"]'),
    ).toHaveAttribute('data-variant', 'table');
  });
});

describe('member-edit error boundary (width-jump fix)', () => {
  it('renders inside the FORM layout container, not the detail container', () => {
    const { container } = renderErr(EditMemberError, {
      error: new Error('x'),
      reset: vi.fn(),
    });
    expect(
      container.querySelector('[data-slot="layout-container"]'),
    ).toHaveAttribute('data-variant', 'form');
  });
});
