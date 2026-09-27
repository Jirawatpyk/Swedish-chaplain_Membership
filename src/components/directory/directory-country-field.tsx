'use client';

/**
 * The directory listing's Country field (spec 122 US3, `Portal-directory`):
 * an AURA Combobox of localised country names whose value stays the ISO
 * 3166-1 alpha-2 code the listing stores — the same code the old two-letter
 * text field sent, so nothing about what is saved changes.
 *
 * Names come from the `i18n-iso-countries` registration `CountryDisplay`
 * uses; until the locale is registered the options are the bare codes, so
 * the list is never empty. Thailand and Sweden (the chamber's two most common
 * countries) lead the list, as in the staff member form's picker.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import i18nIsoCountries from 'i18n-iso-countries';
import { Combobox, type ComboboxOption } from '@jirawatpyk/aura-react';
import { ensureLocaleLoaded, isLocaleRegistered } from '@/components/members/country-display';

const LEADING_CODES = ['TH', 'SE'] as const;

export function DirectoryCountryField({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  /** ISO alpha-2, or '' for none. */
  readonly value: string;
  readonly onChange: (code: string) => void;
}) {
  const t = useTranslations('admin.members.create.fields');
  const baseLocale = useLocale().split('-')[0] ?? 'en';
  const [ready, setReady] = useState(isLocaleRegistered(baseLocale));

  useEffect(() => {
    let cancelled = false;
    void ensureLocaleLoaded(baseLocale).then(() => {
      if (!cancelled) setReady(isLocaleRegistered(baseLocale));
    });
    return () => {
      cancelled = true;
    };
  }, [baseLocale]);

  const options = useMemo<ComboboxOption[]>(() => {
    const names: Record<string, string> = ready
      ? i18nIsoCountries.getNames(baseLocale)
      : Object.fromEntries(Object.keys(i18nIsoCountries.getAlpha2Codes()).map((code) => [code, code]));
    const option = (code: string): ComboboxOption => ({ value: code, label: names[code] ?? code, keywords: [code] });
    const leading: readonly string[] = LEADING_CODES;
    const rest = Object.keys(names)
      .filter((code) => !leading.includes(code))
      .map(option)
      .sort((a, b) => a.label.localeCompare(b.label, baseLocale));
    return [...LEADING_CODES.filter((code) => code in names).map(option), ...rest];
  }, [ready, baseLocale]);

  return (
    <Combobox
      id={id}
      label={label}
      options={options}
      value={value.toUpperCase() || null}
      onChange={(next) => onChange(next ?? '')}
      placeholder={t('countryPlaceholder')}
      emptyText={t('countryEmptyMessage')}
    />
  );
}
