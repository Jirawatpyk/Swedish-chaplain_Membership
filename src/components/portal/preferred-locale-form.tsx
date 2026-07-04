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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAriaAnnounce } from '@/hooks/use-aria-announce';
import {
  updatePreferredLocale,
  PREFERRED_LOCALE_ENDPOINT,
  type PreferredLocale,
} from '@/components/portal/preferred-locale-client';

type LoadState = 'loading' | 'ready' | 'error';

export interface PreferredLocaleFormProps {
  /**
   * Optional SSR-seeded initial value. When provided the form skips the
   * client-side GET on mount entirely (no skeleton flash, no waterfall).
   * `undefined` = no SSR seed → fall back to client-side fetch.
   * `null` = SSR confirmed value is null (use tenant default).
   */
  readonly initialValue?: PreferredLocale | undefined;
}

export function PreferredLocaleForm({
  initialValue,
}: PreferredLocaleFormProps = {}): ReactElement {
  const t = useTranslations('portal.preferredLocale');
  const tLang = useTranslations('common');
  const seeded = initialValue !== undefined;
  const [state, setState] = useState<LoadState>(seeded ? 'ready' : 'loading');
  const [value, setValue] = useState<PreferredLocale>(seeded ? initialValue : null);
  const [saving, setSaving] = useState(false);
  const { announcement, announce } = useAriaAnnounce();

  useEffect(() => {
    if (seeded) return; // SSR seeded — skip client-side fetch
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(PREFERRED_LOCALE_ENDPOINT, {
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
  }, [seeded]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await updatePreferredLocale(value);
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
        <RadioGroup
          value={value === null ? '__null' : value}
          onValueChange={(v) => setValue(v === '__null' ? null : (v as 'en' | 'th' | 'sv'))}
          disabled={saving}
          className="space-y-2"
        >
          {(['__null', 'en', 'th', 'sv'] as const).map((opt) => {
            const id = `preferred-locale-${opt}`;
            const label =
              opt === '__null' ? t('useTenantDefault') : tLang(`languageOptions.${opt}`);
            return (
              <div key={opt} className="flex items-center gap-2">
                <RadioGroupItem id={id} value={opt} aria-label={label} />
                <Label htmlFor={id} className="mb-0 leading-4 cursor-pointer">
                  {label}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      </fieldset>
      <Button
        type="submit"
        disabled={saving}
        className="w-full"
        size="lg"
      >
        {saving && (
          <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" />
        )}
        {t('save')}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </form>
  );
}
