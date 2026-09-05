'use client';

/**
 * 108 PR-D (US6 — FR-032, FR-033, FR-051) — the contact's OWN marketing
 * control on /portal/profile.
 *
 *   - on / off (by contact or by staff) → a switch; PATCH
 *     `/api/portal/profile/marketing` with a fresh `Idempotency-Key` per
 *     request and `{ optOut }`;
 *   - unsubscribed → plain text and NO control: the person's own unsubscribe
 *     stands and is not something to flip from here (FR-025);
 *   - unavailable → a disabled switch with an explanation (FR-031a);
 *   - primary contact → the FR-033 note: invoices and payment emails are
 *     unaffected by this preference.
 *
 * Only the session's own state is ever rendered — the page never passes
 * another contact's state in (FR-032).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import type { MarketingState } from '@/modules/members';

type ResponseBody = { readonly outcome?: string; readonly error?: { readonly code?: string } };

export function PortalMarketingToggle({
  state,
  isPrimary,
}: {
  readonly state: MarketingState;
  readonly isPrimary: boolean;
}): React.ReactElement {
  const t = useTranslations('portal.profile.marketing');
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const checked = state === 'on';
  const controllable = state !== 'unsubscribed';
  const disabled = state === 'unavailable';

  async function send(optOut: boolean): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/portal/profile/marketing', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ optOut }),
      });
      const body = (await res.json().catch(() => ({}))) as ResponseBody;
      if (!res.ok) {
        if (res.status === 409) toast.error(t('toast.errors.suppressed'));
        else if (res.status === 429) toast.error(t('toast.errors.rateLimited'));
        else toast.error(t('toast.errors.generic'));
        return;
      }
      if (body.outcome === 'unchanged') toast.info(t('toast.unchanged'));
      else toast.success(optOut ? t('toast.switchedOff') : t('toast.switchedOn'));
      router.refresh();
    } catch {
      toast.error(t('toast.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col gap-1"
      data-testid="portal-marketing"
      data-marketing-state={state}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{t('label')}</span>
        {controllable && (
          <span className="inline-flex min-h-6 min-w-6 items-center">
            <Switch
              checked={checked}
              disabled={disabled || busy}
              aria-label={t('switchLabel')}
              onCheckedChange={(next) => {
                void send(!next);
              }}
            />
          </span>
        )}
        <span className="text-sm text-muted-foreground">{t(`state.${state}`)}</span>
      </div>
      {state === 'unsubscribed' && (
        <p className="text-xs text-muted-foreground">{t('unsubscribedHint')}</p>
      )}
      {state === 'unavailable' && (
        <p className="text-xs text-muted-foreground">{t('unavailableHint')}</p>
      )}
      {isPrimary && <p className="text-xs text-muted-foreground">{t('primaryNote')}</p>}
    </div>
  );
}
