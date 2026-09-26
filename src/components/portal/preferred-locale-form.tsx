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
 *    success/error in addition to toasts
 *  - Error (load-time): explicit error block with role="alert" and i18n copy;
 *    does NOT silently fall through to a half-broken form
 *  - Spec 122 US3: AURA RadioGroup (legend = the title, for screen readers;
 *    the section shows it above) and Save in an ActionBar pinned to the card
 *    that reads "Unsaved changes" while the choice differs from the saved one
 */
'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { ActionBar, Button, RadioGroup } from '@jirawatpyk/aura-react';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
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
  const readOnlyToast = useReadOnlyToast();
  const tLang = useTranslations('common');
  const seeded = initialValue !== undefined;
  const [state, setState] = useState<LoadState>(seeded ? 'ready' : 'loading');
  const [value, setValue] = useState<PreferredLocale>(seeded ? initialValue : null);
  // the last value the server holds — drives the "Unsaved changes" status
  const [saved, setSaved] = useState<PreferredLocale>(seeded ? initialValue : null);
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
          setSaved(body.preferredLocale);
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
        setSaved(value);
        toast.success(t('savedToast'));
        announce(t('savedToast'));
      } else if (await isReadOnlyResponse(res)) {
        announce(readOnlyToast());
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
            <SkeletonBlock className="h-4 w-4 rounded-full" />
            <SkeletonBlock className="h-4 w-32" />
          </div>
        ))}
        <SkeletonBlock className="mt-4 h-11 w-32" />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <p className="text-sm text-[var(--aura-fg-danger)]" role="alert">
        {t('loadError')}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <RadioGroup
        label={t('title')}
        className="[&>legend]:sr-only"
        value={value === null ? '__null' : value}
        onChange={(v) => setValue(v === '__null' ? null : (v as 'en' | 'th' | 'sv'))}
        disabled={saving}
        options={(['__null', 'en', 'th', 'sv'] as const).map((opt) => ({
          value: opt,
          label: opt === '__null' ? t('useTenantDefault') : tLang(`languageOptions.${opt}`),
        }))}
      />
      <ActionBar position="container" status={value !== saved ? tLang('unsavedStatus') : null}>
        <Button type="submit" loading={saving}>
          {t('save')}
        </Button>
      </ActionBar>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </form>
  );
}
