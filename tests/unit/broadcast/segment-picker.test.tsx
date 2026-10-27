/**
 * Spec 122 US12d-3 (T1270) — the segment picker on AURA.
 *
 * PR D (27 Oct 2026, FR-011): the tier option used to be a free-text "Tier
 * code" field ("premium, large"), but the recipient query matches only the
 * two `plan_category` values, case-sensitively, so anything else reached
 * nobody. It is now a choice of the two categories, more than one allowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import { SegmentPicker, type SegmentPickerValue } from '@/components/broadcast/segment-picker';

const seen: SegmentPickerValue[] = [];

function Host({ initial }: { readonly initial?: SegmentPickerValue }): React.ReactElement {
  const [value, setValue] = useState<SegmentPickerValue>(initial ?? { kind: 'tier', tierCodes: [] });
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

function renderPicker(locale: 'en' | 'th' = 'en', initial?: SegmentPickerValue): void {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en}>
      <Host {...(initial ? { initial } : {})} />
    </NextIntlClientProvider>,
  );
}

const cat = en.portal.broadcasts.list.tierCode;

beforeEach(() => {
  // The shared setup installs fake timers; userEvent never resolves under them.
  vi.useRealTimers();
  seen.length = 0;
});
afterEach(() => cleanup());

describe('SegmentPicker (T1270)', () => {
  it('names the radios by their option and the group by its legend', () => {
    renderPicker();
    expect(screen.getByRole('group', { name: 'Recipients' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Specific membership tier' })).toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(4);
  });
});

describe('the tier option is a choice of membership categories (PR D)', () => {
  it('shows the two categories as checkboxes in a named group, and no text field', () => {
    renderPicker();
    const group = screen.getByRole('group', { name: en.portal.broadcasts.compose.tierLabel });
    expect(group).toHaveTextContent(en.portal.broadcasts.compose.fields.tierCodesHelp);
    expect(screen.getByRole('checkbox', { name: cat.corporate })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: cat.partnership })).not.toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('ticking both gives both codes, in a fixed order', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('checkbox', { name: cat.partnership }));
    expect(seen.at(-1)).toEqual({ kind: 'tier', tierCodes: ['partnership'] });
    await user.click(screen.getByRole('checkbox', { name: cat.corporate }));
    expect(seen.at(-1)).toEqual({ kind: 'tier', tierCodes: ['corporate', 'partnership'] });
  });

  it('unticking the last one gives no codes', async () => {
    const user = userEvent.setup();
    renderPicker('en', { kind: 'tier', tierCodes: ['corporate'] });
    const corporate = screen.getByRole('checkbox', { name: cat.corporate });
    expect(corporate).toBeChecked();
    await user.click(corporate);
    expect(seen.at(-1)).toEqual({ kind: 'tier', tierCodes: [] });
  });

  it('a code that is not a category is dropped on the next change', async () => {
    const user = userEvent.setup();
    renderPicker('en', { kind: 'tier', tierCodes: ['premium'] });
    await user.click(screen.getByRole('checkbox', { name: cat.corporate }));
    expect(seen.at(-1)).toEqual({ kind: 'tier', tierCodes: ['corporate'] });
  });

  it('choosing another kind clears the categories', async () => {
    const user = userEvent.setup();
    renderPicker('en', { kind: 'tier', tierCodes: ['corporate'] });
    await user.click(screen.getByRole('radio', { name: 'All members' }));
    expect(seen.at(-1)).toEqual({ kind: 'all_members', tierCodes: [] });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('names the categories in Thai', () => {
    renderPicker('th');
    expect(screen.getByRole('checkbox', { name: th.portal.broadcasts.list.tierCode.corporate })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: th.portal.broadcasts.list.tierCode.partnership })).toBeInTheDocument();
  });
});
