/**
 * F8 Phase 7 T198 + T199 — `TierUpgradeQueueClient` client component.
 *
 * Renders the admin tier-upgrade queue with Accept/Dismiss/Escalate
 * actions per row. Manager-role hidden CTAs are NOT rendered here —
 * the parent server component already rejects manager role.
 *
 * **T199 — confirmations**: Accept and Dismiss are destructive per FR-058 § 4
 * (UX standards), so both confirm with focus on Cancel. Escalate is
 * non-destructive (drafts an outreach record) and fires directly.
 *
 * **WP6 (plan-change UX remediation)**:
 *   - Reason cell surfaces the full pricing EVIDENCE (declared turnover /
 *     paid-invoice volume + threshold date) so an admin isn't approving a
 *     price increase on a coarse label alone (BP2). The Accept dialog restates
 *     the figures + the plan move (ux-standards § 6.2).
 *   - Member cell links a resolved COMPANY NAME to `/admin/members/[id]`
 *     instead of a raw UUID slice (P1-9).
 *   - Action failures map raw server codes to localised copy (BP5 item 1) and
 *     persist (error toasts do not auto-dismiss, ux-standards § 4.2).
 *   - Programmatic-close focus return: on a success/refresh the trigger row
 *     leaves the queue (or its buttons disable), so focus is steered to
 *     `#main-content` instead of dropping to `<body>` (WCAG 2.1 SC 2.4.3).
 *
 * **122 US7b-1 (T725)**, boards `Admin-tier-upgrades` (+ `-accept`,
 * `-mobile`): one AURA `DataTable` that stacks into cards below 640px, titled
 * by the member. The plan cells carry the annual fee excl. VAT. Each row has
 * Accept plus a ⋯ menu (Escalate, Dismiss) named for its row, at every width;
 * Accept and Dismiss confirm in AURA alertdialogs, and Accept adds "Fees
 * exclude VAT." (spec Clarifications, Session 2026-10-01 US7b start). The
 * requests, error mapping and toasts are unchanged.
 */
'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Button,
  DataTable,
  Dialog,
  DropdownMenu,
  IconButton,
  StatusPill,
  type DataTableColumn,
  type MenuItem,
} from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { TierUpgradesEmptyState } from './tier-upgrades-empty-state';
import { tierUpgradeStatusTone } from '../_lib/tier-upgrade-status-tone';
import {
  buildAcceptDialogMessage,
  buildEvidenceMessage,
} from '../_lib/evidence-message';
import { normalizeTierUpgradeErrorCode } from '../_lib/tier-upgrade-error-codes';
import type { TierUpgradeEvidenceView } from '../_lib/tier-upgrade-queue-item';

type TierUpgradeQueueItem = {
  readonly suggestionId: string;
  readonly memberId: string;
  /** Localised member company name resolved in the SSR page; falls back to the id slice. */
  readonly companyName?: string;
  readonly status: string;
  readonly fromPlanId: string;
  /** Localised plan name resolved in the SSR page; falls back to the ID. */
  readonly fromPlanName?: string;
  /** Annual fee (minor units) of the from-plan; absent when the plan lookup returned nothing. */
  readonly fromFeeMinorUnits?: number;
  readonly toPlanId: string;
  /** Localised plan name resolved in the SSR page; falls back to the ID. */
  readonly toPlanName?: string;
  /** Annual fee (minor units) of the to-plan; absent when the plan lookup returned nothing. */
  readonly toFeeMinorUnits?: number;
  readonly reasonCode: string;
  /** Validated + server-date-formatted evidence view; null → render "unavailable". */
  readonly evidence: TierUpgradeEvidenceView | null;
  readonly createdAt: string;
};

interface TierUpgradeQueueClientProps {
  readonly items: ReadonlyArray<TierUpgradeQueueItem>;
}

type DialogAction = 'accept' | 'dismiss';
type QueueAction = 'accept' | 'dismiss' | 'escalate';

interface PendingDialog {
  readonly action: DialogAction;
  readonly suggestionId: string;
}

interface PendingAction {
  readonly action: QueueAction;
  readonly suggestionId: string;
}

