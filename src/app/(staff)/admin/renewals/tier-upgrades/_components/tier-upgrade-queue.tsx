/**
 * F8 Phase 7 T198 + T199 — `TierUpgradeQueueClient` client component.
 *
 * Renders the admin tier-upgrade queue with Accept/Dismiss/Escalate
 * actions per row. Manager-role hidden CTAs are NOT rendered here —
 * the parent server component already rejects manager role.
 *
 * **T199 — AlertDialog confirmations**: Accept and Dismiss are
 * destructive per FR-058 § 4 (UX standards). Both wrap a shadcn
 * AlertDialog with focus-on-Cancel default + descriptive copy. Escalate is
 * non-destructive (drafts an outreach record) so it fires directly
 * without a dialog.
 *
 * **WP6 (plan-change UX remediation)**:
 *   - Reason cell now surfaces the full pricing EVIDENCE (declared turnover /
 *     paid-invoice volume + threshold date) so an admin isn't approving a
 *     price increase on a coarse label alone (BP2). The Accept dialog restates
 *     the figures + the plan move (ux-standards § 6.2).
 *   - Member cell links a resolved COMPANY NAME to `/admin/members/[id]`
 *     instead of a raw UUID slice (P1-9).
 *   - Action failures map raw server codes to localised copy (BP5 item 1) and
 *     persist (error toasts do not auto-dismiss, ux-standards § 4.2).
 *   - Mobile overflow trigger is a real 44×44 tap target (§ 9.1).
 *   - Programmatic-close focus return: on a success/refresh the trigger row
 *     leaves the queue (or its buttons disable), so focus is steered to
 *     `#main-content` instead of dropping to `<body>` (WCAG 2.1 SC 2.4.3).
 */
