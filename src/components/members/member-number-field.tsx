'use client';

/**
 * Admin detail — formatted human-readable member number with a copy
 * affordance. Rendered ABOVE the UUID Field (backend lookups stay UUID).
 *
 * The formatted string is computed server-side via
 * `formatMemberNumber(prefix, member.memberNumber)` and passed as a prop
 * so this client component never imports the tenant prefix.
 */

import { useTranslations } from 'next-intl';
import { CopyButton } from './copy-button';

function Field({
  label,
  value,
  mono = false,
  extra,
}: {
  label: string;
  value: string;
  mono?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-sm">
        <span className={mono ? 'font-mono text-xs' : ''}>{value}</span>
        {extra}
      </dd>
    </div>
  );
}

export function MemberNumberField({ formatted }: { readonly formatted: string }) {
  const t = useTranslations('admin.members.detail');
  return (
    <Field
      label={t('fields.memberNumber')}
      value={formatted}
      mono
      extra={<CopyButton value={formatted} label={t('copy.copyMemberNumber')} />}
    />
  );
}
