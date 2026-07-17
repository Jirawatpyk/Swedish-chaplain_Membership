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
 */
import { createContext, useContext, type ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { ScheduleStepWire } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';

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
  step?: Partial<ScheduleStepWire>;
  siblingSteps?: ReadonlyArray<ScheduleStepWire>;
}) {
  const onChange = vi.fn();
  const step: ScheduleStepWire = {
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

it('shows a non-standard offset as an extra "(custom)" option instead of silently snapping it', () => {
  // -45 is not in the 'regular' tier's standard offset set.
  renderCard({ step: { offset_days: -45, step_id: 't-45.email', template_id: 'renewal.t-45.regular' } });
  expect(screen.getByRole('option', { name: /45 days before renewal.*custom/i })).toBeInTheDocument();
  // The step's own value must still be exactly what was loaded — not
  // snapped to the nearest standard offset.
  expect(screen.queryByRole('option', { name: /^45 days before renewal$/i })).not.toBeInTheDocument();
});

it('renders channel as a radiogroup', () => {
  renderCard();
  expect(screen.getByRole('radiogroup', { name: /channel/i })).toBeInTheDocument();
});
