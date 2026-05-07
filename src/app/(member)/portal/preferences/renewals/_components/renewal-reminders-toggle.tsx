/**
 * F8 Phase 5 Wave C · T132 — Renewal-reminder opt-out toggle (client).
 *
 * Optimistic toggle posting to `/api/portal/preferences/renewals` per
 * FR-016. Idempotent — re-toggle preserves the original timestamp on
 * the DB side; the UI just reflects the latest server state.
 *
 * i18n: strings under `portal.preferences.renewals.*` in EN/TH/SV.
 */
'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

interface RenewalRemindersToggleProps {
  readonly initialOptedOut: boolean;
}

export function RenewalRemindersToggle({
  initialOptedOut,
}: RenewalRemindersToggleProps) {
  const t = useTranslations('portal.preferences.renewals');
  const [optedOut, setOptedOut] = useState(initialOptedOut);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onChange = (next: boolean) => {
    const prev = optedOut;
    setOptedOut(next);
    setError(null);
    startTransition(async () => {
      try {
        const r = await fetch('/api/portal/preferences/renewals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ opted_out: next }),
        });
        if (!r.ok) {
          setOptedOut(prev);
          const body = (await r.json().catch(() => ({}))) as {
            error?: { code?: string };
          };
          setError(body.error?.code ?? `http_${r.status}`);
        }
      } catch {
        setOptedOut(prev);
        setError('network_error');
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="renewal-reminders-toggle" className="flex flex-col">
          <span className="font-medium">{t('pauseLabel')}</span>
          <span className="text-xs text-muted-foreground">
            {t('pauseDescription')}
          </span>
        </Label>
        <Switch
          id="renewal-reminders-toggle"
          checked={optedOut}
          onCheckedChange={onChange}
          disabled={isPending}
        />
      </div>
      {error && (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="preferences-toggle-error"
        >
          {t('errorPrefix')} {error}
        </p>
      )}
    </div>
  );
}
