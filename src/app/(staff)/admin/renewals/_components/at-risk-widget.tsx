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

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Heart, AlertTriangle, AlertCircle } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
  const [activeBand, setActiveBand] = useState<Band>('at-risk');
  // Single state shape (data | error) keyed by activeBand so changing
  // the band re-runs the fetch via effect-with-fresh-key. `loading` is
  // derived (null data + null error) — avoids react-hooks/set-state-
  // in-effect rule fires.
  const [fetchState, setFetchState] = useState<{
    band: Band;
    data: ApiResponse | null;
    error: string | null;
  }>({ band: activeBand, data: null, error: null });

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
  }, [activeBand]);

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
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('featureDisabled')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card aria-labelledby="at-risk-widget-title">
      <CardHeader>
        <CardTitle id="at-risk-widget-title">{t('title')}</CardTitle>
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
        <div
          role="tablist"
          aria-label={t('bandTabs.label')}
          className="mb-3 flex flex-wrap gap-1 border-b"
        >
          {BANDS.map((band) => {
            const count =
              data?.summary[band] !== undefined ? data.summary[band] : null;
            const isActive = activeBand === band;
            return (
              <button
                key={band}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="at-risk-widget-rows"
                onClick={() => setActiveBand(band)}
                className={
                  'inline-flex items-center gap-1 rounded-t-md px-3 py-1.5 text-sm font-medium transition-colors ' +
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

        <div id="at-risk-widget-rows">
          {loading ? (
            <WidgetSkeleton />
          ) : error ? (
            <p className="py-6 text-center text-sm text-destructive">
              {t('errorLoading')}
            </p>
          ) : !data || data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('emptyState')}
            </p>
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
                        ? new Date(
                            m.risk_score_last_computed_at,
                          ).toLocaleDateString()
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
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
                            size="sm"
                            variant="ghost"
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

function BandIcon({ band }: { band: Band }) {
  if (band === 'warning')
    return <Heart className="h-3.5 w-3.5" aria-hidden="true" />;
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
