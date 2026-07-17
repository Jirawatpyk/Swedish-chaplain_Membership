/**
 * F8 Phase 4 Wave I2/I3 · Task 8 — `StepCard` friendly editor row (spec
 * §5.2 channel segmented control, §5.3 timing stepper, §6.2 advanced
 * raw-identifier escape hatch).
 *
 * Design contract:
 *   - step_id / template_id are DERIVED (composed), not hand-typed, on
 *     every timing or channel change — `composeStepId`/`composeTemplateId`
 *     stay the single source of the offset-first / tier-last wire grammar.
 *   - Channel renders as a labelled `radiogroup` (Email / Task segments).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
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

function renderCard(onChange = vi.fn()) {
  const step = { step_id: 't-30.email', offset_days: -30, channel: 'email' as const, template_id: 'renewal.t-30.regular' };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StepCard tierBucket="regular" step={step} index={0} total={1} readOnly={false}
        onChange={onChange} onRemove={vi.fn()} onMoveUp={vi.fn()} onMoveDown={vi.fn()} />
    </NextIntlClientProvider>,
  );
  return { onChange };
}

it('recomposes step_id when timing changes to "after"', () => {
  const { onChange } = renderCard();
  // flip before/after to "after" (radio)
  fireEvent.click(screen.getByRole('radio', { name: /after/i }));
  const arg = onChange.mock.calls.at(-1)![0];
  expect(arg.offset_days).toBe(30);          // 30 days after
  expect(arg.step_id).toBe('t+30.email');    // recomposed, offset-first
  expect(arg.template_id).toBe('renewal.t+30.regular');
});

it('renders channel as a radiogroup', () => {
  renderCard();
  expect(screen.getByRole('radiogroup', { name: /channel/i })).toBeInTheDocument();
});
