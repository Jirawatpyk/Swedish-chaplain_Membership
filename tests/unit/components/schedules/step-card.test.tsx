/**
 * `<StepCard>` — 122 US7b-2 (T736), boards `Admin-renewal-schedules`
 * (+`-mobile`), on AURA, with no UI mocks:
 *
 * - header: the timing sentence, then Move step earlier / later and Remove
 *   step icon buttons;
 * - Delivery channel as an AURA `RadioGroup` (Email, Task) and Send timing as
 *   an AURA `Select` ending in "Custom…" (a number of days plus Before/After);
 * - an email step reads "Reminder email is configured for this timing" (or the
 *   no-copy warning); a task step has a Task type `Combobox` that accepts a
 *   typed type, with the board's hint, and an Assignee role `Select`.
 *
 * `step_id` and `template_id` stay derived from the plain controls through
 * `step-id-composer` (offset first, collision-safe), exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { EditorStep } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';
import { StepCard } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-card';

const S = messages.admin.renewals.settings.schedules;

/** AURA Select keeps a real <select> under its listbox: read and pick through it (US5a precedent). */
function native(label: string | RegExp): HTMLSelectElement {
  const box = screen.getByRole('combobox', { name: label });
  const el = box.closest('.aura-select')?.querySelector('select');
  if (!el) throw new Error(`no native select for ${String(label)}`);
  return el;
}
function pick(label: string | RegExp, value: string) {
  fireEvent.change(native(label), { target: { value } });
}
function option(label: string | RegExp, text: RegExp): HTMLOptionElement {
  const found = [...native(label).options].find((o) => text.test(o.textContent ?? ''));
  if (!found) throw new Error(`no option ${String(text)}`);
  return found;
}

function renderCard(opts?: {
  step?: Partial<EditorStep>;
  siblingSteps?: ReadonlyArray<EditorStep>;
  index?: number;
  total?: number;
  readOnly?: boolean;
}) {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  const step: EditorStep = {
    _uiKey: 'regular-0',
    step_id: 't-30.email',
    offset_days: -30,
    channel: 'email',
    template_id: 'renewal.t-30.regular',
    ...opts?.step,
  };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StepCard
        tierBucket="regular"
        step={step}
        index={opts?.index ?? 0}
        total={opts?.total ?? 1}
        readOnly={opts?.readOnly ?? false}
        siblingSteps={opts?.siblingSteps ?? []}
        onChange={onChange}
        onRemove={onRemove}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
  return { onChange, onRemove };
}

const TASK: Partial<EditorStep> = {
  step_id: 't-30.task.phone_call',
  channel: 'task',
  task_type: 'phone_call',
  assignee_role: 'admin',
};

beforeEach(() => {
  vi.useRealTimers();
});

