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
 *     date, thinned by each label's estimated width at the chart's measured
 *     width, so "ครบกำหนด" or "Förfallodag" never runs into a neighbour on a
 *     phone (Due always stays); a label at either edge anchors to that edge.
 *   - One `role="img"` SVG named by a sentence listing the email and task
 *     timings, so a screen reader hears the whole schedule at once; the
 *     legend names the two marker shapes.
 *   - Horizontal positions are percentages of the chart's width and vertical
 *     ones are pixels, so the chart fills its box at any width (no sideways
 *     scroll at 320px) while the labels stay 11px and the markers round,
 *     where a scaled viewBox would shrink the text on a phone.
 *
 * Markers are keyed by the editor's stable `_uiKey`, never by `step_id`
 * (recomposed on every timing edit).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { EditorStep } from './schedule-editor';
import type { TierBucket } from '@/modules/renewals/client';
import { timingSentence } from './format-offset';

export interface ReminderTimelineProps {
  readonly tierBucket: TierBucket;
  readonly steps: ReadonlyArray<EditorStep>;
}

const HEIGHT = 80;
/** Side padding, in percent of the width, so the outermost labels fit. */
const PAD_X = 5;
const EMAIL_Y = 22;
const TASK_Y = 42;
const AXIS_Y = 32;
const LABEL_Y = 70;
const RADIUS = 6;
const LABEL_SIZE = 11;
/** A generous average glyph width at 11px, so the estimate errs wide. */
const LABEL_CHAR_PX = 7;
/** Space kept between two axis labels, in pixels. */
const LABEL_GAP_PX = 6;
/** Width assumed until the chart is measured (server render, tests). */
const DEFAULT_WIDTH = 640;
/** Days shown either side of the renewal date when there are no other steps. */
const EMPTY_SPAN = 30;

export interface PlacedAxisLabel {
  readonly day: number;
  readonly text: string;
  readonly anchor: 'start' | 'middle' | 'end';
  /** The label's estimated extent, in pixels from the chart's left edge. */
  readonly left: number;
  readonly right: number;
}

/**
 * Picks the axis labels that fit: each label's width is estimated from its
 * length, a label that would cross the chart's edge anchors to that edge, and
 * a label that would overlap one already kept is dropped. `days` is in
 * priority order (the renewal date first, so it always stays).
 */
export function placeAxisLabels(
  days: ReadonlyArray<number>,
  textOf: (day: number) => string,
  xOf: (day: number) => number,
  width: number,
): PlacedAxisLabel[] {
  const kept: PlacedAxisLabel[] = [];
  for (const day of days) {
    const text = textOf(day);
    const w = text.length * LABEL_CHAR_PX;
    const x = xOf(day);
    let anchor: PlacedAxisLabel['anchor'] = 'middle';
    let left = x - w / 2;
    let right = x + w / 2;
    if (left < 0) {
      anchor = 'start';
      left = x;
      right = x + w;
    } else if (right > width) {
      anchor = 'end';
      left = x - w;
      right = x;
    }
    if (left < 0 || right > width) continue;
    if (kept.every((k) => right + LABEL_GAP_PX <= k.left || left >= k.right + LABEL_GAP_PX)) {
      kept.push({ day, text, anchor, left, right });
    }
  }
  return kept;
}

export function ReminderTimeline({ tierBucket, steps }: ReminderTimelineProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const locale = useLocale();
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = svg.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const sorted = [...steps].sort((a, b) => a.offset_days - b.offset_days);

  const offsets = sorted.map((s) => s.offset_days);
  const min = Math.min(0, ...offsets);
  const max = Math.max(0, ...offsets);
  const lo = min === max ? -EMPTY_SPAN : min;
  const hi = min === max ? EMPTY_SPAN : max;
  const pct = (days: number) => PAD_X + ((days - lo) / (hi - lo)) * (100 - 2 * PAD_X);
  const x = (days: number) => `${pct(days).toFixed(2)}%`;

  // Axis labels: every distinct offset plus the renewal date, Due first so it
  // always survives the thinning.
  const axisDays = [0, ...[...new Set(offsets)].filter((d) => d !== 0)];
  const axisLabel = (d: number) => (d === 0 ? t('timeline.dueShort') : d < 0 ? `T${d}` : `T+${d}`);
  const labels = placeAxisLabels(axisDays, axisLabel, (d) => (pct(d) / 100) * width, width);

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
        ref={svgRef}
        role="img"
        aria-label={chartName}
        width="100%"
        height={HEIGHT}
        className="block max-w-full overflow-visible"
      >
        <line x1={`${PAD_X}%`} x2={`${100 - PAD_X}%`} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--aura-chart-grid)" strokeWidth={1} />
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
        {labels.map((label) => (
          <text
            key={label.day}
            data-axis-label=""
            x={x(label.day)}
            y={LABEL_Y}
            textAnchor={label.anchor}
            fontSize={LABEL_SIZE}
            fill="var(--aura-fg-secondary)"
          >
            {label.text}
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
