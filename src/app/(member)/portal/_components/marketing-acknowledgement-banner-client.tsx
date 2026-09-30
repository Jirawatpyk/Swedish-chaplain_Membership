'use client';

/**
 * T091 — Acknowledgement banner client wrapper.
 *
 * Renders the visual banner + "I acknowledge" / "Remind me later" CTAs.
 * Acknowledge POSTs to `/api/portal/broadcasts/acknowledge` (Q15 — the
 * member acknowledges the E-Blast sending terms; not recipient consent).
 *
 * Behaviour on Acknowledge click:
 *   - 2xx response → success toast + dismiss banner.
 *   - non-2xx response OR network failure → error toast with retry hint.
 *     Banner stays mounted so the user can re-click. NO best-effort
 *     dismiss — silently dismissing on failure would diverge the recorded
 *     acknowledgement state from what the UI implies.
 *
 * a11y CHK042 — banner-dismissal returns focus to a sibling anchor span
 * that stays mounted across the hidden state so `document.activeElement`
 * is always a known element.
 */
import { useRef, useState, useTransition } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Alert, Button } from '@jirawatpyk/aura-react';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';

export interface AcknowledgementBannerClientProps {
  readonly title: string;
  readonly body: string;
  readonly acknowledge: string;
  readonly remindLater: string;
  /** Server-resolved next-intl locale — recorded as the acknowledgement
   *  locale on the audit row. Passed as a prop instead of read from
   *  `document.documentElement.lang` so the record reflects what the
   *  user actually saw on the server-rendered page. */
  readonly locale: 'en' | 'th' | 'sv';
  /** UX-5 — optional tenant Privacy Policy URL. When null/undefined
   *  the link is omitted entirely (no dead anchor) for tenants
   *  without a published policy URL. */
  readonly privacyPolicyUrl?: string | null;
  readonly privacyPolicyLinkLabel?: string;
}

export function AcknowledgementBannerClient({
  title,
  body,
  acknowledge,
  remindLater,
  locale,
  privacyPolicyUrl,
  privacyPolicyLinkLabel,
}: AcknowledgementBannerClientProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.banner.acknowledgement');
  const readOnlyToast = useReadOnlyToast();
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
          // The write freeze: nothing was recorded, and the banner stays.
          if (await isReadOnlyResponse(res)) {
            readOnlyToast();
            return;
          }
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
        // Outer wrapper matches DetailContainer's `mx-auto + max-w +
        // px-[var(--page-padding-x)]` so the warning-banner edges align
        // with the page content cards below on narrow viewports (was
        // flush to viewport edges < 1152px).
        <div className="mx-auto w-full max-w-(--layout-max-width-detail) px-[var(--page-padding-x)] pt-[var(--page-padding-y)]">
          {/* A named region, not an alert: it is a standing request, announced
              by its landmark. Inside, AURA's warning Alert with role="none"
              (spec 122; 5.8 role override, handoff #66). */}
          <div
            ref={ref}
            role="region"
            aria-labelledby="broadcasts-ack-banner-heading"
            data-testid="broadcasts-acknowledge-banner"
          >
            <Alert
              tone="warning"
              role="none"
              icon={<ShieldCheck aria-hidden="true" />}
              // U36 — AURA's title is a `<p>`, not an `<h2>`: the banner
              // renders ABOVE the page `<h1>`, so a heading here made the
              // outline read h2 → h1 → h2. The region is named by it.
              title={<span id="broadcasts-ack-banner-heading">{title}</span>}
              action={
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    onClick={onAcknowledge}
                    loading={pending}
                    data-testid="banner-acknowledge-cta"
                  >
                    {acknowledge}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={dismiss}
                    disabled={pending}
                    data-testid="banner-remind-later"
                  >
                    {remindLater}
                  </Button>
                </div>
              }
            >
              <p>{body}</p>
              {privacyPolicyUrl && privacyPolicyLinkLabel ? (
                <p className="text-sm">
                  <a
                    href={privacyPolicyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    // `inline-block max-w-full` — the short link phrase stays
                    // whole (TH "อ่านนโยบายความเป็นส่วนตัว" has no spaces) and
                    // breaks only when it is wider than the line, e.g. at 200%
                    // text on a phone (WCAG 1.4.4). `whitespace-nowrap` pushed
                    // it past the viewport there and scrolled the page sideways.
                    className="inline-block max-w-full font-medium text-[var(--aura-fg-accent)] underline underline-offset-2 hover:text-[var(--aura-fg-primary)]"
                  >
                    {privacyPolicyLinkLabel}
                  </a>
                </p>
              ) : null}
            </Alert>
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
