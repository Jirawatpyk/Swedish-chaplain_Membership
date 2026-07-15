/**
 * F8 Phase 6 Wave E · T167 — `AtRiskWidget` admin dashboard component.
 *
 * Renders the at-risk-members widget on `/admin/renewals` per FR-029
 * +FR-030 + FR-052a manager-visible read + FR-034 hidden-from-member.
 *
 * Features:
 *   - 3 band-tabs (warning | at-risk | critical) — default 'at-risk'
 *   - Sortable table (server-side: ordered by risk_score DESC) with:
 *       company name + score badge + last computed timestamp + last
 *       outreach + action buttons
 *   - Snooze CTA — admin only (manager hidden per FR-052a)
 *   - Contact CTA — admin OR manager visible (FR-052a manager exception)
 *   - Empty state per FR-046a ("All members healthy this week")
 *   - Skeleton loader during fetch (docs/ux-standards.md § 2.1)
 *
 * Authz at the route level (T163 GET denies member, returns
 * feature_disabled placeholder for granular kill-switch); this
 * client component renders whatever the API returns.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertCircle,
  AlertTriangle,
  HelpCircleIcon,
  ShieldCheck,
  TrendingDown,
} from 'lucide-react';
import Link from 'next/link';
import { formatLocalisedTimestamp } from '@/components/members/timeline-event-item';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  RiskScoreBadge,
  type RiskBand,
} from '@/components/renewals/risk-score-badge';
import { SnoozeDialog } from './snooze-dialog';
import { OutreachDialog } from './outreach-dialog';

const BANDS = ['warning', 'at-risk', 'critical'] as const;
type Band = (typeof BANDS)[number];

interface ApiRow {
  readonly member_id: string;
  readonly company_name: string | null;
  readonly risk_score: number;
  readonly risk_score_band: RiskBand;
  readonly risk_score_last_computed_at: string | null;
  readonly risk_snoozed_until: string | null;
}

interface ApiResponse {
  readonly items: ReadonlyArray<ApiRow>;
  readonly next_cursor: string | null;
  readonly summary: {
    readonly warning: number;
    readonly 'at-risk': number;
    readonly critical: number;
    readonly f6_active: boolean;
    readonly active_max: 70 | 100;
  };
  readonly feature_disabled?: boolean;
}

export interface AtRiskWidgetProps {
  /** Captured server-side from session — admin/manager/member. */
  readonly actorRole: 'admin' | 'manager';
}

