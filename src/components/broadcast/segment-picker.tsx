'use client';

/**
 * T085 — Segment picker (4 RadioGroup options).
 *
 * Drives the `segment` field of the compose form:
 *   - all_members
 *   - tier:X (with tier code input)
 *   - event_attendees_last_90d
 *   - custom (paired with <CustomListInput />)
 *
 * The picker only emits the `kind` + `tierCodes` (when applicable).
 * `customRecipientEmails` is collected by the sibling <CustomListInput />.
 */
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

export type SegmentKind =
  | 'all_members'
  | 'tier'
  | 'event_attendees_last_90d'
  | 'custom';

export interface SegmentPickerValue {
  readonly kind: SegmentKind;
  readonly tierCodes: ReadonlyArray<string>;
}

export interface SegmentPickerProps {
  readonly value: SegmentPickerValue;
  readonly onChange: (next: SegmentPickerValue) => void;
  readonly disabled?: boolean;
}

const OPTIONS: readonly SegmentKind[] = [
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
];

export function SegmentPicker({
  value,
  onChange,
  disabled = false,
}: SegmentPickerProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const tOption = useTranslations('portal.broadcasts.compose.segmentOption');

  return (
    <fieldset className="space-y-3" aria-disabled={disabled}>
      <legend className="text-sm font-medium">{t('fields.segmentLabel')}</legend>
      <RadioGroup
        value={value.kind}
        onValueChange={(next: string) => {
          onChange({
            kind: next as SegmentKind,
            tierCodes: next === 'tier' ? value.tierCodes : [],
          });
        }}
        disabled={disabled}
        className="space-y-2"
      >
        {OPTIONS.map((opt) => {
          return (
            <div key={opt} className="flex items-center gap-2">
              {/* E5 UX hardening — removed redundant `aria-disabled`.
                  The HTML `disabled` attribute on RadioGroupItem already
                  surfaces as `aria-disabled="true"` via Radix. Setting
                  both risks fighting if Radix ever changes its
                  defaults. */}
              <RadioGroupItem
                id={`segment-${opt}`}
                value={opt}
                disabled={disabled}
                // base-ui Radio.Root renders its own internal id, so the
                // sibling <Label htmlFor> can't name it — set the accessible
                // name directly (fixes axe aria-toggle-field-name).
                aria-label={tOption(opt)}
              />
              <Label htmlFor={`segment-${opt}`} className="cursor-pointer">
                {tOption(opt)}
              </Label>
            </div>
          );
        })}
      </RadioGroup>
      {value.kind === 'tier' ? (
        <div className="ml-6 space-y-1">
          <Label htmlFor="segment-tier-codes">{t('tierLabel')}</Label>
          <Input
            id="segment-tier-codes"
            value={value.tierCodes.join(', ')}
            onChange={(e) =>
              onChange({
                kind: 'tier',
                tierCodes: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            placeholder={t('fields.tierCodesPlaceholder')}
            disabled={disabled}
            aria-describedby="segment-tier-codes-help"
          />
          <p
            id="segment-tier-codes-help"
            className="text-xs text-muted-foreground"
          >
            {t('fields.tierCodesHelp')}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}
