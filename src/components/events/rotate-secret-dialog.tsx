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
import { parseRetryAfterSeconds } from '@/lib/http/parse-retry-after';
import { adminPost } from '@/lib/http/admin-post';

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
      // Round 3 S-H3 — shared `adminPost` replaces the boilerplate.
      const res = await adminPost(
        '/api/admin/integrations/eventcreate/rotate-secret',
      );
      if (res.status === 429) {
        // Round 3 S-M1 — shared `parseRetryAfterSeconds` returns `null`
        // for missing/non-integer/zero/negative values, with a forensic
        // console.warn for HTTP-date form (M-err-4).
        const retryAfter = parseRetryAfterSeconds(res);
        toast.error(
          retryAfter !== null
            ? t('rateLimitedWithRetry', { seconds: retryAfter })
            : t('rateLimited'),
        );
        return;
      }
      if (!res.ok) {
        toast.error(
          await parseProblemDetail(res, t('failed'), 'rotate-secret'),
        );
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
  //
  // Round 3 M-code-2 (2026-05-13) — accepts an `acknowledgedAlready`
  // flag from the explicit Acknowledge-button paths so we don't emit
  // `onRotationAcknowledged()` twice when the dialog closes via the
  // confirm-button (which already calls it inline). The previous
  // version emitted on both confirm AND close → two `router.refresh()`
  // calls per acknowledgement.
  function handleOpenChange(next: boolean, acknowledgedAlready = false) {
    if (!next) {
      if (rotationResult && !acknowledgedAlready) {
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
          handleOpenChange(false, true);
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
              handleOpenChange(false, true);
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
