'use client';

/**
 * DV-12 — Cancel-broadcast action (admin + member), unified (review #13).
 *
 * A destructive-outline trigger that mounts the shared <CancelBroadcastDialog>
 * with per-surface config. Returns a bare fragment (NO justify-end wrapper) so
 * each call site owns its own layout.
 *
 * Config matrix:
 *   surface=admin  → /api/admin/broadcasts/{id}/cancel · admin.broadcasts.cancelDialog · reason REQUIRED
 *   surface=member → /api/broadcasts/{id}/cancel       · portal.broadcasts.detail.cancelDialog · reason OPTIONAL
 *
 * Ownership/RBAC is enforced upstream (admin: requireAdminContext write; member:
 * getMemberBroadcast cross-member probe → 404). The parent gates visibility:
 * status ∈ {submitted, approved}.
 *
 * **108 Phase 9, round 3 below-cap sweep — the `variant="halt"` arm is GONE.**
 * It existed for F7.1a's mid-dispatch BATCH halt (stop the not-yet-dispatched
 * batches of a `sending` broadcast), `ca51f59a1` deleted the batch model, and
 * its parent gate — "status 'sending' with pending batches" — can therefore
 * never be true again. It had zero renderers and a five-case test suite: tested
 * dead code, which reads as a live feature to anyone who greps for it.
 *
 * Not to be confused with the LIVE member marketing halt
 * (`clear-halt-dialog`, `halt-state-banner`, `broadcasts-halt-clear`), a
 * different feature that keeps the name.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Ban, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CancelBroadcastDialog } from '@/components/broadcast/cancel-broadcast-dialog';

export interface CancelBroadcastActionProps {
  readonly broadcastId: string;
  readonly surface: 'admin' | 'member';
}

interface CancelActionConfig {
  readonly endpoint: (id: string) => string;
  readonly dialogNamespace: string;
  readonly toastNamespace: string;
  readonly reasonRequired: boolean;
  readonly successToastKey: string;
  readonly labelNamespace: string;
  readonly labelKey: string;
  readonly Icon: LucideIcon;
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
} satisfies CancelActionConfig;

const MEMBER_CANCEL = {
  endpoint: (id: string) => `/api/broadcasts/${id}/cancel`,
  dialogNamespace: 'portal.broadcasts.detail.cancelDialog',
  toastNamespace: 'portal.broadcasts.detail.toast',
  reasonRequired: false,
  successToastKey: 'cancelled',
  labelNamespace: 'portal.broadcasts.detail',
  labelKey: 'cancelButton',
  Icon: Ban,
} satisfies CancelActionConfig;

function resolveConfig(surface: 'admin' | 'member'): CancelActionConfig {
  return surface === 'admin' ? ADMIN_CANCEL : MEMBER_CANCEL;
}

export function CancelBroadcastAction({
  broadcastId,
  surface,
}: CancelBroadcastActionProps): React.ReactElement {
  const cfg = resolveConfig(surface);
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
