'use client';

/**
 * DV-12 — Task 4: Member Cancel-broadcast action.
 *
 * A destructive-outline trigger button that mounts the shared
 * <CancelBroadcastDialog> configured for the member path:
 *   - endpoint: /api/broadcasts/${broadcastId}/cancel
 *   - namespace: portal.broadcasts.detail.cancelDialog (reason OPTIONAL ≤500)
 *   - toastNamespace: portal.broadcasts.detail.toast
 *   - reasonRequired: false (member cancel reason is optional — FR-004a)
 *
 * Mounted after the delivery-breakdown Card on the portal broadcast detail
 * page, gated to status ∈ {submitted, approved} by the parent RSC.
 * Ownership is already enforced by the getMemberBroadcast use-case (cross-
 * member probe → 404 + audit); no extra ownership check needed here.
 *
 * Focus: triggerRef wires focus-return on ESC / backdrop-click. On the
 * success path the detail page refreshes and this component unmounts;
 * finalFocus chains to #main-content (see CancelBroadcastDialog).
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export interface MemberCancelActionProps {
  readonly broadcastId: string;
}

export function MemberCancelAction({
  broadcastId,
}: MemberCancelActionProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.detail');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex justify-end">
      <Button
        variant="destructive-outline"
        ref={triggerRef}
        onClick={() => setOpen(true)}
      >
        <Ban className="mr-1 size-4" aria-hidden="true" />
        {t('cancelButton')}
      </Button>
      <CancelBroadcastDialog
        broadcastId={broadcastId}
        open={open}
        onOpenChange={setOpen}
        endpoint={`/api/broadcasts/${broadcastId}/cancel`}
        namespace="portal.broadcasts.detail.cancelDialog"
        toastNamespace="portal.broadcasts.detail.toast"
        reasonRequired={false}
        triggerRef={triggerRef}
      />
    </div>
  );
}
