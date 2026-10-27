/**
 * Spec 122 US12d-3 (T1270) — the segment picker on AURA.
 *
 * The tier-codes field used to be controlled by `tierCodes.join(', ')`, so the
 * comma typed after the first code was split away on the very next render and
 * a second code could never be typed ("premium," → "premium"). The field now
 * keeps the typed text and only derives the codes from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { SegmentPicker, type SegmentPickerValue } from '@/components/broadcast/segment-picker';

const seen: SegmentPickerValue[] = [];

function Host(): React.ReactElement {
  const [value, setValue] = useState<SegmentPickerValue>({ kind: 'tier', tierCodes: [] });
  return (
    <SegmentPicker
      value={value}
      onChange={(next) => {
        seen.push(next);
        setValue(next);
      }}
    />
  );
}

beforeEach(() => {
  // The shared setup installs fake timers; userEvent never resolves under them.
  vi.useRealTimers();
  seen.length = 0;
});
afterEach(() => cleanup());

describe('SegmentPicker (T1270)', () => {
  it('two tier codes can be typed, comma and all', async () => {
    const user = userEvent.setup();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Host />
      </NextIntlClientProvider>,
    );

    const field = screen.getByLabelText('Tier code');
    await user.type(field, 'premium, large');

    expect(field).toHaveValue('premium, large');
    expect(seen.at(-1)).toEqual({ kind: 'tier', tierCodes: ['premium', 'large'] });
  });

  it('names the radios by their option and the group by its legend', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Host />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('group', { name: 'Recipients' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Specific membership tier' })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });
});
