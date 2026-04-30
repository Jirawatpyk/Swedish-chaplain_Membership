'use client';

/**
 * T118 — Review actions trio per row.
 *
 * Buttons: "Approve & send now / schedule" + "Reject". Hidden for
 * manager role (parent renders only when role is admin).
 *
 * Local state opens approve-dialog or reject-dialog. State scoped to
 * one row instance — clicking another row's actions opens its own
 * dialog.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApproveDialog } from './approve-dialog';
import { RejectDialog } from './reject-dialog';

export interface ReviewActionsProps {
  readonly broadcastId: string;
}

export function ReviewActions({
  broadcastId,
}: ReviewActionsProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approveDialog');
  const tReject = useTranslations('admin.broadcasts.rejectDialog');
  const [approveOpen, setApproveOpen] = useState<boolean>(false);
  const [rejectOpen, setRejectOpen] = useState<boolean>(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size="sm"
        variant="default"
        onClick={() => setApproveOpen(true)}
      >
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        {t('confirm')}
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        onClick={() => setRejectOpen(true)}
      >
        <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        {tReject('confirm')}
      </Button>
      <ApproveDialog
        broadcastId={broadcastId}
        open={approveOpen}
        onOpenChange={setApproveOpen}
      />
      <RejectDialog
        broadcastId={broadcastId}
        open={rejectOpen}
        onOpenChange={setRejectOpen}
      />
    </div>
  );
}
