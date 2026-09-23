/**
 * F119 T089 + T099 (US3-AS2, FR-040) — an image cannot be inserted without a
 * 1–125-character description, and an empty one is an ANNOUNCED field error.
 *
 * The dialog is a DESCRIPTION dialog, never an upload field: it is opened
 * before the image node can exist, so the alt text is carried into the node
 * (and therefore into the delivered email) rather than being an afterthought
 * a member can skip. "Announced" means the field is `aria-invalid`, its error
 * is referenced by `aria-describedby`, and the error element is a live region
 * — not a red border a screen-reader user never hears.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json`, so a
 * dangling `t()` reference fails here instead of shipping a raw key path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ImageAltDialog } from '@/components/broadcast/image-alt-dialog';
import { BANNER_ALT_MAX } from '@/lib/design-blocks-client';

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ImageAltDialog>> = {},
) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ImageAltDialog
        open
        onOpenChange={onOpenChange}
        variant="inline"
        onConfirm={onConfirm}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { onConfirm, onOpenChange };
}

const field = (): HTMLTextAreaElement | HTMLInputElement =>
  screen.getByLabelText(/image description/i) as HTMLTextAreaElement;

const insertButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /insert/i }) as HTMLButtonElement;

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

describe('T089 — insert is refused with an announced error until a description is given', () => {
  it('offers a LABELLED description field and is not an upload field', () => {
    renderDialog();
    expect(field()).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('an empty description refuses the insert and announces the error', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.click(insertButton());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const error = await screen.findByRole('alert');
    expect(error.textContent ?? '').not.toBe('');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(describedText(field())).toContain(error.textContent ?? '');
  });

  it('whitespace only is treated as empty', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.type(field(), '   ');
    await user.click(insertButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it(`a description longer than ${BANNER_ALT_MAX} characters is refused, naming the bound`, async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    fireEvent.change(field(), { target: { value: 'x'.repeat(BANNER_ALT_MAX + 1) } });
    await user.click(insertButton());

    expect(onConfirm).not.toHaveBeenCalled();
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain(String(BANNER_ALT_MAX));
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });

  it('a 1–125-character description inserts, trimmed, and closes the dialog', async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.type(field(), '  Chart of member growth  ');
    await user.click(insertButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('Chart of member growth');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('the error clears once a valid description is typed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(insertButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.type(field(), 'A chart');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid', 'true');
  });
});

describe('T099 — the banner variant is the same dialog with banner copy', () => {
  it('names the banner in its heading and still requires a description', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ variant: 'banner' });

    expect(screen.getByRole('heading', { name: /banner/i })).toBeInTheDocument();

    await user.click(insertButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
