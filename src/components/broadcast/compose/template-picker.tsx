'use client';

/**
 * T115 (F7.1a US7) — Template picker for member compose surface (MVP).
 *
 * Renders a native `<select>` listing the tenant's templates filtered
 * by cascading locale (server pre-applies the locale cascade and passes
 * the rows in as `templates`). Selecting a template navigates to
 * `/portal/broadcasts/new?template={id}` so the server page can fetch
 * the template, apply `substituteChamberName`, and re-render the
 * compose form with the substituted subject + body as initial values.
 *
 * Phase 5H upgrade path: replace native `<select>` with shadcn
 * Combobox (per critique X3/E8 + contracts/broadcast-template.md § 3)
 * for ARIA combobox role + keyboard typeahead + MRU section. The
 * native select is the accessibility-equivalent MVP — it carries the
 * implicit listbox role, supports keyboard navigation by default, and
 * works without JS-hydration. Power-user "Show all locales" toggle +
 * Starter badge in dropdown items also Phase 5H.
 */
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';

export interface TemplatePickerRow {
  readonly id: string;
  readonly name: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly isSeeded: boolean;
}

interface Props {
  readonly templates: readonly TemplatePickerRow[];
  /** Currently-selected template id (from `?template=` query). */
  readonly selectedId?: string | null;
}

export function ComposeTemplatePicker({
  templates,
  selectedId = null,
}: Props): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.templatePicker');
  const router = useRouter();

  // Hide the picker entirely if no templates exist (FR-018 implicit —
  // a chamber with zero templates shows the "Blank" compose surface
  // directly without an empty dropdown).
  if (templates.length === 0) return null;

  function onChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value;
    if (value === '') {
      // "Blank" — clear the query string so the server re-renders
      // with empty initial values.
      router.push('/portal/broadcasts/new');
    } else {
      router.push(`/portal/broadcasts/new?template=${encodeURIComponent(value)}`);
    }
  }

  return (
    <div className="mb-6 space-y-2">
      <Label htmlFor="compose-template-picker">{t('triggerLabel')}</Label>
      <select
        id="compose-template-picker"
        value={selectedId ?? ''}
        onChange={onChange}
        className="block w-full rounded-md border border-input bg-background px-3 h-[var(--input-height)] text-sm"
        aria-describedby="compose-template-picker-help"
      >
        <option value="">{t('blankOption')}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.name}
            {tpl.isSeeded ? ` (${t('starterSuffix')})` : ''}
          </option>
        ))}
      </select>
      <p id="compose-template-picker-help" className="text-caption">
        {t('helpText')}
      </p>
    </div>
  );
}