export function TierUpgradeQueueClient({
  items,
}: TierUpgradeQueueClientProps) {
  const t = useTranslations('admin.renewals.tier_upgrades');
  const format = useFormatter();
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [, startTransition] = useTransition();

  // Focus-return plumbing (WCAG 2.1 SC 2.4.3). `triggerRef` captures the
  // button that opened the shared dialog; `closedViaSuccessRef` is raised in
  // `callAction`'s success branch. On success the row unmounts / disables, so
  // the resolver skips the about-to-vanish trigger and lands on
  // `#main-content` instead of `<body>`. On Cancel / Escape the trigger
  // survives and is the least-surprising focus target. A dialog opened from
  // the ⋯ menu passes NO trigger (the menu item is gone with the menu), so it
  // falls through to the landmark.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closedViaSuccessRef = useRef(false);
  // Each row's ⋯ trigger, so a Dismiss opened from the menu returns focus to
  // it on Cancel / Escape (the menu item is gone with the menu).
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      resolveDialogFinalFocus({
        closedViaSuccess: closedViaSuccessRef.current,
        trigger: triggerRef.current,
        fallback: null,
        mainContent:
          typeof document !== 'undefined'
            ? document.getElementById('main-content')
            : null,
      }),
    [],
  );

  /** Format a raw MAJOR-baht figure as `฿…` (narrowSymbol holds `฿` in every locale). */
  const thb = useCallback(
    (majorBaht: number): string =>
      format.number(majorBaht, {
        style: 'currency',
        currency: 'THB',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 0,
      }),
    [format],
  );

  const callAction = useCallback(
    async (suggestionId: string, action: QueueAction): Promise<void> => {
      setPending({ suggestionId, action });
      closedViaSuccessRef.current = false;
      try {
        const response = await fetch(
          `/api/admin/renewals/tier-upgrades/${suggestionId}/${action}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          },
        );
        if (!response.ok) {
          const errBody = await response.json().catch(() => null);
          const code = normalizeTierUpgradeErrorCode(errBody);
          // Error toasts persist until the admin dismisses them (ux-standards
          // § 4.2) and describe the failure in human copy, never a raw code.
          toast.error(t(`actions.${action}.error`), {
            description: t(`action_errors.${code}`),
            duration: Infinity,
          });
          return;
        }
        // Success → the queue refreshes; steer focus off the vanishing row.
        closedViaSuccessRef.current = true;
        toast.success(t(`actions.${action}.success`));
        startTransition(() => router.refresh());
      } catch (e) {
        const isOffline =
          e instanceof TypeError &&
          /(failed to fetch|networkerror|load failed)/i.test(e.message);
        toast.error(t(`actions.${action}.error`), {
          description: t(
            isOffline ? 'action_errors.network_error' : 'action_errors.unknown',
          ),
          duration: Infinity,
        });
      } finally {
        // Close the confirm dialog only AFTER the action settles — so the
        // focus resolver reads `closedViaSuccessRef` with the real outcome
        // and the trigger re-enabled: success → #main-content (the row
        // unmounts on refresh); error → the now-enabled trigger (the admin
        // can retry). No-op for Escalate (no dialog open).
        // Scoped to this suggestion: an escalate on one row must not close
        // (or clear the busy state of) a dialog opened on another (M4).
        setPending((p) => (p?.suggestionId === suggestionId ? null : p));
        setDialog((d) => (d?.suggestionId === suggestionId ? null : d));
      }
    },
    [t, router],
  );

  const columns = useMemo<DataTableColumn<TierUpgradeQueueItem>[]>(
    () => [
      {
        key: 'member',
        label: t('columns.member'),
        minWidth: 160,
        card: 'title',
        // P1-9 — the resolved company name links to the member detail; the
        // 8-char id slice when the SSR lookup returned nothing. enterprise-ux
        // C3: no sr-only full UUID (its href carries the id).
        render: (item) => (
          <Link
            href={`/admin/members/${item.memberId}`}
            className="font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline"
          >
            {item.companyName ?? (
              <span className="aura-text-mono text-xs">{item.memberId.slice(0, 8)}</span>
            )}
          </Link>
        ),
      },
      {
        key: 'fromPlan',
        label: t('columns.from_plan'),
        width: 180,
        render: (item) => (
          <PlanCell
            name={item.fromPlanName}
            planId={item.fromPlanId}
            exclVat={(fee) => t('fee_excl_vat', { fee })}
            fee={item.fromFeeMinorUnits !== undefined ? thb(item.fromFeeMinorUnits / 100) : null}
          />
        ),
      },
      {
        key: 'toPlan',
        label: t('columns.to_plan'),
        width: 180,
        render: (item) => (
          <PlanCell
            name={item.toPlanName}
            planId={item.toPlanId}
            exclVat={(fee) => t('fee_excl_vat', { fee })}
            fee={item.toFeeMinorUnits !== undefined ? thb(item.toFeeMinorUnits / 100) : null}
            strong
          />
        ),
      },
      {
        // Reason + pricing evidence (WP6): the justification an admin needs
        // before approving a fee increase; a null view says "verify manually".
        key: 'reason',
        label: t('columns.reason'),
        minWidth: 240,
        // The phone card gives the reason and its evidence a line of their own
        // at full width (board Admin-tier-upgrades-mobile; AURA 5.23, #120).
        card: 'wide',
        render: (item) => (
          <span className="flex flex-col gap-0.5 whitespace-normal">
            <span className="text-sm">{t(`reason.${item.reasonCode}`)}</span>
            <span className="text-xs text-[var(--aura-fg-secondary)]">
              {item.evidence ? buildEvidenceMessage(t, item.evidence, thb) : t('evidence.unavailable')}
            </span>
          </span>
        ),
      },
      {
        key: 'status',
        label: t('columns.status'),
        width: 128,
        card: 'pill',
        render: (item) => (
          <StatusPill tone={tierUpgradeStatusTone(item.status)}>{t(`status.${item.status}`)}</StatusPill>
        ),
      },
      {
        // An empty label: AURA names the header "Actions" for screen readers.
        key: 'actions',
        label: '',
        width: 152,
        actions: true,
        align: 'end',
        // The phone card's last row, full width (board Admin-tier-upgrades-mobile).
        card: 'footer',
        render: (item) => {
          const busy = pending?.suggestionId === item.suggestionId;
          const closed = item.status !== 'open';
          const disabled = closed || busy;
          const company = item.companyName ?? item.memberId.slice(0, 8);
          const menuLabel = t('actions.row_menu', { member: company });
          const openDialog = (action: DialogAction, trigger: HTMLButtonElement | null) => {
            triggerRef.current = trigger;
            closedViaSuccessRef.current = false;
            setDialog({ action, suggestionId: item.suggestionId });
          };
          const menuItems: MenuItem[] = [
            {
              label: t('actions.escalate.label'),
              disabled,
              onSelect: () => void callAction(item.suggestionId, 'escalate'),
            },
            {
              label: t('actions.dismiss.label'),
              tone: 'danger',
              disabled,
              onSelect: () => openDialog('dismiss', menuTriggers.current.get(item.suggestionId) ?? null),
            },
          ];
          // A fragment: the Button and the ⋯ sit straight in AURA's cell, so
          // the stacked card's footer grows Accept across the row.
          return (
            <>
              <Button
                variant="primary"
                size="sm"
                touchHeight
                disabled={disabled}
                loading={busy && pending?.action === 'accept'}
                onClick={(e) => openDialog('accept', e.currentTarget)}
                className="me-[var(--aura-space-1)]"
              >
                {t('actions.accept.label')}
              </Button>
              <DropdownMenu
                label={menuLabel}
                items={menuItems}
                // Disabled only for a closed suggestion: while this row's
                // escalate runs the ⋯ keeps focus and its items are disabled (M3).
                trigger={
                  <IconButton
                    ref={(el) => {
                      if (el) menuTriggers.current.set(item.suggestionId, el);
                      else menuTriggers.current.delete(item.suggestionId);
                    }}
                    icon="ellipsis"
                    label={menuLabel}
                    size="sm"
                    touchHeight
                    disabled={closed}
                    aria-busy={busy || undefined}
                  />
                }
              />
            </>
          );
        },
      },
    ],
    [t, thb, pending, callAction],
  );

  if (items.length === 0) {
    return <TierUpgradesEmptyState />;
  }

  const dialogItem = dialog
    ? items.find((i) => i.suggestionId === dialog.suggestionId) ?? null
    : null;

  /**
   * Accept restates the evidence + the plan move WITH the old→new annual fees
   * (§ 6.2 — repeat the figures before an irreversible-feeling money action; C2
   * — an admin approving a price increase must see the numbers). Dismiss keeps
   * its suppression consequence copy.
   */
  function dialogDescription(): string {
    if (!dialog || !dialogItem) return '';
    if (dialog.action === 'dismiss') return t('actions.dismiss.confirm');
    return buildAcceptDialogMessage(
      t,
      {
        evidence: dialogItem.evidence,
        fromPlanLabel: dialogItem.fromPlanName ?? dialogItem.fromPlanId,
        toPlanLabel: dialogItem.toPlanName ?? dialogItem.toPlanId,
        ...(dialogItem.fromFeeMinorUnits !== undefined
          ? { fromFeeMinorUnits: dialogItem.fromFeeMinorUnits }
          : {}),
        ...(dialogItem.toFeeMinorUnits !== undefined
          ? { toFeeMinorUnits: dialogItem.toFeeMinorUnits }
          : {}),
      },
      thb,
    );
  }

  const dialogAction = dialog?.action ?? 'accept';
  // Busy only while THIS dialog's own request runs (M4).
  const dialogBusy = dialog !== null && pending?.suggestionId === dialog.suggestionId;

  return (
    <>
      {/* The phone cards show bare fees, so "excl. VAT" is said once above
          them (board Admin-tier-upgrades-mobile); never over the empty state. */}
      <p className="m-0 text-xs text-[var(--aura-fg-secondary)] sm:hidden">{t('fees_exclude_vat')}</p>
      <DataTable<TierUpgradeQueueItem>
        label={t('tableCaption')}
        rows={items}
        columns={columns}
        rowKey="suggestionId"
        rowHeight="auto"
        stackBelow={640}
        // Edge to edge inside the list card from 640px up (AURA 5.27, #130),
        // and the card's last content, so the card's radius closes it.
        bleed
        bleedEnd
      />
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        role="alertdialog"
        // ux-standards § 6.4: no dismissal while the action is in flight.
        dismissible={!dialogBusy}
        finalFocus={finalFocus}
        title={t(`actions.${dialogAction}.dialog_title`)}
        description={dialogDescription()}
        // Focus on Cancel by default (FR-058 § 4).
        footer={
          <>
            <Button
              variant="secondary"
              data-autofocus=""
              onClick={() => setDialog(null)}
              disabled={dialogBusy}
            >
              {t('dialog.cancel')}
            </Button>
            <Button
              // Dismiss is irreversible (90-day suppression): the danger style.
              variant={dialogAction === 'dismiss' ? 'danger' : 'primary'}
              loading={dialogBusy}
              onClick={() => {
                if (!dialog) return;
                // The dialog stays open until callAction settles (it closes in
                // its `finally`), so focus resolves on the real outcome.
                void callAction(dialog.suggestionId, dialog.action);
              }}
            >
              {dialogBusy
                ? t(`actions.${dialogAction}.submitting`)
                : t(`actions.${dialogAction}.label`)}
            </Button>
          </>
        }
      >
        {dialogAction === 'accept' ? (
          <p className="m-0 text-sm text-[var(--aura-fg-secondary)]">{t('fees_exclude_vat')}</p>
        ) : null}
      </Dialog>
    </>
  );
}

/** A plan name with its annual fee underneath; the raw id when the lookup failed. */
function PlanCell({
  name,
  planId,
  fee,
  exclVat,
  strong = false,
}: {
  readonly name: string | undefined;
  readonly planId: string;
  /** The annual fee, formatted. */
  readonly fee: string | null;
  /** "{fee} excl. VAT", shown from 640px; a phone card says it once above the list. */
  readonly exclVat: (fee: string) => string;
  readonly strong?: boolean;
}) {
  return (
    <span className="flex flex-col gap-0.5 whitespace-normal">
      {name ? (
        <span className={strong ? 'text-sm font-medium' : 'text-sm'}>{name}</span>
      ) : (
        <span className="aura-text-mono text-xs text-[var(--aura-fg-secondary)]" title={planId}>
          {planId}
        </span>
      )}
      {fee ? (
        <>
          <span className="text-xs tabular-nums text-[var(--aura-fg-secondary)] sm:hidden">{fee}</span>
          <span className="text-xs tabular-nums text-[var(--aura-fg-secondary)] max-sm:hidden">{exclVat(fee)}</span>
        </>
      ) : null}
    </span>
  );
}
