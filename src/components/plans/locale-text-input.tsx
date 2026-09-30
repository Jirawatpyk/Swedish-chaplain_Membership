/**
 * T104 — LocaleTextInput (US2 + US3).
 *
 * Tabbed en/th/sv editor used in the plan wizard and edit form. EN is the
 * only required locale; TH/SV are optional, and a tab whose translation is
 * empty is marked so admins see the gap live.
 *
 * Tab state is local to this component; values are lifted up via
 * `onChange` so the form's draft stays the single source of truth.
 *
 * 122 US6 (T604): AURA `Tabs` ("Plan name language") above one AURA field
 * per language, labelled "Plan name (English)" etc. as the plan boards draw
 * it; every panel stays mounted so a hidden language keeps its field. An
 * error belongs to the English value, so it switches back to that tab.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TextField, Textarea } from '@jirawatpyk/aura-react';

type LocaleKey = 'en' | 'th' | 'sv';
// Aligned with zod z.input<typeof localeTextSchema> which emits
// `| undefined` on optional fields under exactOptionalPropertyTypes.
type LocaleTextLike = {
  readonly en: string;
  readonly th?: string | undefined;
  readonly sv?: string | undefined;
};

export interface LocaleTextInputProps {
  readonly value: LocaleTextLike;
  readonly onChange: (next: LocaleTextLike) => void;
  readonly label: string;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly required?: boolean;
  readonly disabled?: boolean;
  /** The English value's message (it is the only required one). */
  readonly error?: string;
  /** The English field's id (the others add `-th` / `-sv`), for error links. */
  readonly id?: string;
}

const LOCALES: ReadonlyArray<{ readonly key: LocaleKey; readonly tab: string }> = [
  { key: 'en', tab: 'EN' },
  { key: 'th', tab: 'TH' },
  { key: 'sv', tab: 'SV' },
];

export function LocaleTextInput({
  value,
  onChange,
  label,
  multiline = false,
  maxLength = 120,
  required = false,
  disabled = false,
  error,
  id,
}: LocaleTextInputProps) {
  const t = useTranslations('admin.plans.create');
  const [active, setActive] = useState<LocaleKey>('en');

  // The message is about the English value: when one arrives, show that
  // tab so the field (and its message) is on screen and can take the form's
  // error focus. Adjusted while rendering (React's derived-state pattern),
  // so the other tabs stay reachable while the message stands.
  const [shownError, setShownError] = useState(error);
  if (error !== shownError) {
    setShownError(error);
    if (error) setActive('en');
  }

  function update(locale: LocaleKey, next: string): void {
    const mutable: { en: string; th?: string; sv?: string } = {
      en: value.en ?? '',
      ...(value.th !== undefined ? { th: value.th } : {}),
      ...(value.sv !== undefined ? { sv: value.sv } : {}),
    };
    if (locale === 'en') {
      mutable.en = next;
    } else if (next === '') {
      delete mutable[locale];
    } else {
      mutable[locale] = next;
    }
    onChange(mutable);
  }

  const tabs = LOCALES.map((l) => {
    const missing = l.key !== 'en' && !value[l.key];
    const fieldLabel = `${label} (${t(`localeNames.${l.key}`)})`;
    const common = {
      ...(id ? { id: l.key === 'en' ? id : `${id}-${l.key}` } : {}),
      label: fieldLabel,
      value: value[l.key] ?? '',
      maxLength,
      disabled,
      ...(l.key === 'en' && required ? { required: true } : {}),
      ...(l.key === 'en' && error ? { error } : {}),
    };
    return {
      id: l.key,
      label: l.tab,
      ...(missing
        ? {
            icon: 'triangle-alert' as const,
            tabProps: {
              'aria-label': t('translationMissing', { code: l.tab, locale: t(`localeNames.${l.key}`) }),
            },
          }
        : {}),
      content: multiline ? (
        <Textarea {...common} rows={3} onChange={(e) => update(l.key, e.target.value)} />
      ) : (
        <TextField {...common} type="text" onChange={(e) => update(l.key, e.target.value)} />
      ),
    };
  });

  return (
    <Tabs
      label={t('localeTabsLabel', { field: label })}
      tabs={tabs}
      value={active}
      onChange={(id) => setActive(id as LocaleKey)}
      keepMounted
    />
  );
}
