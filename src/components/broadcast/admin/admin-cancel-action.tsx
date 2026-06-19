'use client';

/**
 * DV-12 — Task 3: Admin Cancel-broadcast action.
 *
 * A destructive-outline trigger button that mounts the shared
 * <CancelBroadcastDialog> configured for the admin path:
 *   - endpoint: /api/admin/broadcasts/${broadcastId}/cancel
 *   - namespace: admin.broadcasts.cancelDialog (reason REQUIRED, 1–500 chars)
 *   - toastNamespace: admin.broadcasts.toast
 *   - reasonRequired: true (admin must supply a reason)
 *
 * Composed as a sibling of <ReviewActions> on the admin broadcast detail
 * page so that Cancel is reachable for both `submitted` AND `approved`
 * broadcasts (ReviewActions only renders for `submitted`).
 *
 * Focus: triggerRef wires the trigger button so Base UI returns keyboard
 * focus to the Cancel-broadcast button on ESC / backdrop-click. On the
 * success path the detail page refreshes and this component unmounts;
 * finalFocus chains to #main-content (see CancelBroadcastDialog).
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export interface AdminCancelActionProps {
  readonly broadcastId: string;
}

export function AdminCancelAction({
  broadcastId,
}: AdminCancelActionProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.cancelDialog');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        variant="destructive-outline"
        ref={triggerRef}
        onClick={() => setOpen(true)}
      >
        <Ban className="mr-1 size-4" aria-hidden="true" />
        {t('confirm')}
      </Button>
      <CancelBroadcastDialog
        broadcastId={broadcastId}
        open={open}
        onOpenChange={setOpen}
        endpoint={`/api/admin/broadcasts/${broadcastId}/cancel`}
        namespace="admin.broadcasts.cancelDialog"
        toastNamespace="admin.broadcasts.toast"
        reasonRequired
        triggerRef={triggerRef}
      />
    </>
  );
}
