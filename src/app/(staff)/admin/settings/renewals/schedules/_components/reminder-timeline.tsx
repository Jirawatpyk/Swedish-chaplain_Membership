'use client';

/**
 * F8 Phase 4 Wave I2 · Task 6 — read-only reminder timeline strip, shown
 * atop each tier tab in the schedule editor (spec §5.1).
 *
 * Renders pins along a `[-120, +30]`-day axis (email = blue `--chart-1`,
 * task = amber `--chart-5`) plus a red due-date marker at day 0, backed by
 * a visually-hidden `<ol>` text alternative that is the SOLE data path for
 * screen readers / no-JS (WCAG 1.1.1 / 1.3.1 — same "canvas is
 * `aria-hidden`, a real DOM list carries the data" pattern the 067
 * dashboard charts use, see `components/dashboard/membership-tier-chart.tsx`).
 * The axis + due-date marker render unconditionally, including with zero
 * steps (design doc §5.1: "a tier with zero steps renders the due-date
 * marker only (no pins)") — only the per-step pins are conditional.
 *
 * Colour token note: the design contract calls for "email = blue,
 * task = amber". `globals.css` defines `--chart-1` as the navy/blue token
 * in both themes, but `--chart-4` is ALSO a blue (navy / deep-blue) in
 * both light and dark mode — `--chart-5` is the amber token. Using
 * `--chart-4` here (as an earlier draft of this brief's skeleton
 * suggested) would render two visually-indistinguishable blue pins.
 * Confirmed against `src/app/globals.css` lines ~204-208 (light) and
 * ~340-344 (dark) before choosing `--chart-5`. Colour is never the SOLE
 * differentiator regardless — the `Mail`/`ListTodo` icons plus a third
 * `bg-destructive` swatch in the legend, and the "Email"/"Task" words in
 * the SR list, carry the same distinctions (WCAG 1.1.1 / 1.4.1) — the red
 * due marker in particular previously had no text equivalent at all,
 * fixed by adding the `timeline.dueLabel` legend entry.
 *
 * ID prefixing: Base UI `Tabs.Panel` (see `../schedule-editor.tsx`) keeps
 * all 5 tier panels mounted simultaneously (toggling `hidden`, not
 * unmounting) so this component renders once per tier bucket at all
 * times. Every `id` in this file is namespaced `${tierBucket}-…` via the
 * local `id()` helper so 5 concurrently-mounted instances never collide
 * (WCAG 4.1.1).
 */
import { useTranslations } from 'next-intl';
import { Mail, ListTodo } from 'lucide-react';
import type { ScheduleStepWire } from './schedule-editor';
import type { TierBucket } from '@/modules/renewals/client';

const AXIS_MIN = -120;
const AXIS_MAX = 30;

function pct(day: number): number {
  const clamped = Math.min(AXIS_MAX, Math.max(AXIS_MIN, day));
  return ((clamped - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * 100;
}

export interface ReminderTimelineProps {
  readonly tierBucket: TierBucket;
  readonly steps: ReadonlyArray<ScheduleStepWire>;
}

export function ReminderTimeline({ tierBucket, steps }: ReminderTimelineProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const id = (suffix: string) => `${tierBucket}-tl-${suffix}`;
  const sorted = [...steps].sort((a, b) => a.offset_days - b.offset_days);

  const offsetLabel = (offsetDays: number) =>
    offsetDays === 0
      ? t('stepCard.offsetDay.exact')
      : offsetDays < 0
        ? t('stepCard.offsetDay.before', { days: Math.abs(offsetDays) })
        : t('stepCard.offsetDay.after', { days: offsetDays });

  return (
    <div className="rounded-md border bg-muted/30 p-4" role="group" aria-labelledby={id('cap')}>
      <p id={id('cap')} className="sr-only">
        {t('timeline.textAlt', { count: steps.length })}
      </p>

      {/* Axis + due-date marker — ALWAYS rendered, even with zero steps
          (design contract §5.1: "a tier with zero steps renders the
          due-date marker only (no pins)"). Only the per-step pins are
          conditional on `sorted.length`. */}
      <div className="relative mt-6 h-0.5 bg-border" aria-hidden="true">
        {/* Due-date marker, always at day 0 regardless of axis clamping. */}
        <span
          className="absolute top-[-7px] h-4 w-0.5 -translate-x-1/2 bg-destructive"
          style={{ left: `${pct(0)}%` }}
        />
        {sorted.map((s) => (
          <span
            key={s.step_id}
            className={`absolute top-[-5px] h-3 w-3 -translate-x-1/2 rounded-full border-2 border-background ${
              s.channel === 'email' ? 'bg-chart-1' : 'bg-chart-5'
            }`}
            style={{ left: `${pct(s.offset_days)}%` }}
          />
        ))}
      </div>

      {sorted.length === 0 ? (
        <p className="mt-2 text-center text-caption text-muted-foreground">{t('timeline.emptyDue')}</p>
      ) : null}

      {/* Text alternative — ALWAYS rendered (not conditionally hidden by
          the pin-strip branch above) so assistive tech gets the same
          "N reminder(s)" overview via the `timeline.textAlt` caption even
          when `sorted.length === 0` (the caption itself reads "0 reminders"
          via the ICU plural, matching the visible empty-due copy). */}
      <ol className="sr-only">
        {sorted.map((s) => (
          <li key={s.step_id}>
            {offsetLabel(s.offset_days)} {'·'} {t(`stepCard.channel.${s.channel}`)}
          </li>
        ))}
      </ol>

      <div className="mt-6 flex justify-center gap-4 text-caption text-muted-foreground">
        <span className="flex items-center gap-1">
          <Mail aria-hidden="true" className="h-3 w-3 text-chart-1" />
          {t('timeline.legendEmail')}
        </span>
        <span className="flex items-center gap-1">
          <ListTodo aria-hidden="true" className="h-3 w-3 text-chart-5" />
          {t('timeline.legendTask')}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-destructive" />
          {t('timeline.dueLabel')}
        </span>
      </div>
    </div>
  );
}
