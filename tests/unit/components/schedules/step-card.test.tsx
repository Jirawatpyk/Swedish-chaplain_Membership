/**
 * StepCard v2 rework (`.superpowers/sdd/rework-stepcard-v2-brief.md`) —
 * three fixes verified together:
 *
 *   1. Channel segmented control (Email/Task) still renders as a
 *      labelled `radiogroup` — the hidden-radio alignment fix (Issue 1)
 *      is a pure CSS change (in-flow box → absolute overlay), not
 *      observable via RTL's DOM/role queries, so it isn't re-asserted
 *      here beyond "the control still works".
 *   2. The day-stepper + separate Before/After toggle is replaced by
 *      ONE plain-language "Send timing" `<Select>` of the tier's
 *      standard reminder points; already-used (offset, channel)
 *      combinations are disabled to prevent duplicate step_ids, EXCEPT
 *      the current step's own offset (never disabled, even when a
 *      pre-existing sibling duplicate shares it).
 *   3. Every step_id recompose path (timing, channel) runs through the
 *      collision-safe `composeUniqueStepId`.
 *
 * Harness note: `@/components/ui/select` (Base UI) is mocked with a
 * lightweight, INTERACTIVE eager-render stub — jsdom cannot drive Base
 * UI's pointer-based popup (see the read-only precedent in
 * tests/unit/app/portal/invoices/invoice-filters-props.test.tsx). This
 * stub additionally threads `value`/`onValueChange` through a React
 * context so a click on a `role="option"` genuinely fires the same
 * `onValueChange` callback the real component would receive, letting
 * this file test the actual recompose logic (not just the option list).
 *
 * F8 follow-up (`.superpowers/sdd/followup-tasktype-brief.md`) —
 * `@/components/ui/combobox` (Base UI Popover + cmdk) is mocked the same
 * way, for the same reason (jsdom can't drive its pointer-based popup —
 * see the real-stack alternative + its jsdom workarounds at
 * `tests/unit/components/ui/combobox-a11y.test.tsx`, not used here to
 * keep this file's existing lightweight-stub convention). The stub
 * reproduces the real primitive's own trigger-text fallback (`selected
 * label ?? (allowCustomValue && value ? value : placeholder)` — see
 * `combobox.tsx`) and its `allowCustomValue` "type then commit" flow via
 * a plain search `<input>` + a synthesized "Use «text»" option.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { EditorStep } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';

interface SelectCtxValue {
  value: string;
  onValueChange: ((v: string) => void) | undefined;
}
const SelectCtx = createContext<SelectCtxValue>({ value: '', onValueChange: undefined });

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange?: (v: string) => void;
    children: ReactNode;
  }) => (
    <SelectCtx.Provider value={{ value, onValueChange }}>{children}</SelectCtx.Provider>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children: ReactNode;
  }) => {
    const ctx = useContext(SelectCtx);
    return (
      <div
        role="option"
        aria-selected={ctx.value === value}
        aria-disabled={disabled ? true : undefined}
        data-value={value}
        onClick={() => {
          if (disabled) return;
          ctx.onValueChange?.(value);
        }}
      >
        {children}
      </div>
    );
  },
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TranslatedSelectValue: () => null,
}));

interface ComboboxOptionStub {
  value: string;
  label: string;
}

vi.mock('@/components/ui/combobox', () => ({
  Combobox: ({
    id,
    'aria-labelledby': ariaLabelledBy,
    options,
    value,
    onChange,
    placeholder,
    searchPlaceholder,
    disabled,
    allowCustomValue,
    customValueLabel,
  }: {
    id: string;
    'aria-labelledby'?: string;
    options: ComboboxOptionStub[];
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
    searchPlaceholder: string;
    disabled?: boolean;
    allowCustomValue?: boolean;
    customValueLabel?: (typed: string) => string;
  }) => {
    const [search, setSearch] = useState('');
    const selected = options.find((o) => o.value === value);
    // Mirrors combobox.tsx's own trigger-text fallback exactly (line
    // ~268): `selected?.label ?? (allowCustomValue && value ? value : placeholder)`.
    const triggerText = selected?.label ?? (allowCustomValue && value ? value : placeholder);
    const trimmed = search.trim();
    const showCustom =
      Boolean(allowCustomValue) && trimmed !== '' && !options.some((o) => o.value === trimmed);
    const listboxId = `${id}-listbox-stub`;
    return (
      <div>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-labelledby={ariaLabelledBy}
          aria-expanded="true"
          aria-controls={listboxId}
          disabled={disabled}
        >
          {triggerText}
        </button>
        <input
          aria-label={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul id={listboxId}>
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={value === o.value}
                onClick={() => onChange(o.value)}
              >
                {o.label}
              </button>
            </li>
          ))}
          {showCustom && customValueLabel && (
            <li>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onChange(trimmed)}
              >
                {customValueLabel(trimmed)}
              </button>
            </li>
          )}
        </ul>
      </div>
    );
  },
}));

import { StepCard } from '@/app/(staff)/admin/settings/renewals/schedules/_components/step-card';

// Base UI Radio uses PointerEvent internally; jsdom lacks it. Same
// polyfill as tests/unit/members/presentation/members-table-selection.test.tsx.
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

function renderCard(opts?: {
  step?: Partial<EditorStep>;
  siblingSteps?: ReadonlyArray<EditorStep>;
}) {
  const onChange = vi.fn();
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
        index={0}
        total={1}
        readOnly={false}
        siblingSteps={opts?.siblingSteps ?? []}
        onChange={onChange}
        onRemove={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
  return { onChange };
}

it('recomposes step_id + template_id (offset-first) when a different standard timing option is selected', () => {
  // 'regular' tier standard offsets: t-60, t-30, t-14, t-7, t+0, t+7.
  const { onChange } = renderCard();
  fireEvent.click(screen.getByRole('option', { name: /14 days before renewal/i }));
  const arg = onChange.mock.calls.at(-1)![0];
  expect(arg.offset_days).toBe(-14);
  expect(arg.step_id).toBe('t-14.email');
  expect(arg.template_id).toBe('renewal.t-14.regular');
});

it('disables a timing option already used by a sibling step of the SAME channel', () => {
  renderCard({
    siblingSteps: [
      {
        _uiKey: 'regular-sib-1',
        step_id: 't-14.email',
        offset_days: -14,
        channel: 'email',
        template_id: 'renewal.t-14.regular',
      },
    ],
  });
  expect(
    screen.getByRole('option', { name: /14 days before renewal/i }),
  ).toHaveAttribute('aria-disabled', 'true');
});

it('does NOT disable an offset used by a sibling of a DIFFERENT channel', () => {
  renderCard({
    siblingSteps: [
      {
        _uiKey: 'regular-sib-2',
        step_id: 't-14.task.phone_call',
        offset_days: -14,
        channel: 'task',
        task_type: 'phone_call',
        assignee_role: 'admin',
      },
    ],
  });
  expect(
    screen.getByRole('option', { name: /14 days before renewal/i }),
  ).not.toHaveAttribute('aria-disabled');
});

it("never disables the current step's own offset, even when a pre-existing sibling duplicate shares it", () => {
  renderCard({
    step: { offset_days: -14, step_id: 't-14.email', template_id: 'renewal.t-14.regular' },
    siblingSteps: [
      {
        // Pre-existing collision (e.g. legacy data) — same offset+channel
        // as the step under test. The `days !== step.offset_days` guard
        // must still exempt the CURRENT step's own selected value.
        _uiKey: 'regular-sib-3',
        step_id: 't-14.email.2',
        offset_days: -14,
        channel: 'email',
        template_id: 'renewal.t-14.regular',
      },
    ],
  });
  expect(
    screen.getByRole('option', { name: /14 days before renewal/i }),
  ).not.toHaveAttribute('aria-disabled');
});

// v3 rework (`.superpowers/sdd/rework-stepcard-v3-brief.md`, Change 1)
// — "Custom…" option + numeric day input, replacing the v2 "extra
// selected option showing the raw sentence" approach.
describe('v3 — "Custom…" timing option', () => {
  it('loads a non-standard offset with "Custom…" selected and the day input pre-filled (load reflection)', () => {
    // -45 is not in the 'regular' tier's standard offset set — must NOT
    // be silently snapped to the nearest standard value.
    renderCard({
      step: { offset_days: -45, step_id: 't-45.email', template_id: 'renewal.t-45.regular' },
    });
    expect(screen.getByRole('option', { name: /^custom/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByLabelText(/number of days/i)).toHaveValue(45);
  });

  it('never disables the "Custom…" option', () => {
    renderCard();
    expect(screen.getByRole('option', { name: /^custom/i })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('selecting "Custom…" reveals the day input; typing recomposes an offset-first step_id and preserves the stable _uiKey', () => {
    // Default step: _uiKey 'regular-0', offset -30 (standard, "before").
    const { onChange } = renderCard();
    fireEvent.click(screen.getByRole('option', { name: /^custom/i }));
    const dayInput = screen.getByLabelText(/number of days/i);
    fireEvent.change(dayInput, { target: { value: '10' } });
    const arg = onChange.mock.calls.at(-1)![0];
    // The custom-day input recomposes through the SAME `applyTiming`
    // path a standard option uses — offset-first step_id, tier-last
    // template_id, exactly like the very first test in this file.
    expect(arg.offset_days).toBe(-10);
    expect(arg.step_id).toBe('t-10.email');
    expect(arg.template_id).toBe('renewal.t-10.regular');
    // v3 Change 3 — the whole point: `_uiKey` survives this recompose
    // (used as the editor's React key so the card never remounts).
    expect(arg._uiKey).toBe('regular-0');
  });
});

// v3 rework Change 2 — the Advanced (raw identifiers) Collapsible is
// deleted entirely: no raw step_id/template_id inputs anywhere in the
// card, regardless of standard or custom timing.
it('renders no Advanced (raw identifiers) panel', () => {
  renderCard({ step: { offset_days: -45, step_id: 't-45.email', template_id: 'renewal.t-45.regular' } });
  expect(screen.queryByText(/advanced \(raw identifiers\)/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^step id$/i)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^template id$/i)).not.toBeInTheDocument();
});

it('renders channel as a radiogroup', () => {
  renderCard();
  expect(screen.getByRole('radiogroup', { name: /channel/i })).toBeInTheDocument();
});

// F8 follow-up (`.superpowers/sdd/followup-tasktype-brief.md`) — the
// Task-type control was a 2-option `<Select>` (`phone_call`,
// `admin_notify`) that silently rewrote any other real value the moment
// the admin touched it. Now a `<Combobox allowCustomValue>` seeded from
// the shared `RENEWAL_KNOWN_TASK_TYPES` catalogue.
describe('task-type combobox (known catalogue + custom entry)', () => {
  function renderTaskCard(opts?: {
    step?: Partial<EditorStep>;
    siblingSteps?: ReadonlyArray<EditorStep>;
  }) {
    const onChange = vi.fn();
    const step: EditorStep = {
      _uiKey: 'regular-0',
      step_id: 't-30.task.phone_call',
      offset_days: -30,
      channel: 'task',
      task_type: 'phone_call',
      assignee_role: 'admin',
      ...opts?.step,
    };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <StepCard
          tierBucket="regular"
          step={step}
          index={0}
          total={1}
          readOnly={false}
          siblingSteps={opts?.siblingSteps ?? []}
          onChange={onChange}
          onRemove={vi.fn()}
          onMoveUp={vi.fn()}
          onMoveDown={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    return { onChange };
  }

  it('offers the known task-type catalogue as combobox options', () => {
    renderTaskCard();
    for (const label of [
      'Phone call',
      'Notify admin',
      'Notify admin (lapsed)',
      'Director call',
      'Quarterly review meeting',
      'Meeting proposed',
      'Benefit fulfillment report',
      'Contract renewal',
      'In-person meeting',
      'Board escalation',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('selecting a known task type sets task_type and recomposes an offset-first step_id (multi-underscore type)', () => {
    const { onChange } = renderTaskCard();
    fireEvent.click(screen.getByRole('option', { name: 'Quarterly review meeting' }));
    const arg = onChange.mock.calls.at(-1)![0];
    expect(arg.task_type).toBe('quarterly_review_meeting');
    // Offset-first — gateway's `deriveOffsetFromStepId` slices only the
    // FIRST dot-segment of `step_id`, so a multi-underscore task type
    // must never disturb offset resolution (the silent-non-delivery
    // footgun class this whole composer exists to prevent).
    expect(arg.step_id).toBe('t-30.task.quarterly_review_meeting');
    expect(arg.step_id.split('.')[0]).toBe('t-30');
  });

  it('loading a bespoke/legacy task_type (absent from the known catalogue) displays it on the trigger — no data loss', () => {
    // NOTE: the brief's own example ('quarterly_review_meeting') is now
    // PART of the known catalogue after Change 1, so it no longer
    // exercises this path — a genuinely bespoke value is required to
    // prove the load-reflection/no-data-loss mechanism.
    renderTaskCard({ step: { task_type: 'legacy_custom_task' } });
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('legacy_custom_task');
    expect(trigger).not.toHaveTextContent('Task type');
  });

  it('committing a typed custom value sets task_type to the typed text and recomposes step_id', () => {
    const { onChange } = renderTaskCard();
    fireEvent.change(screen.getByLabelText('Search task types…'), {
      target: { value: 'brand_new_task' },
    });
    fireEvent.click(screen.getByRole('option', { name: 'Use "brand_new_task"' }));
    const arg = onChange.mock.calls.at(-1)![0];
    expect(arg.task_type).toBe('brand_new_task');
    expect(arg.step_id).toBe('t-30.task.brand_new_task');
  });

  it('names the combobox via aria-labelledby pointing at the visible <Label> (trigger is a button, htmlFor alone does not name it)', () => {
    renderTaskCard();
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveAccessibleName('Task type');
  });
});
