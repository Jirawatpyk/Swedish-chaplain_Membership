/**
 * Timeline-A follow-up (`.superpowers/sdd/followup-timeline-a-brief.md`) —
 * `ReminderTimeline` reworked to render the shared `<Stepper>` primitive
 * (evenly-spaced connected circles + labels) instead of a scaled
 * `[-120, +30]`-day axis with pins. User feedback on the axis version was
 * "confusing + ugly" (pins bunch to one side because negative offsets
 * dominate the range).
 *
 * Design contract (this follow-up):
 *   - One `<Stepper>` node per reminder step, PLUS a synthetic due-date
 *     node (Flag icon, danger tone) inserted at its sorted position
 *     (offset 0) — UNLESS a real step already sits at `offset_days === 0`
 *     (a standard offset for 4 of 5 tiers), in which case no duplicate
 *     node is added.
 *   - Order: earliest-before … due-date … latest-after.
 *   - Reminder nodes: `Mail` icon + `info` tone for email, `ListTodo` icon
 *     + `warning` tone for task; label = the plain-language timing
 *     sentence ("N days before/after renewal" / "On renewal date"), never
 *     the cryptic "T-N" form.
 *   - Zero steps → Stepper renders the due-date node ONLY + the
 *     `timeline.emptyDue` caption below. Must not crash.
 *   - The Stepper's `<ol role="list">` + visible labels ARE the
 *     accessible representation (WCAG 1.1.1/1.3.1) — no more hand-rolled
 *     `sr-only` list. Icons stay `aria-hidden`; a legend (Email / Task /
 *     Due date, each with its own icon) keeps colour from being the sole
 *     differentiator (WCAG 1.4.1).
 *   - Each tier's Stepper carries a distinct `aria-label`.
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { ReminderTimeline } from '@/app/(staff)/admin/settings/renewals/schedules/_components/reminder-timeline';
import type { EditorStep } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';
import type { TierBucket } from '@/modules/renewals/client';

function renderTL(steps: EditorStep[], tierBucket: TierBucket = 'regular') {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReminderTimeline tierBucket={tierBucket} steps={steps} />
    </NextIntlClientProvider>,
  );
}

const emailBefore: EditorStep = {
  _uiKey: 'regular-0',
  step_id: 't-30.email',
  offset_days: -30,
  channel: 'email',
  template_id: 'renewal.t-30.regular',
};

const taskAfter: EditorStep = {
  _uiKey: 'regular-1',
  step_id: 't+7.task.phone_call',
  offset_days: 7,
  channel: 'task',
  task_type: 'phone_call',
  assignee_role: 'admin',
};

const emailOnDueDate: EditorStep = {
  _uiKey: 'regular-2',
  step_id: 't+0.email',
  offset_days: 0,
  channel: 'email',
  template_id: 'renewal.t+0.regular',
};

it('renders one Stepper list item per reminder step plus the synthetic due-date node', () => {
  renderTL([emailBefore, taskAfter]);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
});

it('orders nodes earliest-before … due-date … after', () => {
  renderTL([emailBefore, taskAfter]);
  const labels = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
  const beforeIdx = labels.findIndex((t) => /before renewal/i.test(t));
  const dueIdx = labels.findIndex((t) => t.includes('Due date'));
  const afterIdx = labels.findIndex((t) => /after renewal/i.test(t));
  expect(beforeIdx).toBeGreaterThanOrEqual(0);
  expect(dueIdx).toBeGreaterThan(beforeIdx);
  expect(afterIdx).toBeGreaterThan(dueIdx);
});

it('uses the plain-language timing sentence, never the cryptic "T-N" form', () => {
  renderTL([emailBefore, taskAfter]);
  expect(screen.getByText('30 days before renewal')).toBeInTheDocument();
  expect(screen.getByText('7 days after renewal')).toBeInTheDocument();
  expect(screen.queryByText(/T-30/)).toBeNull();
  expect(screen.queryByText(/T\+7/)).toBeNull();
});

it('renders Mail for email steps, ListTodo for task steps, and Flag for the due-date node', () => {
  const { container } = renderTL([emailBefore, taskAfter]);
  expect(container.querySelector('svg.lucide-mail')).not.toBeNull();
  expect(container.querySelector('svg.lucide-list-todo')).not.toBeNull();
  expect(container.querySelector('svg.lucide-flag')).not.toBeNull();
});

it('labels the due-date node with the localized due label', () => {
  renderTL([emailBefore]);
  // Once in the Stepper node, once in the legend.
  expect(screen.getAllByText('Due date').length).toBeGreaterThanOrEqual(2);
});

it('zero steps: renders only the due-date node plus the empty-due caption, without crashing', () => {
  renderTL([]);
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(1);
  expect(items[0]!.textContent).toContain('Due date');
  expect(screen.getByText(/only the due date is shown/i)).toBeInTheDocument();
});

it('does not insert a duplicate due-date node when a real step already sits at offset 0', () => {
  renderTL([emailOnDueDate]);
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(1);
  // The single Stepper node is the real day-0 reminder (plain-language
  // timing sentence + Mail icon), not the synthetic "Due date" node — no
  // Flag icon renders INSIDE the Stepper node (the legend below always
  // keeps its own Flag entry, scoped out of this assertion).
  expect(items[0]!.textContent).toContain('On renewal date');
  expect(items[0]!.querySelector('svg.lucide-flag')).toBeNull();
  expect(items[0]!.querySelector('svg.lucide-mail')).not.toBeNull();
});

it('gives the Stepper a tier-specific aria-label', () => {
  renderTL([emailBefore]);
  expect(screen.getByRole('list', { name: 'Reminder timeline for Regular' })).toBeInTheDocument();
});

it('shows a legend with Email / Task / Due date entries, each carrying its own icon (not colour alone)', () => {
  const { container } = renderTL([emailBefore, taskAfter]);
  expect(screen.getByText('Email')).toBeInTheDocument();
  expect(screen.getByText('Task')).toBeInTheDocument();
  // At least 2 of each icon: one in the Stepper node, one in the legend.
  expect(container.querySelectorAll('svg.lucide-mail').length).toBeGreaterThanOrEqual(2);
  expect(container.querySelectorAll('svg.lucide-list-todo').length).toBeGreaterThanOrEqual(2);
  expect(container.querySelectorAll('svg.lucide-flag').length).toBeGreaterThanOrEqual(2);
});

// Fix round 1 (`.superpowers/sdd/followup-timeline-a-report.md`) — narrow-
// viewport density fix: wide tiers (up to 8 nodes) scroll horizontally
// instead of cramming, via an overflow-x-auto region wrapping the Stepper.
it('wraps the Stepper in a keyboard-focusable scroll region with a DISTINCT aria-label from the Stepper list', () => {
  renderTL([emailBefore, taskAfter]);
  const region = screen.getByRole('region', { name: 'Reminder timeline for Regular, scrollable' });
  expect(region.getAttribute('tabindex')).toBe('0');
  expect(region.className).toContain('overflow-x-auto');
  // Distinct text from the region label — same-text nested landmarks would
  // double-announce to screen readers.
  expect(screen.getByRole('list', { name: 'Reminder timeline for Regular' })).toBeInTheDocument();
});

it('scales the scroll region inner min-width with node count (~80px/node) so short tiers never scroll unnecessarily', () => {
  const { container } = renderTL([emailBefore, taskAfter]);
  // 2 reminder steps + 1 synthetic due node = 3 nodes.
  const inner = container.querySelector('[role="region"] > div');
  expect(inner).not.toBeNull();
  expect((inner as HTMLElement).style.minWidth).toBe('240px');
});
