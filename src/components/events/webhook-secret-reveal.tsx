'use client';

/**
 * T076 — Webhook secret one-time-reveal panel (F6 Phase 5 / US3 AS1).
 *
 * Rendered as Phase A of the onboarding wizard. The secret returned
 * by POST `/generate-secret` is shown ONCE in plaintext with a
 * copy-to-clipboard button + "I've saved this in a password manager"
 * checkbox that gates Phase B (FR-024). On reload the secret is gone —
 * a masked `whsec_••••••••<last4>` display + Rotate CTA is shown by
 * the parent wizard instead (AS3).
 *
 * Accessibility:
 *   - Secret rendered inside `<code>` with `font-mono` so copy/paste
 *     fidelity is preserved.
 *   - Copy success is announced once, by the toast (AURA's Toaster is a
 *     polite live region); a second live line here read it twice.
 *   - While masked, the dots are hidden from screen readers, which hear
 *     "hidden, ending in <last4>" instead.
 *   - Checkbox + label associated via shadcn `<Label htmlFor>`.
 *   - Reduced-motion safe — no CSS animation.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Checkbox, IconButton } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { WebhookValueBox } from './webhook-value-box';

export interface WebhookSecretRevealProps {
  /** Plaintext secret returned by `/generate-secret`. */
  readonly secret: string;
  /** Last 4 chars (for the "saved-as" reminder beside the checkbox). */
  readonly secretLastFour: string;
  /**
   * Fires when the user clicks "Continue to Zapier setup" AFTER ticking
   * the "saved in password manager" checkbox. The explicit Continue
   * button (verify-fix 2026-05-13) replaced an earlier auto-advance-on-
   * checkbox callback that unmounted this component mid-state-update,
   * causing a Playwright race condition + occasional missed advances
   * in production. The button stays disabled until the checkbox is
   * ticked (FR-024 gate preserved).
   */
  readonly onContinue: () => void;
  /**
   * Phase 5 review-fix W-04 (2026-05-13) — when rendered inside the
   * `RotateSecretDialog` post-rotation view, the wrapper dialog
   * supplies its own "Done/Acknowledge" button. Without this flag the
   * embedded Continue button creates a dual-completion path: keyboard/
   * AT users encounter Cancel → [reveal/copy buttons] → Continue
   * (disabled) → Done, with no clear cue which terminates the flow.
   * Setting `hideInternalContinue={true}` suppresses the embedded
   * button so the dialog's Done is the single completion path. The
   * "saved in password manager" checkbox + its aria-live announcement
   * remain — the wrapping dialog's Done button is itself gated on the
   * saved state via parent-side state lift.
   */
  readonly hideInternalContinue?: boolean;
  /**
   * Phase 5 review-fix W-04 (2026-05-13) — companion of
   * `hideInternalContinue`. Fires whenever the saved-checkbox state
   * changes so the parent dialog can mirror the gate on its own
   * action button.
   */
  readonly onSavedChange?: (saved: boolean) => void;
}

export function WebhookSecretReveal({
  secret,
  secretLastFour,
  onContinue,
  hideInternalContinue = false,
  onSavedChange,
}: WebhookSecretRevealProps) {
  const t = useTranslations('admin.integrations.eventcreate.phaseA');
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  // Its own label id: in the rotate dialog step 3's "Current secret" group
  // is still on the page, and a shared id would name this group after it.
  const labelId = useId();

  // Reset the 2s "copied" indicator.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(id);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success(t('copied'));
    } catch {
      // Older browsers / insecure contexts.
      const el = document.createElement('textarea');
      el.value = secret;
      el.setAttribute('readonly', '');
      el.style.position = 'absolute';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        toast.success(t('copied'));
      } catch {
        toast.error(t('copyFailed'));
      } finally {
        document.body.removeChild(el);
      }
    }
  }

  function handleSavedChange(value: boolean) {
    setSaved(value);
    // Phase 5 review-fix W-04 (2026-05-13) — mirror the saved state
    // up to the parent so a wrapping dialog (RotateSecretDialog) can
    // gate its own Done button on the same condition without
    // requiring two independent checkboxes.
    onSavedChange?.(value);
    // No longer auto-advances. The "Continue" button below is enabled
    // when `saved === true` and explicitly invokes `onContinue`.
  }

  // Spec 122 US9c — AURA has no secret field: the value sits in the page's
  // value box with eye / eye-off and copy IconButtons, and the "saved" gate
  // is AURA Checkbox (its hint is the description, linked for AT).
  return (
    <Card>
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        {/*
          Round 2 CRIT-02 — a `<span id>` names the group; a `<label>` can
          only point at a form control and the value is a `<code>`.
        */}
        <div
          className="flex flex-col gap-[var(--aura-space-2)]"
          role="group"
          aria-labelledby={labelId}
        >
          <span id={labelId} className="aura-text-label">
            {t('secretLabel')}
          </span>
          <div className="flex min-w-0 items-center gap-[var(--aura-space-2)]">
            <WebhookValueBox id="webhook-secret-input" data-testid="webhook-secret-value">
              {visible ? (
                secret
              ) : (
                // Screen readers hear "hidden, ending in 7f3a", not the dots.
                <>
                  <span aria-hidden="true">{`${'•'.repeat(20)}${secretLastFour}`}</span>
                  <span className="sr-only">{t('maskedSecret', { lastFour: secretLastFour })}</span>
                </>
              )}
            </WebhookValueBox>
            <IconButton
              icon={visible ? 'eye-off' : 'eye'}
              label={visible ? t('hideSecret') : t('revealSecret')}
              onClick={() => setVisible((v) => !v)}
            />
            <IconButton
              icon={copied ? 'check' : 'copy'}
              label={t('copySecret')}
              onClick={() => void handleCopy()}
            />
          </div>
          <p className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('warning')}</p>
        </div>

        <Checkbox
          id="secret-saved-checkbox"
          checked={saved}
          onChange={handleSavedChange}
          description={t('savedHint', { lastFour: secretLastFour })}
        >
          {t('savedInPasswordManager')}
        </Checkbox>

        {/* Explicit Continue (verify-fix 2026-05-13), disabled until the box
            is ticked (FR-024). Hidden inside the rotate dialog, which has its
            own Done (Phase 5 review-fix W-04). */}
        {hideInternalContinue ? null : (
          <Button
            type="button"
            touchHeight
            className="self-end max-sm:w-full"
            onClick={onContinue}
            disabled={!saved}
          >
            {t('continueToSetup')}
          </Button>
        )}
      </div>
    </Card>
  );
}
