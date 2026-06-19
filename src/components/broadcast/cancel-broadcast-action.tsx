'use client';

/**
 * DV-12 — Cancel-broadcast action (admin + member), unified (review #13).
 * F7.1a — adds an admin-only `variant="halt"` for the mid-dispatch halt
 * (FR-004): stop the not-yet-dispatched batches of a `sending` broadcast.
 *
 * A destructive-outline trigger that mounts the shared <CancelBroadcastDialog>
 * with per-(surface, variant) config. Returns a bare fragment (NO justify-end
 * wrapper) so each call site owns its own layout.
 *
 * Config matrix:
 *   surface=admin  variant=cancel → /api/admin/broadcasts/{id}/cancel · admin.broadcasts.cancelDialog · reason REQUIRED · "Cancel broadcast"
 *   surface=member variant=cancel → /api/broadcasts/{id}/cancel       · portal.broadcasts.detail.cancelDialog · reason OPTIONAL · "Cancel broadcast"
 *   surface=admin  variant=halt   → /api/admin/broadcasts/{id}/cancel · admin.broadcasts.haltDialog · reason REQUIRED · "Halt sending" · success toast 'halted'
 *     (same /cancel endpoint — the use-case detects the `sending`+batches state
 *      and stops only the PENDING batches; already-dispatched batches deliver.)
 *
 * Ownership/RBAC is enforced upstream (admin: requireAdminContext write; member:
 * getMemberBroadcast cross-member probe → 404). The parent gates visibility:
 * cancel → status ∈ {submitted, approved}; halt → status 'sending' with pending
 * batches (admin only).
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban, CircleStop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export interface CancelBroadcastActionProps {
  readonly broadcastId: string;
  readonly surface: 'admin' | 'member';
  /** 'cancel' (pre-send, default) or 'halt' (admin-only mid-`sending` batch halt). */
  readonly variant?: 'cancel' | 'halt';
}

const ADMIN_CANCEL = {
  endpoint: (id: string) => `/api/admin/broadcasts/${id}/cancel`,
  dialogNamespace: 'admin.broadcasts.cancelDialog',
  toastNamespace: 'admin.broadcasts.toast',
  reasonRequired: true,
  successToastKey: 'cancelled',
  labelNamespace: 'admin.broadcasts.cancelDialog',
  labelKey: 'confirm',
  Icon: Ban,
} as const;

const MEMBER_CANCEL = {
  endpoint: (id: string) => `/api/broadcasts/${id}/cancel`,
  dialogNamespace: 'portal.broadcasts.detail.cancelDialog',
  toastNamespace: 'portal.broadcasts.detail.toast',
  reasonRequired: false,
  successToastKey: 'cancelled',
  labelNamespace: 'portal.broadcasts.detail',
  labelKey: 'cancelButton',
  Icon: Ban,
} as const;

// Admin mid-dispatch halt — same cancel endpoint, distinct copy + success toast.
const ADMIN_HALT = {
  endpoint: (id: string) => `/api/admin/broadcasts/${id}/cancel`,
  dialogNamespace: 'admin.broadcasts.haltDialog',
  toastNamespace: 'admin.broadcasts.toast',
  reasonRequired: true,
  successToastKey: 'halted',
  labelNamespace: 'admin.broadcasts.haltDialog',
  labelKey: 'confirm',
  Icon: CircleStop,
} as const;

function resolveConfig(surface: 'admin' | 'member', variant: 'cancel' | 'halt') {
  if (variant === 'halt') return ADMIN_HALT; // halt is admin-only by design
  return surface === 'admin' ? ADMIN_CANCEL : MEMBER_CANCEL;
}

export function CancelBroadcastAction({
  broadcastId,
  surface,
  variant = 'cancel',
}: CancelBroadcastActionProps): React.ReactElement {
  const cfg = resolveConfig(surface, variant);
  const t = useTranslations(cfg.labelNamespace);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { Icon } = cfg;

  return (
    <>
      <Button
        variant="destructive-outline"
        ref={triggerRef}
        onClick={() => setOpen(true)}
      >
        <Icon className="mr-1 size-4" aria-hidden="true" />
        {t(cfg.labelKey)}
      </Button>
      <CancelBroadcastDialog
        open={open}
        onOpenChange={setOpen}
        endpoint={cfg.endpoint(broadcastId)}
        namespace={cfg.dialogNamespace}
        toastNamespace={cfg.toastNamespace}
        reasonRequired={cfg.reasonRequired}
        successToastKey={cfg.successToastKey}
        triggerRef={triggerRef}
      />
    </>
  );
}
