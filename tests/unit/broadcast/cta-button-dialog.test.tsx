/**
 * F119 T102 (FR-041) — the call-to-action button dialog.
 *
 * Senior-tester review BLOCKER: `src/components/broadcast/cta-button-dialog.tsx`
 * had ZERO tests, while its sibling `image-alt-dialog.tsx` has a full suite.
 * Two things it owns are load-bearing and were unasserted:
 *
 *   1. the SCHEME refusal. `zod.url()` accepts `javascript:` (it validates
 *      WHATWG URL shape, not scheme safety — the repo has been bitten by this
 *      before), so the dialog refuses with the SAME
 *      `BROADCAST_ALLOWED_URI_REGEXP` the shared content policy sanitises
 *      with. Deleting that check (`cta-button-dialog.tsx` `submit`, the
 *      `error === 'scheme'` arm) hands `javascript:alert(1)` to
 *      `onConfirm` — verified by mutation, see below.
 *   2. FR-041's NEGATIVE half: "colour, font, size and spacing belong to the
 *      platform" — the author MUST NOT be offered a control for them. A
 *      colour input added here would pass every behavioural test ever written
 *      for this file, so the shape is asserted directly.
 *
 * Both bounds come from the Domain re-export (`CTA_TEXT_MIN`/`MAX`), never a
 * literal, so a bound change moves the test with the code. Rendered under
 * `NextIntlClientProvider` with the REAL `en.json`, so a dangling `t()`
 * reference fails here instead of shipping a raw key path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { CtaButtonDialog } from '@/components/broadcast/cta-button-dialog';
import { CTA_TEXT_MAX } from '@/lib/design-blocks-client';

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof CtaButtonDialog>> = {},
) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CtaButtonDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { onConfirm, onOpenChange };
}

const textField = (): HTMLInputElement =>
  screen.getByLabelText(/button text/i) as HTMLInputElement;

const urlField = (): HTMLInputElement =>
  screen.getByLabelText(/button link/i) as HTMLInputElement;

const confirmButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /insert button/i }) as HTMLButtonElement;

/** Resolve `aria-describedby` to the combined text of what it points at. */
function describedText(el: Element): string {
  const ids = el.getAttribute('aria-describedby');
  expect(ids).toBeTruthy();
  return ids!
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

// The shared setup installs FAKE timers; userEvent schedules its inter-key
// delay on them, so without this every typing case dies on the test timeout.
beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T102 — the label is required, bounded, and its refusal is announced', () => {
  it('empty text refuses the insert and announces the error on the field', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.type(urlField(), 'https://swecham.example/join');
    await user.click(confirmButton());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const error = await screen.findByRole('alert');
    expect(error.textContent ?? '').not.toBe('');
    expect(textField()).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(textField())).toContain(error.textContent ?? '');
    // The link field is not the one at fault.
    expect(urlField()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('whitespace-only text is treated as empty', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.type(textField(), '   ');
    await user.type(urlField(), 'https://swecham.example/join');
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it(`text longer than ${CTA_TEXT_MAX} characters is refused, naming the bound`, async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    fireEvent.change(textField(), { target: { value: 'x'.repeat(CTA_TEXT_MAX + 1) } });
    await user.type(urlField(), 'https://swecham.example/join');
    await user.click(confirmButton());

    expect(onConfirm).not.toHaveBeenCalled();
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain(String(CTA_TEXT_MAX));
    expect(textField()).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('T102 — the link is required and scheme-checked IN THE DIALOG', () => {
  it('an empty link is refused with the error on the link field', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.type(textField(), 'Join us');
    await user.click(confirmButton());

    expect(onConfirm).not.toHaveBeenCalled();
    const error = await screen.findByRole('alert');
    expect(error.textContent ?? '').not.toBe('');
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(urlField())).toContain(error.textContent ?? '');
    expect(textField()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    ['javascript:alert(1)'],
    ['  javascript:alert(1)  '],
    ['ftp://files.example.com/report.pdf'],
    ['data:text/html;base64,PHNjcmlwdD4='],
  ])('refuses %s — onConfirm is never called', async (raw) => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.type(textField(), 'Join us');
    await user.type(urlField(), raw);
    await user.click(confirmButton());

    expect(
      onConfirm,
      'zod .url() accepts javascript: — the scheme allow-list is what refuses it',
    ).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const error = await screen.findByRole('alert');
    // The message says what IS allowed, not just that this failed.
    expect(error.textContent).toMatch(/https?/i);
    expect(error.textContent).toMatch(/mailto/i);
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
  });

  it.each([
    ['https://swecham.example/join'],
    ['http://swecham.example/join'],
    ['mailto:info@swecham.example'],
  ])('accepts %s, trimmed, and closes', async (raw) => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.type(textField(), '  Join us  ');
    await user.type(urlField(), `  ${raw}  `);
    await user.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ href: raw, text: 'Join us' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('the refusal clears once an allowed scheme is typed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(textField(), 'Join us');
    await user.type(urlField(), 'javascript:alert(1)');
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.clear(urlField());
    await user.type(urlField(), 'https://ok.example');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(urlField()).not.toHaveAttribute('aria-invalid', 'true');
  });
});

/**
 * FR-041: "Colour, font, size and spacing belong to the platform and the
 * chamber's brand settings" — the author is offered the label and the link,
 * and nothing else. This is the half no behavioural assertion can reach.
 */
describe('T102 — exactly two fields; no styling controls (FR-041)', () => {
  it('offers the label and the link and no third input, select or colour picker', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');

    const inputs = [...dialog.querySelectorAll('input')];
    expect(inputs).toHaveLength(2);
    expect(inputs).toEqual(expect.arrayContaining([textField(), urlField()]));

    expect(dialog.querySelector('input[type="color"]')).toBeNull();
    expect(dialog.querySelector('select')).toBeNull();
    expect(dialog.querySelectorAll('textarea')).toHaveLength(0);
    // …and no combobox standing in for a font / size / colour menu.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
