'use client';

/**
 * F8 Phase 4 Wave I2 · Task 6 — the read-only reminder timeline at the top of
 * each tier in the schedule editor (spec §5.1).
 *
 * 122 US7b-2 (T737), boards `Admin-renewal-schedules` (+`-mobile`): a chart on
 * a day scale, as the boards draw it, replacing the legacy `Stepper` (AURA's
 * Stepper tracks progress through a wizard and has no per-step meaning).
 *   - Email markers are filled on the upper lane, task markers are rings on
 *     the lower lane, both in the chart colour; a dashed line marks the
 *     renewal date.
 *   - The axis reads "T-90 … Due … T+14": the step offsets plus the renewal
 *     date, thinned where two labels would collide (Due always stays).
 *   - One `role="img"` SVG named by a sentence listing the email and task
 *     timings, so a screen reader hears the whole schedule at once; the
 *     legend names the two marker shapes.
 *   - The SVG scales with its box (no sideways scroll at 320px).
 *
 * Markers are keyed by the editor's stable `_uiKey`, never by `step_id`
 * (recomposed on every timing edit).
 */
import { useLocale, useTranslations } from 'next-intl';
import type { EditorStep } from './schedule-editor';
import type { TierBucket } from '@/modules/renewals/client';
import { timingSentence } from './format-offset';

export interface ReminderTimelineProps {
  readonly tierBucket: TierBucket;
  readonly steps: ReadonlyArray<EditorStep>;
}

const WIDTH = 560;
const HEIGHT = 80;
const PAD_X = 24;
const EMAIL_Y = 22;
const TASK_Y = 42;
const AXIS_Y = 32;
const LABEL_Y = 70;
const RADIUS = 6;
/** Closest two axis labels may sit, in viewBox units, before one is dropped. */
const MIN_LABEL_GAP = 36;
/** Days shown either side of the renewal date when there are no other steps. */
const EMPTY_SPAN = 30;

export function ReminderTimeline({ tierBucket, steps }: ReminderTimelineProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const locale = useLocale();
  const sorted = [...steps].sort((a, b) => a.offset_days - b.offset_days);

  const offsets = sorted.map((s) => s.offset_days);
  const min = Math.min(0, ...offsets);
  const max = Math.max(0, ...offsets);
  const lo = min === max ? -EMPTY_SPAN : min;
  const hi = min === max ? EMPTY_SPAN : max;
  const x = (days: number) => PAD_X + ((days - lo) / (hi - lo)) * (WIDTH - 2 * PAD_X);

  // Axis labels: every distinct offset plus the renewal date, Due first so it
  // always survives the thinning.
  const axisDays = [0, ...[...new Set(offsets)].filter((d) => d !== 0)];
  const kept: number[] = [];
  for (const d of axisDays) {
    if (kept.every((k) => Math.abs(x(k) - x(d)) >= MIN_LABEL_GAP)) kept.push(d);
  }
  const axisLabel = (d: number) => (d === 0 ? t('timeline.dueShort') : d < 0 ? `T${d}` : `T+${d}`);

  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  const timings = (channel: EditorStep['channel']) => {
    const items = sorted.filter((s) => s.channel === channel).map((s) => timingSentence(s.offset_days, t));
    return items.length > 0 ? list.format(items) : t('timeline.none');
  };
  const chartName = t('timeline.chartLabel', {
    tier: t(`tabs.${tierBucket}`),
    email: timings('email'),
    task: timings('task'),
  });

  return (
    <div className="flex flex-col gap-[var(--aura-space-2)]">
      <svg
        role="img"
        aria-label={chartName}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        className="block h-auto max-w-full overflow-visible"
      >
        <line x1={PAD_X} x2={WIDTH - PAD_X} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--aura-chart-grid)" strokeWidth={1} />
        <line
          data-due-line=""
          x1={x(0)}
          x2={x(0)}
          y1={8}
          y2={LABEL_Y - 14}
          stroke="var(--aura-chart-axis)"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {sorted.map((s) =>
          s.channel === 'email' ? (
            <circle
              key={s._uiKey}
              data-lane="email"
              cx={x(s.offset_days)}
              cy={EMAIL_Y}
              r={RADIUS}
              fill="var(--aura-chart-1)"
            />
          ) : (
            <circle
              key={s._uiKey}
              data-lane="task"
              cx={x(s.offset_days)}
              cy={TASK_Y}
              r={RADIUS - 1}
              fill="none"
              stroke="var(--aura-chart-1)"
              strokeWidth={2}
            />
          ),
        )}
        {kept.map((d) => (
          <text
            key={d}
            data-axis-label=""
            x={x(d)}
            y={LABEL_Y}
            textAnchor="middle"
            fontSize={11}
            fill="var(--aura-fg-secondary)"
          >
            {axisLabel(d)}
          </text>
        ))}
      </svg>
      {sorted.length === 0 ? (
        <p className="m-0 text-xs text-[var(--aura-fg-secondary)]">{t('timeline.emptyDue')}</p>
      ) : null}
      {/* The legend names the two marker shapes; the chart's name already
          lists the timings for a screen reader. */}
      <ul className="m-0 flex list-none flex-wrap gap-[var(--aura-space-4)] p-0 text-xs text-[var(--aura-fg-secondary)]">
        <li className="flex items-center gap-[var(--aura-space-1)]">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="5" fill="var(--aura-chart-1)" />
          </svg>
          {t('timeline.legendEmail')}
        </li>
        <li className="flex items-center gap-[var(--aura-space-1)]">
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
            <circle cx="6" cy="6" r="4" fill="none" stroke="var(--aura-chart-1)" strokeWidth={2} />
          </svg>
          {t('timeline.legendTask')}
        </li>
      </ul>
    </div>
  );
}
