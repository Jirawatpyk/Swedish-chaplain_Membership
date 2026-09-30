/**
 * `LapsedTab` panel — renders when `?urgency=terminated` (the bucket was
 * renamed from `lapsed`; this panel still lists status='lapsed' cycles).
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

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Badge,
  DropdownMenu,
  IconButton,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type Tone,
} from '@jirawatpyk/aura-react';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
import { OutreachDialog } from './outreach-dialog';
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
  | 'pending_reactivation_timed_out'
  | 'coverage_ended';

export interface LapsedTabProps {
  readonly rows: ReadonlyArray<PipelineRow>;
}

/**
 * The close reason's badge tone, by meaning: an ended membership in danger,
 * a settled one in success, a refund or a timed-out reactivation in
 * warning, a reactivation in accent; anything else (cancelled, unknown)
 * neutral. The text label carries the meaning; the tone only supports it.
 */
const REASON_TONE: Readonly<Record<string, Tone>> = {
  lapsed: 'danger',
  grace_expired: 'danger',
  payment_failed: 'danger',
  coverage_ended: 'danger',
  paid: 'success',
  completed_offline: 'success',
  admin_reactivated: 'accent',
  admin_rejected_with_refund: 'warning',
  pending_reactivation_timed_out: 'warning',
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
  // Review fix #5 (WCAG 2.4.3) — ONE shared `OutreachDialog`, many rows:
  // the ⋯ trigger that was clicked is snapshotted here and handed to the
  // dialog as `finalFocus`, so focus returns to the row that opened it.
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section aria-labelledby="lapsed-tab-heading" className="flex flex-col gap-[var(--aura-space-3)]">
      <h2 id="lapsed-tab-heading" className="sr-only">
        {t('banner.title')}
      </h2>
      <Alert tone="info" role="note" title={t('banner.title')}>
        {t('banner.description')}
      </Alert>
      <Table caption={t('banner.title')} captionHidden stackBelow="sm" stackStyle="cards" align="middle">
        <THead>
          <Tr>
            <Th>{tTable('columns.tier')}</Th>
            <Th>{tTable('columns.company')}</Th>
            <Th>{tTable('columns.expires')}</Th>
            <Th>{t('columns.reason')}</Th>
            <Th>
              <span className="sr-only">{tTable('columns.actions')}</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {rows.length === 0 ? (
            <Tr>
              <Td colSpan={5} className="py-[var(--aura-space-6)] text-center text-[var(--aura-fg-secondary)]">
                {tTable('noRows')}
              </Td>
            </Tr>
          ) : (
            rows.map((r) => {
              const reason: LapsedReasonKey = (r.closedReason ?? 'lapsed') as LapsedReasonKey;
              const isKnownReason = tReason.has(reason);
              const reasonLabel = isKnownReason ? tReason(reason) : `${reason} (untranslated)`;
              const tone: Tone = isKnownReason ? (REASON_TONE[reason] ?? 'neutral') : 'neutral';
              const company = r.companyName || r.memberId;
              const menuLabel = tActions('rowMenu', { company });
              return (
                <Tr key={r.cycleId}>
                  <Td>
                    <CycleTierCell tier={r.tierBucket} />
                  </Td>
                  <Td card="title">
                    <CycleCompanyCell
                      memberId={r.memberId}
                      companyName={r.companyName}
                      emailUnverified={r.emailUnverified}
                    />
                  </Td>
                  <Td>
                    <CycleExpiresCell expiresAt={r.expiresAt} />
                  </Td>
                  <Td>
                    <Badge tone={tone}>{reasonLabel}</Badge>
                  </Td>
                  <Td card="action">
                    {/* T277d — "Open cycle" navigates; "Mark contacted" records
                        outreach without leaving the tab. */}
                    <DropdownMenu
                      label={menuLabel}
                      items={[
                        { label: tActions('open'), href: `/admin/renewals/${r.cycleId}` },
                        {
                          label: tActions('markContacted'),
                          onSelect: () => {
                            setOutreachFor({ memberId: r.memberId, companyName: r.companyName });
                          },
                        },
                      ]}
                      trigger={
                        <IconButton
                          icon="ellipsis"
                          label={menuLabel}
                          size="sm"
                          touchHeight
                          onClick={(e) => {
                            activeTriggerRef.current = e.currentTarget;
                          }}
                        />
                      }
                    />
                  </Td>
                </Tr>
              );
            })
          )}
        </TBody>
      </Table>
      {outreachFor ? (
        <OutreachDialog
          open
          onOpenChange={(open) => {
            if (!open) setOutreachFor(null);
          }}
          memberId={outreachFor.memberId}
          memberCompanyName={outreachFor.companyName}
          finalFocus={activeTriggerRef}
        />
      ) : null}
    </section>
  );
}
