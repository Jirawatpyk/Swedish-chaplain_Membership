'use client';

/**
 * Spec 122 US12d-3 follow-up (PR C) — the E-Blast sending rules on the member
 * compose page (boards `Portal-broadcast-new-rules`, `Portal-broadcast-new`).
 *
 * Reuses the company's acknowledgement the portal banner records
 * (`members.broadcasts_acknowledged_at`, POST /api/portal/broadcasts/acknowledge,
 * audited once as `member_acknowledged_broadcasts_terms`) and the banner's
 * own copy, so the two surfaces say the same thing:
 * - not yet acknowledged: the banner's warning alert, with "I acknowledge";
 * - acknowledged: one line, "E-Blast sending rules · Read again", a
 *   disclosure that shows the same rules and changes nothing on the server.
 *
 * It explains the rules; it never gates Save or Submit (they never were).
 * The portal banner is hidden on this route, so the rules show once.
 */
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Alert, Button } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';

export interface ComposeSendingRulesProps {
  /** ISO time the company acknowledged the rules, or null when it has not. */
  readonly acknowledgedAt: string | null;
  /** Recorded on the audit row, as the banner does. */
  readonly locale: 'en' | 'th' | 'sv';
  /** The tenant's privacy policy, when one is published. */
  readonly privacyPolicyUrl: string | null;
}

export function ComposeSendingRules({
  acknowledgedAt,
  locale,
  privacyPolicyUrl,
}: ComposeSendingRulesProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.banner.acknowledgement');
  const tRules = useTranslations('portal.broadcasts.compose.rules');
  const router = useRouter();
  const readOnlyToast = useReadOnlyToast();
  const [acknowledged, setAcknowledged] = useState(acknowledgedAt !== null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  const titleId = useId();
  const rulesId = useId();

  // After acknowledging, the alert's button unmounts: focus moves to the
  // line's "Read again", where the rules can be opened again.
  useEffect(() => {
    if (acknowledged && focusToggle.current) {
      focusToggle.current = false;
      toggleRef.current?.focus();
    }
  }, [acknowledged]);

  const rules = (
    <>
      <p>{t('body')}</p>
      {privacyPolicyUrl ? (
        <p className="text-sm">
          <a
            href={privacyPolicyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block max-w-full font-medium text-[var(--aura-fg-accent)] underline underline-offset-2 hover:text-[var(--aura-fg-primary)]"
          >
            {t('privacyPolicyLink')}
          </a>
        </p>
      ) : null}
    </>
  );

  function onAcknowledge(): void {
    startTransition(async () => {
      try {
        const res = await fetch('/api/portal/broadcasts/acknowledge', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale }),
        });
        if (!res.ok) {
          if (await isReadOnlyResponse(res)) {
            readOnlyToast();
            return;
          }
          toast.error(t('toastAcknowledgeFailed'), { description: t('toastAcknowledgeFailedHint') });
          return;
        }
        toast.success(t('toastAcknowledged'), { duration: 3000 });
        focusToggle.current = true;
        setAcknowledged(true);
        // The portal banner lives in the layout: refresh so it is gone on
        // the member's next page too.
        router.refresh();
      } catch (e) {
        console.error('[broadcasts.acknowledge] network error', e);
        toast.error(t('toastAcknowledgeFailed'), { description: t('toastAcknowledgeFailedHint') });
      }
    });
  }

  if (!acknowledged) {
    return (
      // A named region, as the banner is: a standing request, not an alert.
      <div role="region" aria-labelledby={titleId} data-testid="compose-sending-rules">
        <Alert
          tone="warning"
          role="none"
          icon={<ShieldCheck aria-hidden="true" />}
          title={<span id={titleId}>{t('title')}</span>}
          action={
            <Button type="button" variant="primary" onClick={onAcknowledge} loading={pending}>
              {t('acknowledge')}
            </Button>
          }
        >
          {rules}
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="compose-sending-rules">
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--aura-fg-secondary)]">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
        <span>{tRules('line')}</span>
        <span aria-hidden="true">·</span>
        <Button
          ref={toggleRef}
          type="button"
          variant="ghost"
          size="sm"
          touchHeight
          aria-expanded={open}
          aria-controls={rulesId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? tRules('hide') : tRules('readAgain')}
        </Button>
      </p>
      {open ? (
        <div
          id={rulesId}
          className="flex flex-col gap-2 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-canvas)] p-3 text-sm"
        >
          {rules}
        </div>
      ) : null}
    </div>
  );
}