describe('<StepCard> header', () => {
  it('reads the timing as a sentence, with AURA icon buttons to move and remove the step', () => {
    const { onRemove } = renderCard({ index: 0, total: 3 });
    expect(screen.getByText('30 days before renewal', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: S.actions.moveUp })).toBeDisabled();
    expect(screen.getByRole('button', { name: S.actions.moveDown })).toBeEnabled();
    const remove = screen.getByRole('button', { name: S.actions.removeStep });
    expect(remove).toHaveClass('aura-icon-btn');
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe('<StepCard> delivery channel (AURA RadioGroup)', () => {
  it('offers Email and Task as radios in a fieldset named "Delivery channel"', () => {
    renderCard();
    const group = screen.getByRole('group', { name: S.stepCard.channelLabel });
    expect(group.closest('.aura-field, .aura-radio-group, .aura-choice')).not.toBeNull();
    expect(within(group).getByRole('radio', { name: 'Email' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Task' })).not.toBeChecked();
  });

  it('switching to Task builds a task step with the default type and role', () => {
    const { onChange } = renderCard();
    fireEvent.click(screen.getByRole('radio', { name: 'Task' }));
    expect(onChange).toHaveBeenLastCalledWith({
      _uiKey: 'regular-0',
      step_id: 't-30.task.phone_call',
      offset_days: -30,
      channel: 'task',
      task_type: 'phone_call',
      assignee_role: 'admin',
    });
  });

  it('switching back to Email derives the template id', () => {
    const { onChange } = renderCard({ step: TASK });
    fireEvent.click(screen.getByRole('radio', { name: 'Email' }));
    expect(onChange).toHaveBeenLastCalledWith({
      _uiKey: 'regular-0',
      step_id: 't-30.email',
      offset_days: -30,
      channel: 'email',
      template_id: 'renewal.t-30.regular',
    });
  });
});

describe('<StepCard> send timing (AURA Select)', () => {
  it('lists the tier\'s standard timings and "Custom…", the current one chosen', () => {
    renderCard();
    expect(screen.getByRole('combobox', { name: S.stepCard.timing.label })).toHaveTextContent('30 days before renewal');
    const texts = [...native(S.stepCard.timing.label).options].map((o) => o.textContent);
    expect(texts.at(-1)).toBe(S.stepCard.timing.customOption);
    expect(texts).toContain('14 days before renewal');
  });

  it('recomposes step_id and template_id offset-first when another timing is chosen', () => {
    const { onChange } = renderCard();
    pick(S.stepCard.timing.label, 't-14');
    const arg = onChange.mock.calls.at(-1)![0] as EditorStep;
    expect(arg.offset_days).toBe(-14);
    expect(arg.step_id).toBe('t-14.email');
    expect(arg.template_id).toBe('renewal.t-14.regular');
  });

  it('disables a timing another step of the same channel already uses, not one of another channel', () => {
    renderCard({
      siblingSteps: [
        { _uiKey: 's1', step_id: 't-14.email', offset_days: -14, channel: 'email', template_id: 'renewal.t-14.regular' },
        { _uiKey: 's2', step_id: 't-7.task.phone_call', offset_days: -7, channel: 'task', task_type: 'phone_call', assignee_role: 'admin' },
      ],
    });
    expect(option(S.stepCard.timing.label, /^14 days before/).disabled).toBe(true);
    expect(option(S.stepCard.timing.label, /^7 days before/).disabled).toBe(false);
  });

  it('a non-standard offset loads with "Custom…" chosen, the days and Before shown', () => {
    renderCard({ step: { offset_days: -45, step_id: 't-45.email', template_id: 'renewal.t-45.regular' } });
    expect(screen.getByRole('combobox', { name: S.stepCard.timing.label })).toHaveTextContent(S.stepCard.timing.customOption);
    expect(screen.getByRole('spinbutton', { name: S.stepCard.timing.customDaysLabel })).toHaveValue('45');
    const dir = screen.getByRole('group', { name: S.stepCard.timing.direction.label });
    expect(within(dir).getByRole('radio', { name: S.stepCard.timing.direction.before })).toBeChecked();
  });

  it('choosing "Custom…" reveals the days; typing recomposes the step and keeps its _uiKey', () => {
    const { onChange } = renderCard();
    pick(S.stepCard.timing.label, 'custom');
    const days = screen.getByRole('spinbutton', { name: S.stepCard.timing.customDaysLabel });
    fireEvent.change(days, { target: { value: '40' } });
    const arg = onChange.mock.calls.at(-1)![0] as EditorStep;
    expect(arg.offset_days).toBe(-40);
    expect(arg.step_id).toBe('t-40.email');
    expect(arg._uiKey).toBe('regular-0');
  });

  it('After flips a custom offset past the renewal date', () => {
    const { onChange } = renderCard({ step: { offset_days: -45, step_id: 't-45.email', template_id: 'renewal.t-45.regular' } });
    fireEvent.click(screen.getByRole('radio', { name: S.stepCard.timing.direction.after }));
    expect((onChange.mock.calls.at(-1)![0] as EditorStep).offset_days).toBe(45);
  });
});

describe('<StepCard> email and task fields', () => {
  it('an email step says its reminder email is configured', () => {
    renderCard();
    expect(screen.getByText(S.stepCard.preview.heading)).toBeInTheDocument();
  });

  it('a task step has a Task type combobox with the board hint, accepting a typed type', () => {
    const { onChange } = renderCard({ step: TASK });
    const box = screen.getByRole('combobox', { name: S.stepCard.taskType.label });
    expect(box.closest('.aura-combobox, .aura-field')).not.toBeNull();
    expect(box).toHaveAccessibleDescription(S.stepCard.taskType.hint);
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Site visit' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.blur(box);
    const arg = onChange.mock.calls.at(-1)![0] as EditorStep;
    expect(arg.task_type).toBe('Site visit');
    expect(arg.step_id.startsWith('t-30.task.')).toBe(true);
  });

  it('picking a known task type recomposes an offset-first step_id', () => {
    const { onChange } = renderCard({ step: TASK });
    const box = screen.getByRole('combobox', { name: S.stepCard.taskType.label });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Quarterly' } });
    fireEvent.click(screen.getByRole('option', { name: /Quarterly review meeting/ }));
    const arg = onChange.mock.calls.at(-1)![0] as EditorStep;
    expect(arg.task_type).toBe('quarterly_review_meeting');
    expect(arg.step_id).toBe('t-30.task.quarterly_review_meeting');
  });

  it('a bespoke saved task type still shows (no data loss)', () => {
    renderCard({ step: { ...TASK, task_type: 'legacy_custom_touch', step_id: 't-30.task.legacy_custom_touch' } });
    expect(screen.getByRole('combobox', { name: S.stepCard.taskType.label })).toHaveValue('legacy_custom_touch');
  });

  it('the Assignee role select sets the role', () => {
    const { onChange } = renderCard({ step: TASK });
    pick(S.stepCard.assigneeLabel, 'executive_director');
    expect((onChange.mock.calls.at(-1)![0] as EditorStep).assignee_role).toBe('executive_director');
  });

  it('read-only disables every control', () => {
    renderCard({ step: TASK, readOnly: true });
    expect(screen.getByRole('radio', { name: 'Email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: S.actions.removeStep })).toBeDisabled();
  });
});
