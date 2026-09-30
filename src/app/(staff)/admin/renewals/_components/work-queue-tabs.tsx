/**
 * `WorkQueueTabs` — the pipeline body and the `AtRiskWidget` as ONE work
 * queue with two lenses on `/admin/renewals`: "All renewals" and "Needs
 * action". Presentation-only — client state, no URL param, so the
 * `admin-pipeline-route` / `renewal-pipeline-dashboard` / `renewal-i18n`
 * contracts are untouched.
 *
 * `pipeline` and `needsAction` are handed in as `ReactNode` (the
 * server-streamed pipeline block; the unchanged `AtRiskWidget`). Only the
 * active lens is mounted. Each lens sits in `#work-queue-panel`, the hook
 * the e2e specs scope the pipeline's own table to.
 *
 * 122 US7a (T703): AURA segmented `Tabs` (board `Admin-renewals`: "All
 * renewals | Needs action · 7"), with the pipeline help at the end of the
 * row. The needs-action count is resolved by the page (a cheap summary read
 * started beside the pipeline load), so the tab can carry it as AURA's
 * `count` without remounting the lens when it arrives.
 *
 * a11y — the nested tablists and navs each carry a distinct name: "Renewals
 * sections" (nav), "Work queue" (this tablist), "Filter by renewal urgency"
 * (nav, inside the pipeline lens) and "Filter by risk band" (inside the
 * needs-action lens).
 */
'use client';

import { useTranslations } from 'next-intl';
import { Tabs, type TabItem } from '@jirawatpyk/aura-react';
import { PipelineHelp } from './pipeline-help';

export interface WorkQueueTabsProps {
  /** Pipeline lens — the filter row + urgency tabs + table/lapsed + pagination block. */
  readonly pipeline: React.ReactNode;
  /** Needs-action lens — the unchanged `AtRiskWidget`. */
  readonly needsAction: React.ReactNode;
  /**
   * Members that need action now (critical + at risk); shown on the tab when
   * above 0. Absent when the count could not be read (best-effort).
   */
  readonly needsActionCount?: number;
  /** The lens shown first — the page always opens on the pipeline; the
   *  preview of `Admin-renewals-needs-action` opens on Needs action. */
  readonly defaultLens?: 'pipeline' | 'needsAction';
}

export function WorkQueueTabs({
  pipeline,
  needsAction,
  needsActionCount,
  defaultLens = 'pipeline',
}: WorkQueueTabsProps) {
  const t = useTranslations('admin.renewals.workQueue');
  const needsActionLabel = t('needsAction');
  const counted = needsActionCount !== undefined && needsActionCount > 0;

  const panel = (content: React.ReactNode) => (
    // A modest min-height softens the reflow between the (tall) pipeline and
    // the (shorter) at-risk lens.
    <div id="work-queue-panel" className="min-h-[320px] pt-[var(--aura-space-3)]">
      {content}
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'pipeline', label: t('pipeline'), content: panel(pipeline) },
    {
      id: 'needsAction',
      label: needsActionLabel,
      content: panel(needsAction),
      ...(counted
        ? {
            count: needsActionCount,
            // The name starts with the visible label (WCAG 2.5.3).
            tabProps: {
              'aria-label': `${needsActionLabel}, ${t('needsActionCountSr', { count: needsActionCount })}`,
            },
          }
        : {}),
    },
  ];

  return (
    <div className="relative">
      <Tabs label={t('label')} tabs={tabs} variant="segmented" defaultValue={defaultLens} />
      {/* The help sits at the end of the toggle row (the tablist is as wide
          as its two tabs, so the corner is free). */}
      <div className="absolute end-0 top-0">
        <PipelineHelp />
      </div>
    </div>
  );
}
