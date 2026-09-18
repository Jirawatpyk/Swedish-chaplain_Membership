/**
 * F119 T100 (FR-038) — the link dialog refuses a scheme outside
 * http / https / mailto IN THE DIALOG, with an inline message.
 *
 * Why here and not only at the sanitiser: `zod`'s `.url()` accepts
 * `javascript:` (it validates WHATWG URL shape, not scheme safety), and a
 * link accepted in the editor and stripped later is the exact
 * "silently removed between editor and delivered email" failure SC-011
 * forbids. The allow-list asserted here is the SAME
 * `BROADCAST_ALLOWED_URI_REGEXP` the shared content policy sanitises with —
 * a second copy would drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { LinkDialog } from '@/components/broadcast/link-dialog';

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof LinkDialog>> = {},
) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  const onRemove = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LinkDialog
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
        onRemove={onRemove}
        initialText="Read the report"
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { onConfirm, onOpenChange, onRemove };
}

const urlField = (): HTMLInputElement =>
  screen.getByLabelText(/link address/i) as HTMLInputElement;

const saveButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /save link/i }) as HTMLButtonElement;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('T100 — `javascript:alert(1)` and `ftp://…` are refused in the dialog', () => {
  it.each([
    ['javascript:alert(1)'],
    ['ftp://files.example.com/report.pdf'],
    ['data:text/html;base64,PHNjcmlwdD4='],
    ['  javascript:alert(1)  '],
  ])('refuses %s with an inline message and no confirm', async (raw) => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.type(urlField(), raw);
    await user.click(saveButton());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const error = await screen.findByRole('alert');
    // The message tells the author what IS allowed, not just that this failed.
    expect(error.textContent).toMatch(/https?/i);
    expect(error.textContent).toMatch(/mailto/i);
    expect(urlField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('an empty address is refused too', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(saveButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('T100 — the three allowed schemes go through', () => {
  it.each([
    ['https://swecham.example/report'],
    ['http://swecham.example/report'],
    ['mailto:info@swecham.example'],
  ])('accepts %s', async (raw) => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = renderDialog();

    await user.type(urlField(), `  ${raw}  `);
    await user.click(saveButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      href: raw,
      text: 'Read the report',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('carries the edited link text (FR-038 — links with editable link text)', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ initialText: '' });

    await user.type(urlField(), 'https://swecham.example');
    await user.type(screen.getByLabelText(/link text/i), 'Our 2026 report');
    await user.click(saveButton());

    expect(onConfirm).toHaveBeenCalledWith({
      href: 'https://swecham.example',
      text: 'Our 2026 report',
    });
  });

  it('the refusal clears once an allowed scheme is typed', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(urlField(), 'javascript:alert(1)');
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.clear(urlField());
    await user.type(urlField(), 'https://ok.example');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(urlField()).not.toHaveAttribute('aria-invalid', 'true');
  });
});

describe('T100 — removing a link', () => {
  it('offers Remove only when a link is under the cursor', async () => {
    const user = userEvent.setup();
    const { onRemove } = renderDialog({ canRemove: true, initialHref: 'https://x.example' });
    await user.click(screen.getByRole('button', { name: /remove link/i }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('hides Remove when there is no link to remove', () => {
    renderDialog({ canRemove: false });
    expect(screen.queryByRole('button', { name: /remove link/i })).toBeNull();
  });
});
