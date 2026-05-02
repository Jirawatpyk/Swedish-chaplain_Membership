/**
 * R4 verify-fix Types-#6 (2026-05-02) — member portal locale picker.
 *
 * Renders 4 radio options (en / th / sv / "use tenant default" = null)
 * + Save button. PATCH /api/portal/preferred-locale on submit. GET on
 * mount to populate current value.
 */
'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type PreferredLocale = 'en' | 'th' | 'sv' | null;
type LoadState = 'loading' | 'ready' | 'error';

export function PreferredLocaleForm(): ReactElement {
  const t = useTranslations('portal.preferredLocale');
  const [state, setState] = useState<LoadState>('loading');
  const [value, setValue] = useState<PreferredLocale>(null);
  const [saving, setSaving] = useState(false);

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
      } else {
        toast.error(t('errorToast'));
      }
    } catch {
      toast.error(t('errorToast'));
    } finally {
      setSaving(false);
    }
  }

  if (state === 'loading') {
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>;
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
        {t('save')}
      </Button>
    </form>
  );
}
