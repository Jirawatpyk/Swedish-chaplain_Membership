'use client';

/**
 * F8 Phase 4 Wave I2 · Task 6 — read-only reminder timeline strip, shown
 * atop each tier tab in the schedule editor (spec §5.1).
 *
 * Timeline-A follow-up (`.superpowers/sdd/followup-timeline-a-brief.md`):
 * user feedback on the original pins-on-an-axis rendering was "confusing +
 * ugly" (ไม่เข้าใจ และไม่สวย) — negative offsets dominate the
 * `[-120, +30]`-day axis so pins bunched to one side. Reworked to reuse
 * the canonical `<Stepper>` primitive (the same "evenly-spaced connected
 * circles + labels" shape the F2 plan wizard and F6 webhook-config-wizard
 * already use) instead of a scaled axis, via two new OPTIONAL Stepper
 * props — `indicator` + `tone` (see `components/ui/stepper.tsx`) — that
 * let this read-only "journey" colour nodes by MEANING (email/task/due)
 * rather than by wizard PROGRESS. Every node's `status` is `'upcoming'`
 * (colour comes entirely from `tone`); there is no notion of "current
 * step" here, so `aria-current` never fires for this timeline.
 *
 * Node order: earliest-before-renewal … due-date … latest-after-renewal.
 * The due-date node is synthetic (Flag icon, danger tone) and is spliced
 * in at its sorted position (offset 0) UNLESS a real step already sits at
 * `offset_days === 0` — a "day 0" reminder is a standard offset for 4 of
 * the 5 tiers (see `TIER_REMINDER_OFFSETS`), so this is common, not an
 * edge case. When it happens, the existing step already marks the due
 * position, so no duplicate node is added.
 *
 * a11y: the Stepper's `<ol role="list">` + visible per-node labels ARE
 * the accessible representation (WCAG 1.1.1 / 1.3.1) — the old hand-
 * rolled `sr-only` `<ol>` text-alternative from the pins-on-an-axis
 * version is gone; there is nothing left for it to duplicate. Channel/
 * due icons stay `aria-hidden` — the visible label (a plain-language
 * timing sentence, never the cryptic "T-N" form — see `timingSentence`)
 * carries the meaning. Colour is never the sole differentiator: icon
 * shape + label text + the legend below all carry the same distinction
 * (WCAG 1.4.1).
 *
 * ID prefixing: `Stepper` uses `step.id` as a React key only (it renders
 * no DOM `id=` attribute), so the historical Base-UI-`Tabs` duplicate-
 * DOM-id hazard from the old sr-only-list version does not apply here.
 * Ids are still namespaced by `tierBucket` for React-key stability, since
 * Base UI `Tabs.Panel` keeps all 5 tier panels mounted simultaneously
 * (toggling `hidden`, not unmounting) — 5 `<ReminderTimeline>` instances
 * render concurrently.
 */
import { useTranslations } from 'next-intl';
import { Mail, ListTodo, Flag } from 'lucide-react';
import { Stepper, type StepperStep } from '@/components/ui/stepper';
import type { EditorStep } from './schedule-editor';
import type { TierBucket } from '@/modules/renewals/client';
import { timingSentence } from './format-offset';

export interface ReminderTimelineProps {
  readonly tierBucket: TierBucket;
  // v3 rework (`.superpowers/sdd/rework-stepcard-v3-brief.md`, Change 3)
  // — keyed by the editor's stable `_uiKey`, NOT `step_id` (which is
  // recomposed on every timing/channel edit — keying by it caused a
  // remount/focus-loss bug in the sibling `<StepCard>` list; the same
  // instability would apply here).
  readonly steps: ReadonlyArray<EditorStep>;
}

export function ReminderTimeline({ tierBucket, steps }: ReminderTimelineProps) {
  const t = useTranslations('admin.renewals.settings.schedules');
  const sorted = [...steps].sort((a, b) => a.offset_days - b.offset_days);
  const hasDueStep = sorted.some((s) => s.offset_days === 0);

  const dueNode: StepperStep = {
    id: `${tierBucket}-due`,
    label: t('timeline.dueLabel'),
    status: 'upcoming',
    tone: 'danger',
    indicator: <Flag aria-hidden="true" className="size-4" />,
  };

  // Reminder nodes in sorted order, with the synthetic due-date node
  // spliced in at the offset-0 position — unless a real step already
  // occupies it (see file doc comment above).
  const stepperSteps: StepperStep[] = [];
  let dueInserted = hasDueStep;
  for (const s of sorted) {
    if (!dueInserted && s.offset_days > 0) {
      stepperSteps.push(dueNode);
      dueInserted = true;
    }
    stepperSteps.push({
      id: `${tierBucket}-${s._uiKey}`,
      label: timingSentence(s.offset_days, t),
      status: 'upcoming',
      tone: s.channel === 'email' ? 'info' : 'warning',
      indicator:
        s.channel === 'email' ? (
          <Mail aria-hidden="true" className="size-4" />
        ) : (
          <ListTodo aria-hidden="true" className="size-4" />
        ),
    });
  }
  // Every step was before the due date (or there were no steps at all) —
  // the due node hasn't been placed yet, so it goes last.
  if (!dueInserted) {
    stepperSteps.push(dueNode);
  }

  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <Stepper
        orientation="horizontal"
        steps={stepperSteps}
        aria-label={t('timeline.ariaLabel', { tier: t(`tabs.${tierBucket}`) })}
      />

      {/* Zero real steps → the Stepper above renders the due-date node
          only (design contract §5.1); this caption explains why. */}
      {sorted.length === 0 ? (
        <p className="mt-4 text-center text-caption text-muted-foreground">
          {t('timeline.emptyDue')}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap justify-center gap-4 text-caption text-muted-foreground">
        <span className="flex items-center gap-1">
          <Mail aria-hidden="true" className="h-3 w-3 text-chart-1" />
          {t('timeline.legendEmail')}
        </span>
        <span className="flex items-center gap-1">
          <ListTodo aria-hidden="true" className="h-3 w-3 text-chart-5" />
          {t('timeline.legendTask')}
        </span>
        <span className="flex items-center gap-1">
          <Flag aria-hidden="true" className="h-3 w-3 text-destructive" />
          {t('timeline.dueLabel')}
        </span>
      </div>
    </div>
  );
}
