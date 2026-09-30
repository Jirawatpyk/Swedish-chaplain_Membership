/**
 * R5 verify-fix UX-H1+B2+M2 (2026-05-02) — admin locale picker for a
 * specific member.
 *
 * Mirrors the portal `PreferredLocaleForm`:
 *  - PATCHes /api/admin/members/[id]/preferred-locale
 *  - Seeds initial value from server prop (parent already loaded
 *    `member.preferredLocale` via `getMember` — no extra GET roundtrip
 *    on screen mount)
 *  - Visually-hidden aria-live region announces save outcome to SRs
 *  - Button shows Loader2 spinner during in-flight PATCH
 *
 * Closes the R4 data-loss footgun (admin clicked Save without seeing
 * the current value → silently reset member's preference to null).
 *
 * Spec 122 US5b-2 (T579): the board's card (`Admin-member-edit`) — an AURA
 * RadioGroup named "Notification language" whose hint says it is saved on
 * its own, not with the form's "Save changes", and a secondary
 * "Save preference" (the portal form's shape).
 */
'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button, Card, RadioGroup } from '@jirawatpyk/aura-react';
import { useAriaAnnounce } from '@/hooks/use-aria-announce';
import { locales } from '@/i18n/config';
// Single source for the locale-or-tenant-default union (shared with the portal
// form + switcher transport) so adding a locale can't leave this card behind.
import type { PreferredLocale } from '@/components/portal/preferred-locale-client';

export interface AdminPreferredLocaleCardProps {
  readonly memberId: string;
  readonly initialValue: PreferredLocale;
}

export function AdminPreferredLocaleCard({
  memberId,
  initialValue,
}: AdminPreferredLocaleCardProps): ReactElement {
  const t = useTranslations('admin.membersPreferredLocale');
  const tLang = useTranslations('common');
  const [value, setValue] = useState<PreferredLocale>(initialValue);
  const [saving, setSaving] = useState(false);
  const { announcement, announce } = useAriaAnnounce();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/admin/members/${encodeURIComponent(memberId)}/preferred-locale`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preferredLocale: value }),
        },
      );
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

  return (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col items-start gap-4">
        <RadioGroup
          id={`admin-preferred-locale-${memberId}`}
          label={t('title')}
          hint={`${t('description')} ${t('savedSeparately')}`}
          orientation="horizontal"
          value={value === null ? '__null' : value}
          onChange={(v) => setValue(v === '__null' ? null : (v as 'en' | 'th' | 'sv'))}
          disabled={saving}
          options={(['__null', ...locales] as const).map((opt) => ({
            value: opt,
            label: opt === '__null' ? t('useTenantDefault') : tLang(`languageOptions.${opt}`),
          }))}
        />
        <Button type="submit" variant="secondary" loading={saving}>
          {t('save')}
        </Button>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </form>
    </Card>
  );
}
