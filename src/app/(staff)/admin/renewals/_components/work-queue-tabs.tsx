/**
 * Wave 2 Task 7 — `WorkQueueTabs`: consolidates the pipeline body + the
 * `AtRiskWidget` into ONE work-queue control on `/admin/renewals`.
 *
 * Previously the two surfaces were stacked as separate cards below the
 * section tabs (`RenewalsSectionTabs`); this 2-lens client tablist folds
 * them into a single "Pipeline" / "Needs action" switcher instead, so the
 * page reads as one queue with two lenses rather than two independent
 * widgets competing for attention. Presentation-only — no URL param is
 * added (client `useState`), so the `admin-pipeline-route` /
 * `renewal-pipeline-dashboard` / `renewal-i18n` contracts are untouched.
 *
 * `pipeline` and `needsAction` are handed in as `ReactNode` — the pipeline
 * body is server-streamed content (filter row + urgency tabs + table/lapsed
 * + pagination) composed by the page, and `needsAction` mounts the unchanged
 * `AtRiskWidget`. Only the ACTIVE lens's panel is mounted, keeping "one
 * queue" honest and mounting/unmounting the pipeline block cheap (it's
 * already-rendered content, not a re-fetch).
 *
 * a11y — THREE `role="tablist"` levels now coexist on this page:
 *   1. `RenewalsSectionTabs` (4 section tabs, ABOVE this component)
 *   2. `WorkQueueTabs` (this component — 2 lenses)
 *   3a. `UrgencyBucketTabs` (8 buckets, nested inside the pipeline lens)
 *   3b. `AtRiskWidget`'s own 3-band tablist (nested inside the needs-action
 *       lens)
 * Each tablist carries a DISTINCT `aria-label` so screen-reader users can
 * tell them apart: "Renewals sections" / "Work queue" / "Filter by renewal
 * urgency" / "Filter by risk band". The roving-tabindex pattern here is
 * ported verbatim from `at-risk-widget.tsx`'s proven band-tabs
 * implementation (ArrowLeft/Right/Home/End, `tabIndex={active?0:-1}`,
 * `aria-selected`, `role="tab"`/`role="tabpanel"` linked by id) rather than
 * the shadcn/Base UI `<Tabs>` primitive used by `RenewalsSectionTabs` +
 * `UrgencyBucketTabs`, so the nested `AtRiskWidget` tablist (which uses the
 * same custom pattern) stays visually and behaviourally consistent with its
 * sibling lens.
 */
'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarClock, ListChecks } from 'lucide-react';

const LENSES = ['pipeline', 'needsAction'] as const;
type Lens = (typeof LENSES)[number];

export interface WorkQueueTabsProps {
  /** Pipeline lens — the existing filter row + urgency tabs + table/lapsed + pagination block. */
  readonly pipeline: React.ReactNode;
  /** Needs-action lens — the unchanged `AtRiskWidget` (its own nested 3-band tablist is preserved). */
  readonly needsAction: React.ReactNode;
  /**
   * Fix I-1 (review round 1) — count badge streamed in server-side by the
   * page (mirrors the `RenewalsSectionTabs` `TabCountBadge` idiom), shown
   * INSIDE the "Needs action" tab right after its label. Restores at-risk
   * discoverability now that `AtRiskWidget` is hidden behind an inactive
   * tab by default (it used to render always-visible). Absent renders
   * nothing — the "pipeline" tab never gets a badge slot.
   */
  readonly needsActionBadge?: React.ReactNode;
}

export function WorkQueueTabs({
  pipeline,
  needsAction,
  needsActionBadge,
}: WorkQueueTabsProps) {
  const t = useTranslations('admin.renewals.workQueue');
  const [active, setActive] = useState<Lens>('pipeline');
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div>
      <div
        role="tablist"
        aria-label={t('label')}
        className="mb-3 flex flex-wrap gap-1 border-b"
      >
        {LENSES.map((lens, idx) => {
          const isActive = active === lens;
          return (
            <button
              key={lens}
              id={`work-queue-tab-${lens}`}
              ref={(el) => {
                refs.current[idx] = el;
              }}
              type="button"
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              aria-controls="work-queue-panel"
              onClick={() => setActive(lens)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const dir = e.key === 'ArrowRight' ? 1 : -1;
                  const n = (idx + dir + LENSES.length) % LENSES.length;
                  setActive(LENSES[n]!);
                  refs.current[n]?.focus();
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setActive(LENSES[0]!);
                  refs.current[0]?.focus();
                } else if (e.key === 'End') {
                  e.preventDefault();
                  const last = LENSES.length - 1;
                  setActive(LENSES[last]!);
                  refs.current[last]?.focus();
                }
              }}
              className={
                'inline-flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm font-medium motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ' +
                (isActive
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {lens === 'pipeline' ? (
                <CalendarClock className="size-3.5" aria-hidden="true" />
              ) : (
                // M-2 (review round 1) — distinct from the `AlertTriangle`
                // used by the at-risk band tab AND the pipeline's own
                // load-error card, so the lens icon no longer shares a
                // glyph with content nested inside it.
                <ListChecks className="size-3.5" aria-hidden="true" />
              )}
              {t(lens)}
              {lens === 'needsAction' ? needsActionBadge : null}
            </button>
          );
        })}
      </div>
      {/* M-1 (review round 1) — `pt-3` separates this tablist from the
          nested urgency/band tablist that opens the active panel, so the
          two tab bars read as distinct controls rather than one continuous
          strip. M-3 — a modest `min-height` softens the reflow when
          switching from the (tall) pipeline table to the (shorter)
          at-risk widget, without leaving a large empty gap on the
          shorter lens. */}
      <div
        id="work-queue-panel"
        role="tabpanel"
        aria-labelledby={`work-queue-tab-${active}`}
        className="pt-3 min-h-[320px]"
      >
        {active === 'pipeline' ? pipeline : needsAction}
      </div>
    </div>
  );
}
