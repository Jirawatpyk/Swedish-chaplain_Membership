/**
 * T104 — LocaleTextInput (US2 + US3).
 *
 * Tabbed en/th/sv editor used inside the plan wizard. EN is the only
 * required locale; TH/SV are optional but surface a "missing" badge
 * until they are filled in so admins see the translation gap live.
 *
 * Tab state is local to this component; values are lifted up via
 * `onChange` so react-hook-form can own the single-source-of-truth.
 *
 * UX standards § 12 (forms): every label pairs with an `id`-based
 * `htmlFor` so screen readers associate labels correctly.
 */
'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
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
  readonly error?: string;
}

const LOCALES: ReadonlyArray<{ readonly key: LocaleKey; readonly label: string }> = [
  { key: 'en', label: 'EN' },
  { key: 'th', label: 'TH' },
  { key: 'sv', label: 'SV' },
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
}: LocaleTextInputProps) {
  const t = useTranslations('admin.plans.badges');
  const baseId = useId();
  const [active, setActive] = useState<LocaleKey>('en');

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

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {/* mb-0 overrides the primitive's field-label-gap — here the
            Label sits inside a flex row with badges, and the outer
            `space-y-2` already manages the gap to the Tabs below.
            Without this override, the primitive's 6px bottom margin
            would stack with the 8px space-y → 14px double-gap. */}
        <Label className="mb-0">
          {label}
          {required ? <span className="text-destructive ml-1">*</span> : null}
        </Label>
        {LOCALES.filter((l) => l.key !== 'en' && !value[l.key]).map((l) => (
          <Badge
            key={l.key}
            variant="outline"
            className="text-xs"
            title={t('missingTranslations', { locales: l.key })}
          >
            {l.label} ⚠
          </Badge>
        ))}
      </div>
      <Tabs value={active} onValueChange={(v) => setActive(v as LocaleKey)}>
        <TabsList>
          {LOCALES.map((l) => (
            <TabsTrigger key={l.key} value={l.key}>
              {l.label}
              {l.key === 'en' && required ? ' *' : ''}
            </TabsTrigger>
          ))}
        </TabsList>
        {LOCALES.map((l) => (
          <TabsContent key={l.key} value={l.key}>
            {multiline ? (
              <Textarea
                id={`${baseId}-${l.key}`}
                value={value[l.key] ?? ''}
                onChange={(e) => update(l.key, e.target.value)}
                maxLength={maxLength}
                disabled={disabled}
                rows={4}
                aria-label={`${label} (${l.label})`}
              />
            ) : (
              <Input
                id={`${baseId}-${l.key}`}
                type="text"
                value={value[l.key] ?? ''}
                onChange={(e) => update(l.key, e.target.value)}
                maxLength={maxLength}
                disabled={disabled}
                aria-label={`${label} (${l.label})`}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
