/**
 * Spec 122 US12d-2 — the editor's link, button and image-description dialogs
 * are AURA `Dialog`s with AURA fields and footer buttons (the repo's AURA
 * form-dialog pattern: secondary Cancel, primary submit). Their validation,
 * copy and props are pinned by the dialogs' own tests; this file pins the
 * component layer and that `finalFocus` still decides where focus returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
