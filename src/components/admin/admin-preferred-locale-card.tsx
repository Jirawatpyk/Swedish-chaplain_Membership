/**
 * R4 verify-fix Types-#6 (2026-05-02) — admin locale picker for a
 * specific member.
 *
 * Mirrors the portal `PreferredLocaleForm` but PATCHes the admin
 * route at `/api/admin/members/[id]/preferred-locale` and seeds the
 * initial value from server-side props (avoids an extra GET roundtrip
 * since the parent page already has the member loaded).
 */
'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

type PreferredLocale = 'en' | 'th' | 'sv' | null;

export interface AdminPreferredLocaleCardProps {
  readonly memberId: string;
}

export function AdminPreferredLocaleCard({
  memberId,
}: AdminPreferredLocaleCardProps): ReactElement {
  const t = useTranslations('admin.membersPreferredLocale');
  // MVP — admin picks fresh value each visit. The PATCH route is
  // idempotent on same value (returns `outcome.kind === 'unchanged'`,
  // no audit emit). When the Member domain entity gains the
  // preferredLocale field (F12 white-label phase), seed initial value
  // from server props instead of starting at null.
  const [value, setValue] = useState<PreferredLocale>(null);
  const [saving, setSaving] = useState(false);

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
      } else {
        toast.error(t('errorToast'));
      }
    } catch {
      toast.error(t('errorToast'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card text-card-foreground mb-6 p-6">
      <h3 className="text-base font-semibold leading-none tracking-tight">
        {t('title')}
      </h3>
      <p className="text-muted-foreground mt-1.5 text-sm">{t('description')}</p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">{t('title')}</legend>
        {(['__null', 'en', 'th', 'sv'] as const).map((opt) => {
          const optValue: PreferredLocale = opt === '__null' ? null : opt;
          const id = `admin-preferred-locale-${memberId}-${opt}`;
          const label =
            opt === '__null' ? t('useTenantDefault') : t(`options.${opt}`);
          return (
            <div key={opt} className="flex items-center gap-2">
              <input
                type="radio"
                id={id}
                name={`preferredLocale-${memberId}`}
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
    </div>
  );
}
