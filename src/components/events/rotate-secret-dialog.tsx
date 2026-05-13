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
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { WebhookSecretReveal } from './webhook-secret-reveal';
import { formatGraceTimestamp } from '@/lib/format-grace-timestamp';
import { parseProblemDetail } from '@/lib/http/parse-problem-detail';

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
  // Round 2 R-H2 fix (2026-05-13) — `formatGraceTimestamp` shared
  // helper renders ISO timestamps with the chamber's Bangkok timezone
  // + locale-correct date/time format. Previously the raw ISO leaked
  // through to the TH/SV post-rotation dialog body via the i18n
  // interpolation.
  const format = useFormatter();
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
        // Round 2 SF-LOW8 fix (2026-05-13) — surface the `Retry-After`
        // seconds in the toast so admin knows how long to wait.
        const retryAfterRaw = res.headers.get('Retry-After');
        const retryAfter = retryAfterRaw ? Number.parseInt(retryAfterRaw, 10) : null;
        toast.error(
          retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > 0
            ? t('rateLimitedWithRetry', { seconds: retryAfter })
            : t('rateLimited'),
        );
        return;
      }
      if (!res.ok) {
        // Round 2 simplifier P1 (2026-05-13) — shared
        // `parseProblemDetail` helper. Surfaces distinct copy for
        // 404 (kill-switch) vs 500 (DB outage / audit-emit-failed)
        // vs 503 (read-only).
        toast.error(await parseProblemDetail(res, t('failed')));
        return;
      }
      const body = (await res.json()) as RotationResult & { ok: true };
      setRotationResult({
        secret: body.secret,
        secretLastFour: body.secretLastFour,
        graceActiveUntil: body.graceActiveUntil,
      });
      toast.success(t('success'));
    } catch (e) {
      // Round-6 verify-fix 2026-05-13 — surface to DevTools so devs
      // can debug network failures without manual repro.
      console.error('[F6] rotate-secret request failed', e);
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
    const graceActiveUntilDisplay = formatGraceTimestamp(
      format,
      rotationResult.graceActiveUntil,
    );
    return (
      <ConfirmationDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t('postTitle')}
        description={t('postDescription', {
          graceActiveUntil: graceActiveUntilDisplay,
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
                 a redundant secondary path here — both buttons
                 converge on the same `onRotationAcknowledged` +
                 dialog-close call so the admin gets to either trigger
                 from either click target. */
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
