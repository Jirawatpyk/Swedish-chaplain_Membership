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

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
                <TableRow key={item.suggestionId}>
                  <TableCell className="font-mono text-xs">
                    {item.memberId.slice(0, 8)}
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
                  <TableCell className="space-x-2 text-right">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={!isOpen || busy}
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
                      onClick={() =>
                        setDialog({
                          action: 'dismiss',
                          suggestionId: item.suggestionId,
                        })
                      }
                    >
                      {t('actions.dismiss.label')}
                    </Button>
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
            <AlertDialogAction
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
