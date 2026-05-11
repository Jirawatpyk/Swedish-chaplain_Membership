/**
 * `LapsedTab` panel — renders when `?urgency=lapsed`.
 *
 * Shows lapsed cycles with reason badges + a row actions dropdown.
 *
 * Staff-Review-2026-05-09 T277d closure: replaces the bare "View detail"
 * link with a `RowActionsMenu` exposing:
 *   - View detail  → /admin/renewals/[cycleId]
 *   - Mark contacted → opens the shared `OutreachDialog` (US4 — already
 *     wired into the at-risk widget; we lift it into the LapsedTab so
 *     admins working a 30+ row lapsed cohort can record win-back outreach
 *     without bouncing through the cycle-detail page each time).
 *
 * Reactivate / Reject / Mark-paid-offline are intentionally NOT here —
 * those use-cases (T136 / T137 / F4 manual-mark-paid) operate on
 * `pending_admin_reactivation` (T136/T137) or `awaiting_payment` (F4)
 * status, neither of which the LapsedTab surface lists. They live on
 * the cycle-detail page actions slot. Adding disabled stubs here would
 * be a broken affordance per UX standards.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
import { cn } from '@/lib/utils';
import { OutreachDialog } from './outreach-dialog';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { PipelineRow } from '@/modules/renewals/client';

type LapsedReasonKey =
  | 'paid'
  | 'cancelled'
  | 'lapsed'
  | 'grace_expired'
  | 'payment_failed'
  | 'completed_offline'
  | 'admin_reactivated'
  | 'admin_rejected_with_refund'
  | 'pending_reactivation_timed_out';

export interface LapsedTabProps {
  readonly rows: ReadonlyArray<PipelineRow>;
}

const REASON_VARIANT_CLASSES: Record<string, string> = {
  lapsed:
    'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  // T115a: forward-compat for the two specific reasons; same red treatment
  // as catch-all `lapsed` until Phase 5 wires the dispatcher decision branch.
  grace_expired:
    'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  payment_failed:
    'bg-rose-50 text-rose-900 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900',
  // UX R5 / Mobile-a11y: dark-mode ring contrast — `dark:ring-gray-700`
  // on `dark:bg-gray-900` was too low (3.0:1 borderline). Bump to -600
  // for clearer pill outline. Same -600 floor applied across the
  // tonal palette so every variant has a visible boundary on dark.
  cancelled:
    'bg-gray-100 text-gray-700 ring-gray-300 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-600',
  paid:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-700',
  completed_offline:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-700',
  admin_reactivated:
    'bg-blue-50 text-blue-900 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-700',
  admin_rejected_with_refund:
    'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-700',
  // -700 (was -600 inconsistently) so this severe state stays
  // dominant in scan order matching `lapsed`/`payment_failed`.
  pending_reactivation_timed_out:
    'bg-orange-50 text-orange-900 ring-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-700',
};

export function LapsedTab({ rows }: LapsedTabProps) {
  const t = useTranslations('admin.renewals.lapsed');
  const tTable = useTranslations('admin.renewals.table');
  const tReason = useTranslations('admin.renewals.lapsedReason');
  const tActions = useTranslations('admin.renewals.actions');
  // Outreach dialog state — single instance lifted to the table level
  // so re-rendering rows doesn't tear down the dialog mid-submit.
  // Mirrors the at-risk-widget pattern (`at-risk-widget.tsx:111`).
  const [outreachFor, setOutreachFor] = useState<{
    memberId: string;
    companyName: string | null;
  } | null>(null);

  return (
    // Round-3 UX M1 fix: wrap in <section aria-labelledby> so SR
    // users have a landmark when switching to the lapsed tab. Mirrors
    // the cycle-detail page's round-2 C2 pattern. The visually-hidden
    // <h2> takes its accessible name from the existing banner title
    // i18n key so we don't introduce a new untranslated string.
    <section
      aria-labelledby="lapsed-tab-heading"
      className="flex flex-col gap-3"
    >
      <h2 id="lapsed-tab-heading" className="sr-only">
        {t('banner.title')}
      </h2>
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('banner.title')}</AlertTitle>
        <AlertDescription>{t('banner.description')}</AlertDescription>
      </Alert>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tTable('columns.tier')}</TableHead>
            <TableHead>{tTable('columns.company')}</TableHead>
            <TableHead>{tTable('columns.expires')}</TableHead>
            <TableHead>{t('columns.reason')}</TableHead>
            <TableHead className="sr-only">
              {tTable('columns.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="text-center text-muted-foreground py-8"
              >
                {tTable('noRows')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const reason: LapsedReasonKey = (r.closedReason ?? 'lapsed') as LapsedReasonKey;
              // Round-3 silent-failure F6 fix: when a future
              // closed_reason is added to the DB enum but the i18n
              // key + REASON_VARIANT_CLASSES branch are missing, fall
              // back to a neutral grey pill instead of forcing
              // lapsed-red (which would mis-signal severity). Matches
              // the cycle-detail page's loud-fail pattern (page.tsx
              // tierLabel / closedReasonLabel `t.has` guards).
              const isKnownReason = tReason.has(reason);
              const reasonLabel = isKnownReason
                ? tReason(reason)
                : `${reason} (untranslated)`;
              const reasonClasses = isKnownReason
                ? REASON_VARIANT_CLASSES[reason] ??
                  REASON_VARIANT_CLASSES.cancelled
                : REASON_VARIANT_CLASSES.cancelled;
              return (
                <TableRow key={r.cycleId}>
                  <TableCell>
                    <CycleTierCell tier={r.tierBucket} />
                  </TableCell>
                  <TableCell>
                    <CycleCompanyCell
                      memberId={r.memberId}
                      companyName={r.companyName}
                      emailUnverified={r.emailUnverified}
                    />
                  </TableCell>
                  <TableCell>
                    <CycleExpiresCell expiresAt={r.expiresAt} />
                  </TableCell>
                  <TableCell>
                    {/*
                      K9: removed redundant aria-label — text content
                      already serves as the accessible name. Older
                      VoiceOver double-announces when aria-label
                      duplicates visible text on non-interactive spans.
                    */}
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                        reasonClasses,
                      )}
                    >
                      {reasonLabel}
                    </span>
                  </TableCell>
                  <TableCell>
                    {/* Staff-Review-2026-05-09 T277d closure: dropdown
                        replaces the bare Link so admins can record
                        outreach without leaving the lapsed-tab view.
                        View Detail is the navigation primary; Mark
                        Contacted opens the OutreachDialog. */}
                    <DropdownMenu>
                      {/*
                       * R4-W9 (staff-review-2026-05-09): align trigger
                       * size with `pipeline-table.tsx` (h-11 w-11 = 44px)
                       * for visual + interaction consistency on the
                       * same page. Old h-8 w-8 was above WCAG 2.5.8
                       * minimum (24px) but inconsistent.
                       */}
                      <DropdownMenuTrigger
                        render={(props) => (
                          <Button
                            {...props}
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11"
                            aria-label={tActions('rowMenu', {
                              company: r.companyName || r.memberId,
                            })}
                            title={tActions('rowMenu', {
                              company: r.companyName || r.memberId,
                            })}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        )}
                      />
                      <DropdownMenuContent
                        align="end"
                        className="min-w-56 whitespace-nowrap"
                      >
                        {/* View detail — uses raw <a> for the same
                            Base UI render-prop reason documented in
                            pipeline-table.tsx:367-374 (Next Link
                            handler types incompatible with
                            DropdownMenuItem render under
                            exactOptionalPropertyTypes). */}
                        <DropdownMenuItem
                          render={(props) => (
                            <a
                              {...props}
                              href={`/admin/renewals/${r.cycleId}`}
                              aria-label={tActions('openAriaLabel', {
                                company: r.companyName || r.memberId,
                              })}
                            >
                              {tActions('open')}
                            </a>
                          )}
                        />
                        <DropdownMenuItem
                          onClick={() => {
                            setOutreachFor({
                              memberId: r.memberId,
                              companyName: r.companyName,
                            });
                          }}
                        >
                          {tActions('markContacted')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {outreachFor ? (
        <OutreachDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setOutreachFor(null);
          }}
          memberId={outreachFor.memberId}
          memberCompanyName={outreachFor.companyName}
        />
      ) : null}
    </section>
  );
}
