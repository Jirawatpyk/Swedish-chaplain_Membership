'use client';

/**
 * DV-12 — Cancel-broadcast action (admin + member), unified (review #13).
 *
 * Replaces the two near-identical admin-cancel-action / member-cancel-action
 * wrappers. A destructive-outline trigger that mounts the shared
 * <CancelBroadcastDialog> with per-surface config. Returns a bare fragment (NO
 * justify-end wrapper) so each call site owns its own layout — on the admin
 * detail page it sits in one row beside Approve/Reject; on the member portal it
 * is wrapped in a right-aligned row.
 *
 * Per-surface differences (everything else is identical):
 *   admin  → /api/admin/broadcasts/{id}/cancel · admin.broadcasts.cancelDialog ·
 *            admin.broadcasts.toast · reason REQUIRED · trigger label = cancelDialog.confirm
 *   member → /api/broadcasts/{id}/cancel · portal.broadcasts.detail.cancelDialog ·
 *            portal.broadcasts.detail.toast · reason OPTIONAL · trigger label = detail.cancelButton
 *
 * Ownership/RBAC is enforced upstream (admin: requireAdminContext write; member:
 * getMemberBroadcast cross-member probe → 404). The parent gates visibility to
 * status ∈ {submitted, approved}.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export interface CancelBroadcastActionProps {
  readonly broadcastId: string;
  readonly surface: 'admin' | 'member';
}

const SURFACE_CONFIG = {
  admin: {
    endpoint: (id: string) => `/api/admin/broadcasts/${id}/cancel`,
    dialogNamespace: 'admin.broadcasts.cancelDialog',
    toastNamespace: 'admin.broadcasts.toast',
    reasonRequired: true,
    labelNamespace: 'admin.broadcasts.cancelDialog',
    labelKey: 'confirm',
  },
  member: {
    endpoint: (id: string) => `/api/broadcasts/${id}/cancel`,
    dialogNamespace: 'portal.broadcasts.detail.cancelDialog',
    toastNamespace: 'portal.broadcasts.detail.toast',
    reasonRequired: false,
    labelNamespace: 'portal.broadcasts.detail',
    labelKey: 'cancelButton',
  },
} as const;

export function CancelBroadcastAction({
  broadcastId,
  surface,
}: CancelBroadcastActionProps): React.ReactElement {
  const cfg = SURFACE_CONFIG[surface];
  const t = useTranslations(cfg.labelNamespace);
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
        {t(cfg.labelKey)}
      </Button>
      <CancelBroadcastDialog
        open={open}
        onOpenChange={setOpen}
        endpoint={cfg.endpoint(broadcastId)}
        namespace={cfg.dialogNamespace}
        toastNamespace={cfg.toastNamespace}
        reasonRequired={cfg.reasonRequired}
        triggerRef={triggerRef}
      />
    </>
  );
}
