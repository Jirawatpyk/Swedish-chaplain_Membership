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
 *   - `aria-live="polite"` SR announcement on copy success.
 *   - Checkbox + label associated via shadcn `<Label htmlFor>`.
 *   - Reduced-motion safe — no CSS animation.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CopyIcon, CheckIcon, EyeIcon, EyeOffIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

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
}

export function WebhookSecretReveal({
  secret,
  secretLastFour,
  onContinue,
}: WebhookSecretRevealProps) {
  const t = useTranslations('admin.integrations.eventcreate.phaseA');
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

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
    // No longer auto-advances. The "Continue" button below is enabled
    // when `saved === true` and explicitly invokes `onContinue`.
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-6">
        <div className="space-y-2">
          <Label htmlFor="webhook-secret-input">{t('secretLabel')}</Label>
          <div className="flex items-stretch gap-2">
            <code
              id="webhook-secret-input"
              className="flex-1 break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm"
              data-testid="webhook-secret-value"
            >
              {visible ? secret : `${'•'.repeat(20)}${secretLastFour}`}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? t('hideSecret') : t('revealSecret')}
              className="min-h-11 min-w-11"
            >
              {visible ? (
                <EyeOffIcon className="size-4" aria-hidden />
              ) : (
                <EyeIcon className="size-4" aria-hidden />
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopy}
              aria-label={t('copySecret')}
              className="min-h-11 min-w-11"
            >
              {copied ? (
                <CheckIcon className="size-4" aria-hidden />
              ) : (
                <CopyIcon className="size-4" aria-hidden />
              )}
              <span role="status" aria-live="polite" className="sr-only">
                {copied ? t('copied') : ''}
              </span>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t('warning')}</p>
        </div>

        <div className="flex items-start gap-2">
          <Checkbox
            id="secret-saved-checkbox"
            checked={saved}
            onCheckedChange={(checked) =>
              handleSavedChange(checked === true)
            }
            aria-describedby="secret-saved-description"
          />
          <div className="space-y-1 leading-none">
            <Label
              htmlFor="secret-saved-checkbox"
              className="cursor-pointer"
            >
              {t('savedInPasswordManager')}
            </Label>
            <p
              id="secret-saved-description"
              className="text-xs text-muted-foreground"
            >
              {t('savedHint', { lastFour: secretLastFour })}
            </p>
          </div>
        </div>

        {/* Explicit Continue button (verify-fix 2026-05-13). Disabled
            until the saved-checkbox is ticked — preserves FR-024 gate
            without the race-condition risk of auto-advance-on-tick. */}
        <Button
          type="button"
          onClick={onContinue}
          disabled={!saved}
          aria-disabled={!saved}
          className="min-h-11 self-end"
        >
          {t('continueToSetup')}
        </Button>
      </CardContent>
    </Card>
  );
}
