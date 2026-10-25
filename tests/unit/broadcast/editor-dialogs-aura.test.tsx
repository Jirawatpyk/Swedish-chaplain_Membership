/**
 * Spec 122 US12d-2 — the editor's link, button and image-description dialogs
 * are AURA `Dialog`s with AURA fields and footer buttons (the repo's AURA
 * form-dialog pattern: secondary Cancel, primary submit). Their validation,
 * copy and props are pinned by the dialogs' own tests; this file pins the
 * component layer and that `finalFocus` still decides where focus returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { LinkDialog } from '@/components/broadcast/link-dialog';
import { CtaButtonDialog } from '@/components/broadcast/cta-button-dialog';
import { ImageAltDialog } from '@/components/broadcast/image-alt-dialog';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
});

const noop = (): void => {};

const cases = [
  {
    name: 'link',
    confirm: /save link/i,
    fields: 2,
    el: (open: boolean, finalFocus?: () => HTMLElement | null) => (
      <LinkDialog
        open={open}
        onOpenChange={noop}
        onConfirm={noop}
        canRemove
        onRemove={noop}
        {...(finalFocus ? { finalFocus } : {})}
      />
    ),
  },
  {
    name: 'button',
    confirm: /insert button/i,
    fields: 2,
    el: (open: boolean, finalFocus?: () => HTMLElement | null) => (
      <CtaButtonDialog
        open={open}
        onOpenChange={noop}
        onConfirm={noop}
        {...(finalFocus ? { finalFocus } : {})}
      />
    ),
  },
  {
    name: 'image description',
    confirm: /insert image/i,
    fields: 1,
    el: (open: boolean, finalFocus?: () => HTMLElement | null) => (
      <ImageAltDialog
        open={open}
        onOpenChange={noop}
        variant="inline"
        onConfirm={noop}
        {...(finalFocus ? { finalFocus } : {})}
      />
    ),
  },
] as const;

const wrap = (node: React.ReactNode): React.ReactElement => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    {node}
  </NextIntlClientProvider>
);

describe.each(cases)('the $name dialog on AURA', ({ confirm, fields, el }) => {
  it('is an AURA Dialog with AURA fields, secondary Cancel and primary confirm', () => {
    render(wrap(el(true)));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('aura-dialog');
    expect(dialog.querySelectorAll('.aura-field')).toHaveLength(fields);
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toHaveClass('aura-btn--secondary');
    expect(within(dialog).getByRole('button', { name: confirm })).toHaveClass('aura-btn--primary');
  });

  it('returns focus to the finalFocus target on close', async () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    const { rerender } = render(wrap(el(true, () => target)));
    rerender(wrap(el(false, () => target)));
    await vi.waitFor(() => expect(document.activeElement).toBe(target));
    target.remove();
  });
});

it('the link dialog draws Remove as a ghost button', () => {
  render(wrap(cases[0].el(true)));
  expect(screen.getByRole('button', { name: /remove link/i })).toHaveClass('aura-btn--ghost');
});

/**
 * Mobile-a11y review LOW: AURA's field shows its error OR its hint, so the
 * character counter (the hint) vanished while the refusal showed. The counter
 * now rides inside the error, so "61 of 60 characters" stays seen and heard.
 */
describe('the counter stays with the refusal', () => {
  it('the button text field keeps its counter under the too-long error', async () => {
    render(wrap(cases[1].el(true)));
    const field = screen.getByLabelText(/button text/i);
    fireEvent.change(field, { target: { value: 'x'.repeat(61) } });
    fireEvent.click(screen.getByRole('button', { name: /insert button/i }));
    await screen.findByRole('alert');
    const described = (field.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('61 of 60 characters');
  });

  it('the image description keeps its counter under the empty error', async () => {
    render(wrap(cases[2].el(true)));
    fireEvent.click(screen.getByRole('button', { name: /insert image/i }));
    await screen.findByRole('alert');
    const field = screen.getByLabelText(/image description/i);
    const described = (field.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain('0 of 125 characters');
  });
});

/**
 * Mobile-a11y review suggestions, fixed at the user's word (25 Oct): the
 * link fields are URL fields on a phone keyboard (no autocorrect, no
 * capital first letter, "done" on the return key, the browser's URL
 * suggestions), and Enter that commits an IME composition in the image
 * description does not submit it half-typed.
 */
describe('mobile keyboards', () => {
  it.each([
    ['link', 0, /link address/i],
    ['button', 1, /button link/i],
  ] as const)('the %s dialog\'s URL field is a URL field for the keyboard', (_name, index, label) => {
    render(wrap(cases[index].el(true)));
    const field = screen.getByLabelText(label);
    expect(field).toHaveAttribute('inputmode', 'url');
    expect(field).toHaveAttribute('enterkeyhint', 'done');
    expect(field).toHaveAttribute('autocomplete', 'url');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(field).toHaveAttribute('autocapitalize', 'none');
  });

  it('Enter while an IME is composing does not submit the image description', () => {
    const onConfirm = vi.fn();
    render(wrap(<ImageAltDialog open onOpenChange={noop} variant="inline" onConfirm={onConfirm} />));
    const field = screen.getByLabelText(/image description/i);
    fireEvent.change(field, { target: { value: 'ทีมงานหอการค้า' } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('ทีมงานหอการค้า');
  });
});
