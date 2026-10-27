'use client';

/**
 * T115 (F7.1a US7) — Template picker for member compose surface.
 *
 * shadcn-style Combobox built on cmdk + Popover per critique X3/E8 +
 * contracts/broadcast-template.md § 3. Replaces the Phase 5H.1 MVP
 * native `<select>` with:
 *   - Typeahead filter via Command's built-in fuzzy match (cmdk)
 *   - "Blank" + per-template options
 *   - Starter badge rendered inline on `is_seeded=TRUE` rows
 *   - Selected state with CheckIcon
 *   - Combobox ARIA role + aria-expanded + keyboard navigation
 *     (Popover + Command provide these natively)
 *
 * Locale cascade + MRU ordering are applied SERVER-SIDE in
 * listBroadcastTemplates (Phase 5D T103) — this component just
 * renders the already-filtered, already-ordered rows.
 *
 * F119 T140 (FR-046): selecting an option REPORTS the choice to the parent
 * (`onSelect(id | null)`) and nothing else. It used to `router.push(
 * ?template={id})`, which remounted `<ComposeForm>` via the `key=` on
 * `new/page.tsx` and destroyed whatever the member had typed, with no
 * confirmation and no undo. The confirm-then-re-seed decision now lives one
 * level up in `<ComposeTemplatePickerField>`; `?template=` still works as a
 * deep link on a fresh page load, which is the only thing it was ever needed
 * for.
 *
 * Spec 122 US12d-3 (T1270) — on AURA's Combobox (cmdk is banned outside the
 * legacy host): the field is the search, its list filters as the member types
 * (AURA's Thai-aware filter), the chosen row carries the check, a starter
 * template says so on its second line, and the box is 44 px on touch. The
 * value stays controlled by `selectedId`, so a choice the overwrite
 * confirmation then cancels leaves the field showing the template in use.
 * No clear button: "Blank" is an option of its own, and clearing would ask the
 * same question with less said.
 */
import { useTranslations } from 'next-intl';
import { Combobox } from '@jirawatpyk/aura-react';

export interface TemplatePickerRow {
  readonly id: string;
  readonly name: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly isSeeded: boolean;
}

interface Props {
  readonly templates: readonly TemplatePickerRow[];
  /** Currently-applied template id (`null` = blank / started from scratch). */
  readonly selectedId?: string | null;
  /** Reports the choice; `null` means the blank option. */
  readonly onSelect: (id: string | null) => void;
  readonly disabled?: boolean;
}

const BLANK_VALUE = '__blank__';

export function ComposeTemplatePicker({
  templates,
  selectedId = null,
  onSelect,
  disabled = false,
}: Props): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.templatePicker');

  // Hide entirely when no templates exist (FR-018 implicit — no
  // empty-dropdown UX).
  if (templates.length === 0) return null;

  const options = [
    // Blank always at the top — members can always start fresh.
    { value: BLANK_VALUE, label: t('blankOption') },
    ...templates.map((tpl) => ({
      value: tpl.id,
      label: tpl.name,
      ...(tpl.isSeeded ? { description: t('starterSuffix') } : {}),
    })),
  ];
  const value = selectedId !== null && templates.some((tpl) => tpl.id === selectedId)
    ? selectedId
    : BLANK_VALUE;

  return (
    // F119 T140 — no `mb-6` any more: the picker is a child of the compose
    // form's own `space-y-6` stack, so a page-level margin would double the gap.
    <div data-compose-feature="template-picker" className="sm:max-w-md">
      <Combobox
        id="compose-template-picker"
        touchHeight
        label={t('triggerLabel')}
        hint={t('helpText')}
        placeholder={t('searchPlaceholder')}
        emptyText={t('emptyMessage')}
        options={options}
        value={value}
        clearable={false}
        onChange={(next) => {
          if (next === null) return;
          onSelect(next === BLANK_VALUE ? null : next);
        }}
        disabled={disabled}
      />
    </div>
  );
}