'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { TierUpgradesEmptyState } from './tier-upgrades-empty-state';
import { buildEvidenceMessage } from '../_lib/evidence-message';
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
  readonly toPlanId: string;
  /** Localised plan name resolved in the SSR page; falls back to the ID. */
  readonly toPlanName?: string;
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
  // `#main-content` instead of `<body>`. On Cancel / ESC the trigger survives
  // and is the least-surprising focus target. The mobile dropdown paths pass
  // NO trigger (the trigger is inside the closing menu), so they always fall
  // through to the landmark.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closedViaSuccessRef = useRef(false);
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

  if (items.length === 0) {
    return <TierUpgradesEmptyState />;
  }

  async function callAction(
    suggestionId: string,
    action: QueueAction,
  ): Promise<void> {
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
      // Close the confirm dialog only AFTER the action settles + `setPending`
      // clears — so Base UI reads `finalFocus` with `closedViaSuccessRef`
      // reflecting the real outcome AND the trigger re-enabled: success →
      // #main-content (row unmounts on refresh); error → the now-enabled
      // trigger (admin can retry). The old synchronous close-on-click dropped
      // focus to <body> on the error path (WCAG 2.4.3). No-op for the inline
      // escalate path (no dialog open).
      setPending(null);
      setDialog(null);
    }
  }

  const dialogItem = dialog
    ? items.find((i) => i.suggestionId === dialog.suggestionId) ?? null
    : null;

  /**
   * Accept restates the evidence + the plan move (§ 6.2 — repeat the figures
   * before an irreversible-feeling money action). Dismiss keeps its
   * suppression consequence copy.
   */
  function dialogDescription(): string {
    if (!dialog || !dialogItem) return '';
    if (dialog.action === 'dismiss') return t('actions.dismiss.confirm');
    const evidenceText = dialogItem.evidence
      ? buildEvidenceMessage(t, dialogItem.evidence, thb)
      : t('evidence.unavailable');
    return t('actions.accept.evidence_restated', {
      evidence: evidenceText,
      fromPlan: dialogItem.fromPlanName ?? dialogItem.fromPlanId,
      toPlan: dialogItem.toPlanName ?? dialogItem.toPlanId,
    });
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.member')}</TableHead>
              <TableHead>{t('columns.from_plan')}</TableHead>
              <TableHead>{t('columns.to_plan')}</TableHead>
              <TableHead>{t('columns.reason')}</TableHead>
              <TableHead>{t('columns.status')}</TableHead>
              <TableHead className="text-right">
                {t('columns.actions')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const busy = pending?.suggestionId === item.suggestionId;
              const isOpen = item.status === 'open';
              return (
                <TableRow key={item.suggestionId} aria-busy={busy}>
                  {/* P1-9 — resolved company name linked to the member
                      detail; falls back to the 8-char id slice when the SSR
                      lookup returned nothing. enterprise-ux C3: no sr-only full
                      UUID — a screen reader reading a 36-char id on every row is
                      pure noise; the company-name link (its href carries the id)
                      is the meaningful, actionable identifier for AT. */}
                  <TableCell>
                    <Link
                      href={`/admin/members/${item.memberId}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {item.companyName ?? (
                        <span className="font-mono text-xs">
                          {item.memberId.slice(0, 8)}
                        </span>
                      )}
                    </Link>
                  </TableCell>
                  {/* Render localised plan name; fall back to the raw ID
                      (font-mono, title tooltip) when the SSR lookup
                      returned nothing (e.g. plan deleted/archived). */}
                  <TableCell>
                    {item.fromPlanName ? (
                      <span className="text-sm">{item.fromPlanName}</span>
                    ) : (
                      <span
                        className="font-mono text-xs text-muted-foreground"
                        title={item.fromPlanId}
                      >
                        {item.fromPlanId}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {item.toPlanName ? (
                      <span className="text-sm">{item.toPlanName}</span>
                    ) : (
                      <span
                        className="font-mono text-xs text-muted-foreground"
                        title={item.toPlanId}
                      >
                        {item.toPlanId}
                      </span>
                    )}
                  </TableCell>
                  {/* Reason + pricing evidence (WP6). The evidence line is the
                      justification an admin needs before approving a fee
                      increase; a null view degrades to the "verify manually"
                      copy rather than hiding the gap. */}
                  <TableCell>
                    <span className="text-sm">
                      {t(`reason.${item.reasonCode}`)}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {item.evidence
                        ? buildEvidenceMessage(t, item.evidence, thb)
                        : t('evidence.unavailable')}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">
                      {t(`status.${item.status}`)}
                    </span>
                  </TableCell>
                  {/* Phase 7 review-fix I-UX-3: 3 buttons inline at md+,
                      DropdownMenu collapse below md so the 44×44 tap-target
                      (WCAG 2.5.5) is preserved on tablet/mobile. */}
                  <TableCell className="text-right">
                    <div className="hidden gap-2 md:inline-flex">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={!isOpen || busy}
                        aria-busy={busy}
                        onClick={(e) => {
                          triggerRef.current = e.currentTarget;
                          closedViaSuccessRef.current = false;
                          setDialog({
                            action: 'accept',
                            suggestionId: item.suggestionId,
                          });
                        }}
                      >
                        {busy && pending?.action === 'accept'
                          ? t('actions.accept.submitting')
                          : t('actions.accept.label')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!isOpen || busy}
                        aria-busy={busy}
                        onClick={() =>
                          void callAction(item.suggestionId, 'escalate')
                        }
                      >
                        {t('actions.escalate.label')}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!isOpen || busy}
                        aria-busy={busy}
                        onClick={(e) => {
                          triggerRef.current = e.currentTarget;
                          closedViaSuccessRef.current = false;
                          setDialog({
                            action: 'dismiss',
                            suggestionId: item.suggestionId,
                          });
                        }}
                      >
                        {busy && pending?.action === 'dismiss'
                          ? t('actions.dismiss.submitting')
                          : t('actions.dismiss.label')}
                      </Button>
                    </div>
                    <div className="md:hidden">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={!isOpen || busy}
                          aria-busy={busy}
                          aria-label={t('actions.row_menu_aria')}
                          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-input bg-background text-sm shadow-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {/* Round 6 Round-7 UX-fix — onClick (not onSelect)
                              to align with the escalation-task-queue pattern
                              that survived review; onSelect races the
                              popper-close on mobile touch chains.
                              WP6 — the mobile dropdown passes NO trigger to
                              finalFocus (the trigger is inside the closing
                              menu), so the resolver falls through to the
                              #main-content landmark. */}
                          <DropdownMenuItem
                            disabled={!isOpen || busy}
                            onClick={() => {
                              triggerRef.current = null;
                              closedViaSuccessRef.current = false;
                              setDialog({
                                action: 'accept',
                                suggestionId: item.suggestionId,
                              });
                            }}
                          >
                            {t('actions.accept.label')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!isOpen || busy}
                            onClick={() =>
                              void callAction(item.suggestionId, 'escalate')
                            }
                          >
                            {t('actions.escalate.label')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!isOpen || busy}
                            onClick={() => {
                              triggerRef.current = null;
                              closedViaSuccessRef.current = false;
                              setDialog({
                                action: 'dismiss',
                                suggestionId: item.suggestionId,
                              });
                            }}
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                          >
                            {t('actions.dismiss.label')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <AlertDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent finalFocus={finalFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog ? t(`actions.${dialog.action}.dialog_title`) : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialogDescription()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('dialog.cancel')}
            </AlertDialogCancel>
            {/* Phase 7 review-fix C-UX-2 + enterprise-ux C5: use the Button
                `destructive` variant for Dismiss (irreversible — 90d
                suppression) rather than hand-rolled utility classes that drift
                if the token changes. Accept stays default. ux-standards § 6.2. */}
            <AlertDialogAction
              variant={dialog?.action === 'dismiss' ? 'destructive' : 'default'}
              disabled={pending !== null}
              onClick={(e) => {
                if (!dialog) return;
                // Keep the dialog OPEN until callAction settles (it closes in
                // its `finally`), so focus resolves correctly on both paths —
                // see the callAction finally note. preventDefault stops Base
                // UI's synchronous auto-close.
                e.preventDefault();
                const { action, suggestionId } = dialog;
                void callAction(suggestionId, action);
              }}
            >
              {dialog
                ? t(
                    pending !== null
                      ? `actions.${dialog.action}.submitting`
                      : `actions.${dialog.action}.label`,
                  )
                : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
