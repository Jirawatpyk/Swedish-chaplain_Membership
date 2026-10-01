/**
 * `<ReminderTimeline>` — 122 US7b-2 (T737), boards `Admin-renewal-schedules`
 * (+`-mobile`): the schedule as a chart on a day scale, replacing the legacy
 * Stepper.
 *
 * - One SVG (`role="img"`) named by a sentence that lists the email and the
 *   task timings, so a screen reader hears the whole schedule.
 * - Email markers are filled on the upper lane, task markers are rings on the
 *   lower lane; a dashed line marks the renewal date ("Due").
 * - Axis labels read "T-30", "Due", "T+14"; a legend names Email and Task.
 * - With no steps, the chart still shows the renewal date, and says so.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { EditorStep } from '@/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor';
import {
  ReminderTimeline,
  placeAxisLabels,
} from '@/app/(staff)/admin/settings/renewals/schedules/_components/reminder-timeline';

const S = messages.admin.renewals.settings.schedules;

function email(offset: number): EditorStep {
  return { _uiKey: `e${offset}`, step_id: `t${offset}.email`, offset_days: offset, channel: 'email', template_id: 'x' };
}
function task(offset: number): EditorStep {
  return {
    _uiKey: `k${offset}`,
    step_id: `t${offset}.task.phone_call`,
    offset_days: offset,
    channel: 'task',
    task_type: 'phone_call',
    assignee_role: 'admin',
  };
}

function renderTimeline(steps: EditorStep[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReminderTimeline tierBucket="premium" steps={steps} />
    </NextIntlClientProvider>,
  );
}

const PREMIUM = [email(-90), email(-60), task(-60), email(-30), email(-7), email(0), task(14)];

describe('<ReminderTimeline> chart', () => {
  it('is one SVG image named by a sentence of the email and task timings', () => {
    renderTimeline(PREMIUM);
    const chart = screen.getByRole('img');
    expect(chart.tagName.toLowerCase()).toBe('svg');
    const name = chart.getAttribute('aria-label') ?? '';
    expect(name).toContain('Premium');
    expect(name).toMatch(/Email: 90 days before renewal, 60 days before renewal, 30 days before renewal, 7 days before renewal,? and On renewal date/i);
    expect(name).toMatch(/Tasks: 60 days before renewal and 14 days after renewal/i);
  });

  it('draws filled email markers on the upper lane and task rings on the lower lane', () => {
    const { container } = renderTimeline(PREMIUM);
    const emails = container.querySelectorAll('[data-lane="email"]');
    const tasks = container.querySelectorAll('[data-lane="task"]');
    expect(emails).toHaveLength(5);
    expect(tasks).toHaveLength(2);
    const ey = Number(emails[0]!.getAttribute('cy'));
    const ty = Number(tasks[0]!.getAttribute('cy'));
    expect(ey).toBeLessThan(ty);
    expect(tasks[0]!.getAttribute('fill')).toBe('none');
    expect(emails[0]!.getAttribute('fill')).not.toBe('none');
  });

  it('places markers on a linear day scale, earlier to the left', () => {
    const { container } = renderTimeline(PREMIUM);
    const xs = [...container.querySelectorAll('[data-lane="email"]')].map((c) => parseFloat(c.getAttribute('cx') ?? ''));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    // -90 → -60 and -60 → -30 are both 30 days: equal gaps.
    expect(xs[1]! - xs[0]!).toBeCloseTo(xs[2]! - xs[1]!, 1);
  });

  it('marks the renewal date with a dashed line and labels the axis T-90 … Due … T+14', () => {
    const { container } = renderTimeline(PREMIUM);
    expect(container.querySelector('[data-due-line]')?.getAttribute('stroke-dasharray')).toBeTruthy();
    const labels = [...container.querySelectorAll('[data-axis-label]')].map((n) => n.textContent);
    expect(labels).toContain('T-90');
    expect(labels).toContain(S.timeline.dueShort);
    expect(labels).toContain('T+14');
  });

  it('names Email and Task in a legend', () => {
    renderTimeline(PREMIUM);
    expect(screen.getByText(S.timeline.legendEmail)).toBeInTheDocument();
    expect(screen.getByText(S.timeline.legendTask)).toBeInTheDocument();
  });

  it('with no steps, still shows the renewal date and says only it is shown', () => {
    const { container } = renderTimeline([]);
    expect(container.querySelector('[data-due-line]')).not.toBeNull();
    expect(screen.getByText(S.timeline.emptyDue)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-lane]')).toHaveLength(0);
  });

  it('fills its box instead of scrolling sideways, with positions in percent so labels keep their size', () => {
    const { container } = renderTimeline(PREMIUM);
    const chart = screen.getByRole('img');
    expect(chart.getAttribute('width')).toBe('100%');
    expect(chart.getAttribute('viewBox')).toBeNull();
    expect(container.querySelector('[data-lane="email"]')?.getAttribute('cx')).toMatch(/%$/);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('placeAxisLabels — thins by each label\'s width, at the chart\'s real width', () => {
  const days = [0, -90, -60, -30, -7, 14];
  const text = (d: number) => (d === 0 ? 'ครบกำหนด' : d < 0 ? `T${d}` : `T+${d}`);
  // The chart's own scale: 5% padding either side of -90 … +14.
  const xAt = (width: number) => (d: number) => ((5 + ((d + 90) / 104) * 90) / 100) * width;

  it.each([320, 390, 1280])('at %ipx no two labels overlap and none leaves the chart', (width) => {
    const placed = placeAxisLabels(days, text, xAt(width), width);
    const sorted = [...placed].sort((a, b) => a.left - b.left);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.left).toBeGreaterThan(sorted[i - 1]!.right);
    for (const label of placed) {
      expect(label.left).toBeGreaterThanOrEqual(0);
      expect(label.right).toBeLessThanOrEqual(width);
    }
  });

  it('always keeps the renewal date, and keeps more labels when there is room', () => {
    const narrow = placeAxisLabels(days, text, xAt(320), 320);
    const wide = placeAxisLabels(days, text, xAt(1280), 1280);
    expect(narrow.map((l) => l.day)).toContain(0);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it('anchors a label at the chart\'s edge to that edge instead of letting it spill out', () => {
    const edgeDays = [0, -90];
    const placed = placeAxisLabels(edgeDays, (d) => (d === 0 ? 'Förfallodag' : 'T-90'), (d) => (d === 0 ? 304 : 16), 320);
    expect(placed.find((l) => l.day === 0)?.anchor).toBe('end');
  });
});
