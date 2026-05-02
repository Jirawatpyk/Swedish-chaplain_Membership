/**
 * R5 verify-fix UX-B1+B2+M2+M3 (2026-05-02) — member portal locale picker.
 *
 * Renders 4 radio options (en / th / sv / "use tenant default" = null)
 * + Save button. PATCH /api/portal/preferred-locale on submit. GET on
 * mount to populate current value.
 *
 * UX standards (docs/ux-standards.md § 2 + § 15):
 *  - Loading: shimmer skeleton mirroring final layout (4 radio rows + button)
 *  - Saving: button shows Loader2 spinner alongside disabled state
 *  - SR feedback: visually-hidden aria-live polite region announces save
 *    success/error in addition to sonner toasts
 *  - Error (load-time): explicit error block with role="alert" and i18n copy;
 *    does NOT silently fall through to a half-broken form
 */
'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

type PreferredLocale = 'en' | 'th' | 'sv' | null;
type LoadState = 'loading' | 'ready' | 'error';

export function PreferredLocaleForm(): ReactElement {
  const t = useTranslations('portal.preferredLocale');
  const [state, setState] = useState<LoadState>('loading');
  const [value, setValue] = useState<PreferredLocale>(null);
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/preferred-locale', {
          credentials: 'same-origin',
        });
        if (!res.ok) {
          if (!cancelled) setState('error');
          return;
        }
        const body = (await res.json()) as { preferredLocale: PreferredLocale };
        if (!cancelled) {
          setValue(body.preferredLocale);
          setState('ready');
        }
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function announce(msg: string) {
    setAnnouncement(msg);
    // Reset after 3s so consecutive saves re-announce.
    setTimeout(() => setAnnouncement(''), 3000);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/portal/preferred-locale', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredLocale: value }),
      });
      if (res.ok) {
        toast.success(t('savedToast'));
        announce(t('savedToast'));
      } else {
        toast.error(t('errorToast'));
        announce(t('errorToast'));
      }
    } catch {
      toast.error(t('errorToast'));
      announce(t('errorToast'));
    } finally {
      setSaving(false);
    }
  }

  if (state === 'loading') {
    return (
      <div
        className="space-y-2"
        aria-busy="true"
        aria-label={t('loading')}
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
        <Skeleton className="mt-4 h-9 w-32" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t('loadError')}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">{t('title')}</legend>
        {(['__null', 'en', 'th', 'sv'] as const).map((opt) => {
          const optValue: PreferredLocale = opt === '__null' ? null : opt;
          const id = `preferred-locale-${opt}`;
          const label =
            opt === '__null' ? t('useTenantDefault') : t(`options.${opt}`);
          return (
            <div key={opt} className="flex items-center gap-2">
              <input
                type="radio"
                id={id}
                name="preferredLocale"
                value={opt}
                checked={value === optValue}
                onChange={() => setValue(optValue)}
                className="h-4 w-4"
                disabled={saving}
              />
              <Label htmlFor={id} className="cursor-pointer">
                {label}
              </Label>
            </div>
          );
        })}
      </fieldset>
      <Button type="submit" disabled={saving}>
        {saving && <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />}
        {t('save')}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </form>
  );
}