export function AtRiskWidget({ actorRole }: AtRiskWidgetProps) {
  const t = useTranslations('admin.renewals.atRisk');
  const locale = useLocale();
  const [activeBand, setActiveBand] = useState<Band>('at-risk');
  // Phase 6 review C5 — refetch counter bumped by retry button so
  // the effect re-runs fetch when the user dismisses an error state.
  const [refetchKey, setRefetchKey] = useState(0);
  // Single state shape (data | error) keyed by activeBand so changing
  // the band re-runs the fetch via effect-with-fresh-key. `loading` is
  // derived (null data + null error) — avoids react-hooks/set-state-
  // in-effect rule fires.
  const [fetchState, setFetchState] = useState<{
    band: Band;
    data: ApiResponse | null;
    error: string | null;
  }>({ band: activeBand, data: null, error: null });

  // Phase 6 review S7 — refs for arrow-key navigation across band tabs.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Snooze + outreach dialog state.
  const [snoozeFor, setSnoozeFor] = useState<{
    memberId: string;
    companyName: string | null;
  } | null>(null);
  const [outreachFor, setOutreachFor] = useState<{
    memberId: string;
    companyName: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const url = `/api/admin/renewals/at-risk?band=${encodeURIComponent(activeBand)}&limit=20`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`http_${res.status}`);
        }
        return (await res.json()) as ApiResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setFetchState({ band: activeBand, data: json, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFetchState({
          band: activeBand,
          data: null,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeBand, refetchKey]);

  // Loading is "active band changed and we haven't yet seen a response
  // for it" (state still pinned to previous band's data). This derivation
  // avoids setState-in-effect rule violations.
  const loading =
    fetchState.band !== activeBand ||
    (fetchState.data === null && fetchState.error === null);
  const data = fetchState.band === activeBand ? fetchState.data : null;
  const error = fetchState.band === activeBand ? fetchState.error : null;

  // Granular kill-switch placeholder render (FR-052b).
  if (data?.feature_disabled) {
    return (
      <Card data-testid="at-risk-widget-disabled">
        <CardHeader>
          <h2 className="text-base font-semibold leading-none tracking-tight">
            {t('title')}
          </h2>
          <CardDescription>{t('featureDisabled')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card aria-labelledby="at-risk-widget-title">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <h2
            id="at-risk-widget-title"
            className="text-base font-semibold leading-none tracking-tight"
          >
            {t('title')}
          </h2>
          {/* Tap-discoverable help (Popover, works on touch — not a hover
              Tooltip) explaining what "at-risk" means + the three bands.
              Beside the heading, same pattern as the pipeline-tab help. */}
          <Popover>
            <PopoverTrigger
              type="button"
              aria-label={t('help.ariaLabel')}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <HelpCircleIcon className="size-4" aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent
              className="w-80 max-w-[calc(100vw-2rem)] text-sm"
              sideOffset={4}
            >
              <p className="font-medium">{t('help.title')}</p>
              <p className="mt-1.5 text-muted-foreground">{t('help.body')}</p>
            </PopoverContent>
          </Popover>
        </div>
        <CardDescription>
          {data?.summary
            ? t('summary', {
                warning: data.summary.warning,
                atRisk: data.summary['at-risk'],
                critical: data.summary.critical,
              })
            : t('summaryLoading')}
          {data?.summary && !data.summary.f6_active ? (
            <span className="ml-2 text-xs text-muted-foreground">
              ({t('f6Inactive', { max: data.summary.active_max })})
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Phase 6 review S7 — ARIA tablist with arrow-key navigation. */}
        <div
          role="tablist"
          aria-label={t('bandTabs.label')}
          className="mb-3 flex flex-wrap gap-1 border-b"
        >
          {BANDS.map((band, idx) => {
            const count =
              data?.summary[band] !== undefined ? data.summary[band] : null;
            const isActive = activeBand === band;
            return (
              <button
                key={band}
                id={`at-risk-widget-tab-${band}`}
                ref={(el) => {
                  tabRefs.current[idx] = el;
                }}
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                aria-controls="at-risk-widget-rows"
                onClick={() => setActiveBand(band)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    const dir = e.key === 'ArrowRight' ? 1 : -1;
                    const nextIdx = (idx + dir + BANDS.length) % BANDS.length;
                    setActiveBand(BANDS[nextIdx]!);
                    tabRefs.current[nextIdx]?.focus();
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    setActiveBand(BANDS[0]!);
                    tabRefs.current[0]?.focus();
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    const last = BANDS.length - 1;
                    setActiveBand(BANDS[last]!);
                    tabRefs.current[last]?.focus();
                  }
                }}
                className={
                  // R4-BLK-4 (staff-review-2026-05-09): WCAG 2.4.7 — band
                  // tab buttons MUST surface keyboard focus. Tailwind v4 +
                  // shadcn/ui globals reset native outlines, so the
                  // focus-visible ring has to be opted-in explicitly.
                  // Pattern matches `success/page.tsx:125` Link focus ring
                  // for visual consistency across F8 surfaces.
                  'inline-flex items-center gap-1 rounded-t-md px-3 py-1.5 text-sm font-medium motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ' +
                  (isActive
                    ? 'border-b-2 border-primary text-primary'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                <BandIcon band={band} />
                {t(`bandTabs.${band.replace('-', '_')}`)}
                {count !== null ? (
                  <span className="ml-1 tabular-nums">({count})</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/*
         * R4-S1 (staff-review-2026-05-09): ARIA Tabs APG pattern — the
         * panel under a tablist MUST carry `role="tabpanel"` and link
         * back to the active tab via `aria-labelledby`. Visual + keyboard
         * UX worked before, but the SR semantics now match WAI-ARIA APG.
         */}
        <div
          id="at-risk-widget-rows"
          role="tabpanel"
          aria-labelledby={`at-risk-widget-tab-${activeBand}`}
        >
          {loading ? (
            <WidgetSkeleton />
          ) : error ? (
            // Phase 6 review C5 — role="alert" announces error to SR
            // (WCAG SC 4.1.3); retry button bumps refetchKey to re-run
            // the effect.
            <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-destructive">{t('errorLoading')}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRefetchKey((k) => k + 1)}
              >
                {t('actions.retry')}
              </Button>
            </div>
          ) : !data || data.items.length === 0 ? (
            // Phase 6 review S8 — illustration + secondary CTA per
            // FR-046a + ux-standards § 5 empty-state pattern.
            // UX R5 / S2: empty-state CTA points at the lapsed urgency
            // tab on this same page rather than away to /admin/members
            // — admins working the at-risk widget care about lapsed
            // recovery next, not the full membership list.
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <ShieldCheck
                className="h-8 w-8 text-success"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t('emptyState')}
              </p>
              <Link
                href="/admin/renewals?urgency=lapsed"
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                {t('actions.reviewLapsed')}
              </Link>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('table.company')}</TableHead>
                  <TableHead>{t('table.score')}</TableHead>
                  <TableHead>{t('table.lastComputed')}</TableHead>
                  <TableHead className="text-right">
                    {t('table.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((m) => (
                  <TableRow key={m.member_id}>
                    <TableCell className="font-medium">
                      {m.company_name ?? t('table.unknownCompany')}
                    </TableCell>
                    <TableCell>
                      <RiskScoreBadge
                        score={m.risk_score}
                        band={m.risk_score_band}
                        activeMax={data.summary.active_max}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground tabular-nums">
                      {m.risk_score_last_computed_at
                        ? // Phase 6 review I2 — locale-pinned formatter
                          // (Buddhist calendar on th-TH per CLAUDE.md
                          // BE display-only convention).
                          formatLocalisedTimestamp(
                            m.risk_score_last_computed_at,
                            locale,
                          )
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {/*
                       * R4-BLK-5 (staff-review-2026-05-09): WCAG 2.5.5
                       * touch target — Contact + Snooze pair must not
                       * crowd at <375px viewport. Stack vertically on
                       * narrow viewports (each button gets full row width
                       * + 36px height = 44px minimum effective target via
                       * default Button size); restore inline `flex-row`
                       * + right-justified at sm: breakpoint and above.
                       * Both buttons share `size="default"` (h-9 = 36px)
                       * for consistency.
                       */}
                      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-end">
                        <Button
                          variant="outline"
                          className="w-full sm:w-auto"
                          aria-label={t('actions.contactAriaLabel', {
                            company:
                              m.company_name ?? t('table.unknownCompany'),
                          })}
                          onClick={() =>
                            setOutreachFor({
                              memberId: m.member_id,
                              companyName: m.company_name,
                            })
                          }
                        >
                          {t('actions.contact')}
                        </Button>
                        {actorRole === 'admin' ? (
                          <Button
                            variant="ghost"
                            className="w-full sm:w-auto"
                            aria-label={t('actions.snoozeAriaLabel', {
                              company:
                                m.company_name ?? t('table.unknownCompany'),
                            })}
                            onClick={() =>
                              setSnoozeFor({
                                memberId: m.member_id,
                                companyName: m.company_name,
                              })
                            }
                          >
                            {t('actions.snooze')}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>

      {snoozeFor ? (
        <SnoozeDialog
          open
          onOpenChange={(open) => {
            if (!open) setSnoozeFor(null);
          }}
          memberId={snoozeFor.memberId}
          memberCompanyName={snoozeFor.companyName}
        />
      ) : null}
      {outreachFor ? (
        <OutreachDialog
          open
          onOpenChange={(open) => {
            if (!open) setOutreachFor(null);
          }}
          memberId={outreachFor.memberId}
          memberCompanyName={outreachFor.companyName}
        />
      ) : null}
    </Card>
  );
}

// UX R5 / I4: warning band uses TrendingDown (downward engagement
// trend) instead of Heart (which conventionally signals "healthy"
// and confused admins into reading the warning state as positive).
function BandIcon({ band }: { band: Band }) {
  if (band === 'warning')
    return <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />;
  if (band === 'at-risk')
    return <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />;
  return <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />;
}

function WidgetSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-8 w-32" />
        </div>
      ))}
    </div>
  );
}
