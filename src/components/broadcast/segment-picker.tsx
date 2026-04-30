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

// Smart-5 — F6 EventAttendees stub returns []. Mark the option as
// "coming soon" until F6 ships its real adapter so members don't
// silently submit zero-recipient broadcasts.
const COMING_SOON_SEGMENTS: ReadonlySet<SegmentKind> = new Set([
  'event_attendees_last_90d',
]);

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
          if (COMING_SOON_SEGMENTS.has(next as SegmentKind)) return;
          onChange({
            kind: next as SegmentKind,
            tierCodes: next === 'tier' ? value.tierCodes : [],
          });
        }}
        disabled={disabled}
        className="space-y-2"
      >
        {OPTIONS.map((opt) => {
          const comingSoon = COMING_SOON_SEGMENTS.has(opt);
          return (
            <div key={opt} className="flex items-center gap-2">
              <RadioGroupItem
                id={`segment-${opt}`}
                value={opt}
                disabled={comingSoon || disabled}
                aria-disabled={comingSoon || disabled}
              />
              <Label
                htmlFor={`segment-${opt}`}
                className={
                  comingSoon
                    ? 'text-muted-foreground cursor-not-allowed'
                    : 'cursor-pointer'
                }
              >
                {tOption(opt)}
                {comingSoon ? (
                  <span className="ml-2 text-xs italic text-muted-foreground">
                    {t('comingSoon')}
                  </span>
                ) : null}
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
