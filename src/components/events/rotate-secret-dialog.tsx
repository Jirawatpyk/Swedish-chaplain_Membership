'use client';

/**
 * T077 — Rotate-secret dialog (F6 Phase 5 / FR-008).
 *
 * Wraps `ConfirmationDialog` (focus-safe — Cancel auto-focused). When
 * confirmed, POSTs to `/rotate-secret`. On success, renders the new
 * plaintext secret inline via the `<WebhookSecretReveal>` component
 * (one-time-reveal — same UX as Phase A).
 *
 * Displays the 24h grace-window-active-until timestamp so the admin
 * sees exactly when the old secret stops verifying.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { WebhookSecretReveal } from './webhook-secret-reveal';

export interface RotateSecretDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fires after the new secret is acknowledged (saved checkbox ticked)
   *  so the parent can re-fetch the integration config view. */
  readonly onRotationAcknowledged: () => void;
}

interface RotationResult {
  readonly secret: string;
  readonly secretLastFour: string;
  readonly graceActiveUntil: string;
}

export function RotateSecretDialog({
  open,
  onOpenChange,
  onRotationAcknowledged,
}: RotateSecretDialogProps) {
  const t = useTranslations('admin.integrations.eventcreate.phaseC.rotate');
  const [rotationResult, setRotationResult] = useState<RotationResult | null>(
    null,
  );

  async function handleConfirm() {
    try {
      const res = await fetch(
        '/api/admin/integrations/eventcreate/rotate-secret',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: '{}',
        },
      );
      if (res.status === 429) {
        toast.error(t('rateLimited'));
        return;
      }
      if (!res.ok) {
        toast.error(t('failed'));
        return;
      }
      const body = (await res.json()) as RotationResult & { ok: true };
      setRotationResult({
        secret: body.secret,
        secretLastFour: body.secretLastFour,
        graceActiveUntil: body.graceActiveUntil,
      });
      toast.success(t('success'));
    } catch {
      toast.error(t('failed'));
    }
  }

  // Reset state when the dialog closes (so a follow-up open doesn't
  // flash the previous secret).
  function handleOpenChange(next: boolean) {
    if (!next) {
      if (rotationResult) {
        // Acknowledge the rotation before closing so parent refreshes.
        onRotationAcknowledged();
      }
      setRotationResult(null);
    }
    onOpenChange(next);
  }

  if (rotationResult) {
    // Post-rotation view: render the new secret one-time + grace info.
    return (
      <ConfirmationDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('postTitle')}
        description={t('postDescription', {
          graceActiveUntil: rotationResult.graceActiveUntil,
        })}
        confirmLabel={t('acknowledge')}
        cancelLabel={t('close')}
        onConfirm={() => {
          onRotationAcknowledged();
          handleOpenChange(false);
        }}
      >
        <div className="py-2">
          <WebhookSecretReveal
            secret={rotationResult.secret}
            secretLastFour={rotationResult.secretLastFour}
            onContinue={() => {
              /* Rotation dialog's primary action is the
                 ConfirmationDialog's own "Acknowledge" button below;
                 the embedded WebhookSecretReveal's Continue button is
                 a no-op secondary path here. Both end up closing the
                 dialog via `onRotationAcknowledged`. */
              onRotationAcknowledged();
              handleOpenChange(false);
            }}
          />
        </div>
      </ConfirmationDialog>
    );
  }

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('preTitle')}
      description={t('preDescription')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      destructive
      onConfirm={handleConfirm}
    />
  );
}
