// @vitest-environment jsdom
/**
 * F119 UX review (T084 follow-up) — the shared <ReasonConfirmationDialog>
 * while a request runs and after the server refuses it (ux-standards § 6.2,
 * § 6.4, § 4.1):
 *
 *   - H2: Confirm keeps focus while busy (`focusableWhenDisabled` +
 *     `aria-busy`, a motion-safe spinner); the fields turn read-only rather
 *     than `disabled`, so focus never drops to <body>. The idle, invalid
 *     Confirm stays natively disabled (existing callers assert that).
 *   - A refusal is focused: the reason field when it names the field, else
 *     the inline error line.
 *   - M1: an identical refusal repeated (a new `seq`) is a NEW alert node, so
 *     it is announced again.
 *   - L3: leaving the blank reason for the Cancel button is not an error.
 *   - L4: the too-long error sits immediately under the field it describes.
 *   - L5: Escape does not close the dialog while the request runs.
 *   - M2: `confirmTone="primary"` paints a non-destructive Confirm; the
 *     default stays destructive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import {
  ReasonConfirmationDialog,
  type ReasonConfirmationDialogProps,
} from '@/components/shell/reason-confirmation-dialog';

const NS = 'portal.broadcasts.approval.requestChanges';
const T = en.portal.broadcasts.approval.requestChanges;

beforeEach(() => {
  // The shared setup installs fake timers; Base UI focus + waitFor need real ones.
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.useFakeTimers();
});

function ui(over: Partial<ReasonConfirmationDialogProps> = {}): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <ReasonConfirmationDialog
        open
        onOpenChange={vi.fn()}
        namespace={NS}
        maxLength={20}
        reasonRequired
        fieldIdPrefix="rc-reason"
        textareaRows={4}
        onConfirm={vi.fn(async () => undefined)}
        finalFocus={() => null}
        announceBlankReason
        {...over}
      />
    </NextIntlClientProvider>
  );
}

const reasonField = (): HTMLTextAreaElement => screen.getByLabelText(T.reasonLabel) as HTMLTextAreaElement;
const confirmButton = (): HTMLElement => screen.getByRole('button', { name: T.confirm });

/** Lets the open-time focus (Base UI initial focus, the double-RAF auto-focus) land first. */
async function settleOpenFocus(): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await new Promise<void>((r) => setTimeout(r, 20));
}

