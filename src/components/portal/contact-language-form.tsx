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
 *
 * Spec 122 US3 (`Portal-account`): AURA RadioGroup with its visible legend
 * ("Emails to you personally") and hint under the options, then a secondary
 * Save button (decision 2026-09-27: no action bar).
 */
import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button, RadioGroup } from '@jirawatpyk/aura-react';
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
        // 503 = the write freeze (READ_ONLY_MODE): "try later", not "something
        // broke". (`PATCH /api/portal/profile` has no rate limit — round 7.)
        const message = res.status === 503 ? t('readOnlyToast') : t('errorToast');
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
      <RadioGroup
        label={t('groupLabel')}
        hint={t('hint')}
        // AURA's option rows are 44px on touch screens (coarse pointers)
        value={value}
        onChange={(v) => setValue(v as ContactLanguage)}
        disabled={saving}
        options={(['en', 'th', 'sv'] as const).map((opt) => ({ value: opt, label: tLang(`languageOptions.${opt}`) }))}
      />
      {/* Decision 2026-09-27 (`Portal-account`): a plain secondary button under the hint, no action bar. */}
      <Button type="submit" variant="secondary" loading={saving}>
        {t('save')}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </form>
  );
}
