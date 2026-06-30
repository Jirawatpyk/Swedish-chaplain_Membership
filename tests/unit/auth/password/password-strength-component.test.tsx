/**
 * `<PasswordStrength>` caption + colour test.
 *
 * The bar now shows a REASON-specific caption for the weak case
 * (too-short / low-variety / server-rejected) instead of one generic
 * line. Render against the REAL en.json so a missing key would surface
 * here as MISSING_MESSAGE (next-intl), which the key-echoing mocks in
 * the form tests cannot catch. Also pins that a server-rejected meter
 * paints the bar red (bg-destructive), the visual the bar-reset UX fix
 * is meant to deliver.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  PasswordStrength,
  type PasswordStrengthProps,
} from '@/components/auth/password-strength';

function renderBar(props: PasswordStrengthProps) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PasswordStrength {...props} />
    </NextIntlClientProvider>,
  );
}

describe('PasswordStrength caption', () => {
  it.each([
    ['tooShort', 'Weak — use at least 12 characters.'],
    ['lowVariety', 'Weak — mix in more varied characters.'],
    ['rejected', 'Weak — choose a different password.'],
  ] as const)('weak + %s → reason-specific caption', (weakReason, message) => {
    const { getByText } = renderBar({ level: 'weak', weakReason });
    expect(getByText(message)).toBeTruthy();
  });

  it('weak with no reason → generic fallback caption', () => {
    const { getByText } = renderBar({ level: 'weak' });
    expect(getByText('Weak — use a longer, more varied password.')).toBeTruthy();
  });

  it.each([
    ['acceptable', 'Acceptable strength.'],
    ['strong', 'Strong password.'],
  ] as const)('%s → its own caption (weakReason ignored)', (level, message) => {
    // A stray weakReason must not leak into non-weak levels.
    const { getByText } = renderBar({ level, weakReason: 'tooShort' });
    expect(getByText(message)).toBeTruthy();
  });

  it('empty → renders no caption', () => {
    const { container } = renderBar({ level: 'empty' });
    expect(container.querySelector('p')).toBeNull();
  });

  it('a server-rejected (weak) bar paints the first segment red', () => {
    const { container } = renderBar({ level: 'weak', weakReason: 'rejected' });
    expect(container.querySelector('.bg-destructive')).not.toBeNull();
  });
});
