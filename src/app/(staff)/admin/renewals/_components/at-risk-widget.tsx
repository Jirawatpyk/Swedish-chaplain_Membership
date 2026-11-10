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
 *
 * 122 US7a (T706), board `Admin-renewals-needs-action`: a titled section
 * inside the work queue (no card of its own), the bands as AURA tabs with
 * counts, the rows as an AURA table that stacks into cards on a phone (the
 * company links to the member), Contact and Snooze as AURA buttons, and the
 * help as an AURA popover. The board's "Main signal" column is not shown:
 * the at-risk API returns no signal field (a data change, out of scope for
 * the UI swap).
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  Popover,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  Tabs,
  type TabItem,
} from '@jirawatpyk/aura-react';
import { formatLocalisedTimestamp } from '@/components/members/timeline-event-item';
import {
  RiskScoreBadge,
  type RiskBand,
} from '@/components/renewals/risk-score-badge';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
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
  /** `canPerform(role, 'renewals.write')` — the gate on the snooze route. */
  readonly canSnooze: boolean;
}

export function AtRiskWidget({ canSnooze }: AtRiskWidgetProps) {
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
  // Snooze + outreach dialog state.
  const [snoozeFor, setSnoozeFor] = useState<{
    memberId: string;
    companyName: string | null;
  } | null>(null);
  const [outreachFor, setOutreachFor] = useState<{
    memberId: string;
    companyName: string | null;
  } | null>(null);
  // Review fix #5 (WCAG 2.1 AA SC 2.4.3) — the "Contact" button that opens
  // `OutreachDialog` is a plain visible button (not behind a menu), so a
  // single shared ref suffices: snapshot the exact button element that was
  // clicked via `e.currentTarget` at open time (mirrors
  // tier-upgrade-queue.tsx's `triggerRef.current = e.currentTarget`
  // pattern), then hand it to `OutreachDialog` as `finalFocus` so Base UI
  // returns focus there on close instead of the default target dropping to
  // `<body>`.
  const outreachTriggerRef = useRef<HTMLButtonElement | null>(null);
  // a11y fix (mirrors outreachTriggerRef above, same rationale) — the
  // "Snooze" button is likewise a plain visible button, so it needs its
  // own snapshot ref handed to `SnoozeDialog` as `finalFocus`.
  const snoozeTriggerRef = useRef<HTMLButtonElement | null>(null);

  // #765 — "Show more": the band's next 20 rows, appended, from the API's
  // own `next_cursor` (the tab counts were already true; only the rows were
  // capped at 20). Kept per band + load, so a band change or a retry starts
  // again from the first page.
  const loadKey = `${activeBand}:${refetchKey}`;
  const [more, setMore] = useState<{
    key: string;
    items: ReadonlyArray<ApiRow>;
    cursor: string | null;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  const moreHere = more !== null && more.key === loadKey ? more : null;
  // After an append, focus moves to the first new row's link (keyboard and
  // screen-reader users continue where the list grew, not at the button).
  const focusIndexRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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
  const heading = (
    <div className="flex items-center gap-[var(--aura-space-1)]">
      <h2 id="at-risk-widget-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      {/* Tap-discoverable help (a popover, not a hover tooltip) explaining
          what "at-risk" means and the three bands. */}
      <Popover
        title={t('help.title')}
        placement="bottom-start"
        width={320}
        trigger={<IconButton icon="info" label={t('help.ariaLabel')} size="sm" />}
      >
        <p className="text-[var(--aura-fg-secondary)]">{t('help.body')}</p>
      </Popover>
    </div>
  );

  useEffect(() => {
    const index = focusIndexRef.current;
    if (index === null) return;
    focusIndexRef.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-at-risk-row="${index}"]`)?.focus();
  }, [moreHere]);

  if (data?.feature_disabled) {
    return (
      <section
        data-testid="at-risk-widget-disabled"
        aria-labelledby="at-risk-widget-title"
        className="flex flex-col gap-[var(--aura-space-1)]"
      >
        {heading}
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('featureDisabled')}</p>
      </section>
    );
  }

  const company = (m: ApiRow) => m.company_name ?? t('table.unknownCompany');

  const shownItems: ReadonlyArray<ApiRow> = data ? [...data.items, ...(moreHere?.items ?? [])] : [];
  const nextCursor = moreHere ? moreHere.cursor : (data?.next_cursor ?? null);
  const bandTotal = data?.summary ? data.summary[activeBand] : null;

  const showMore = () => {
    if (nextCursor === null || moreHere?.pending) return;
    const key = loadKey;
    const prior = moreHere?.items ?? [];
    setMore({ key, items: prior, cursor: nextCursor, pending: true, failed: false });
    const url = `/api/admin/renewals/at-risk?band=${encodeURIComponent(activeBand)}&limit=20&cursor=${encodeURIComponent(nextCursor)}`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`http_${res.status}`);
        return (await res.json()) as ApiResponse;
      })
      .then((json) => {
        // The first new row; an empty page (rows left the band since) falls
        // back to the last row shown, as the button may now go away.
        const before = (data?.items.length ?? 0) + prior.length;
        focusIndexRef.current = json.items.length > 0 ? before : Math.max(0, before - 1);
        setMore((cur) =>
          cur && cur.key === key
            ? { key, items: [...prior, ...json.items], cursor: json.next_cursor, pending: false, failed: false }
            : cur,
        );
      })
      .catch(() => {
        setMore((cur) => (cur && cur.key === key ? { ...cur, pending: false, failed: true } : cur));
      });
  };

  const rows = loading ? (
    <WidgetSkeleton />
  ) : error ? (
    <Alert
      tone="danger"
      title={t('errorLoading')}
      action={
        <Button size="sm" touchHeight variant="secondary" onClick={() => setRefetchKey((k) => k + 1)}>
          {t('actions.retry')}
        </Button>
      }
    />
  ) : !data || shownItems.length === 0 ? (
    <EmptyState
      icon="circle-check"
      title={t('emptyState')}
      headingLevel={false}
      action={
        <Link
          href="/admin/renewals?urgency=terminated"
          className="text-sm text-[var(--aura-fg-accent)] underline-offset-4 hover:underline"
        >
          {t('actions.reviewLapsed')}
        </Link>
      }
    />
  ) : (
    // Board `Admin-renewals-needs-action`: Company, Risk score, Last
    // computed and Actions; each row a card on a phone.
    <div ref={listRef} className="flex flex-col gap-[var(--aura-space-3)]">
      <Table caption={t('title')} captionHidden stackBelow="sm" stackStyle="cards" align="middle" bleed>
        <THead>
          <Tr>
            <Th>{t('table.company')}</Th>
            <Th>{t('table.score')}</Th>
            <Th>{t('table.lastComputed')}</Th>
            <Th>{t('table.actions')}</Th>
          </Tr>
        </THead>
        <TBody>
          {shownItems.map((m, index) => (
            <Tr key={m.member_id}>
              <Td card="title">
                <Link
                  data-at-risk-row={index}
                  href={`/admin/members/${m.member_id}`}
                  className="font-medium text-[var(--aura-fg-accent)] hover:underline"
                >
                  {company(m)}
                </Link>
              </Td>
              <Td>
                <RiskScoreBadge
                  score={m.risk_score}
                  band={m.risk_score_band}
                  activeMax={data.summary.active_max}
                />
              </Td>
              <Td className="tabular-nums text-[var(--aura-fg-secondary)]">
                {m.risk_score_last_computed_at
                  ? // Phase 6 review I2 — locale-pinned formatter
                    formatLocalisedTimestamp(m.risk_score_last_computed_at, locale)
                  : '—'}
              </Td>
              <Td card="action">
                {/* Contact stays for a manager (FR-033 + FR-052a's one manager
                    mutation); Snooze is admin-only. Each button is the lifted
                    dialog's focus-return target. */}
                <div className="flex gap-[var(--aura-space-2)] sm:justify-end">
                  <Button
                    size="sm"
                    variant="secondary"
                    touchHeight
                    aria-label={t('actions.contactAriaLabel', { company: company(m) })}
                    onClick={(e) => {
                      outreachTriggerRef.current = e.currentTarget;
                      setOutreachFor({ memberId: m.member_id, companyName: m.company_name });
                    }}
                  >
                    {t('actions.contact')}
                  </Button>
                  {canSnooze ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      touchHeight
                      aria-label={t('actions.snoozeAriaLabel', { company: company(m) })}
                      onClick={(e) => {
                        snoozeTriggerRef.current = e.currentTarget;
                        setSnoozeFor({ memberId: m.member_id, companyName: m.company_name });
                      }}
                    >
                      {t('actions.snooze')}
                    </Button>
                  ) : null}
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      {nextCursor !== null || moreHere?.failed ? (
        <div className="flex flex-col items-start gap-[var(--aura-space-2)]">
          {moreHere?.failed ? <Alert tone="danger" title={t('showMore.failed')} /> : null}
          {/* One button that stays mounted through load, failure and retry,
              so keyboard focus never falls to the page (WCAG 2.4.3). */}
          <Button size="sm" touchHeight variant="secondary" loading={moreHere?.pending ?? false} onClick={showMore}>
            {moreHere?.failed ? t('actions.retry') : t('showMore.action')}
          </Button>
        </div>
      ) : null}
      {/* Polite count, updated after each append (WCAG 4.1.3). */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="at-risk-shown-status">
        {moreHere && moreHere.items.length > 0 && bandTotal !== null
          ? t('showMore.shown', { shown: shownItems.length, total: bandTotal })
          : ''}
      </span>
    </div>
  );

  // The band filters: AURA tabs with each band's count (once loaded); only
  // the active band's panel renders.
  const tabs: TabItem[] = BANDS.map((band) => ({
    id: band,
    label: t(`bandTabs.${band.replace('-', '_')}` as 'bandTabs.warning'),
    ...(data?.summary ? { count: data.summary[band] } : {}),
    content: band === activeBand ? rows : null,
  }));

  return (
    <section aria-labelledby="at-risk-widget-title" className="flex flex-col gap-[var(--aura-space-3)]">
      <div className="flex flex-col gap-[var(--aura-space-1)]">
        {heading}
        <p className="text-sm text-[var(--aura-fg-secondary)]">
          {data?.summary
            ? t('summary', {
                warning: data.summary.warning,
                atRisk: data.summary['at-risk'],
                critical: data.summary.critical,
              })
            : t('summaryLoading')}
          {data?.summary && !data.summary.f6_active ? (
            <span className="ml-2 text-xs">
              ({t('f6Inactive', { max: data.summary.active_max })})
            </span>
          ) : null}
        </p>
      </div>
      <Tabs
        touchHeight
        label={t('bandTabs.label')}
        tabs={tabs}
        value={activeBand}
        onChange={(id) => {
          const band = BANDS.find((b) => b === id);
          if (band) setActiveBand(band);
        }}
      />

      {snoozeFor ? (
        <SnoozeDialog
          open
          onOpenChange={(open) => {
            if (!open) setSnoozeFor(null);
          }}
          memberId={snoozeFor.memberId}
          memberCompanyName={snoozeFor.companyName}
          finalFocus={snoozeTriggerRef}
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
          finalFocus={outreachTriggerRef}
        />
      ) : null}
    </section>
  );
}

function WidgetSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--aura-space-2)] py-[var(--aura-space-2)]">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-[var(--aura-space-4)]">
          <SkeletonBlock className="h-4 w-1/3" />
          <SkeletonBlock className="h-4 w-20" />
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="ml-auto h-8 w-32" />
        </div>
      ))}
    </div>
  );
}