/** A request that stays in flight until the test says otherwise. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ReasonConfirmationDialog — while the request runs (H2)', () => {
  it('Confirm keeps focus, says it is busy and spins; the fields turn read-only, not disabled', async () => {
    const inFlight = deferred();
    render(ui({ onConfirm: () => inFlight.promise }));
    await settleOpenFocus();
    fireEvent.change(reasonField(), { target: { value: 'The date is wrong' } });
    const confirm = confirmButton();
    confirm.focus();
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toHaveAttribute('aria-busy', 'true'));
    expect(confirm).not.toHaveAttribute('disabled');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(confirm);
    expect(confirm.querySelector('svg.motion-safe\\:animate-spin')).not.toBeNull();
    expect(reasonField()).not.toBeDisabled();
    expect(reasonField()).toHaveAttribute('readonly');

    inFlight.resolve();
    await waitFor(() => expect(confirm).not.toHaveAttribute('aria-busy'));
  });

  it('the typed-phrase input is read-only (not disabled) while the request runs', async () => {
    const inFlight = deferred();
    render(
      <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
        <ReasonConfirmationDialog
          open
          onOpenChange={vi.fn()}
          namespace="portal.broadcasts.detail.cancelDialog"
          maxLength={500}
          reasonRequired={false}
          fieldIdPrefix="cancel-reason"
          textareaRows={4}
          onConfirm={() => inFlight.promise}
          finalFocus={() => null}
          typedPhrase="Autumn mixer"
        />
      </NextIntlClientProvider>,
    );
    await settleOpenFocus();
    const phrase = screen.getByLabelText(en.portal.broadcasts.detail.cancelDialog.subjectLabel);
    fireEvent.change(phrase, { target: { value: 'Autumn mixer' } });
    phrase.focus();
    fireEvent.keyDown(phrase, { key: 'Enter' });

    await waitFor(() => expect(phrase).toHaveAttribute('readonly'));
    expect(phrase).not.toBeDisabled();
    expect(document.activeElement).toBe(phrase);
    inFlight.resolve();
  });

  it('the idle, invalid Confirm stays natively disabled (existing callers rely on it)', () => {
    render(ui());
    expect(confirmButton()).toBeDisabled();
  });

  it('Escape does not close the dialog while the request runs (L5) — and does once it settles', async () => {
    const inFlight = deferred();
    const onOpenChange = vi.fn();
    render(ui({ onOpenChange, onConfirm: () => inFlight.promise }));
    fireEvent.change(reasonField(), { target: { value: 'x' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton()).toHaveAttribute('aria-busy', 'true'));

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false, expect.anything());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    inFlight.resolve();
    await waitFor(() => expect(confirmButton()).not.toHaveAttribute('aria-busy'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalled());
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });
});

describe('ReasonConfirmationDialog — a refusal inside the open dialog', () => {
  it('a form-level refusal is focused', async () => {
    const { rerender } = render(ui());
    await waitFor(() => expect(document.activeElement).toBe(reasonField()));
    // A refusal only follows a submitted (non-blank) reason.
    fireEvent.change(reasonField(), { target: { value: 'The date is wrong' } });
    rerender(ui({ refusal: { message: 'Too many attempts', field: null, seq: 1 } }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it('a refusal that names the reason focuses the reason field', async () => {
    const { rerender } = render(ui());
    // The required reason auto-focuses on open; move away first, so only the
    // refusal can bring focus back.
    await waitFor(() => expect(document.activeElement).toBe(reasonField()));
    screen.getByRole('button', { name: T.cancel }).focus();
    rerender(ui({ refusal: { message: 'Give a reason', field: 'reason', seq: 1 } }));
    await waitFor(() => expect(document.activeElement).toBe(reasonField()));
  });

  it('an identical refusal repeated is a NEW alert node, so it is announced again (M1)', async () => {
    const { rerender } = render(ui({ refusal: { message: 'Too many attempts', field: null, seq: 1 } }));
    const first = screen.getByRole('alert');
    rerender(ui({ refusal: { message: 'Too many attempts', field: null, seq: 2 } }));
    const second = screen.getByRole('alert');
    expect(second).toHaveTextContent('Too many attempts');
    expect(second).not.toBe(first);
  });
});

describe('ReasonConfirmationDialog — field errors', () => {
  it('leaving the blank reason for the Cancel button is not an error (L3)', () => {
    render(ui());
    const cancel = screen.getByRole('button', { name: T.cancel });
    fireEvent.blur(reasonField(), { relatedTarget: cancel });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(reasonField()).not.toHaveAttribute('aria-invalid', 'true');

    // Anywhere else, the blank reason is still announced.
    fireEvent.blur(reasonField(), { relatedTarget: null });
    expect(screen.getByRole('alert')).toHaveTextContent(T.errors.reasonRequired);
  });

  it('the too-long error sits immediately under the field and describes it (L4)', () => {
    render(ui());
    fireEvent.change(reasonField(), { target: { value: 'x'.repeat(21) } });
    const error = reasonField().nextElementSibling as HTMLElement;
    expect(error).toHaveTextContent(T.errors.reasonTooLong);
    expect(error).toHaveAttribute('role', 'alert');
    expect(reasonField().getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
  });
});

describe('ReasonConfirmationDialog — the typed-phrase error placement (L4)', () => {
  it('the subject mismatch error sits immediately under its input, above the help text', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
        <ReasonConfirmationDialog
          open
          onOpenChange={vi.fn()}
          namespace="portal.broadcasts.detail.cancelDialog"
          maxLength={500}
          reasonRequired={false}
          fieldIdPrefix="cancel-reason"
          textareaRows={4}
          onConfirm={vi.fn(async () => undefined)}
          finalFocus={() => null}
          typedPhrase="Autumn mixer"
        />
      </NextIntlClientProvider>,
    );
    const phrase = screen.getByLabelText(en.portal.broadcasts.detail.cancelDialog.subjectLabel);
    fireEvent.change(phrase, { target: { value: 'Winter' } });
    fireEvent.blur(phrase);
    expect(phrase.nextElementSibling).toHaveTextContent(en.portal.broadcasts.detail.cancelDialog.subjectError);
  });
});

describe('ReasonConfirmationDialog — confirm tone (M2)', () => {
  it('destructive by default', () => {
    render(ui());
    expect(confirmButton().className).toContain('bg-destructive');
  });

  it('primary when asked — a reversible step is not painted red', () => {
    render(ui({ confirmTone: 'primary' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: T.confirm }).className).not.toContain('bg-destructive');
  });
});
