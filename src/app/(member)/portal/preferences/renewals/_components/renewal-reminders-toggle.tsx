/**
 * F8 Phase 5 Wave C · T132 — Renewal-reminder opt-out toggle (client).
 *
 * Optimistic toggle posting to `/api/portal/preferences/renewals` per
 * FR-016. Idempotent — re-toggle preserves the original timestamp on
 * the DB side; the UI just reflects the latest server state.
 *
 * i18n: strings under `portal.preferences.renewals.*` in EN/TH/SV.
 *
 * Spec 122 US3: AURA Switch — its label names it and its description
 * describes it (the 067 / S13 naming fixes are what AURA does by default).
 */
'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Switch } from '@jirawatpyk/aura-react';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';

interface RenewalRemindersToggleProps {
  readonly initialOptedOut: boolean;
}

export function RenewalRemindersToggle({
  initialOptedOut,
}: RenewalRemindersToggleProps) {
  const t = useTranslations('portal.preferences.renewals');
  const readOnlyToast = useReadOnlyToast();
  const [optedOut, setOptedOut] = useState(initialOptedOut);
  const [isPending, startTransition] = useTransition();

  const onChange = (next: boolean) => {
    const prev = optedOut;
    setOptedOut(next);
    startTransition(async () => {
      // I17 review-fix: surface failures via toast (per
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
          // The write freeze: the switch has already flipped back.
          if (isReadOnlyRefusal(r.status, body)) {
            readOnlyToast();
            return;
          }
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
    <Switch
      id="renewal-reminders-toggle"
      label={t('pauseLabel')}
      description={t('pauseDescription')}
      checked={optedOut}
      onChange={onChange}
      disabled={isPending}
    />
  );
}
