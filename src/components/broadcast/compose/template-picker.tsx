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
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

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
  const [open, setOpen] = useState(false);

  // Hide entirely when no templates exist (FR-018 implicit — no
  // empty-dropdown UX).
  if (templates.length === 0) return null;

  const selectedTemplate = templates.find((tpl) => tpl.id === selectedId);
  const triggerLabel = selectedTemplate?.name ?? t('blankOption');

  function selectTemplate(value: string): void {
    setOpen(false);
    onSelect(value === BLANK_VALUE ? null : value);
  }

  return (
    // F119 T140 — no `mb-6` any more: the picker is a child of the compose
    // form's own `space-y-6` stack now, so its old page-level bottom margin
    // would double the gap above the editor.
    <div className="space-y-2">
      <Label id="compose-template-picker-label">{t('triggerLabel')}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-labelledby="compose-template-picker-label"
              aria-describedby="compose-template-picker-help"
              disabled={disabled}
              className="w-full justify-between"
            />
          }
        >
          <span
            className={cn(
              'truncate',
              !selectedTemplate && 'text-muted-foreground',
            )}
          >
            {triggerLabel}
          </span>
          <ChevronsUpDownIcon
            className="ml-2 size-4 shrink-0 opacity-50"
            aria-hidden="true"
          />
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0"
          align="start"
        >
          <Command>
            <CommandInput placeholder={t('searchPlaceholder')} />
            <CommandList>
              <CommandEmpty>{t('emptyMessage')}</CommandEmpty>
              <CommandGroup>
                {/* Blank option always at the top — chamber members can
                    always start fresh even when templates exist. */}
                <CommandItem
                  value={BLANK_VALUE}
                  keywords={[t('blankOption')]}
                  onSelect={() => selectTemplate(BLANK_VALUE)}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <CheckIcon
                    className={cn(
                      'size-4',
                      selectedId === null ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">
                    {t('blankOption')}
                  </span>
                </CommandItem>
                {templates.map((tpl) => (
                  <CommandItem
                    key={tpl.id}
                    value={tpl.id}
                    keywords={[tpl.name]}
                    onSelect={() => selectTemplate(tpl.id)}
                    className="flex cursor-pointer items-center justify-between gap-2"
                  >
                    <span className="flex items-center gap-2">
                      <CheckIcon
                        className={cn(
                          'size-4',
                          selectedId === tpl.id ? 'opacity-100' : 'opacity-0',
                        )}
                        aria-hidden="true"
                      />
                      <span>{tpl.name}</span>
                    </span>
                    {tpl.isSeeded ? (
                      <span
                        className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border border-warning bg-warning-surface text-warning"
                        aria-label={t('starterBadgeAria')}
                      >
                        {t('starterSuffix')}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p id="compose-template-picker-help" className="text-caption">
        {t('helpText')}
      </p>
    </div>
  );
}
