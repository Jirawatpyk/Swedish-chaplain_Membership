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
import { toast } from 'sonner';
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

  const onChange = (next: boolean) => {
    const prev = optedOut;
    setOptedOut(next);
    startTransition(async () => {
      // I17 review-fix: surface failures via sonner toast (per
      // docs/ux-standards.md async-feedback convention) instead of an
      // inline error. The toast title + description tell the member
      // both that the toggle reverted AND why — clearer than a
      // silent revert with raw error-code text below.
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
          console.warn('[renewal-reminders-toggle] save failed', {
            code: body.error?.code,
            status: r.status,
          });
          toast.error(t('saveErrorTitle'), {
            description: t('saveErrorDescription'),
          });
        }
      } catch (err) {
        setOptedOut(prev);
        console.warn('[renewal-reminders-toggle] network error', err);
        toast.error(t('saveErrorTitle'), {
          description: t('saveErrorDescription'),
        });
      }
    });
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor="renewal-reminders-toggle" className="flex flex-col">
        <span id="renewal-reminders-toggle-label" className="font-medium">
          {t('pauseLabel')}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('pauseDescription')}
        </span>
      </Label>
      <Switch
        id="renewal-reminders-toggle"
        // 067 a11y — Base UI Switch.Root renders a <button role="switch">; the
        // `<label htmlFor>` accessible-name association can resolve late on
        // hydration (the intermittent axe "switch must have an accessible name"
        // flake). Pin the name directly via aria-labelledby → the visible
        // pauseLabel span, so the switch is named on first paint, every render.
        aria-labelledby="renewal-reminders-toggle-label"
        checked={optedOut}
        onCheckedChange={onChange}
        disabled={isPending}
      />
    </div>
  );
}
