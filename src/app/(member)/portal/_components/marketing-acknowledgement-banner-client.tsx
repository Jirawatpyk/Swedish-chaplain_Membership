'use client';

/**
 * T091 — Acknowledgement banner client wrapper.
 *
 * Renders the visual banner + "I acknowledge" / "Remind me later" CTAs.
 * Acknowledge POSTs to `/api/portal/broadcasts/acknowledge` (Q15 GDPR
 * Art. 7 demonstrable consent surface).
 *
 * Behaviour on Acknowledge click:
 *   - 2xx response → success toast + dismiss banner.
 *   - non-2xx response OR network failure → error toast with retry hint.
 *     Banner stays mounted so the user can re-click. NO best-effort
 *     dismiss — silently dismissing on failure would diverge the recorded
 *     consent state from what the UI implies (legal exposure).
 *
 * a11y CHK042 — banner-dismissal returns focus to a sibling anchor span
 * that stays mounted across the hidden state so `document.activeElement`
 * is always a known element.
 */
import { useRef, useState, useTransition } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export interface AcknowledgementBannerClientProps {
  readonly title: string;
  readonly body: string;
  readonly acknowledge: string;
  readonly remindLater: string;
  /** Server-resolved next-intl locale — recorded as the consent locale
   *  on the audit row (GDPR Art. 7). Passed as a prop instead of read
   *  from `document.documentElement.lang` so the consent reflects what
   *  the user actually saw on the server-rendered page. */
  readonly locale: 'en' | 'th' | 'sv';
}

export function AcknowledgementBannerClient({
  title,
  body,
  acknowledge,
  remindLater,
  locale,
}: AcknowledgementBannerClientProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.banner.acknowledgement');
  const [hidden, setHidden] = useState<boolean>(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const focusAnchorRef = useRef<HTMLSpanElement>(null);

  function dismiss() {
    // Move focus to the persistent anchor BEFORE unmount so the
    // screen reader stays on a known element after the banner is
    // removed (a11y CHK042).
    focusAnchorRef.current?.focus();
    setHidden(true);
  }

  function onAcknowledge() {
    startTransition(async () => {
      try {
        const res = await fetch('/api/portal/broadcasts/acknowledge', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
        if (!res.ok) {
          toast.error(t('toastAcknowledgeFailed'), {
            description: t('toastAcknowledgeFailedHint'),
          });
          return;
        }
        toast.success(t('toastAcknowledged'), { duration: 3000 });
        dismiss();
      } catch (e) {
        // Bind the exception so the actual cause (TypeError, AbortError,
        // CSP block, …) reaches the browser console / Sentry instead of
        // disappearing into a generic "failed, retry" toast.
        console.error('[broadcasts.acknowledge] network error', e);
        toast.error(t('toastAcknowledgeFailed'), {
          description: t('toastAcknowledgeFailedHint'),
        });
      }
    });
  }

  return (
    <>
      {hidden ? null : (
        <div
          ref={ref}
          role="region"
          aria-labelledby="broadcasts-ack-banner-heading"
          data-testid="broadcasts-acknowledge-banner"
          className="mx-auto my-4 flex max-w-(--layout-max-width-detail) items-start gap-4 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/40"
        >
          <ShieldCheck
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
          <div className="flex-1 space-y-2">
            <h2
              id="broadcasts-ack-banner-heading"
              className="text-sm font-semibold"
            >
              {title}
            </h2>
            <p className="text-sm text-muted-foreground">{body}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={onAcknowledge}
                disabled={pending}
                data-testid="banner-acknowledge-cta"
              >
                {pending ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                {acknowledge}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={dismiss}
                disabled={pending}
                data-testid="banner-remind-later"
              >
                {remindLater}
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* a11y CHK042 — focus anchor stays mounted ACROSS the hidden
          state so `document.activeElement` after dismiss remains a
          known element rather than the document body. The element has
          no text content and `tabIndex={-1}`, so screen readers skip
          it during sequential navigation but JS-driven focus works
          (no aria-hidden — the previous aria-hidden:true conflicted
          with programmatic focus per WCAG SC 4.1.2). */}
      <span
        ref={focusAnchorRef}
        tabIndex={-1}
        data-testid="banner-return-focus-anchor"
        className="sr-only"
      />
    </>
  );
}
