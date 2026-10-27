// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1266) — "Send options" replaces the "Leave blank to
 * submit for immediate review" checkbox on both compose forms (the
 * maintainer, 26 Oct 2026; board `Proposal-compose-inset-send-options`).
 * Collapsed, it is one line that states the current choice; expanded, one
 * optional "Schedule for later" field whose hint says that blank means now.
 * The value is unchanged: an ISO instant in Bangkok wall-time, or `null`.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { SchedulePicker } from '@/components/broadcast/schedule-picker';

const f = enMessages.portal.broadcasts.compose.fields;

/** The form holds the value, as both compose forms do. */
function Harness({ initial, onChange }: { initial: string | null; onChange: (v: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <SchedulePicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

function renderPicker(value: string | null, onChange = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness initial={value} onChange={onChange} />
    </NextIntlClientProvider>,
  );
  return onChange;
}

const disclosure = (): HTMLElement => screen.getByRole('button', { name: new RegExp(f.sendOptions) });

afterEach(cleanup);

describe('Send options (T1266)', () => {
  it('is one collapsed line stating the choice, with no checkbox', () => {
    renderPicker(null);
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure()).toHaveTextContent("As soon as it's approved");
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByLabelText(new RegExp(f.schedulePicker))).not.toBeVisible();
  });

  it('expands to an optional "Schedule for later" field whose hint says blank is now', () => {
    renderPicker(null);
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    const input = screen.getByLabelText(new RegExp(f.schedulePicker));
    expect(input).toHaveAttribute('type', 'datetime-local');
    expect(input).toHaveAccessibleDescription(new RegExp(f.scheduleHelp));
  });

  it('a time entered is sent as a Bangkok instant; clearing it is "now" again', () => {
    const onChange = renderPicker(null);
    fireEvent.click(disclosure());
    const input = screen.getByLabelText(new RegExp(f.schedulePicker));
    fireEvent.change(input, { target: { value: '2026-11-03T09:30' } });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-03T02:30:00.000Z');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('collapsed with a time set, the line states that time', () => {
    renderPicker('2026-11-03T02:30:00.000Z');
    expect(disclosure()).toHaveTextContent('3 November 2026 at 09:30, Bangkok time');
  });
});
