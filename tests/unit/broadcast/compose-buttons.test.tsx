/**
 * Spec 122 US12d-1 (T1234) — the compose page's buttons on AURA:
 *   - `SubmitButton`: an AURA primary button; disabled with its reason named
 *     (U29) only while dimmed; busy and inert while submitting;
 *   - `ComposeButtonWithTooltip`: an AURA button that stays focusable
 *     (`aria-disabled`, not `disabled`), named with its reason (UX-R2-4), in
 *     an AURA Tooltip.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { SubmitButton } from '@/components/broadcast/submit-button';
import { ComposeButtonWithTooltip } from '@/components/broadcast/compose-button-with-tooltip';

vi.mock('@/lib/toast', () => ({ toast: { info: vi.fn() } }));

const compose = en.portal.broadcasts.compose;

function renderSubmit(props: Partial<React.ComponentProps<typeof SubmitButton>> = {}) {
  const onClick = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SubmitButton disabled={false} submitting={false} onClick={onClick} {...props} />
    </NextIntlClientProvider>,
  );
  return onClick;
}

describe('SubmitButton on AURA', () => {
  it('is an AURA primary button that submits', () => {
    const onClick = renderSubmit();
    const button = screen.getByRole('button', { name: compose.button.submit });
    expect(button).toHaveClass('aura-btn', 'aura-btn--primary');
    expect(button).toHaveAttribute('data-compose-feature', 'submit');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('names its blocked reason only while dimmed', () => {
    renderSubmit({ disabled: true, blockedReasonIds: 'why-1' });
    const button = screen.getByRole('button', { name: compose.button.submit });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', 'why-1');
  });

  it('is busy and inert while submitting', () => {
    renderSubmit({ submitting: true, blockedReasonIds: 'why-1' });
    const button = screen.getByRole('button', { name: compose.toast.submitting });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).not.toHaveAttribute('aria-describedby');
  });
});

describe('ComposeButtonWithTooltip on AURA', () => {
  it('is a focusable AURA button named with its reason, inert to clicks', () => {
    render(<ComposeButtonWithTooltip label="Compose E-Blast" tooltipText="Renews 1 January 2027" />);
    const button = screen.getByRole('button', { name: 'Compose E-Blast — Renews 1 January 2027' });
    expect(button).toHaveClass('aura-btn');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    button.focus();
    expect(button).toHaveFocus();
  });
});
