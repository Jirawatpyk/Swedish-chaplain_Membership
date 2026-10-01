/**
 * Done and Skip dialogs — 122 US7b-2 (T733): AURA `Textarea`s inside the AURA
 * alertdialog shell, with the same bodies as before.
 *
 * - Done: an optional outcome note (1000 characters), its counter as the
 *   field's hint; an empty note is sent as `undefined`.
 * - Skip: a required reason (1–500 characters after trimming); the error
 *   shows once the field is left empty, and Skip stays disabled until valid.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { DoneTaskDialog } from '@/app/(staff)/admin/renewals/tasks/_components/done-task-dialog';
import { SkipTaskDialog } from '@/app/(staff)/admin/renewals/tasks/_components/skip-task-dialog';

const D = enMessages.admin.renewals.tasks.done_dialog;
const S = enMessages.admin.renewals.tasks.skip_dialog;

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('<DoneTaskDialog> on AURA', () => {
  it('is an alertdialog with an AURA textarea and its counter as the hint', () => {
    wrap(<DoneTaskDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole('alertdialog', { name: D.title })).toBeInTheDocument();
    const note = screen.getByRole('textbox', { name: D.outcome_note_label });
    expect(note.closest('.aura-field')).not.toBeNull();
    expect(note).toHaveAttribute('maxlength', '1000');
    expect(note).toHaveAccessibleDescription(/1000 characters remaining/);
  });

  it('sends the trimmed note, or undefined when empty', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    wrap(<DoneTaskDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: D.confirm }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(undefined));
    fireEvent.change(screen.getByRole('textbox', { name: D.outcome_note_label }), {
      target: { value: '  Renewing in May  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: D.confirm }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith('Renewing in May'));
  });
});

describe('<SkipTaskDialog> on AURA', () => {
  it('asks for a required reason in an AURA textarea; Skip is disabled until one is given', () => {
    wrap(<SkipTaskDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    const reason = screen.getByRole('textbox', { name: new RegExp(S.reason_label) });
    expect(reason).toBeRequired();
    expect(reason.closest('.aura-field')).not.toBeNull();
    expect(screen.getByRole('button', { name: S.confirm })).toBeDisabled();
  });

  it('shows the error once the empty field is left', () => {
    wrap(<SkipTaskDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    const reason = screen.getByRole('textbox', { name: new RegExp(S.reason_label) });
    fireEvent.blur(reason);
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(S.reason_required)).toBeInTheDocument();
  });

  it('sends the trimmed reason in the danger confirm', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    wrap(<SkipTaskDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(S.reason_label) }), {
      target: { value: ' Unreachable ' },
    });
    const confirm = screen.getByRole('button', { name: S.confirm });
    expect(confirm).toHaveClass('aura-btn--danger');
    fireEvent.click(confirm);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Unreachable'));
  });
});
