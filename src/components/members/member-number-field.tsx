'use client';

/**
 * Admin detail — formatted human-readable member number with a copy
 * affordance. Rendered ABOVE the UUID Field (backend lookups stay UUID).
 *
 * The formatted string is computed server-side via
 * `formatMemberNumber(prefix, member.memberNumber)` and passed as a prop
 * so this client component never imports the tenant prefix.
 *
 * 056 fix #7 — consumes the shared `DetailField` instead of a private copy.
 */

import { useTranslations } from 'next-intl';
import { CopyButton } from './copy-button';
import { DetailField } from './detail-field';

export function MemberNumberField({ formatted }: { readonly formatted: string }) {
  const t = useTranslations('admin.members.detail');
  return (
    <DetailField
      label={t('fields.memberNumber')}
      value={formatted}
      mono
      extra={<CopyButton value={formatted} label={t('copy.copyMemberNumber')} />}
    />
  );
}
