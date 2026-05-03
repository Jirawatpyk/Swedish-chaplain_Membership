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
 */
'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useAriaAnnounce } from '@/hooks/use-aria-announce';

type PreferredLocale = 'en' | 'th' | 'sv' | null;

export interface AdminPreferredLocaleCardProps {
  readonly memberId: string;
  readonly initialValue: PreferredLocale;
}

export function AdminPreferredLocaleCard({
  memberId,
  initialValue,
}: AdminPreferredLocaleCardProps): ReactElement {
  const t = useTranslations('admin.membersPreferredLocale');
  const titleId = `admin-preferred-locale-title-${memberId}`;
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
    <div className="rounded-lg border bg-card text-card-foreground mb-6 p-6">
      <h3
        id={titleId}
        className="text-base font-semibold leading-none tracking-tight"
      >
        {t('title')}
      </h3>
      <p className="text-muted-foreground mt-1.5 text-sm">{t('description')}</p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <fieldset className="space-y-2" aria-labelledby={titleId}>
          <RadioGroup
            value={value === null ? '__null' : value}
            onValueChange={(v) => setValue(v === '__null' ? null : (v as 'en' | 'th' | 'sv'))}
            disabled={saving}
            className="space-y-2"
          >
            {(['__null', 'en', 'th', 'sv'] as const).map((opt) => {
              const id = `admin-preferred-locale-${memberId}-${opt}`;
              const label =
                opt === '__null' ? t('useTenantDefault') : t(`options.${opt}`);
              return (
                <div key={opt} className="flex items-center gap-2">
                  <RadioGroupItem id={id} value={opt} />
                  <Label htmlFor={id} className="mb-0 leading-4 cursor-pointer">
                    {label}
                  </Label>
                </div>
              );
            })}
          </RadioGroup>
        </fieldset>
        <Button type="submit" disabled={saving} className="min-w-[8rem]">
          {saving && (
            <Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" />
          )}
          {t('save')}
        </Button>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </form>
    </div>
  );
}
