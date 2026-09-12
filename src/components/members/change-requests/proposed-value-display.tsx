'use client';

/**
 * F114 — one proposed / seen / current value rendered for people: a scalar
 * as text, `null`/'' as the localised "(empty)" sentinel (muted — see memory
 * "muted = empty sentinel"), an address group as a labelled line list. Shared
 * by the staff decision table (US2) and the history surfaces; the portal diff
 * table carries its own inline copy of the same rule.
 */
import { useTranslations } from 'next-intl';
import type { ChangeRequestFieldView } from '@/lib/change-request-portal-view';
import {
  BILLING_ADDRESS_LINES,
  REGISTERED_ADDRESS_LINES,
  isAddressGroupKey,
} from '@/modules/members/domain/change-request/proposable-fields';

export type ProposedValue = ChangeRequestFieldView['proposed'];

function isAddress(v: ProposedValue): v is Exclude<ProposedValue, string | null> {
  return v !== null && typeof v === 'object';
}

export interface ProposedValueDisplayProps {
  readonly fieldKey: ChangeRequestFieldView['key'];
  readonly value: ProposedValue;
}

export function ProposedValueDisplay({ fieldKey, value }: ProposedValueDisplayProps) {
  const t = useTranslations('portal.changeRequests.diff');
  if (value === null || value === '') return <span className="text-muted-foreground">{t('empty')}</span>;
  if (isAddress(value) || isAddressGroupKey(fieldKey)) {
    const obj = (isAddress(value) ? value : {}) as Readonly<Record<string, string | null>>;
    const lines = fieldKey === 'billing_address' ? BILLING_ADDRESS_LINES : REGISTERED_ADDRESS_LINES;
    const present = lines.filter((line) => (obj[line] ?? null) !== null && obj[line] !== '');
    if (present.length === 0) return <span className="text-muted-foreground">{t('empty')}</span>;
    return (
      <dl className="m-0 space-y-0.5">
        {present.map((line) => (
          <div key={line} className="flex gap-2">
            <dt className="shrink-0 text-caption text-muted-foreground">{t(`lines.${line}`)}</dt>
            <dd className="m-0 break-words">{obj[line]}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="break-words">{value}</span>;
}
