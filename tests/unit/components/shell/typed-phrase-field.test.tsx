/**
 * F119 U35 — the typed-phrase matcher and field shared by the E-Blast cancel
 * dialog (which now types the SUBJECT) and clear-halt (a member name).
 *
 * The matcher compares what a person SEES: NFKC, no emoji variation selector,
 * no zero-width characters, Thai combining marks in one order (the same
 * syllable can be typed with its marks in either order and renders the same),
 * whitespace collapsed, case and common punctuation ignored. Different base
 * letters still differ, so a misspelling still blocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TypedPhraseField,
  normalizeTypedPhrase,
  typedPhraseMatches,
} from '@/components/shell/typed-phrase-field';

describe('typedPhraseMatches — the normaliser', () => {
  it('ignores case, surrounding and repeated whitespace', () => {
    expect(typedPhraseMatches('  spring   MIXER ', 'Spring Mixer')).toBe(true);
  });

  it('ignores common punctuation, including a spaced dash', () => {
    expect(typedPhraseMatches('Spring mixer 2026', 'Spring mixer — 2026!')).toBe(true);
  });

  it('ignores the emoji variation selector (U+FE0F) and zero-width characters', () => {
    expect(typedPhraseMatches('Party ❤', 'Party ❤️')).toBe(true);
    expect(typedPhraseMatches('งานเลี้ยงประจำปี', 'งานเลี้ยง​ประจำปี')).toBe(true);
  });

  it('treats ำ (SARA AM) and ํา (NIKHAHIT + SARA AA) as the same', () => {
    expect(typedPhraseMatches('ประจําปี', 'ประจำปี')).toBe(true);
  });

  it('treats a Thai tone mark typed before or after its vowel as the same', () => {
    // กี่ — tone mark (U+0E48) and SARA II (U+0E35) in both typing orders.
    expect(typedPhraseMatches('ก่ี', 'กี่')).toBe(true);
    // น้ำ vs นํ้า — tone mark and the NIKHAHIT of ำ in both orders.
    expect(typedPhraseMatches('นํ้า', 'น้ำ')).toBe(true);
  });

  it('still refuses a different letter (Thai and Latin)', () => {
    expect(typedPhraseMatches('ก่ิ', 'ก่ี')).toBe(false);
    expect(typedPhraseMatches('cancle', 'cancel')).toBe(false);
  });

  it('normalises a punctuation-only phrase to empty (callers must not gate on it)', () => {
    expect(normalizeTypedPhrase(' !!! — ?? ')).toBe('');
    expect(normalizeTypedPhrase('​️')).toBe('');
  });
});

/** Controlled harness — the field is controlled, like both of its callers. */
function Harness({
  phrase,
  onSubmit,
  copy,
}: {
  readonly phrase: string;
  readonly onSubmit?: () => void;
  readonly copy?: { readonly label: string; readonly copiedMessage: string };
}): React.ReactElement {
  const [value, setValue] = useState('');
  return (
    <TypedPhraseField
      id="tp"
      label="Type the subject"
      phrase={phrase}
      value={value}
      onChange={setValue}
      errorMessage="Does not match"
      helpText="Case does not matter"
      {...(onSubmit ? { onSubmit } : {})}
      {...(copy ? { copy } : {})}
    />
  );
}

const input = (): HTMLElement => screen.getByLabelText('Type the subject');

describe('TypedPhraseField — behaviour', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('shows the WHOLE phrase, wrapped and scrollable, in body type', () => {
    const long = 'ก'.repeat(200);
    render(<Harness phrase={long} />);
    const target = screen.getByText(long);
    for (const cls of ['whitespace-pre-wrap', 'break-words', 'max-h-32', 'overflow-y-auto', 'text-sm', 'leading-relaxed']) {
      expect(target.className).toMatch(new RegExp(`(^|\\s)${cls}(\\s|$)`));
    }
    expect(target.className).not.toMatch(/font-mono/);
  });

  it('does not show the error on the first keystroke — only after blur', () => {
    render(<Harness phrase="Spring mixer" />);
    fireEvent.change(input(), { target: { value: 'x' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(input());
    expect(screen.getByRole('alert')).toHaveTextContent('Does not match');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input().getAttribute('aria-describedby')).toContain('tp-error');
  });

  it('shows the error once the input is as long as the phrase', () => {
    render(<Harness phrase="cancel" />);
    fireEvent.change(input(), { target: { value: 'cancl' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(input(), { target: { value: 'cancle' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows no error while an IME composition is in progress', () => {
    render(<Harness phrase="cancel" />);
    fireEvent.compositionStart(input());
    fireEvent.change(input(), { target: { value: 'cancle' } });
    fireEvent.blur(input());
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.compositionEnd(input());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Enter submits, but not while composing', () => {
    const onSubmit = vi.fn();
    render(<Harness phrase="cancel" onSubmit={onSubmit} />);
    fireEvent.change(input(), { target: { value: 'cancel' } });
    fireEvent.compositionStart(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('describes the input by the phrase and the help text', () => {
    render(<Harness phrase="Spring mixer" />);
    const ids = (input().getAttribute('aria-describedby') ?? '').split(/\s+/);
    const described = ids.map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain('Spring mixer');
    expect(described).toContain('Case does not matter');
  });

  it('the copy button copies the phrase and announces it politely', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<Harness phrase="Spring mixer" copy={{ label: 'Copy subject', copiedMessage: 'Copied' }} />);
    const button = screen.getByRole('button', { name: 'Copy subject' });
    expect(button.className).toMatch(/(^|\s)h-9(\s|$)/);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('Spring mixer');
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
  });

  it('renders no copy button when none is asked for (clear-halt)', () => {
    render(<Harness phrase="Acme Co" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
