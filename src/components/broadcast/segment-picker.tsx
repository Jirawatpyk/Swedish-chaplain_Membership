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
 *
 * Spec 122 US12d-3 (T1270) — on AURA's RadioGroup (a fieldset named by its
 * legend, each radio by its own label; 44 px rows on touch).
 *
 * PR D (27 Oct 2026, FR-011): the tier option is a choice of the two
 * membership categories, more than one allowed. It used to be a free-text
 * "Tier code" field, but the recipient query matches only the `plan_category`
 * values, so anything else typed there reached nobody. AURA has no checkbox
 * group yet: a fieldset and legend hold AURA Checkboxes (stand-in until AURA
 * #183, docs/aura-adoption.md).
 */
import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Checkbox, RadioGroup } from '@jirawatpyk/aura-react';
import {
  BROADCAST_TIER_CODES,
  isBroadcastTierCode,
  type BroadcastTierCode,
} from '@/lib/broadcasts-tier-codes';

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

function isSegmentKind(value: string): value is SegmentKind {
  return (OPTIONS as readonly string[]).includes(value);
}

export function SegmentPicker({
  value,
  onChange,
  disabled = false,
}: SegmentPickerProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const tOption = useTranslations('portal.broadcasts.compose.segmentOption');

  return (
    <div className="space-y-3" data-compose-feature="segment-picker">
      <RadioGroup
        label={t('fields.segmentLabel')}
        options={OPTIONS.map((opt) => ({ value: opt, label: tOption(opt) }))}
        value={value.kind}
        onChange={(next) => {
          if (!isSegmentKind(next)) return;
          onChange({
            kind: next,
            tierCodes: next === 'tier' ? value.tierCodes : [],
          });
        }}
        disabled={disabled}
        touchHeight
      />
      {value.kind === 'tier' ? (
        <TierCategoriesField
          codes={value.tierCodes}
          onChange={(tierCodes) => onChange({ kind: 'tier', tierCodes })}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

/**
 * The categories, in a fixed order whatever order they were ticked in. A code
 * held from elsewhere that is not a category shows nothing ticked and is
 * dropped on the next change.
 */
function TierCategoriesField({
  codes,
  onChange,
  disabled,
}: {
  readonly codes: ReadonlyArray<string>;
  readonly onChange: (codes: ReadonlyArray<BroadcastTierCode>) => void;
  readonly disabled: boolean;
}): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const tCategory = useTranslations('portal.broadcasts.list.tierCode');
  const hintId = useId();
  const chosen = new Set(codes.filter(isBroadcastTierCode));
  return (
    <fieldset
      className="m-0 ml-6 flex min-w-0 flex-col gap-[var(--aura-space-1)] border-0 p-0"
      aria-describedby={hintId}
      disabled={disabled}
      data-compose-feature="tier-categories"
    >
      <legend className="mb-[var(--aura-space-1)] p-0 text-sm font-medium">{t('tierLabel')}</legend>
      {BROADCAST_TIER_CODES.map((code) => (
        <Checkbox
          key={code}
          checked={chosen.has(code)}
          onChange={(checked) => {
            const next = new Set(chosen);
            if (checked) next.add(code);
            else next.delete(code);
            onChange(BROADCAST_TIER_CODES.filter((c) => next.has(c)));
          }}
          disabled={disabled}
          touchHeight
        >
          {tCategory(code)}
        </Checkbox>
      ))}
      <p id={hintId} className="m-0 text-sm text-[var(--aura-fg-secondary)]">
        {t('fields.tierCodesHelp')}
      </p>
    </fieldset>
  );
}
