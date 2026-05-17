'use client';

/**
 * Rotate-secret dialog (F6 Phase 5 / FR-008).
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
  // `formatGraceTimestamp` shared
  // helper renders ISO timestamps with the chamber's Bangkok timezone
  // + locale-correct date/time format. Previously the raw ISO leaked
  // through to the TH/SV post-rotation dialog body via the i18n
  // interpolation.
  const format = useFormatter();
  const [rotationResult, setRotationResult] = useState<RotationResult | null>(
    null,
  );
  // mirror the embedded
  // WebhookSecretReveal's saved-checkbox state up to this dialog so
  // the Acknowledge button can gate on it. Eliminates the previous
  // dual-completion path where AT users saw both the inner Continue
  // button (disabled) AND the outer Done button (enabled).
  const [secretAcknowledged, setSecretAcknowledged] = useState(false);

  async function handleConfirm() {
    try {
      // shared `adminPost` replaces the boilerplate.
      const res = await adminPost(
        '/api/admin/integrations/eventcreate/rotate-secret',
      );
      if (res.status === 429) {
        // shared `parseRetryAfterSeconds` returns `null`
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
      // 05-13 — surface to DevTools so devs
      // can debug network failures without manual repro.
      console.error('[F6] rotate-secret request failed', e);
      toast.error(t('failed'));
    }
  }

  // 2 — accepts an `acknowledgedAlready`
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
      // reset the saved gate so a follow-up
      // open of the dialog starts fresh (without this the second
      // rotation would see acknowledged=true from the prior cycle).
      setSecretAcknowledged(false);
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
        confirmDisabled={!secretAcknowledged}
        onConfirm={() => {
          onRotationAcknowledged();
          handleOpenChange(false, true);
        }}
      >
        <div className="py-2">
          {/* Phase 5 review-fix W-04 — single completion
              path: the embedded WebhookSecretReveal hides its internal
              Continue button and lifts its saved-checkbox state to
              this dialog, so the Acknowledge button below is the only
              way to dismiss. Keyboard/AT order is now Cancel →
              [reveal/copy/checkbox] → Acknowledge — no disabled-button
              clutter mid-flow. */}
          <WebhookSecretReveal
            secret={rotationResult.secret}
            secretLastFour={rotationResult.secretLastFour}
            hideInternalContinue
            onSavedChange={setSecretAcknowledged}
            onContinue={() => {
              /* Unreachable when hideInternalContinue=true; kept as a
                 no-op so the prop contract stays satisfied. */
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
      // F6 Phase 8 T100 — DO NOT auto-close after onConfirm.
      // handleConfirm sets `rotationResult` so this dialog re-renders
      // into the post-rotation one-time-reveal view (the `if
      // (rotationResult)` branch above). The default
      // `closeOnConfirm=true` would fire `onOpenChange(false)` BEFORE
      // React commits the post-rotation re-render, so the admin never
      // sees the new plaintext secret. The post-rotation view's
      // explicit Done button owns its own close path via the inline
      // onConfirm → handleOpenChange(false, true) wiring.
      closeOnConfirm={false}
      onConfirm={handleConfirm}
    />
  );
}
