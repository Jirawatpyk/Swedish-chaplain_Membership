/**
 * F8 Phase 7 T198 + T199 — `TierUpgradeQueueClient` client component.
 *
 * Renders the admin tier-upgrade queue with Accept/Dismiss/Escalate
 * actions per row. Manager-role hidden CTAs are NOT rendered here —
 * the parent server component already rejects manager role.
 *
 * **T199 — AlertDialog confirmations**: Accept and Dismiss are
 * destructive per FR-058 § 4 (UX standards). Both wrap a shadcn
 * AlertDialog with focus-on-Cancel default + descriptive copy
 * summarising the pending-flow consequence (Accept: "applies at next
 * renewal" — Dismiss: "suppressed for 90 days"). Escalate is
 * non-destructive (drafts an outreach record) so it fires directly
 * without a dialog.
 *
 * Action flow: each Accept/Dismiss/Escalate POSTs to the corresponding
 * API route + shows a sonner toast on success/failure. Page reloads on
 * success via `router.refresh()` to re-fetch the queue.
 */
'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type TierUpgradeQueueItem = {
  readonly suggestionId: string;
  readonly memberId: string;
  readonly status: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
};

interface TierUpgradeQueueClientProps {
  readonly items: ReadonlyArray<TierUpgradeQueueItem>;
}

type DialogAction = 'accept' | 'dismiss';

interface PendingDialog {
  readonly action: DialogAction;
  readonly suggestionId: string;
}

export function TierUpgradeQueueClient({
  items,
}: TierUpgradeQueueClientProps) {
  const t = useTranslations('admin.renewals.tier_upgrades');
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-base text-muted-foreground">
          {t('empty_state.title')}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('empty_state.subtitle')}
        </p>
        {/* Phase 7 review-fix S-UX-3: empty-state CTA per FR-046a. */}
        <Link
          href="/admin/settings/renewals/schedules"
          className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline"
        >
          {t('empty_state.cta')}
        </Link>
      </div>
    );
  }

  async function callAction(
    suggestionId: string,
    action: 'accept' | 'dismiss' | 'escalate',
  ): Promise<void> {
    setPendingId(suggestionId);
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
        const errBody = await response
          .json()
          .catch(() => ({ error: { code: 'unknown' } }));
        toast.error(t(`actions.${action}.error`), {
          description: errBody?.error?.code ?? '',
        });
        return;
      }
      toast.success(t(`actions.${action}.success`));
      startTransition(() => router.refresh());
    } catch (e) {
      toast.error(t(`actions.${action}.error`), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
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
              const busy = pendingId === item.suggestionId;
              const isOpen = item.status === 'open';
              return (
                <TableRow key={item.suggestionId} aria-busy={busy}>
                  {/* Phase 7 review-fix I-UX-2: full member id available
                      to assistive tech via sr-only span; visible label
                      stays truncated (8-char prefix) for compact display. */}
                  <TableCell className="font-mono text-xs">
                    <span aria-hidden="true">{item.memberId.slice(0, 8)}</span>
                    <span className="sr-only">{item.memberId}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.fromPlanId}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.toPlanId}
                  </TableCell>
                  <TableCell>{t(`reason.${item.reasonCode}`)}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">
                      {t(`status.${item.status}`)}
                    </span>
                  </TableCell>
                  {/* Phase 7 review-fix I-UX-3: 3 buttons inline at md+,
                      DropdownMenu collapse below md so 44×44 tap-target
                      (WCAG 2.5.5) is preserved on tablet/mobile. */}
                  <TableCell className="text-right">
                    <div className="hidden gap-2 md:inline-flex">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={!isOpen || busy}
                        aria-busy={busy}
                        onClick={() =>
                          setDialog({
                            action: 'accept',
                            suggestionId: item.suggestionId,
                          })
                        }
                      >
                        {t('actions.accept.label')}
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
                        onClick={() =>
                          setDialog({
                            action: 'dismiss',
                            suggestionId: item.suggestionId,
                          })
                        }
                      >
                        {t('actions.dismiss.label')}
                      </Button>
                    </div>
                    <div className="md:hidden">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={!isOpen || busy}
                          aria-busy={busy}
                          aria-label={t('actions.row_menu_aria')}
                          className="inline-flex size-8 items-center justify-center rounded-md border border-input bg-background text-sm shadow-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {/* Round 6 Round-7 UX-fix — switched onSelect →
                              onClick to align with F8 Phase 8
                              `escalation-task-queue.tsx` pattern that
                              shipped successfully through review.
                              Radix DropdownMenuItem.onSelect interacts
                              poorly with mobile touch event chains
                              (verified failing under Playwright
                              mobile-chrome / mobile-safari simulators
                              2026-05-10); onClick on the underlying
                              <button> bypasses the popper-close race. */}
                          <DropdownMenuItem
                            disabled={!isOpen || busy}
                            onClick={() =>
                              setDialog({
                                action: 'accept',
                                suggestionId: item.suggestionId,
                              })
                            }
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
                            onClick={() =>
                              setDialog({
                                action: 'dismiss',
                                suggestionId: item.suggestionId,
                              })
                            }
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog ? t(`actions.${dialog.action}.dialog_title`) : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog ? t(`actions.${dialog.action}.confirm`) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('dialog.cancel')}
            </AlertDialogCancel>
            {/* Phase 7 review-fix C-UX-2: destructive variant for Dismiss
                (irreversible — 90d suppression). Accept stays default
                (positive action). ux-standards.md § 6.2 requires the
                visual destructive affordance for irreversible actions. */}
            <AlertDialogAction
              className={
                dialog?.action === 'dismiss'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20'
                  : undefined
              }
              onClick={() => {
                if (!dialog) return;
                const { action, suggestionId } = dialog;
                setDialog(null);
                void callAction(suggestionId, action);
              }}
            >
              {dialog ? t(`actions.${dialog.action}.label`) : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
