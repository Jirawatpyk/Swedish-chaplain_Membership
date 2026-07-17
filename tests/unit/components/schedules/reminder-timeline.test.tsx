/**
 * F8 Phase 4 Wave I2 · Task 6 — `ReminderTimeline` read-only strip.
 *
 * Design contract (spec §5.1):
 *   - Pins positioned by `offset_days` on a `[-120, +30]` axis + a red
 *     due-date marker at day 0.
 *   - A visually-hidden `<ol>` text alternative is the SR/no-JS data path
 *     (WCAG 1.1.1 / 1.3.1) — always rendered, one `<li>` per step.
 *   - Every DOM `id` is prefixed with `${tierBucket}-` because Base UI
 *     `Tabs.Panel` keeps all 5 tier panels mounted via `hidden` (WCAG
 *     4.1.1 — duplicate ids across simultaneously-mounted panels).
 *   - Zero steps → only the due marker + `timeline.emptyDue` copy.
 *   - The due-date marker also carries a `timeline.dueLabel` text legend
 *     entry (WCAG 1.1.1 / 1.4.1 — color is never the sole differentiator).
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { ReminderTimeline } from '@/app/(staff)/admin/settings/renewals/schedules/_components/reminder-timeline';
import type { ScheduleStepWire } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';

function renderTL(steps: ScheduleStepWire[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReminderTimeline tierBucket="regular" steps={steps} />
    </NextIntlClientProvider>,
  );
}

it('renders a text-alternative list item per step', () => {
  renderTL([
    { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
    { step_id: 't+7.task.phone_call', offset_days: 7, channel: 'task', task_type: 'phone_call', assignee_role: 'admin' },
  ]);
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(2);
});

it('shows the empty-due copy and the due-date marker when there are no steps', () => {
  const { container } = renderTL([]);
  expect(screen.getByText(/only the due date is shown/i)).toBeInTheDocument();
  // Axis + due marker must still render (design doc §5.1: zero steps →
  // due marker only, no pins) — not replaced entirely by the text copy.
  const marker = container.querySelector('.h-4.bg-destructive');
  expect(marker).not.toBeNull();
});

it('shows the due-date legend label alongside the marker (WCAG 1.1.1/1.4.1 — not color alone)', () => {
  renderTL([
    { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
  ]);
  expect(screen.getByText('Due date')).toBeInTheDocument();
});

it('prefixes ids with the tier bucket', () => {
  const { container } = renderTL([
    { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
  ]);
  // every element with an id starts with "regular-"
  const idEls = container.querySelectorAll('[id]');
  expect(idEls.length).toBeGreaterThan(0);
  idEls.forEach((el) => {
    expect(el.id.startsWith('regular-')).toBe(true);
  });
});
