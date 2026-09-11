'use client';

/**
 * F114 FR-004 / research R6 (T041) — the contact's OWN email language
 * (`contacts.preferred_language`, Group A). Lives on /portal/account beside
 * `PreferredLocaleForm` (the member-level display setting) and saves
 * IMMEDIATELY through `PATCH /api/portal/profile` with
 * `{ primary_contact: { preferredLanguage } }` — the one body the narrowed
 * endpoint accepts while the tenant requires approval. Same UX contract as
 * the sibling form: radio group, Save button with spinner, toast + sr-only
 * live announcement.
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAriaAnnounce } from '@/hooks/use-aria-announce';

export type ContactLanguage = 'en' | 'th' | 'sv';

export interface ContactLanguageFormProps {
  readonly initialValue: ContactLanguage;
}

export function ContactLanguageForm({ initialValue }: ContactLanguageFormProps): ReactElement {
  const t = useTranslations('portal.account.contactLanguage');
  const tLang = useTranslations('common');
  const [value, setValue] = useState<ContactLanguage>(initialValue);
  // the last value the SERVER accepted — a failed save reverts to it so the
  // radio never disagrees with the record (round 6, silent-failure #13)
  const [saved, setSaved] = useState<ContactLanguage>(initialValue);
  const [saving, setSaving] = useState(false);
  const { announcement, announce } = useAriaAnnounce();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/portal/profile', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ primary_contact: { preferredLanguage: value } }),
      });
      if (res.ok) {
        setSaved(value);
        toast.success(t('savedToast'));
        announce(t('savedToast'));
      } else {
        setValue(saved);
        // 503 = the write freeze, 429 = the profile rate limit: both are
        // "try later", not "something broke"
        const message = res.status === 503 ? t('readOnlyToast') : res.status === 429 ? t('rateLimitedToast') : t('errorToast');
        toast.error(message);
        announce(message);
      }
    } catch (e) {
      console.error('[contact-language-form] save failed', e);
      setValue(saved);
      toast.error(t('errorToast'));
      announce(t('errorToast'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="contact-language-form">
      <fieldset className="space-y-2">
        <legend className="sr-only">{t('title')}</legend>
        <RadioGroup
          value={value}
          onValueChange={(v) => setValue(v as ContactLanguage)}
          disabled={saving}
          className="space-y-2"
        >
          {(['en', 'th', 'sv'] as const).map((opt) => {
            const id = `contact-language-${opt}`;
            const label = tLang(`languageOptions.${opt}`);
            return (
              <div key={opt} className="flex items-center gap-2">
                <RadioGroupItem id={id} value={opt} aria-label={label} />
                <Label htmlFor={id} className="mb-0 cursor-pointer leading-4">
                  {label}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      </fieldset>
      <Button type="submit" disabled={saving} className="w-full" size="lg">
        {saving && <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" />}
        {t('save')}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </form>
  );
}
